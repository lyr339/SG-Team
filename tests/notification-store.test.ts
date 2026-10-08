import { describe, expect, it, vi } from 'vitest'
import { NotificationStore, type NotificationApi } from '../src/renderer/src/notifications/notification-store'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPage, type NotificationPush, type NotificationRecord } from '../src/domain/notification'

const summary = (revision: number) => ({ revision, total: 1, unread: 1, pending: 0, clearable: 0 })
const record: NotificationRecord = { id: 'n1', key: 'test', category: 'automation', source: '自动化', title: '自动化已完成', scope: {}, tone: 'success', attention: 'notice', state: 'resolved',
  occurredAt: 100, createdAt: 100, updatedAt: 100, revision: 2, sourceRevision: 2, readRevision: 0, attentionRevision: 2 }
function harness() {
  let push!: (event: NotificationPush) => void; const unsubscribe = vi.fn()
  const api: NotificationApi = { getNotificationPage: vi.fn(async () => ({ records: [], summary: summary(0), reset: false })),
    getNotificationPreferences: vi.fn(async () => DEFAULT_NOTIFICATION_PREFERENCES), saveNotificationPreferences: vi.fn(async value => value),
    onNotificationChanged: vi.fn(callback => { push = callback; return unsubscribe }), readNotification: vi.fn(), readAllNotifications: vi.fn(), archiveNotification: vi.fn(), clearReadNotifications: vi.fn() }
  return { api, push: (event: NotificationPush) => push(event), unsubscribe, store: new NotificationStore(api, () => 200) }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
describe('notification renderer store', () => {
  it('serializes field edits across views, rebasing each on confirmed preferences and recovering from a failed write', async () => {
    const h = harness(), release = h.store.acquire(); await flush()
    let reject!: (reason: Error) => void
    vi.mocked(h.api.saveNotificationPreferences).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const first = h.store.updatePreferences(current => ({ ...current, quiet: true }))
    const rejected = expect(first).rejects.toThrow('disk full')
    const second = h.store.updatePreferences(current => ({ ...current, nativeEnabled: true }))
    const third = h.store.updatePreferences(current => ({ ...current, preview: true }))
    await flush(); expect(h.api.saveNotificationPreferences).toHaveBeenCalledTimes(1)
    reject(Error('disk full')); await rejected; await Promise.all([second, third])
    expect(h.store.snapshot().preferences).toMatchObject({ quiet: false, nativeEnabled: true, preview: true })
    expect(vi.mocked(h.api.saveNotificationPreferences).mock.calls[2]![0]).toMatchObject({ nativeEnabled: true, preview: true })
    release()
  })
  it('a proven new private generation accepts a lower summary, but neither an old generation nor a late same-generation reload can rewind it', async () => {
    const h = harness(), release = h.store.acquire(); await flush()
    h.push({ storageEpoch: 0, change: { changed: true, record, summary: summary(100) }, health: 'ready', historyIncomplete: false })
    h.push({ storageEpoch: 1, historyReload: true, change: { changed: false, summary: summary(2) }, health: 'ready', historyIncomplete: true })
    expect(h.store.snapshot().summary.revision).toBe(2)
    h.push({ storageEpoch: 1, change: { changed: true, record: { ...record, storageEpoch: 1, revision: 3 }, summary: summary(3) }, health: 'ready', historyIncomplete: true })
    h.push({ storageEpoch: 1, historyReload: true, change: { changed: false, summary: summary(2) }, health: 'ready', historyIncomplete: true })
    h.push({ storageEpoch: 0, change: { changed: true, record, summary: summary(200) }, health: 'ready', historyIncomplete: false })
    expect(h.store.snapshot().summary.revision).toBe(3); release()
  })
  it('a late same-generation recovery page cannot overwrite a newer history-gap acknowledgement or request a redundant history reload', async () => {
    const h = harness(), release = h.store.acquire(); await flush(); const subscriber = vi.fn(); h.store.subscribe(subscriber)
    const integrity = { revision: 2, acknowledgedRevision: 2, latestGapId: '11111111-1111-4111-8111-111111111111', observedAt: 1, acknowledgedAt: 2 }
    h.push({ storageEpoch: 1, change: { changed: true, summary: summary(5) }, health: 'ready', historyIncomplete: true, historyIntegrity: integrity, historyGapUnconfirmed: false })
    h.push({ storageEpoch: 1, historyReload: true, change: { changed: false, summary: summary(2) }, health: 'ready', historyIncomplete: true,
      historyIntegrity: { ...integrity, revision: 1, acknowledgedRevision: 0 }, historyGapUnconfirmed: true })
    expect(h.store.snapshot().historyGapUnconfirmed).toBe(false); expect(h.store.snapshot().historyIntegrity).toEqual(integrity)
    expect(subscriber).toHaveBeenLastCalledWith(expect.objectContaining({ historyReload: undefined, change: undefined })); release()
  })
  it('a stale initial pull cannot overwrite live delivery health or a newer native open request', async () => {
    const h = harness(); let resolve!: (value: NotificationPage) => void
    vi.mocked(h.api.getNotificationPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const release = h.store.acquire()
    const openRequested = { token: 'new-open', key: 'current-key', recordId: 'current-record', revision: 2 }
    h.push({ health: 'ready', historyIncomplete: false, delivery: { nativeSupported: true, state: 'failed', message: 'actual failure' }, openRequested })
    resolve({ records: [], summary: summary(0), reset: false, delivery: { nativeSupported: true, state: 'ready' }, openRequested: { ...openRequested, token: 'old-open', recordId: 'old-record' } }); await flush()
    expect(h.store.snapshot().delivery?.state).toBe('failed'); expect(h.store.snapshot().openRequested).toEqual(openRequested)
    release()
  })
  it('cannot roll back a new push with an older initial pull or replay history as a toast', async () => {
    const h = harness(); let resolve!: (value: NotificationPage) => void
    vi.mocked(h.api.getNotificationPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const release = h.store.acquire()
    h.push({ change: { changed: true, record, summary: summary(2) }, health: 'ready', historyIncomplete: false, announcement: { id: 'n1:2', expiresAt: 1_000 } })
    resolve({ records: [record], summary: summary(1), reset: false }); await flush()
    expect(h.store.snapshot().summary.revision).toBe(2); expect(h.store.snapshot().toasts).toHaveLength(1)
    release(); expect(h.unsubscribe).toHaveBeenCalledOnce()
  })
  it('deduplicates live announcements, ignores expired and activity records and does not mark dismissal read', async () => {
    const h = harness(); const release = h.store.acquire(); await flush()
    const event: NotificationPush = { change: { changed: true, record, summary: summary(2) }, health: 'ready', historyIncomplete: false, announcement: { id: 'n1:2', expiresAt: 1_000 } }
    h.push(event); h.push(event); expect(h.store.snapshot().toasts).toHaveLength(1)
    h.store.dismissToast('n1:2'); expect(h.api.readNotification).not.toHaveBeenCalled()
    h.push({ ...event, announcement: { id: 'expired', expiresAt: 100 } }); expect(h.store.snapshot().toasts).toHaveLength(0)
    release()
  })
  it('shares one subscription, cleans it up once and ignores late replies after release', async () => {
    const h = harness(); let resolve!: (value: NotificationPage) => void
    vi.mocked(h.api.getNotificationPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const a = h.store.acquire(); const b = h.store.acquire()
    expect(h.api.onNotificationChanged).toHaveBeenCalledTimes(1); a(); a(); expect(h.unsubscribe).not.toHaveBeenCalled()
    b(); resolve({ records: [], summary: summary(4), reset: false }); await flush()
    expect(h.store.snapshot().summary.revision).toBe(-1); expect(h.unsubscribe).toHaveBeenCalledOnce()
  })
  it('does not overwrite a pushed preference with a stale preference pull', async () => {
    const h = harness(); let resolve!: (value: typeof DEFAULT_NOTIFICATION_PREFERENCES) => void
    vi.mocked(h.api.getNotificationPreferences).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const release = h.store.acquire()
    h.push({ preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, quiet: true }, health: 'ready', historyIncomplete: false })
    resolve(DEFAULT_NOTIFICATION_PREFERENCES); await flush(); expect(h.store.snapshot().preferences.quiet).toBe(true); release()
  })
  it('does not forward a stale change into center or read-style subscribers', async () => {
    const h = harness(); const release = h.store.acquire(); await flush()
    const subscriber = vi.fn(); h.store.subscribe(subscriber)
    h.push({ change: { changed: true, record: { ...record, readRevision: 2 }, summary: summary(3) }, health: 'ready', historyIncomplete: false })
    h.push({ change: { changed: true, record, summary: summary(2) }, health: 'ready', historyIncomplete: false })
    expect(subscriber).toHaveBeenLastCalledWith(expect.objectContaining({ change: undefined }))
    expect(h.store.snapshot().summary.revision).toBe(3); release()
  })
})
