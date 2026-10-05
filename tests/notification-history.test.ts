import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { NOTIFICATION_ROUTINE_RETENTION_MS, notificationHistoryNeedsAcknowledgement } from '../src/domain/notification-history'
import { notificationContentSignature, type NotificationDraft } from '../src/domain/notification'
import { notificationSourceHarness } from './notification-source-fixtures'
import { NotificationRuntimeJournal } from '../src/infrastructure/notifications/runtime-journal'

const one = '11111111-1111-4111-8111-111111111111', two = '22222222-2222-4222-8222-222222222222'
const old = 1_000, later = old + NOTIFICATION_ROUTINE_RETENTION_MS + 1_000
const draft = (key: string, patch: Partial<NotificationDraft> = {}): NotificationDraft => ({ key, category: 'run', source: '原入口', title: '已确认的普通结果', tone: 'success',
  attention: 'notice', state: 'resolved', scope: {}, occurredAt: old, sourceRevision: 1, ...patch })
describe('safe routine history retention', () => {
  it('protects unread, active, diagnostics, prior actions, archived-unread and recent reading; normal read/activity age out', () => {
    const ledger = new SqliteNotificationRepository(':memory:')
    const save = (value: NotificationDraft, read = false, at = old) => { const record = ledger.put(value, at).record!; if (read) ledger.read(record.id, record.revision, at); return record }
    try {
      save(draft('read'), true); save(draft('activity', { attention: 'activity' }))
      save(draft('unread')); save(draft('active', { state: 'active' }), true)
      save(draft('diagnostic', { tone: 'warning' }), true)
      const action = save(draft('action', { attention: 'action', state: 'active' }), true)
      ledger.put(draft('action', { sourceRevision: 2, attention: 'notice', tone: 'success' }), old + 1); ledger.read(action.id, ledger.page({ key: 'action' }).records[0]!.revision, old + 1)
      const recovered = save(draft('recovered-diagnostic', { tone: 'error' }), true)
      ledger.put(draft('recovered-diagnostic', { sourceRevision: 2 }), old + 1); ledger.read(recovered.id, ledger.page({ key: 'recovered-diagnostic' }).records[0]!.revision, old + 1)
      const archived = save(draft('archived-unread')); ledger.archive(archived.id, old)
      const recent = save(draft('recent-read')); ledger.read(recent.id, recent.revision, later - 1)
      const result = ledger.pruneRoutine(later)
      expect(result.removed).toBe(2); expect(result.summary.unread).toBe(1)
      expect(ledger.marker('read').cleared).toBe(true); expect(ledger.marker('activity').cleared).toBe(true)
      for (const key of ['unread','active','diagnostic','action','recovered-diagnostic','archived-unread','recent-read']) expect(ledger.marker(key).cleared).not.toBe(true)
      expect(ledger.page({ key: 'action' }).records[0]?.retentionProtected).toBe(true)
    } finally { ledger.close() }
  })
  it('uses bounded batches, preserves scope queries and cursor invalidation; same content cannot resurrect a pruned record', () => {
    const ledger = new SqliteNotificationRepository(':memory:')
    try {
      for (let i = 0; i < 205; i++) ledger.put(draft(`activity:${i}`, { attention: 'activity', scope: { workspaceId: 'one' } }), old)
      const page = ledger.page({ workspaceId: 'one', limit: 20 })
      expect(ledger.pruneRoutine(later)).toMatchObject({ removed: 100, more: true }); expect(ledger.page({ cursor: page.nextCursor! }).reset).toBe(true)
      expect(ledger.pruneRoutine(later)).toMatchObject({ removed: 100, more: true }); expect(ledger.pruneRoutine(later)).toMatchObject({ removed: 5, more: false })
      expect(ledger.put(draft('activity:0', { attention: 'activity', scope: { workspaceId: 'one' }, sourceRevision: 99 }), later).changed).toBe(false)
      expect(ledger.put(draft('activity:0', { attention: 'notice', tone: 'warning', title: '同一来源出现新的明确故障', sourceRevision: 100 }), later).changed).toBe(true)
      expect(ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
    } finally { ledger.close() }
  })
  it('migration preserves legacy unknown importance, original source/read state and unrelated schema, even after repeated reopen', () => {
    const folder = mkdtempSync(join(tmpdir(), 'sg-retention-migration-')), path = join(folder, 'ledger.sqlite')
    try {
      const original = new SqliteNotificationRepository(path), record = original.put(draft('legacy'), old).record!
      original.read(record.id, record.revision, old); original.close()
      const db = new DatabaseSync(path)
      db.exec("UPDATE desktop_notification_meta SET schema_version=3; UPDATE desktop_notifications SET payload=json_remove(payload,'$.retentionProtected'); CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES('safe'); PRAGMA user_version=19;"); db.close()
      for (let i = 0; i < 2; i++) { const restored = new SqliteNotificationRepository(path); expect(restored.pruneRoutine(later).removed).toBe(0); expect(restored.page().records[0]).toMatchObject({ id: record.id, retentionProtected: true, readRevision: record.revision }); restored.close() }
      const check = new DatabaseSync(path); expect(check.prepare('SELECT value FROM preserve').get()!.value).toBe('safe'); expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(19); check.close()
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })
})

describe('gap facts, acknowledgement and quit identities remain independent', () => {
  it('coalesces exact durable identities; old/future acknowledgements cannot dismiss a newer gap or read business notifications', () => {
    const ledger = new SqliteNotificationRepository(':memory:')
    try {
      ledger.put(draft('important', { attention: 'action', state: 'active' }), old)
      expect(ledger.recordHistoryGap(one, old)).toMatchObject({ revision: 1, acknowledgedRevision: 0 })
      expect(ledger.recordHistoryGap(one, later).revision).toBe(1)
      expect(ledger.recordHistoryGap(two, later).revision).toBe(2)
      expect(notificationHistoryNeedsAcknowledgement(ledger.acknowledgeHistoryGap(1, later))).toBe(true)
      expect(() => ledger.acknowledgeHistoryGap(3, later)).toThrow('版本')
      const integrity = ledger.acknowledgeHistoryGap(2, later); expect(notificationHistoryNeedsAcknowledgement(integrity)).toBe(false)
      expect(integrity.revision).toBe(2); expect(ledger.page().summary).toMatchObject({ unread: 1, pending: 1 })
      ledger.clearRead({}, later); expect(ledger.historyGap().integrity).toEqual(integrity)
    } finally { ledger.close() }
  })
  it('a gap observed while acknowledgement is in flight is a new episode, not swallowed by its late old receipt', async () => {
    const h = notificationSourceHarness()
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    const { NotificationHistoryController } = await import('../src/application/notifications/history-controller')
    const controller = new NotificationHistoryController({ historyGap: h.port.historyGap!, recordHistoryGap: h.port.recordHistoryGap!,
      acknowledgeHistoryGap: async (revision, at) => { const result = h.ledger.acknowledgeHistoryGap(revision, at); await gate; return result }, pruneRoutine: h.port.pruneRoutine! },
      { state: () => {}, changed: () => {}, failed: () => {} }, () => old)
    try {
      controller.report(one); await controller.flush(); const shown = h.ledger.historyGap().integrity.revision
      const acknowledging = controller.acknowledge(shown)
      controller.report(); await controller.flush(); expect(h.ledger.historyGap().integrity.revision).toBe(shown + 1)
      release(); await acknowledging
      expect(notificationHistoryNeedsAcknowledgement(controller.state().integrity)).toBe(true)
      expect(h.ledger.page().summary.unread).toBe(0)
    } finally { release(); await controller.close(); await h.owner.close() }
  })
  it('unknown gap writes are audited by exact key before retry, never duplicated; failed acknowledgement stays pending', async () => {
    const h = notificationSourceHarness()
    try {
      const { NotificationHistoryController } = await import('../src/application/notifications/history-controller')
      const failure = vi.fn(), write = vi.fn(async (id: string, at: number) => { const result = h.ledger.recordHistoryGap(id, at); if (write.mock.calls.length === 1) throw Error('ack lost'); return result })
      const controller = new NotificationHistoryController({ historyGap: h.port.historyGap!, recordHistoryGap: write,
        acknowledgeHistoryGap: async () => { throw Error('not acknowledged') }, pruneRoutine: h.port.pruneRoutine! }, { state: () => {}, changed: () => {}, failed: failure }, () => old)
      controller.report(one); await controller.flush(); expect(controller.state().unconfirmed).toBe(true)
      controller.retry(true); await controller.flush(); expect(write).toHaveBeenCalledOnce(); expect(controller.state().unconfirmed).toBe(false)
      await expect(controller.acknowledge(1)).rejects.toThrow(); expect(notificationHistoryNeedsAcknowledgement(controller.state().integrity)).toBe(true)
      await controller.close()
    } finally { await h.owner.close() }
  })
  it('clean restarts retain one acknowledged historical fact; a later forced exit creates a new exact identity', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sg-history-journal-')), path = join(folder, 'runtime.json'), ledgerPath = join(folder, 'ledger.sqlite')
    try {
      const first = new NotificationRuntimeJournal(path, () => old); first.open()
      const second = new NotificationRuntimeJournal(path, () => old + 1), recovered = second.open()
      const h = notificationSourceHarness(ledgerPath); h.owner.reportHistoryGap(recovered.gapId); await h.owner.flush()
      const integrity = h.ledger.historyGap().integrity; await h.owner.acknowledgeHistoryGap(integrity.revision)
      second.finish(true, true, h.owner.status().historyGapId); await h.owner.close()
      const third = new NotificationRuntimeJournal(path, () => old + 2), repeat = third.open()
      expect(repeat.gapId).toBe(recovered.gapId)
      const next = notificationSourceHarness(ledgerPath); next.owner.reportHistoryGap(repeat.gapId); await next.owner.flush()
      expect(next.ledger.historyGap().integrity).toMatchObject({ revision: 1, acknowledgedRevision: 1 }); expect(next.owner.status().historyIncomplete).toBe(true)
      third.finish(false, true, next.owner.status().historyGapId); await next.owner.close()
      const fourth = new NotificationRuntimeJournal(path, () => old + 3).open(); expect(fourth.gapId).not.toBe(recovered.gapId)
      const final = notificationSourceHarness(ledgerPath); final.owner.reportHistoryGap(fourth.gapId); await final.owner.flush()
      expect(final.ledger.historyGap().integrity).toMatchObject({ revision: 2, acknowledgedRevision: 1 }); await final.owner.close()
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })
})

describe('private upkeep scheduling and opaque tombstones', () => {
  it('retention starts off the startup path, yields between batches and stops its timer on seal', async () => {
    vi.useFakeTimers()
    try {
      const { NotificationHistoryController } = await import('../src/application/notifications/history-controller')
      const changed = vi.fn(), failed = vi.fn(), summary = { revision: 1, total: 0, unread: 0, pending: 0, clearable: 0 }
      const prune = vi.fn().mockResolvedValueOnce({ changed: true, removed: 100, more: true, summary }).mockResolvedValue({ changed: false, removed: 0, more: false, summary })
      const controller = new NotificationHistoryController({ historyGap: async () => ({ integrity: { revision: 0, acknowledgedRevision: 0 } }),
        recordHistoryGap: vi.fn(), acknowledgeHistoryGap: vi.fn(), pruneRoutine: prune }, { state: () => {}, changed, failed })
      await vi.advanceTimersByTimeAsync(29_999); expect(prune).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1); expect(prune).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(249); expect(prune).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1); expect(prune).toHaveBeenCalledTimes(2)
      await controller.close(); await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1_000)
      expect(prune).toHaveBeenCalledTimes(2); expect(failed).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('clearing/pruning keeps only an opaque dedupe fingerprint, not a second retained copy of the body', () => {
    const ledger = new SqliteNotificationRepository(':memory:'), db = Reflect.get(ledger, 'db') as DatabaseSync
    try {
      const body = 'This deliberately unique ordinary summary must not remain in the dedupe tombstone'
      const record = ledger.put(draft('private:body', { detail: body }), old).record!; ledger.read(record.id, record.revision, old)
      ledger.pruneRoutine(later)
      const tombstone = db.prepare('SELECT content_signature FROM desktop_notification_tombstones WHERE semantic_key=?').get('private:body')!.content_signature as string
      expect(tombstone).toMatch(/^sha256:[a-f0-9]{64}$/); expect(tombstone).not.toContain(body)
      expect(ledger.marker('private:body').signature).toBe(tombstone)
    } finally { ledger.close() }
  })
  it('old plaintext tombstones migrate once without resurrecting their already-cleared history', () => {
    const folder = mkdtempSync(join(tmpdir(), 'sg-tombstone-migration-')), path = join(folder, 'ledger.sqlite')
    try {
      const input = draft('legacy:cleared', { detail: 'old retained summary' }), original = new SqliteNotificationRepository(path)
      const record = original.put(input, old).record!; original.read(record.id, record.revision, old); original.clearRead({}, old); original.close()
      const db = new DatabaseSync(path); db.prepare('UPDATE desktop_notification_tombstones SET content_signature=?').run(notificationContentSignature(input)); db.exec('UPDATE desktop_notification_meta SET schema_version=3'); db.close()
      const restored = new SqliteNotificationRepository(path)
      expect(restored.marker(input.key).signature).toMatch(/^sha256:/)
      expect(restored.put({ ...input, sourceRevision: 99 }, later).changed).toBe(false); expect(restored.page().summary.total).toBe(0); restored.close()
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })
})

describe('integrity corruption and confirmation boundaries fail closed', () => {
  it('missing v4 gap evidence is not reconstructed as an empty clean history', () => {
    const folder = mkdtempSync(join(tmpdir(), 'sg-gap-corruption-')), path = join(folder, 'ledger.sqlite')
    try {
      const original = new SqliteNotificationRepository(path); original.recordHistoryGap(one, old); original.put(draft('preserve'), old); original.close()
      const db = new DatabaseSync(path); db.exec('DROP TABLE desktop_notification_gap_keys'); db.close()
      expect(() => new SqliteNotificationRepository(path)).toThrow('结构异常')
      const check = new DatabaseSync(path)
      expect(check.prepare('SELECT revision FROM desktop_notification_integrity').get()!.revision).toBe(1)
      expect(check.prepare('SELECT COUNT(*) AS n FROM desktop_notifications').get()!.n).toBe(1)
      expect(check.prepare("SELECT 1 FROM sqlite_master WHERE name='desktop_notification_gap_keys'").get()).toBeUndefined(); check.close()
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })
  it('a corrupt eligible row rolls the entire retention batch back, including earlier valid candidates and tombstones', () => {
    const ledger = new SqliteNotificationRepository(':memory:'), db = Reflect.get(ledger, 'db') as DatabaseSync
    try {
      ledger.put(draft('first', { attention: 'activity' }), old); ledger.put(draft('second', { attention: 'activity' }), old)
      db.exec("UPDATE desktop_notifications SET payload=json_set(payload,'$.id',123) WHERE semantic_key='second'")
      expect(() => ledger.pruneRoutine(later)).toThrow('格式异常')
      expect(ledger.marker('first').cleared).not.toBe(true); expect(db.prepare('SELECT COUNT(*) AS n FROM desktop_notifications').get()!.n).toBe(2)
      expect(db.prepare('SELECT COUNT(*) AS n FROM desktop_notification_tombstones').get()!.n).toBe(0)
    } finally { ledger.close() }
  })
  it('invalid acknowledgement does not split an existing loss episode or generate another durable notice', async () => {
    const h = notificationSourceHarness()
    try {
      h.owner.reportHistoryGap(); await h.owner.flush()
      await expect(h.owner.acknowledgeHistoryGap(0)).rejects.toThrow('版本')
      h.owner.reportHistoryGap(); await h.owner.flush(); expect(h.ledger.historyGap().integrity.revision).toBe(1)
    } finally { await h.owner.close() }
  })
})
