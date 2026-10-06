// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { observeSourceNotificationRead } from '../src/renderer/src/notifications/observe-source-read'
import type { NotificationChange, NotificationDraft, NotificationPage, NotificationPush, NotificationQuery, NotificationRecord } from '../src/domain/notification'

const draft = (index: number): NotificationDraft => ({ key: `history:${index}`, eventType: 'session.reply', category: 'sessions', source: 'fixture', title: `original ${index}`,
  scope: { sessionId: 'session', generation: '1' }, target: { kind: 'session', scope: { sessionId: 'session', generation: '1' }, entryId: `reply-${index}` },
  tone: 'info', attention: 'notice', state: 'resolved', sourceRevision: 1, occurredAt: 1 })
let ledger: SqliteNotificationRepository, element: HTMLDivElement, stop: (() => void) | undefined
let push!: (value: NotificationPush) => void
beforeEach(() => {
  ledger = new SqliteNotificationRepository(':memory:'); element = document.createElement('div'); document.body.append(element)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 70, top: 100, bottom: 170, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) })
})
afterEach(() => { stop?.(); stop = undefined; element.remove(); ledger.close(); vi.restoreAllMocks() })
function fixture(matches: (record: NotificationRecord) => boolean = () => true) {
  const page = vi.fn(async (query?: NotificationQuery) => ledger.page(query))
  const read = vi.fn(async (input: { id: string; revision: number }) => {
    const change = ledger.read(input.id, input.revision, 2)
    push({ health: 'ready', historyIncomplete: false, change }); return change
  })
  const api = { getNotificationPage: page, readNotification: read, onNotificationChanged: (next: typeof push) => { push = next; return vi.fn() } }
  stop = observeSourceNotificationRead(element, api, { sessionId: 'session', eventType: 'session.reply', filter: 'unread', limit: 100 }, matches)
  return { page, read, api }
}
it('finds and acknowledges an exact visible record beyond the first 100, without marking the other 430 source records read', async () => {
  for (let index = 0; index < 431; index++) ledger.put(draft(index), 1)
  const f = fixture(record => record.key === 'history:0')
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  expect(f.page).toHaveBeenCalledTimes(5); expect(ledger.page().summary.unread).toBe(430)
  expect(ledger.page({ key: 'history:0' }).summary.unread).toBe(0)
})
it('bounds human read RPC concurrency at four while completely draining 431 actually matched visible records across shrinking unread pages', async () => {
  for (let index = 0; index < 431; index++) ledger.put(draft(index), 1)
  let inFlight = 0, peak = 0
  const releases: Array<() => void> = [], page = vi.fn(async (query?: NotificationQuery) => ledger.page(query)), calls: string[] = []
  const api = { getNotificationPage: page, onNotificationChanged: (next: typeof push) => { push = next; return vi.fn() },
    readNotification: (input: { id: string; revision: number }) => new Promise<NotificationChange>(resolve => {
      ++inFlight; peak = Math.max(peak, inFlight); calls.push(input.id)
      releases.push(() => { const change = ledger.read(input.id, input.revision, 2); --inFlight; push({ health: 'ready', historyIncomplete: false, change }); resolve(change) })
    }) }
  stop = observeSourceNotificationRead(element, api, { sessionId: 'session', filter: 'unread', limit: 100 }, () => true)
  await Promise.resolve(); expect(peak).toBe(4); expect(page).toHaveBeenCalledOnce()
  for (let step = 0; step < 150 && ledger.page().summary.unread; step++) {
    releases.splice(0).forEach(release => release()); for (let index = 0; index < 8; index++) await Promise.resolve()
  }
  expect(ledger.page().summary.unread).toBe(0); expect(new Set(calls).size).toBe(431); expect(calls).toHaveLength(431)
  expect(peak).toBe(4); expect(page).toHaveBeenCalledTimes(5)
})
it('does not read or fetch further pages while unfocused, clipped or underneath another modal; resumption needs a real visibility event', async () => {
  for (let index = 0; index < 230; index++) ledger.put(draft(index), 1)
  const f = fixture(record => record.key === 'history:0')
  const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
  try {
    // The first lookup began before this modal. Its response cannot consume a source now covered by it.
    await vi.waitFor(() => expect(f.page).toHaveBeenCalledOnce())
    await Promise.resolve(); await Promise.resolve()
    expect(f.read).not.toHaveBeenCalled()
  } finally { modal.remove() }
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce())
})
it('a private history reload fences a pending old successful read and permits the genuinely restored lower revision to be confirmed anew', async () => {
  for (let index = 0; index < 10; index++) ledger.put({ ...draft(0), title: `old ${index}`, sourceRevision: index + 1, renewAttention: true }, 1)
  const old = ledger.page().records[0]!
  let release!: (value: NotificationChange) => void, reads = 0
  const restored = { ...old, revision: 1, attentionRevision: 1, readRevision: 0 }
  const page = { records: [old], summary: ledger.page().summary, reset: false }
  const api = { getNotificationPage: vi.fn(async () => page), onNotificationChanged: (next: typeof push) => { push = next; return vi.fn() },
    readNotification: vi.fn((input: { id: string; revision: number }) => {
      ++reads
      if (reads === 1) return new Promise<NotificationChange>(resolve => { release = resolve })
      return Promise.resolve({ changed: true, record: { ...restored, readRevision: restored.attentionRevision }, summary: page.summary })
    }) }
  stop = observeSourceNotificationRead(element, api, { key: old.key, limit: 1 }, () => true)
  await vi.waitFor(() => expect(reads).toBe(1))
  page.records = [restored]
  page.summary = { ...page.summary, revision: 1 }
  push({ health: 'ready', historyIncomplete: true, historyReload: true })
  for (let index = 0; index < 8; index++) await Promise.resolve()
  release({ changed: true, record: { ...old, readRevision: old.attentionRevision }, summary: page.summary })
  await vi.waitFor(() => expect(reads).toBe(2))
  expect(api.readNotification).toHaveBeenLastCalledWith({ id: old.id, revision: restored.revision })
})
it('disposal discards delayed page reads and unsubscribes before a later original query result can acknowledge anything', async () => {
  let release!: (value: NotificationPage) => void
  const f = fixture(), current = ledger.put(draft(0), 1).record!
  f.page.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  window.dispatchEvent(new Event('focus')); await vi.waitFor(() => expect(typeof release).toBe('function')); stop!(); stop = undefined
  release({ records: [current], summary: ledger.page().summary, reset: false, nextReadCursor: { revision: 1, id: 'same', ceiling: 1 } })
  for (let index = 0; index < 8; index++) await Promise.resolve()
  expect(f.read).not.toHaveBeenCalled()
})
it('a malformed/non-advancing private read cursor terminates the scan rather than making an automatic query loop', async () => {
  const page = vi.fn(async (): Promise<NotificationPage> => ({ records: [], summary: { revision: 3, total: 2, unread: 2, pending: 0, clearable: 0 }, reset: false,
    nextReadCursor: { revision: 2, id: 'same', ceiling: 3 } })), read = vi.fn(async () => ({ changed: false, summary: ledger.page().summary }))
  stop = observeSourceNotificationRead(element, { getNotificationPage: page, readNotification: read, onNotificationChanged: () => () => {} }, { limit: 100 }, () => false)
  await vi.waitFor(() => expect(page).toHaveBeenCalledTimes(2))
  for (let index = 0; index < 8; index++) await Promise.resolve()
  expect(page).toHaveBeenCalledTimes(2); expect(read).not.toHaveBeenCalled()
})
