import { NATIVE_SCOPE_SOURCE_PREFIXES, validNativeScope, type NotificationSourceListPage, type NotificationSourceListQuery } from '../../domain/native-scope-availability'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { NotificationChange, NotificationDraft, NotificationMarker, NotificationPage, NotificationPreferences, NotificationQuery, NotificationRecord, NotificationSummary, NotificationSourceResult, NotificationSourceState } from '../../domain/notification'
import { normalizeNotificationPreferences, notificationContentSignature, notificationIsPending, notificationSafeText, NotificationActionError, validateNotificationDraft, NOTIFICATION_SOURCE_BATCH_LIMIT, NOTIFICATION_SOURCE_PAYLOAD_LIMIT } from '../../domain/notification'
import { NOTIFICATION_ROUTINE_RETENTION_MS, validateNotificationGapId, validateNotificationIntegrity, type NotificationHistoryIntegrity, type NotificationHistoryStatus } from '../../domain/notification-history'
import { notificationFingerprint, fingerprintSignature } from '../../application/notification-fingerprint'
import type { OperatorMessageRecordMetadata } from '../../domain/team-message-notification'
import type { McpWriteRecordMetadata } from '../../domain/mcp-write-notification'
import { validateReplyIdentityBatch, type ReplyIdentityBatch, type ReplyIdentityMatch } from '../../domain/reply-identity-index'
import { SqliteReplyIdentityIndex } from './sqlite-reply-identity-index'
import { validateQuestionTerminalLookup, validateQuestionTerminalBatch, type QuestionTerminalBatch, type QuestionTerminalReceipt } from '../../domain/question-terminal-receipt'

type StoredRow = { payload: string }
const knownNegativeTransactions = new WeakSet<object>()
export function notificationSqliteIsBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ERR_SQLITE_ERROR' || !('errcode' in error) || typeof error.errcode !== 'number') return false
  return [5, 6].includes(error.errcode & 255) // SQLITE_BUSY / SQLITE_LOCKED, including extended codes.
}
export function notificationTransactionMayRetry(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && knownNegativeTransactions.has(error))
}
function rememberNegative(error: unknown, confirmed: boolean): void {
  if (!error || typeof error !== 'object') return
  knownNegativeTransactions.delete(error)
  if (confirmed && notificationSqliteIsBusy(error)) knownNegativeTransactions.add(error)
}
function decodeRecord(payload: string): NotificationRecord {
  try {
    const record = JSON.parse(payload) as NotificationRecord
    validateNotificationDraft(record)
    if (record.retentionProtected !== undefined && typeof record.retentionProtected !== 'boolean') throw Error('invalid retention evidence')
    if (typeof record.id !== 'string' || !record.id || [record.revision, record.attentionRevision, record.readRevision].some(value => !Number.isSafeInteger(value) || value < 0)
      || [record.createdAt, record.updatedAt, record.readAt, record.archivedAt].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000))) throw Error('invalid record')
    return record
  } catch { throw new Error('通知记录格式异常，原操作不受影响；原历史保留。') }
}

