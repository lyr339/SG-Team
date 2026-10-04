import { describe, expect, it, vi } from 'vitest'
import type { AppUpdateService } from '../src/application/app-update-service'
import { connectAppUpdateNotifications } from '../src/application/notifications/app-update-notifications'
import { NotificationService } from '../src/application/notification-service'
import type { NotificationRepository } from '../src/application/notification-repository'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { appUpdateNotification } from '../src/domain/app-update-notification'
import type { AppUpdateStatus } from '../src/domain/app-update'

describe('update source connected to the durable owner', () => {
  function harness() {
    const ledger = new SqliteNotificationRepository(':memory:')
    const port: NotificationRepository = { marker: async key => ledger.marker(key), sourceState: async key => ledger.sourceState(key), commitSource: async (key, expected, data, drafts, now) => ledger.commitSource(key, expected, data, drafts, now),
      put: async (draft, now) => ledger.put(draft, now), page: async query => ledger.page(query),
      read: async (id, revision, now) => ledger.read(id, revision, now), readAll: async (query, revision, now) => ledger.readAll(query, revision, now), archive: async (id, now) => ledger.archive(id, now),
      clearRead: async (query, now) => ledger.clearRead(query, now), preferences: async () => ledger.preferences(), savePreferences: async value => ledger.savePreferences(value), close: async () => ledger.close() }
    const service = new NotificationService(port)
    let current: AppUpdateStatus = { currentVersion: '0.5.15', state: { phase: 'idle' }, settings: { autoCheck: true, checkIntervalHours: 6 }, launchedAfterUpdate: false, releaseUrl: 'https://github.com/lyr339/SG-Team/releases' }
    let listener!: (status: AppUpdateStatus) => void
    const unsubscribe = vi.fn()
    const updates = { getStatus: vi.fn(() => current), onChange: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe }) }
    return { ledger, service, updates, unsubscribe, emit: (status: AppUpdateStatus) => { current = status; listener(status) }, current: () => current }
  }
  it('expires already installed version notices on startup without creating another check or replay', async () => {
    const h = harness()
    const state = { ...h.current(), currentVersion: '0.4.0', reminderVersion: '0.5.0', state: { phase: 'available' as const, release: { version: '0.5.0', releaseUrl: 'https://github.com/lyr339/SG-Team/releases' }, checkedAt: 1 } }
    h.ledger.put({ ...appUpdateNotification(state, false)!, sourceRevision: 1 }, 2)
    const stop = connectAppUpdateNotifications(h.updates as unknown as AppUpdateService, h.service)
    await vi.waitFor(() => expect(h.ledger.page().records[0]?.state).toBe('expired'))
    expect(h.ledger.page().summary.unread).toBe(0); stop(); await h.service.close()
  })
  it('uses already published status and does not re-read files or spam receipts on percent updates', async () => {
    const h = harness(); const stop = connectAppUpdateNotifications(h.updates as unknown as AppUpdateService, h.service)
    const release = { version: '0.6.0', releaseUrl: 'https://github.com/lyr339/SG-Team/releases' }
    await Promise.resolve(); await Promise.resolve()
    h.emit({ ...h.current(), state: { phase: 'available', release, checkedAt: 100 }, reminderVersion: '0.6.0' }); await h.service.flush()
    const revision = h.ledger.page().summary.revision; const reads = h.updates.getStatus.mock.calls.length
    for (let bytes = 0; bytes < 5; bytes++) h.emit({ ...h.current(), state: { phase: 'downloading', release, receivedBytes: bytes, totalBytes: 10, startedAt: 100 } })
    await h.service.flush()
    expect(h.ledger.page().summary.revision).toBe(revision); expect(h.updates.getStatus.mock.calls.length).toBe(reads)
    stop(); expect(h.unsubscribe).toHaveBeenCalledOnce(); await h.service.close()
  })
})
