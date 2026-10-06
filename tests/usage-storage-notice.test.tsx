// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { UsageStorageNotice } from '../src/renderer/src/notifications/UsageStorageNotice'
import { SettingsStats } from '../src/renderer/src/settings/SettingsStats'
import type { NotificationRecord, NotificationPush } from '../src/domain/notification'
const record: NotificationRecord = { id: 'r1', key: 'usage-storage:write:'+'1'.repeat(64), eventId: 'write-failed-1', eventType: 'usage.storage-write', subjectState: 'unconfirmed', scope: {},
  category: 'storage', source: '统计 · 本机用量记录', title: '用量记录保存未确认', detail: '本次内存统计仍可显示，重启后不能保证保留最新记录。', target: { kind: 'settings', section: 'stats' }, state: 'active', tone: 'warning', attention: 'notice',
  revision: 1, attentionRevision: 1, readRevision: 0, sourceRevision: 1, occurredAt: 100, createdAt: 100, updatedAt: 100 }
const page = (r = record) => ({ records: [r], summary: { revision: r.revision, total: 1, unread: 1, pending: 0, clearable: 0 }, reset: false })
let host: HTMLDivElement, root: Root, listeners: Set<(value: NotificationPush) => void>, api: any
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  listeners = new Set()
  api = { getNotificationPage: vi.fn(async (q: any) => q.eventType ? (q.eventType === record.eventType ? page() : { ...page(), records: [] }) : page()),
    onNotificationChanged: vi.fn((f: any) => { listeners.add(f); return () => listeners.delete(f) }), readNotification: vi.fn(async () => ({ changed: true, record: { ...record, readRevision: 1 }, summary: page().summary })) }
  Object.assign(window, { sgDesktop: api })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    // Real Chromium returns non-zero layout even for closed details bodies.
    return { width: 300, height: 90, top: 100, bottom: 190, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) }
  })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
it('keeps normal stats quiet and renders the same warning even when corruption led to an empty usage snapshot', async () => {
  await act(async () => root.render(<SettingsStats usageSnapshot={{}} active />))
  expect(host.textContent).toContain('用量记录保存未确认'); expect(host.textContent).toContain('暂无可展示的用量')
  expect(api.getNotificationPage).toHaveBeenCalledTimes(3)
  expect(api.readNotification).not.toHaveBeenCalled()
})
it('queries only when active, ignores usage ticks, and does not consume unread from a collapsed title', async () => {
  await act(async () => root.render(<UsageStorageNotice active={false} />)); expect(api.getNotificationPage).not.toHaveBeenCalled()
  await act(async () => root.render(<UsageStorageNotice active />))
  expect(api.getNotificationPage).toHaveBeenCalledTimes(2); expect(api.readNotification).not.toHaveBeenCalled()
  await act(async () => root.render(<UsageStorageNotice active />)); expect(api.getNotificationPage).toHaveBeenCalledTimes(2)
  const p = host.querySelector('p')!
  const details = host.querySelector('details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle', { bubbles: false })); await new Promise(requestAnimationFrame) })
  expect(api.readNotification).toHaveBeenCalledWith({ id: record.id, revision: 1 })
})
it('late old private reads and old body visibility cannot overwrite or read a newly pushed cause with a new event identity', async () => {
  let resolve!: (p: any) => void
  api.getNotificationPage.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => root.render(<UsageStorageNotice active />))
  const changed = { ...record, eventId: 'write-failed-capacity', revision: 2, attentionRevision: 2, detail: '原保存入口报告空间不足。' }
  await act(async () => { listeners.forEach(f => f({ health: 'ready', historyIncomplete: false, change: { changed: true, record: changed, summary: page(changed).summary } })) })
  await act(async () => resolve(page()))
  expect(host.textContent).toContain('空间不足'); expect(api.readNotification).not.toHaveBeenCalled()
  await act(async () => { listeners.forEach(f => f({ health: 'ready', historyIncomplete: false, change: { changed: true, record: { ...changed, revision: 3, state: 'resolved' }, summary: page(changed).summary } })) })
  expect(host.querySelector('.usage-storage-notices')).toBeNull()
})
it('an unrelated app event or a stopped page does not cause a reload or late focus change', async () => {
  await act(async () => root.render(<UsageStorageNotice active />))
  const count = api.getNotificationPage.mock.calls.length
  await act(async () => { listeners.forEach(f => f({ health: 'ready', historyIncomplete: false, change: { changed: true, record: { ...record, key: 'foreign', eventType: 'session.reply' }, summary: page().summary } })) })
  expect(api.getNotificationPage).toHaveBeenCalledTimes(count)
  await act(async () => root.render(<UsageStorageNotice active={false} />))
  expect(listeners.size).toBe(0); expect(host.querySelector('.usage-storage-notices')).toBeNull()
})
