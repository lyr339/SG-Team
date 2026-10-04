import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { NotificationChange, NotificationDraft, NotificationPage, NotificationPreferences, NotificationQuery, NotificationRecord, NotificationSummary } from '../../domain/notification'
import { normalizeNotificationPreferences, notificationContentSignature, notificationIsPending, notificationSafeText, NotificationActionError, validateNotificationDraft } from '../../domain/notification'

type StoredRow = { payload: string }

/** Synchronous on purpose: this repository is owned ONLY by the notification worker. */
export class SqliteNotificationRepository {
  private readonly db: DatabaseSync
  private closed = false
  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    try {
      this.db.exec(`PRAGMA busy_timeout=250;
        CREATE TABLE IF NOT EXISTS desktop_notification_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, preferences TEXT NOT NULL,schema_version INTEGER NOT NULL DEFAULT 1);
        INSERT OR IGNORE INTO desktop_notification_meta(id,revision,preferences) VALUES(1,0,'{}');
        CREATE TABLE IF NOT EXISTS desktop_notifications (
          id TEXT PRIMARY KEY, semantic_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
          workspace_id TEXT, category TEXT NOT NULL, attention TEXT NOT NULL, state TEXT NOT NULL,
          revision INTEGER NOT NULL, attention_revision INTEGER NOT NULL, read_revision INTEGER NOT NULL,
          archived_at INTEGER, source_revision INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS desktop_notifications_scope ON desktop_notifications(workspace_id,revision DESC);
        CREATE INDEX IF NOT EXISTS desktop_notifications_order ON desktop_notifications(revision DESC);
        CREATE TABLE IF NOT EXISTS desktop_notification_tombstones (semantic_key TEXT PRIMARY KEY, source_revision INTEGER NOT NULL, cleared_at INTEGER NOT NULL);`)
      const version = (this.db.prepare('SELECT schema_version FROM desktop_notification_meta WHERE id=1').get() as { schema_version: number }).schema_version
      if (version !== 1) throw new Error('通知历史格式暂不支持，原有数据未修改')
    } catch (error) { this.db.close(); throw error }
  }

  private revision(): number {
    return Number((this.db.prepare('SELECT revision FROM desktop_notification_meta WHERE id=1').get() as { revision: number }).revision)
  }
  private nextRevision(): number {
    this.db.prepare('UPDATE desktop_notification_meta SET revision=revision+1 WHERE id=1').run()
    return this.revision()
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { try { this.db.exec('ROLLBACK') } catch { /* Preserve the original commit/storage failure. */ } throw error }
  }
  private where(query: NotificationQuery, filter = query.filter): { sql: string; params: Array<string | number> } {
    const clauses = ['archived_at IS NULL']; const params: Array<string | number> = []
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
    return { revision: this.revision(), total: count(), unread: count('unread'), pending: count('pending') }
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
    return row ? JSON.parse(row.payload) as NotificationRecord : undefined
  }

  put(draft: NotificationDraft, now: number): NotificationChange {
    validateNotificationDraft(draft)
    draft = { ...draft, title: notificationSafeText(draft.title), source: notificationSafeText(draft.source),
      ...(draft.detail !== undefined ? { detail: notificationSafeText(draft.detail) } : {}) }
    return this.transaction(() => {
      const oldRow = this.db.prepare('SELECT payload FROM desktop_notifications WHERE semantic_key=?').get(draft.key) as StoredRow | undefined
      const old = oldRow ? JSON.parse(oldRow.payload) as NotificationRecord : undefined
      const tombstone = this.db.prepare('SELECT source_revision FROM desktop_notification_tombstones WHERE semantic_key=?').get(draft.key) as { source_revision: number } | undefined
      if ((!old && tombstone && draft.sourceRevision <= tombstone.source_revision) || (old && draft.sourceRevision <= old.sourceRevision)) {
        return { changed: false, record: old, summary: this.summary() }
      }
      if (old && notificationContentSignature(old) === notificationContentSignature(draft)) {
        old.sourceRevision = draft.sourceRevision
        this.save(old)
        return { changed: false, record: old, summary: this.summary() }
      }
      const revision = this.nextRevision()
      const { renewAttention, ...content } = draft
      const escalated = old && (old.attention === 'activity' && draft.attention !== 'activity'
        || draft.attention === 'action' && draft.state === 'active' && !notificationIsPending(old))
      const attentionRevision = draft.attention === 'activity' ? 0 : !old || renewAttention || escalated ? revision : old.attentionRevision
      const record: NotificationRecord = {
        ...content, id: old?.id ?? randomUUID(), createdAt: old?.createdAt ?? now, updatedAt: now, revision, attentionRevision,
        readRevision: old?.readRevision ?? 0, ...(old?.readAt !== undefined ? { readAt: old.readAt } : {}),
        ...(old?.archivedAt !== undefined && !renewAttention && !escalated ? { archivedAt: old.archivedAt } : {})
      }
      this.save(record)
      if (tombstone) this.db.prepare('DELETE FROM desktop_notification_tombstones WHERE semantic_key=?').run(draft.key)
      return { changed: true, record, summary: this.summary() }
    })
  }
  page(query: NotificationQuery = {}): NotificationPage {
    const summary = this.summary(query)
    const reset = query.cursor !== undefined && query.cursor.revision !== summary.revision
    const offset = reset ? 0 : Math.max(0, Math.floor(query.cursor?.offset ?? 0))
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 40)))
    const where = this.where(query)
    const rows = this.db.prepare(`SELECT payload FROM desktop_notifications WHERE ${where.sql}
      ORDER BY CASE WHEN attention='action' AND state='active' THEN 0 ELSE 1 END,revision DESC LIMIT ? OFFSET ?`).all(...where.params, limit + 1, offset) as StoredRow[]
    return { records: rows.slice(0, limit).map(row => JSON.parse(row.payload) as NotificationRecord), summary, reset,
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
        for (const row of rows) { const record = JSON.parse(row.payload) as NotificationRecord; record.readRevision = record.attentionRevision; record.readAt = now; this.save(record) }
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
        const record = JSON.parse(row.payload) as NotificationRecord
        this.db.prepare(`INSERT INTO desktop_notification_tombstones VALUES(?,?,?) ON CONFLICT(semantic_key)
          DO UPDATE SET source_revision=MAX(source_revision,excluded.source_revision),cleared_at=excluded.cleared_at`).run(record.key, record.sourceRevision, now)
        this.db.prepare('DELETE FROM desktop_notifications WHERE id=?').run(record.id)
      }
      if (rows.length) this.nextRevision()
      return { changed: rows.length > 0, summary: this.summary() }
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
