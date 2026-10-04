// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationResultRead } from '../src/renderer/src/notifications/use-notification-result-read'
import type { NotificationPage, NotificationPush, NotificationRecord } from '../src/domain/notification'

function Result({ eventId = 'available' }: { eventId?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useNotificationResultRead(ref, 'update:1', eventId)
  return <div ref={ref} data-notification-key="update:1" data-notification-event={eventId}>真实原页面结果</div>
}
const record: NotificationRecord = { id: 'n1', key: 'update:1', eventId: 'available', category: 'updates', source: '软件更新', title: '版本可用', tone: 'info', attention: 'notice', state: 'active',
  scope: {}, sourceRevision: 1, occurredAt: 1, createdAt: 1, updatedAt: 1, revision: 1, attentionRevision: 1, readRevision: 0 }
const page = (records = [record]): NotificationPage => ({ records, summary: { revision: 1, total: records.length, unread: records.length, pending: 0, clearable: 0 }, reset: false })
describe('exact visible source result acknowledgements', () => {
  let host: HTMLDivElement; let root: Root; let push: (event: NotificationPush) => void
  let api: { getNotificationPage: ReturnType<typeof vi.fn>; readNotification: ReturnType<typeof vi.fn>; onNotificationChanged: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 70, top: 100, bottom: 170, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) })
    api = { getNotificationPage: vi.fn(async () => page()), readNotification: vi.fn(async () => ({ changed: true })), onNotificationChanged: vi.fn(callback => { push = callback; return () => {} }) }
    window.sgDesktop = api as never
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); delete (window as unknown as { sgDesktop?: unknown }).sgDesktop })
  it('reads only the known record after the exact result is visible, not an entire route', async () => {
    await act(async () => root.render(<Result />))
    expect(api.getNotificationPage).toHaveBeenCalledWith({ key: 'update:1', limit: 1 })
    expect(api.readNotification).toHaveBeenCalledWith({ id: 'n1', revision: 1 })
  })
  it('does not acknowledge hidden, unfocused or mismatched results', async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) })
    await act(async () => root.render(<Result />))
    expect(api.readNotification).not.toHaveBeenCalled(); expect(api.getNotificationPage).not.toHaveBeenCalled()
  })
  it('does not mark a new milestone read using a late old query result', async () => {
    let resolve!: (value: NotificationPage) => void
    api.getNotificationPage.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await act(async () => root.render(<Result />))
    api.getNotificationPage.mockResolvedValue(page([{ ...record, eventId: 'downloaded', revision: 2, attentionRevision: 2 }]))
    await act(async () => root.render(<Result eventId="downloaded" />))
    await act(async () => resolve(page()))
    expect(api.readNotification).toHaveBeenCalledTimes(1); expect(api.readNotification).toHaveBeenCalledWith({ id: 'n1', revision: 2 })
  })
  it('can acknowledge a live record committed after the initial source lookup returned empty', async () => {
    api.getNotificationPage.mockResolvedValue(page([]))
    await act(async () => root.render(<Result />)); expect(api.readNotification).not.toHaveBeenCalled()
    await act(async () => push({ change: { changed: true, record, summary: page().summary }, health: 'ready', historyIncomplete: false }))
    expect(api.readNotification).toHaveBeenCalledWith({ id: 'n1', revision: 1 })
  })
})
