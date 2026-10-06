import type { DatabaseSync } from 'node:sqlite'
import { REPLY_IDENTITY_BATCH_LIMIT, REPLY_IDENTITY_LOOKUP_LIMIT, validateReplyIdentityBatch, validateReplyIdentityLookup, validReplyIdentityRow, type ReplyIdentityBatch, type ReplyIdentityMatch } from '../../domain/reply-identity-index'

/** Owned by the private notification worker. Caller owns the enclosing source transaction. */
export class SqliteReplyIdentityIndex {
  constructor(private readonly db: DatabaseSync) {}
  create(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS desktop_notification_reply_keys (
      source_key TEXT NOT NULL, logical_key TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(source_key,logical_key));
      CREATE TABLE IF NOT EXISTS desktop_notification_reply_aliases (
        source_key TEXT NOT NULL, alias TEXT NOT NULL, logical_key TEXT NOT NULL,
        PRIMARY KEY(source_key,alias,logical_key));`)
  }
  validateStructure(): void {
    for (const [table, expected] of [
      ['desktop_notification_reply_keys', [['source_key', 'TEXT', 1], ['logical_key', 'TEXT', 2], ['payload', 'TEXT', 0]]],
      ['desktop_notification_reply_aliases', [['source_key', 'TEXT', 1], ['alias', 'TEXT', 2], ['logical_key', 'TEXT', 3]]]
    ] as const) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; pk: number; notnull: number }>
      if (columns.length !== expected.length || expected.some(([name, type, pk], index) => {
        const column = columns[index]; return !column || column.name !== name || column.type !== type || column.pk !== pk || column.notnull !== 1
      })) throw Error('私有回复关联结构异常，原数据保留')
    }
  }
  write(batch: ReplyIdentityBatch): void {
    validateReplyIdentityBatch(batch)
    const put = this.db.prepare(`INSERT INTO desktop_notification_reply_keys VALUES(?,?,?)
      ON CONFLICT(source_key,logical_key) DO UPDATE SET payload=excluded.payload`)
    const alias = this.db.prepare('INSERT OR IGNORE INTO desktop_notification_reply_aliases VALUES(?,?,?)')
    for (const row of batch.rows) {
      const stored = this.db.prepare('SELECT payload FROM desktop_notification_reply_keys WHERE source_key=? AND logical_key=?').get(batch.sourceKey, row.key) as { payload: string } | undefined
      if (stored) {
        const previous: unknown = JSON.parse(stored.payload)
        if (!validReplyIdentityRow(previous) || previous.recorded && !row.recorded) throw Error('私有回复已发布身份不能回退')
      }
      put.run(batch.sourceKey, row.key, JSON.stringify(row))
      for (const value of new Set([row.key, ...row.aliases])) alias.run(batch.sourceKey, value, row.key)
    }
    for (const link of batch.links ?? []) alias.run(batch.sourceKey, link.alias, link.key)
    for (const merge of batch.merges ?? []) {
      const stored = this.db.prepare('SELECT payload FROM desktop_notification_reply_keys WHERE source_key=? AND logical_key=?').get(batch.sourceKey, merge.from) as { payload: string } | undefined
      if (!stored) throw Error('私有回复原身份缺失，不猜测归并')
      const previous: unknown = JSON.parse(stored.payload)
      if (!validReplyIdentityRow(previous) || previous.recorded) throw Error('已发布的回复身份不能作为被归并项')
      this.db.prepare(`INSERT OR IGNORE INTO desktop_notification_reply_aliases SELECT source_key,alias,? FROM desktop_notification_reply_aliases WHERE source_key=? AND logical_key=?`).run(merge.to, batch.sourceKey, merge.from)
      this.db.prepare('DELETE FROM desktop_notification_reply_aliases WHERE source_key=? AND logical_key=?').run(batch.sourceKey, merge.from)
      this.db.prepare('DELETE FROM desktop_notification_reply_keys WHERE source_key=? AND logical_key=?').run(batch.sourceKey, merge.from)
    }
  }
  lookup(sourceKey: string, aliases: readonly string[]): ReplyIdentityMatch[] {
    validateReplyIdentityLookup(sourceKey, aliases)
    if (!aliases.length) return []
    const rows = this.db.prepare(`SELECT a.logical_key,a.alias,k.payload FROM desktop_notification_reply_aliases a
      LEFT JOIN desktop_notification_reply_keys k ON k.source_key=a.source_key AND k.logical_key=a.logical_key
      WHERE a.source_key=? AND a.alias IN (${aliases.map(() => '?').join(',')}) LIMIT ?`).all(sourceKey, ...aliases, REPLY_IDENTITY_LOOKUP_LIMIT + 1) as Array<{ logical_key: string; alias: string; payload: string | null }>
    if (rows.length > REPLY_IDENTITY_LOOKUP_LIMIT) throw Error('私有回复关联存在过多候选，不猜测合并')
    const matches = new Map<string, ReplyIdentityMatch>()
    for (const value of rows) {
      const row: unknown = value.payload === null ? undefined : JSON.parse(value.payload)
      if (!validReplyIdentityRow(row) || row.key !== value.logical_key) throw Error('私有回复关联格式异常，历史保留')
      let match = matches.get(row.key)
      if (!match) { match = { row, aliases: [] }; matches.set(row.key, match) }
      match.aliases.push(value.alias)
    }
    if (matches.size > REPLY_IDENTITY_BATCH_LIMIT) throw Error('私有回复关联存在过多候选，不猜测合并')
    return [...matches.values()]
  }
}
