import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { NotificationChange, NotificationDraft, NotificationMarker, NotificationPage, NotificationPreferences, NotificationQuery, NotificationRecord, NotificationSummary, NotificationSourceResult, NotificationSourceState } from '../../domain/notification'
import { normalizeNotificationPreferences, notificationContentSignature, notificationIsPending, notificationSafeText, NotificationActionError, validateNotificationDraft, NOTIFICATION_SOURCE_BATCH_LIMIT, NOTIFICATION_SOURCE_PAYLOAD_LIMIT } from '../../domain/notification'
import { NOTIFICATION_ROUTINE_RETENTION_MS, validateNotificationGapId, validateNotificationIntegrity, type NotificationHistoryIntegrity, type NotificationHistoryStatus } from '../../domain/notification-history'
import { notificationFingerprint, fingerprintSignature } from '../../application/notification-fingerprint'

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
  private closed = false
  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
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
      } else if (![2, 3, 4].includes(version)) throw new Error('通知历史格式暂不支持，原有数据未修改')
      if (version === 4) {
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
        if (version !== 4) {
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
      this.historyGap() // Invalid v4 integrity never silently becomes a fresh, clean ledger.
    } catch (error) { this.db.close(); throw error }
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
  commitSource(key: string, expectedRevision: number, data: unknown, drafts: NotificationDraft[], now: number): NotificationSourceResult {
    if (!key || key.length > 300 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || drafts.length > NOTIFICATION_SOURCE_BATCH_LIMIT) throw new Error('通知来源提交无效')
    const payload = JSON.stringify(data)
    if (!payload || Buffer.byteLength(payload, 'utf8') > NOTIFICATION_SOURCE_PAYLOAD_LIMIT) throw new Error('通知来源状态过大或无效')
    for (const draft of drafts) validateNotificationDraft(draft)
    return this.transaction(() => {
      const source = this.sourceState(key)
      if (source.revision !== expectedRevision) return { applied: false, source, changes: [] }
      const changes = drafts.map(draft => this.putInTransaction(draft, now))
      const revision = expectedRevision + 1
      this.db.prepare(`INSERT INTO desktop_notification_sources VALUES(?,?,?,?) ON CONFLICT(source_key)
        DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at`).run(key, revision, payload, now)
      return { applied: true, source: { revision, data }, changes }
    })
  }
  page(query: NotificationQuery = {}): NotificationPage {
    const summary = this.summary(query)
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