/** Synchronous on purpose: this repository is owned ONLY by the notification worker. */
export class SqliteNotificationRepository {
  private readonly db: DatabaseSync
  private readonly replyIndex: SqliteReplyIdentityIndex
  private closed = false
  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.replyIndex = new SqliteReplyIdentityIndex(this.db)
    try {
      this.db.exec(`PRAGMA busy_timeout=250;
        CREATE TABLE IF NOT EXISTS desktop_notification_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, preferences TEXT NOT NULL,schema_version INTEGER NOT NULL DEFAULT 3);
        INSERT OR IGNORE INTO desktop_notification_meta(id,revision,preferences) VALUES(1,0,'{}');
        CREATE TABLE IF NOT EXISTS desktop_notifications (
          id TEXT PRIMARY KEY, semantic_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
          workspace_id TEXT, category TEXT NOT NULL, attention TEXT NOT NULL, state TEXT NOT NULL,
          revision INTEGER NOT NULL, attention_revision INTEGER NOT NULL, read_revision INTEGER NOT NULL,
          archived_at INTEGER, source_revision INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS desktop_notifications_scope ON desktop_notifications(workspace_id,revision DESC);
        CREATE INDEX IF NOT EXISTS desktop_notifications_order ON desktop_notifications(revision DESC);
        CREATE TABLE IF NOT EXISTS desktop_notification_tombstones (semantic_key TEXT PRIMARY KEY, source_revision INTEGER NOT NULL, cleared_at INTEGER NOT NULL,content_signature TEXT);`)
      const version = (this.db.prepare('SELECT schema_version FROM desktop_notification_meta WHERE id=1').get() as { schema_version: number }).schema_version
      if (version === 1) {
        this.transaction(() => {
          const columns = this.db.prepare('PRAGMA table_info(desktop_notification_tombstones)').all() as Array<{ name: string }>
          if (!columns.some(column => column.name === 'content_signature')) this.db.exec('ALTER TABLE desktop_notification_tombstones ADD COLUMN content_signature TEXT')
          this.db.exec('UPDATE desktop_notification_meta SET schema_version=2 WHERE id=1')
        })
      } else if (![2, 3, 4, 5, 6, 7].includes(version)) throw new Error('通知历史格式暂不支持，原有数据未修改')
      if (version >= 4) {
        for (const table of ['desktop_notification_sources', 'desktop_notification_integrity', 'desktop_notification_gap_keys'])
          if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw Error('通知历史结构异常，原数据保留')
        if (!this.db.prepare('SELECT 1 FROM desktop_notification_integrity WHERE id=1').get()) throw Error('通知历史完整性证据缺失，原数据保留')
      }
      this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS desktop_notification_sources (source_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL,updated_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS desktop_notification_integrity (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,acknowledged_revision INTEGER NOT NULL,latest_gap_id TEXT,observed_at INTEGER,acknowledged_at INTEGER);
          INSERT OR IGNORE INTO desktop_notification_integrity VALUES(1,0,0,NULL,NULL,NULL);
          CREATE TABLE IF NOT EXISTS desktop_notification_gap_keys (gap_id TEXT PRIMARY KEY);`)
        // Older rows lack evidence of their past diagnostic/action importance.
        // Migration preserves them rather than guessing they're disposable.
        if (version < 4) {
          this.db.exec(`UPDATE desktop_notifications SET payload=json_set(payload,'$.retentionProtected',json('true'));
            UPDATE desktop_notification_meta SET schema_version=4 WHERE id=1;`)
          let after = ''
          for (;;) {
            const tombstones = this.db.prepare('SELECT semantic_key,content_signature FROM desktop_notification_tombstones WHERE content_signature IS NOT NULL AND semantic_key>? ORDER BY semantic_key LIMIT 100').all(after) as Array<{ semantic_key: string; content_signature: string }>
            if (!tombstones.length) break
            for (const tombstone of tombstones) if (!/^sha256:[a-f0-9]{64}$/.test(tombstone.content_signature)) this.db.prepare('UPDATE desktop_notification_tombstones SET content_signature=? WHERE semantic_key=?').run(fingerprintSignature(tombstone.content_signature), tombstone.semantic_key)
            after = tombstones.at(-1)!.semantic_key
          }
        }
      })
      // Version 4 checkpoints are backfilled in bounded source CAS batches, not
      // an unbounded initialization transaction. Never recreate missing v5 data.
      if (version < 5) this.transaction(() => {
        this.replyIndex.create(); this.replyIndex.validateStructure()
        this.db.exec('UPDATE desktop_notification_meta SET schema_version=5 WHERE id=1')
      })
      else this.replyIndex.validateStructure()
      let questionStampReady = version >= 7
      if (version < 6) this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS desktop_notification_question_terminals (
          source_key TEXT NOT NULL, identity TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(source_key,identity));`)
        questionStampReady = this.db.prepare('PRAGMA table_info(desktop_notification_question_terminals)').all().some(row => row.name === 'original_stamp')
        this.validateQuestionTerminalsStructure(questionStampReady)
        this.db.exec('UPDATE desktop_notification_meta SET schema_version=6 WHERE id=1')
      })
      else this.validateQuestionTerminalsStructure(version >= 7)
      if (version < 7) this.transaction(() => {
        if (!questionStampReady) this.db.exec('ALTER TABLE desktop_notification_question_terminals ADD COLUMN original_stamp TEXT')
        this.validateQuestionTerminalsStructure()
        this.db.exec('UPDATE desktop_notification_meta SET schema_version=7 WHERE id=1')
      })
      this.historyGap() // Invalid v4 integrity never silently becomes a fresh, clean ledger.
    } catch (error) { this.db.close(); throw error }
  }

  private validateQuestionTerminalsStructure(withStamp = true): void {
    const columns = this.db.prepare('PRAGMA table_info(desktop_notification_question_terminals)').all() as Array<{ name: string; type: string; pk: number; notnull: number }>
    const expected = [['source_key', 1], ['identity', 2], ['status', 0]] as const
    if (columns.length !== (withStamp ? 4 : 3) || expected.some(([name, pk], index) => columns[index]?.name !== name || columns[index]?.type !== 'TEXT' || columns[index]?.pk !== pk || columns[index]?.notnull !== 1)
      || withStamp && (columns[3]?.name !== 'original_stamp' || columns[3]?.type !== 'TEXT' || columns[3]?.pk !== 0 || columns[3]?.notnull !== 0)) throw Error('私有问卷终态结构异常，原数据保留')
  }
  questionTerminals(sourceKey: string, identities: string[]): QuestionTerminalReceipt[] {
    validateQuestionTerminalLookup(sourceKey, identities)
    if (!identities.length) return []
    const rows = this.db.prepare(`SELECT identity,status,original_stamp FROM desktop_notification_question_terminals WHERE source_key=? AND identity IN (${identities.map(() => '?').join(',')})`).all(sourceKey, ...identities) as unknown as Array<QuestionTerminalReceipt & { original_stamp: string | null }>
    const values = rows.map(row => ({ identity: row.identity, status: row.status, ...(row.original_stamp === null ? {} : { originalStamp: row.original_stamp }) }))
    validateQuestionTerminalBatch({ sourceKey, rows: values }); return values
  }
  private writeQuestionTerminals(batch: QuestionTerminalBatch): void {
    const get = this.db.prepare('SELECT status FROM desktop_notification_question_terminals WHERE source_key=? AND identity=?')
    const put = this.db.prepare(`INSERT INTO desktop_notification_question_terminals VALUES(?,?,?,?)
      ON CONFLICT(source_key,identity) DO UPDATE SET original_stamp=COALESCE(excluded.original_stamp,desktop_notification_question_terminals.original_stamp)`)
    for (const row of batch.rows) {
      const previous = get.get(batch.sourceKey, row.identity) as { status: string } | undefined
      if (previous && previous.status !== row.status) throw Error('原问卷终态凭据冲突，不猜测覆盖')
      put.run(batch.sourceKey, row.identity, row.status, row.originalStamp ?? null)
    }
  }
  private revision(): number {
    const value = Number((this.db.prepare('SELECT revision FROM desktop_notification_meta WHERE id=1').get() as { revision: number }).revision)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('通知历史版本异常，原数据保留。')
    return value
  }
  private nextRevision(): number {
    this.db.prepare('UPDATE desktop_notification_meta SET revision=revision+1 WHERE id=1').run()
    return this.revision()
  }
  private transaction<T>(run: () => T): T {
    try { this.db.exec('BEGIN IMMEDIATE') }
    catch (error) { rememberNegative(error, true); throw error } // No transaction or mutation began.
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) {
      let rolledBack = false
      try { this.db.exec('ROLLBACK'); rolledBack = true } catch { /* Preserve the original error, without granting unsafe retries. */ }
      rememberNegative(error, rolledBack)
      throw error
    }
  }
  private where(query: NotificationQuery, filter = query.filter): { sql: string; params: Array<string | number> } {
    const clauses = ['archived_at IS NULL']; const params: Array<string | number> = []
    if (query.key) { clauses.push('semantic_key=?'); params.push(query.key) }
    if (query.eventType) { clauses.push("json_extract(payload,'$.eventType')=?"); params.push(query.eventType) }
    if (query.runId) { clauses.push("json_extract(payload,'$.scope.runId')=?"); params.push(query.runId) }
    if (query.operationFamilyId) { clauses.push("json_extract(payload,'$.scope.operationFamilyId')=?"); params.push(query.operationFamilyId) }
    if (query.sessionId) { clauses.push("json_extract(payload,'$.scope.sessionId')=?"); params.push(query.sessionId) }
    if (query.contextDomain) { clauses.push("json_extract(payload,'$.scope.contextDomain')=?"); params.push(query.contextDomain) }
    if (query.installationId) { clauses.push("json_extract(payload,'$.scope.installationId')=?"); params.push(query.installationId) }
    if (query.memoryId) { clauses.push("json_extract(payload,'$.scope.memoryId')=?"); params.push(query.memoryId) }
    if (query.generation) { clauses.push("json_extract(payload,'$.scope.generation')=?"); params.push(query.generation) }
    if (query.toolCallId) { clauses.push("json_extract(payload,'$.target.toolCallId')=?"); params.push(query.toolCallId) }
    if (query.entryId) { clauses.push("json_extract(payload,'$.target.entryId')=?"); params.push(query.entryId) }
    if (query.workspaceId) { clauses.push('(workspace_id=? OR workspace_id IS NULL)'); params.push(query.workspaceId) }
    if (query.category) { clauses.push('category=?'); params.push(query.category) }
    if (filter === 'unread') clauses.push("attention<>'activity' AND read_revision<attention_revision")
    if (filter === 'pending') clauses.push("attention='action' AND state='active'")
    return { sql: clauses.join(' AND '), params }
  }
  private summary(query: NotificationQuery = {}): NotificationSummary {
    const count = (filter?: NotificationQuery['filter']): number => {
      const where = this.where(query, filter ?? 'all')
      return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM desktop_notifications WHERE ${where.sql}`).get(...where.params) as { n: number }).n)
    }
    const where = this.where(query, 'all')
    const clearable = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM desktop_notifications WHERE ${where.sql}
      AND attention<>'activity' AND read_revision>=attention_revision AND NOT (attention='action' AND state='active')`).get(...where.params) as { n: number }).n)
    return { revision: this.revision(), total: count(), unread: count('unread'), pending: count('pending'), clearable }
  }
  private save(record: NotificationRecord): void {
    this.db.prepare(`INSERT INTO desktop_notifications VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, workspace_id=excluded.workspace_id,
      category=excluded.category, attention=excluded.attention, state=excluded.state, revision=excluded.revision,
      attention_revision=excluded.attention_revision,read_revision=excluded.read_revision,
      archived_at=excluded.archived_at,source_revision=excluded.source_revision`).run(
      record.id, record.key, JSON.stringify(record), record.scope.workspaceId ?? null, record.category, record.attention, record.state,
      record.revision, record.attentionRevision, record.readRevision, record.archivedAt ?? null, record.sourceRevision)
  }
  private get(id: string): NotificationRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM desktop_notifications WHERE id=?').get(id) as StoredRow | undefined
    return row ? decodeRecord(row.payload) : undefined
  }

  marker(key: string): NotificationMarker {
    const row = this.db.prepare('SELECT payload FROM desktop_notifications WHERE semantic_key=?').get(key) as StoredRow | undefined
    if (row) { const record = decodeRecord(row.payload); return { sourceRevision: record.sourceRevision, signature: notificationFingerprint(record) } }
    const tombstone = this.db.prepare('SELECT source_revision,content_signature FROM desktop_notification_tombstones WHERE semantic_key=?').get(key) as { source_revision: number; content_signature: string | null } | undefined
    return tombstone ? { sourceRevision: tombstone.source_revision, cleared: true, ...(tombstone.content_signature ? { signature: tombstone.content_signature } : {}) } : { sourceRevision: 0 }
  }

  put(draft: NotificationDraft, now: number): NotificationChange {
    validateNotificationDraft(draft)
    return this.transaction(() => this.putInTransaction(draft, now))
  }
  private putInTransaction(draft: NotificationDraft, now: number): NotificationChange {
    draft = { ...draft, title: notificationSafeText(draft.title), source: notificationSafeText(draft.source),
      ...(draft.detail !== undefined ? { detail: notificationSafeText(draft.detail) } : {}) }
      const oldRow = this.db.prepare('SELECT payload FROM desktop_notifications WHERE semantic_key=?').get(draft.key) as StoredRow | undefined
      const old = oldRow ? decodeRecord(oldRow.payload) : undefined
      const tombstone = this.db.prepare('SELECT source_revision,content_signature FROM desktop_notification_tombstones WHERE semantic_key=?').get(draft.key) as { source_revision: number; content_signature: string | null } | undefined
      if ((!old && tombstone && draft.sourceRevision <= tombstone.source_revision) || (old && draft.sourceRevision <= old.sourceRevision)) {
        return { changed: false, record: old, summary: this.summary() }
      }
      if (!old && tombstone && (draft.respectCleared || tombstone.content_signature === notificationFingerprint(draft))) {
        this.db.prepare('UPDATE desktop_notification_tombstones SET source_revision=?,content_signature=? WHERE semantic_key=?')
          .run(draft.sourceRevision, notificationFingerprint(draft), draft.key)
        return { changed: false, summary: this.summary() }
      }
      if (old && notificationContentSignature(old) === notificationContentSignature(draft)) {
        old.sourceRevision = draft.sourceRevision
        this.save(old)
        return { changed: false, record: old, summary: this.summary() }
      }
      const revision = this.nextRevision()
      const { renewAttention, announce: _announce, respectCleared: _respectCleared, liveSignal: _liveSignal, ...content } = draft
      const escalated = old && (old.attention === 'activity' && draft.attention !== 'activity'
        || draft.attention === 'action' && draft.state === 'active' && !notificationIsPending(old))
      const attentionRevision = draft.attention === 'activity' ? 0 : !old || renewAttention || escalated ? revision : old.attentionRevision
      const record: NotificationRecord = {
        ...content, id: old?.id ?? randomUUID(), createdAt: old?.createdAt ?? now, updatedAt: now, revision, attentionRevision,
        retentionProtected: Boolean(old?.retentionProtected || draft.attention === 'action' || ['warning', 'error'].includes(draft.tone)),
        readRevision: old?.readRevision ?? 0, ...(old?.readAt !== undefined ? { readAt: old.readAt } : {}),
        ...(old?.archivedAt !== undefined && !renewAttention && !escalated ? { archivedAt: old.archivedAt } : {})
      }
      this.save(record)
      if (tombstone) this.db.prepare('DELETE FROM desktop_notification_tombstones WHERE semantic_key=?').run(draft.key)
      return { changed: true, record, summary: this.summary() }
  }
  sourceState(key: string): NotificationSourceState {
    const row = this.db.prepare('SELECT revision,payload FROM desktop_notification_sources WHERE source_key=?').get(key) as { revision: number; payload: string } | undefined
    if (!row) return { revision: 0 }
    if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('通知来源版本异常，原数据保留。')
    return { revision: row.revision, data: JSON.parse(row.payload) as unknown }
  }
  /** Internal private checkpoints only. Fixed source prefixes, keyset pagination, no renderer IPC or business DB. */
  listNativeSources(query: NotificationSourceListQuery): NotificationSourceListPage {
    if (!NATIVE_SCOPE_SOURCE_PREFIXES.includes(query.prefix) || query.after !== undefined && (typeof query.after !== 'string' || !new RegExp(`^${query.prefix}[a-f0-9]{64}$`).test(query.after))
      || query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) throw Error('私有来源目录查询无效')
    const limit = query.limit ?? 100
    const rows = this.db.prepare(`SELECT source_key,revision,json_extract(payload,'$.observedScope') AS scope FROM desktop_notification_sources
      WHERE source_key>=? AND source_key<? AND source_key>? ORDER BY source_key LIMIT ?`)
      .all(query.prefix, query.prefix + '\uffff', query.after ?? '', limit + 1) as Array<{ source_key: string; revision: number; scope: string | null }>
    const entries = rows.slice(0, limit).map(row => {
      if (!new RegExp(`^${query.prefix}[a-f0-9]{64}$`).test(row.source_key) || !Number.isSafeInteger(row.revision) || row.revision < 0) throw Error('私有原来源身份无法验证')
      const scope: unknown = row.scope === null ? undefined : JSON.parse(row.scope)
      if (scope !== undefined && !validNativeScope(scope)) throw Error('私有原来源范围无法验证')
      return { key: row.source_key, revision: row.revision, ...(scope ? { scope } : {}) }
    })
    return { rows: entries, ...(rows.length > limit ? { nextKey: entries.at(-1)!.key } : {}) }
  }
  replyIdentities(sourceKey: string, aliases: string[]): ReplyIdentityMatch[] { return this.replyIndex.lookup(sourceKey, aliases) }
  commitSource(key: string, expectedRevision: number, data: unknown, drafts: NotificationDraft[], now: number, replyIdentities?: ReplyIdentityBatch, questionTerminals?: QuestionTerminalBatch): NotificationSourceResult {
    if (!key || key.length > 300 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || drafts.length > NOTIFICATION_SOURCE_BATCH_LIMIT) throw new Error('通知来源提交无效')
    const payload = JSON.stringify(data)
    if (!payload || Buffer.byteLength(payload, 'utf8') > NOTIFICATION_SOURCE_PAYLOAD_LIMIT) throw new Error('通知来源状态过大或无效')
    for (const draft of drafts) validateNotificationDraft(draft)
    if (replyIdentities) {
      validateReplyIdentityBatch(replyIdentities)
      if (replyIdentities.sourceKey !== key) throw Error('私有回复身份不能跨来源提交')
    }
    if (questionTerminals) {
      validateQuestionTerminalBatch(questionTerminals)
      if (questionTerminals.sourceKey !== key) throw Error('私有问卷终态不能跨来源提交')
    }
    return this.transaction(() => {
      const source = this.sourceState(key)
      if (source.revision !== expectedRevision) return { applied: false, source, changes: [] }
      const changes = drafts.map(draft => this.putInTransaction(draft, now))
      if (replyIdentities) this.replyIndex.write(replyIdentities)
      if (questionTerminals) this.writeQuestionTerminals(questionTerminals)
      const revision = expectedRevision + 1
      this.db.prepare(`INSERT INTO desktop_notification_sources VALUES(?,?,?,?) ON CONFLICT(source_key)
        DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at`).run(key, revision, payload, now)
      return { applied: true, source: { revision, data }, changes }
    })
  }
  /** Internal exact keys, including archived records. Thin private metadata only; no arbitrary renderer query or original DB. */
  operatorMessageRecords(keys: string[]): OperatorMessageRecordMetadata[] {
    if (!Array.isArray(keys) || keys.length > 100 || keys.some(key => typeof key !== 'string' || !key.startsWith('operator-message:') || key.length <= 17 || key.length > 297)
      || new Set(keys).size !== keys.length) throw Error('私有协作消息元数据查询无效')
    if (!keys.length) return []
    const rows = this.db.prepare(`SELECT payload FROM desktop_notifications WHERE semantic_key IN (${keys.map(() => '?').join(',')})`).all(...keys) as StoredRow[]
    return rows.map(row => {
      const record = decodeRecord(row.payload)
      if (record.eventType !== 'team.operator-message') throw Error('原协作消息记录类型无法验证')
      return { key: record.key, scope: record.scope, attention: record.attention, source: record.source, subjectState: record.subjectState, sourceRevision: record.sourceRevision }
    })
  }
  mcpWriteRecords(keys: string[]): McpWriteRecordMetadata[] {
    if (!Array.isArray(keys) || keys.length > 100 || keys.some(key => typeof key !== 'string' || !/^mcp-write:[a-f0-9]{64}$/.test(key))
      || new Set(keys).size !== keys.length) throw Error('私有 MCP 摘要元数据查询无效')
    if (!keys.length) return []
    const rows = this.db.prepare(`SELECT payload FROM desktop_notifications WHERE semantic_key IN (${keys.map(() => '?').join(',')})`).all(...keys) as StoredRow[]
    return rows.map(row => {
      const r = decodeRecord(row.payload)
      if (r.eventType !== 'mcp.write-result') throw Error('原 MCP 摘要类型无法验证')
      return { key: r.key, eventId: r.eventId, subjectState: r.subjectState, scope: r.scope, target: r.target, title: r.title, detail: r.detail, source: r.source,
        tone: r.tone, state: r.state, attention: r.attention, occurredAt: r.occurredAt, timeBasis: r.timeBasis, sourceRevision: r.sourceRevision,
        archivedAt: r.archivedAt, origin: r.origin }
    })
  }
  page(query: NotificationQuery = {}): NotificationPage {
    const summary = this.summary(query)
    if (query.readCursor !== undefined) {
      const cursor = query.readCursor
      if (query.cursor || cursor !== 'start' && (!cursor || typeof cursor !== 'object' || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0
        || !Number.isSafeInteger(cursor.ceiling) || cursor.ceiling < cursor.revision || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 300))
        throw new NotificationActionError('通知阅读游标无效')
      const reset = cursor !== 'start' && cursor.ceiling > summary.revision
      const ceiling = cursor === 'start' || reset ? summary.revision : cursor.ceiling
      const where = this.where(query), limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 40)))
      const after = cursor === 'start' || reset ? undefined : cursor
      const rows = this.db.prepare(`SELECT payload FROM desktop_notifications WHERE ${where.sql} AND revision<=?
        ${after ? 'AND (revision<? OR (revision=? AND id<?))' : ''} ORDER BY revision DESC,id DESC LIMIT ?`)
        .all(...where.params, ceiling, ...(after ? [after.revision, after.revision, after.id] : []), limit + 1) as StoredRow[]
      const records = rows.slice(0, limit).map(row => decodeRecord(row.payload)), last = records.at(-1)
      return { records, summary, reset, historyIntegrity: this.historyGap().integrity,
        ...(rows.length > limit && last ? { nextReadCursor: { revision: last.revision, id: last.id, ceiling } } : {}) }
    }
    const reset = query.cursor !== undefined && query.cursor.revision !== summary.revision
    const offset = reset ? 0 : Math.max(0, Math.floor(query.cursor?.offset ?? 0))
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 40)))
    const where = this.where(query)
    const rows = this.db.prepare(`SELECT payload FROM desktop_notifications WHERE ${where.sql}
      ORDER BY CASE WHEN attention='action' AND state='active' THEN 0 WHEN attention='activity' THEN 2 ELSE 1 END,revision DESC LIMIT ? OFFSET ?`).all(...where.params, limit + 1, offset) as StoredRow[]
    return { records: rows.slice(0, limit).map(row => decodeRecord(row.payload)), summary, reset, historyIntegrity: this.historyGap().integrity,
      ...(rows.length > limit ? { nextCursor: { revision: summary.revision, offset: offset + limit } } : {}) }
  }
  read(id: string, observedRevision: number, now: number): NotificationChange {
    return this.transaction(() => {
      const record = this.get(id)
      if (!record || record.attention === 'activity' || observedRevision < record.attentionRevision || record.readRevision >= record.attentionRevision) {
        return { changed: false, record, summary: this.summary() }
      }
      record.readRevision = record.attentionRevision; record.readAt = now; this.nextRevision()
      this.save(record)
      return { changed: true, record, summary: this.summary() }
    })
  }
  readAll(query: NotificationQuery, observedRevision: number, now: number): NotificationChange {
    return this.transaction(() => {
      const where = this.where(query)
      const rows = this.db.prepare(`SELECT payload FROM desktop_notifications WHERE ${where.sql} AND attention<>'activity'
        AND read_revision<attention_revision AND attention_revision<=?`).all(...where.params, observedRevision) as StoredRow[]
      if (rows.length) {
        this.nextRevision()
        for (const row of rows) { const record = decodeRecord(row.payload); record.readRevision = record.attentionRevision; record.readAt = now; this.save(record) }
      }
      return { changed: rows.length > 0, summary: this.summary() }
    })
  }
  archive(id: string, now: number): NotificationChange {
    return this.transaction(() => {
      const record = this.get(id)
      if (record && notificationIsPending(record)) throw new NotificationActionError('此事项仍待处理，不能归档；关闭提醒不会取消业务')
      if (!record || record.archivedAt !== undefined) return { changed: false, record, summary: this.summary() }
      record.archivedAt = now; this.nextRevision(); this.save(record)
      return { changed: true, record, summary: this.summary() }
    })
  }
  clearRead(query: NotificationQuery, now: number): NotificationChange {
    return this.transaction(() => {
      const where = this.where(query)
      const rows = this.db.prepare(`SELECT payload FROM desktop_notifications WHERE ${where.sql}
        AND attention<>'activity' AND read_revision>=attention_revision AND NOT (attention='action' AND state='active')`).all(...where.params) as StoredRow[]
      for (const row of rows) {
        const record = decodeRecord(row.payload)
        this.forget(record, now)
      }
      if (rows.length) this.nextRevision()
      return { changed: rows.length > 0, summary: this.summary() }
    })
  }
  private forget(record: NotificationRecord, now: number): void {
    this.db.prepare(`INSERT INTO desktop_notification_tombstones VALUES(?,?,?,?) ON CONFLICT(semantic_key)
      DO UPDATE SET source_revision=MAX(source_revision,excluded.source_revision),cleared_at=excluded.cleared_at,content_signature=excluded.content_signature`).run(record.key, record.sourceRevision, now, notificationFingerprint(record))
    this.db.prepare('DELETE FROM desktop_notifications WHERE id=?').run(record.id)
  }
  /** Bounded batches. Never size-truncate unread/active/diagnostic or legacy-unknown records. */
  pruneRoutine(now: number): NotificationChange & { removed: number; more: boolean } {
    if (!Number.isSafeInteger(now) || now < 0) throw Error('通知保留时间无效')
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT payload FROM desktop_notifications WHERE state IN ('resolved','expired')
        AND attention<>'action' AND (attention='activity' OR read_revision>=attention_revision)
        AND json_extract(payload,'$.retentionProtected')=0 AND json_extract(payload,'$.tone') IN ('info','success')
        AND MAX(json_extract(payload,'$.updatedAt'),COALESCE(json_extract(payload,'$.readAt'),0),COALESCE(archived_at,0))<?
        ORDER BY revision ASC LIMIT 101`).all(now - NOTIFICATION_ROUTINE_RETENTION_MS) as StoredRow[]
      for (const row of rows.slice(0, 100)) this.forget(decodeRecord(row.payload), now)
      if (rows.length) this.nextRevision()
      return { changed: rows.length > 0, removed: Math.min(100, rows.length), more: rows.length > 100, summary: this.summary() }
    })
  }
  historyGap(id?: string): NotificationHistoryStatus {
    if (id) validateNotificationGapId(id)
    const row = this.db.prepare('SELECT * FROM desktop_notification_integrity WHERE id=1').get() as {
      revision: number; acknowledged_revision: number; latest_gap_id: string | null; observed_at: number | null; acknowledged_at: number | null }
    const integrity: NotificationHistoryIntegrity = { revision: row.revision, acknowledgedRevision: row.acknowledged_revision,
      ...(row.latest_gap_id ? { latestGapId: row.latest_gap_id } : {}), ...(row.observed_at !== null ? { observedAt: row.observed_at } : {}),
      ...(row.acknowledged_at !== null ? { acknowledgedAt: row.acknowledged_at } : {}) }
    validateNotificationIntegrity(integrity)
    if (integrity.latestGapId && !this.db.prepare('SELECT 1 FROM desktop_notification_gap_keys WHERE gap_id=?').get(integrity.latestGapId)) throw Error('通知缺口去重证据缺失，原数据保留')
    return { integrity, ...(id ? { known: Boolean(this.db.prepare('SELECT 1 FROM desktop_notification_gap_keys WHERE gap_id=?').get(id)) } : {}) }
  }
  recordHistoryGap(id: string, now: number): NotificationHistoryIntegrity {
    validateNotificationGapId(id)
    if (!Number.isSafeInteger(now) || now < 0) throw Error('通知缺口观察时间无效')
    return this.transaction(() => {
      const result = this.db.prepare('INSERT OR IGNORE INTO desktop_notification_gap_keys VALUES(?)').run(id)
      if (result.changes) this.db.prepare('UPDATE desktop_notification_integrity SET revision=revision+1,latest_gap_id=?,observed_at=? WHERE id=1').run(id, now)
      return this.historyGap().integrity
    })
  }
  acknowledgeHistoryGap(revision: number, now: number): NotificationHistoryIntegrity {
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw Error('通知说明确认时间无效')
    return this.transaction(() => {
      const { integrity } = this.historyGap()
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > integrity.revision) throw new NotificationActionError('历史说明版本已变化，请刷新后确认')
      if (revision > integrity.acknowledgedRevision) this.db.prepare('UPDATE desktop_notification_integrity SET acknowledged_revision=?,acknowledged_at=? WHERE id=1').run(revision, now)
      return this.historyGap().integrity
    })
  }
  preferences(): NotificationPreferences {
    return normalizeNotificationPreferences(JSON.parse((this.db.prepare('SELECT preferences FROM desktop_notification_meta WHERE id=1').get() as { preferences: string }).preferences))
  }
  savePreferences(input: unknown): NotificationPreferences {
    const preferences = normalizeNotificationPreferences(input)
    this.db.prepare('UPDATE desktop_notification_meta SET preferences=? WHERE id=1').run(JSON.stringify(preferences))
    return preferences
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }
}
