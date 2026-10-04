// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationToast } from '../src/renderer/src/notifications/NotificationToast'
import { NotificationStore, type NotificationApi } from '../src/renderer/src/notifications/notification-store'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationRecord } from '../src/domain/notification'

describe('single calm notification toast', () => {
  let host: HTMLDivElement; let root: Root; let store: NotificationStore; let api: NotificationApi; let release: () => void
  const record = (id: string): NotificationRecord => ({ id, key: id, source: '测试结果', category: 'storage', title: `${id} 清理完成`, scope: {}, tone: 'success', attention: 'notice', state: 'resolved',
    occurredAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), revision: 1, attentionRevision: 1, readRevision: 0, sourceRevision: 1 })
  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers(); vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const summary = { revision: 0, total: 0, unread: 0, pending: 0, clearable: 0 }
    api = { getNotificationPage: async () => ({ records: [], summary, reset: false }), getNotificationPreferences: async () => DEFAULT_NOTIFICATION_PREFERENCES,
      saveNotificationPreferences: async value => value, onNotificationChanged: () => () => {}, readNotification: vi.fn(), readAllNotifications: vi.fn(), archiveNotification: vi.fn(), clearReadNotifications: vi.fn() }
    store = new NotificationStore(api); release = store.acquire(); await Promise.resolve(); await Promise.resolve()
    await act(async () => root.render(<NotificationToast store={store} blocked={false} onOpen={() => {}} />))
  })
  afterEach(async () => { await act(async () => root.unmount()); release(); host.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
  const push = async (id: string, revision = 1) => {
    await act(async () => store.accept({ change: { changed: true, summary: { revision, total: revision, unread: revision, pending: 0, clearable: 0 }, record: record(id) },
      announcement: { id, expiresAt: Date.now() + 60_000 }, health: 'ready', historyIncomplete: false }))
  }
  it('presents one card and quiet mode closes it without recursive listener updates or marking it read', async () => {
    await push('first'); await push('second', 2)
    expect(document.querySelectorAll('.notification-toast')).toHaveLength(1)
    expect(document.querySelector('.notification-toast')!.textContent).toContain('first 清理完成')
    await act(async () => store.accept({ preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, quiet: true }, health: 'ready', historyIncomplete: false }))
    expect(document.querySelector('.notification-toast')).toBeNull(); expect(api.readNotification).not.toHaveBeenCalled()
  })
  it('hover pauses the remaining dwell time; the next queued card gets its own full timer', async () => {
    await push('first'); await push('second', 2)
    await act(async () => vi.advanceTimersByTime(3_000))
    await act(async () => document.querySelector('.notification-toast')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(8_000))
    expect(document.querySelector('.notification-toast')!.textContent).toContain('first 清理完成')
    await act(async () => document.querySelector('.notification-toast')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(2_100))
    expect(document.querySelector('.notification-toast')!.textContent).toContain('second 清理完成')
    await act(async () => vi.advanceTimersByTime(4_000))
    expect(document.querySelector('.notification-toast')).not.toBeNull()
    await act(async () => vi.advanceTimersByTime(1_100)); expect(document.querySelector('.notification-toast')).toBeNull()
  })
  it('does not replay expired ordinary success after returning from the background', async () => {
    await push('first')
    await act(async () => window.dispatchEvent(new Event('blur')))
    await act(async () => vi.advanceTimersByTime(70_000))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(document.querySelector('.notification-toast')).toBeNull()
  })
  it('reading a result in the center retires its paused toast instead of replaying it on close', async () => {
    await push('first')
    await act(async () => root.render(<NotificationToast store={store} blocked={true} onOpen={() => {}} />))
    await act(async () => store.accept({ change: { changed: true, record: { ...record('first'), readRevision: 1 }, summary: { revision: 2, total: 1, unread: 0, pending: 0, clearable: 1 } }, health: 'ready', historyIncomplete: false }))
    await act(async () => root.render(<NotificationToast store={store} blocked={false} onOpen={() => {}} />))
    expect(document.querySelector('.notification-toast')).toBeNull()
  })
})
