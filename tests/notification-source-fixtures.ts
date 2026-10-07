import { vi } from 'vitest'
import { NotificationService } from '../src/application/notification-service'
import type { NotificationRepository, NotificationRepositoryLifecycle } from '../src/application/notification-repository'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
export { notificationTeam, notificationSession, notificationFrame } from '../scripts/fixtures/notification-session-data'

export function notificationSourceHarness(path = ':memory:', subscribeLifecycle?: (listener: (event: NotificationRepositoryLifecycle) => void) => () => void) {
  const ledger = new SqliteNotificationRepository(path)
  const port: NotificationRepository = {
    ...(subscribeLifecycle ? { subscribeLifecycle } : {}),
    historyGap: async id => ledger.historyGap(id), recordHistoryGap: async (id, now) => ledger.recordHistoryGap(id, now),
    acknowledgeHistoryGap: async (revision, now) => ledger.acknowledgeHistoryGap(revision, now), pruneRoutine: async now => ledger.pruneRoutine(now),
    marker: async key => ledger.marker(key), sourceState: vi.fn(async key => ledger.sourceState(key)),
    listNativeSources: vi.fn(async query => ledger.listNativeSources(query)),
    operatorMessageRecords: vi.fn(async keys => ledger.operatorMessageRecords(keys)),
    mcpWriteRecords: vi.fn(async keys => ledger.mcpWriteRecords(keys)),
    replyIdentities: vi.fn(async (key, aliases) => ledger.replyIdentities(key, aliases)),
    questionTerminals: vi.fn(async (key, identities) => ledger.questionTerminals(key, identities)),
    claimDelivery: vi.fn(async (claim, now) => ledger.claimDelivery(claim, now)),
    commitSource: vi.fn(async (key, expected, data, drafts, now, identities, questions) => ledger.commitSource(key, expected, data, drafts, now, identities, questions)),
    put: async (draft, now) => ledger.put(draft, now), page: async query => ledger.page(query), read: async (id, revision, now) => ledger.read(id, revision, now),
    readAll: async (query, revision, now) => ledger.readAll(query, revision, now), archive: async (id, now) => ledger.archive(id, now), clearRead: async (query, now) => ledger.clearRead(query, now),
    preferences: async () => ledger.preferences(), savePreferences: async value => ledger.savePreferences(value), close: async () => ledger.close()
  }
  const owner = new NotificationService(port, () => 10_000)
  return { ledger, port, owner }
}
