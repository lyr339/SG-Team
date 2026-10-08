// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { NotificationStore, type NotificationApi } from '../src/renderer/src/notifications/notification-store'
import { HistoryGapNotice, HistoryRetentionInfo } from '../src/renderer/src/notifications/NotificationHistoryNotice'
import type { NotificationHistoryIntegrity } from '../src/domain/notification-history'

const id = '11111111-1111-4111-8111-111111111111', nextId = '22222222-2222-4222-8222-222222222222'
let host: HTMLDivElement, root: Root, ledger: SqliteNotificationRepository, store: NotificationStore, api: NotificationApi
beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); ledger = new SqliteNotificationRepository(':memory:')
  const read = vi.fn(async () => { throw Error('must not read business records') })
  api = { getNotificationPage: async () => ledger.page(), getNotificationPreferences: async () => ledger.preferences(), saveNotificationPreferences: async value => value,
    onNotificationChanged: () => () => {}, readNotification: read, readAllNotifications: read, archiveNotification: read, clearReadNotifications: read,
    acknowledgeNotificationHistory: vi.fn(async revision => ledger.acknowledgeHistoryGap(revision, 100)) }
  store = new NotificationStore(api)
  ledger.recordHistoryGap(id, 10)
  store.accept({ health: 'ready', historyIncomplete: true, historyIntegrity: ledger.historyGap().integrity, historyGapUnconfirmed: false })
  await act(async () => root.render(<><HistoryGapNotice store={store} /><HistoryRetentionInfo store={store} /></>))
})
afterEach(async () => { await act(async () => root.unmount()); ledger.close(); host.remove() })
const confirm = () => host.querySelector<HTMLButtonElement>('button')!
describe('quiet history facts and exact-version acknowledgement', () => {
  it('opening and closing policy preserves the trigger/content nodes and never acknowledges or reads business history', async () => {
    const details = host.querySelector<HTMLDetailsElement>('.notification-history-policy')!
    const summary = details.querySelector('summary')!, content = details.querySelector<HTMLDivElement>('.notification-history-policy__content')!
    const saved = ledger.historyGap().integrity
    expect(content.getAttribute('role')).toBe('region'); expect(content.tabIndex).toBe(0)
    expect(summary.querySelectorAll('svg')).toHaveLength(1)
    await act(async () => summary.click()); expect(details.open).toBe(true)
    await act(async () => summary.click()); expect(details.open).toBe(false)
    expect(details.querySelector('summary')).toBe(summary)
    expect(details.querySelector('.notification-history-policy__content')).toBe(content)
    expect(api.acknowledgeNotificationHistory).not.toHaveBeenCalled()
    expect(api.readNotification).not.toHaveBeenCalled(); expect(api.clearReadNotifications).not.toHaveBeenCalled()
    expect(ledger.historyGap().integrity).toEqual(saved)
  })
  it('hides the explanation only after durable confirmation, keeps the fact/policy, and never marks notifications read', async () => {
    await act(async () => { confirm().click() })
    expect(host.querySelector('.notification-history-notice')).toBeNull(); expect(store.snapshot().historyIncomplete).toBe(true)
    expect(host.textContent).toContain('这次说明已确认，不代表缺口已修复')
    expect(api.readNotification).not.toHaveBeenCalled(); expect(api.readAllNotifications).not.toHaveBeenCalled(); expect(api.clearReadNotifications).not.toHaveBeenCalled()
  })
  it('failure stays visible without an optimistic disappearance; an unconfirmed fact disables confirmation', async () => {
    vi.mocked(api.acknowledgeNotificationHistory!).mockRejectedValueOnce(Error('unknown write'))
    await act(async () => { confirm().click() })
    expect(host.querySelector('.notification-history-notice')).not.toBeNull(); expect(host.textContent).toContain('待核对')
    await act(async () => { store.accept({ health: 'ready', historyIncomplete: true, historyGapUnconfirmed: true }) })
    expect(confirm().disabled).toBe(true)
  })
  it('late old acknowledgement does not dismiss a newer gap or an unconfirmed new fact', async () => {
    let release!: (value: NotificationHistoryIntegrity) => void
    vi.mocked(api.acknowledgeNotificationHistory!).mockImplementationOnce(() => new Promise(done => { release = done }))
    await act(async () => { confirm().click() })
    const old = ledger.acknowledgeHistoryGap(1, 100), newer = ledger.recordHistoryGap(nextId, 200)
    await act(async () => { store.accept({ health: 'ready', historyIncomplete: true, historyIntegrity: newer, historyGapUnconfirmed: true }); release(old) })
    expect(store.snapshot().historyIntegrity?.revision).toBe(2); expect(store.snapshot().historyGapUnconfirmed).toBe(true)
    expect(host.querySelector('.notification-history-notice')).not.toBeNull()
  })
  it('a late old pull cannot rewind acknowledgement or clear a fresh in-memory unconfirmed gap', async () => {
    const stale = ledger.page(), original = api.getNotificationPage
    let release!: (value: typeof stale) => void
    api.getNotificationPage = vi.fn(() => new Promise<typeof stale>(done => { release = done }))
    const refreshing = store.refresh()
    await act(async () => {
      store.accept({ health: 'ready', historyIncomplete: true, historyIntegrity: ledger.acknowledgeHistoryGap(1, 100), historyGapUnconfirmed: true })
      release({ ...stale, historyGapUnconfirmed: false }); await refreshing
    })
    expect(store.snapshot().historyIntegrity?.acknowledgedRevision).toBe(1); expect(store.snapshot().historyGapUnconfirmed).toBe(true)
    api.getNotificationPage = original
  })
  it('a zero-revision metadata response cannot erase the independent possible-gap fact', async () => {
    const empty = new NotificationStore(api)
    empty.accept({ health: 'ready', historyIncomplete: true, historyIntegrity: { revision: 0, acknowledgedRevision: 0 }, historyGapUnconfirmed: true })
    expect(empty.snapshot().historyIncomplete).toBe(true)
  })
})
