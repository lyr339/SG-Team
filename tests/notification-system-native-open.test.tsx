// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationSystem } from '../src/renderer/src/notifications/NotificationSystem'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import type { NotificationPage, NotificationPush, NotificationRecord, NotificationTarget, NotificationScope } from '../src/domain/notification'
import type { NotificationApi } from '../src/renderer/src/notifications/notification-store'

describe('explicit native click opens exact ledger content, never a saved business action', () => {
  let host: HTMLDivElement, root: Root, ledger: SqliteNotificationRepository, api: NotificationApi, record: NotificationRecord
  const listeners = new Set<(value: NotificationPush) => void>(), navigate = vi.fn(async (_target:NotificationTarget,_scope?:NotificationScope,_stillRelevant?:()=>boolean) => true)
  const push = (value: NotificationPush) => { for (const listener of listeners) listener(value) }
  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers(); vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 70, top: 100, bottom: 170, left: 10, right: 410, x: 10, y: 100, toJSON: () => ({}) })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host); ledger = new SqliteNotificationRepository(':memory:'); navigate.mockClear()
    const base = { key: 'native:record', category: 'automation' as const, source: '自动化', title: '流程完成，有一个待核对结果', detail: '这是原始具体结果，并不代表允许重新执行流程。', scope: {},
      attention: 'notice' as const, state: 'resolved' as const, tone: 'warning' as const, occurredAt: 100, sourceRevision: 1 }
    record = ledger.put(base, 100).record!; ledger.put({ ...base, key: 'unrelated:record', title: '另一条没有被阅读的通知' }, 100)
    api = { getNotificationPage: vi.fn(async query => ({ ...ledger.page(query), delivery: { nativeSupported: true, state: 'ready' as const } })), getNotificationPreferences: async () => ledger.preferences(),
      saveNotificationPreferences: async value => ledger.savePreferences(value),
      onNotificationChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      readNotification: vi.fn(async input => { const change = ledger.read(input.id, input.revision, 200); push({ change, health: 'ready', historyIncomplete: false }); return change }),
      readAllNotifications: vi.fn(), archiveNotification: vi.fn(), clearReadNotifications: vi.fn() }
    window.sgDesktop = api as never
    await act(async () => root.render(<NotificationSystem workspaceId="workspace-a" onAvailable={() => {}} onNavigate={navigate} onSnoozeUpdate={async () => {}} />))
    await act(async () => vi.advanceTimersByTimeAsync(0))
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); ledger.close(); listeners.clear(); vi.restoreAllMocks(); vi.useRealTimers(); delete (window as unknown as { sgDesktop?: unknown }).sgDesktop })
  const open = async (token = 'open:1') => { await act(async () => push({ health: 'ready', historyIncomplete: false, openRequested: { token, recordId: record.id, key: record.key, revision: record.revision } })) }
  it('portal selection stays inside its owner; Esc only closes the menu, and a second Esc closes the center', async () => {
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="通知"]')!
    await act(async () => trigger.click())
    const scope = document.querySelector<HTMLButtonElement>('[aria-label="通知工作区范围"]')!
    await act(async () => scope.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!
    expect(list.dataset.overlayOwner).toBe(document.querySelector<HTMLElement>('[data-overlay-scope]')!.dataset.overlayScope)
    expect(document.querySelector('.notification-panel')).not.toBeNull()
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(document.querySelector('[role="listbox"]')).toBeNull(); expect(document.querySelector('.notification-panel')).not.toBeNull(); expect(document.activeElement).toBe(scope)
    await act(async () => scope.click())
    const current = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(option => option.textContent === '当前工作区')!
    await act(async () => { current.dispatchEvent(new Event('pointerdown', { bubbles: true })); current.click() })
    expect(document.querySelector('.notification-panel')).not.toBeNull(); expect(api.readNotification).not.toHaveBeenCalled(); expect(api.readAllNotifications).not.toHaveBeenCalled()
    await act(async () => scope.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(document.querySelector('.notification-panel')).toBeNull(); expect(document.activeElement).toBe(trigger)
  })
  it('renders and reads only the exact opened body, leaving other notifications unread and never invoking source navigation', async () => {
    await open()
    expect(document.querySelector('.notification-row__detail')?.textContent).toContain('原始具体结果')
    expect(api.readNotification).toHaveBeenCalledWith({ id: record.id, revision: record.revision }); expect(api.readAllNotifications).not.toHaveBeenCalled()
    expect(ledger.page().summary.unread).toBe(1); expect(navigate).not.toHaveBeenCalled()
  })
  it('an exact-body read before the slow initial list arrives does not masquerade as a new business update', async () => {
    const original = vi.mocked(api.getNotificationPage).getMockImplementation()!
    let resolve!: (value: NotificationPage) => void, captured!: NotificationPage
    vi.mocked(api.getNotificationPage).mockImplementation(query => {
      if (query?.limit === 30 && !query.key) { captured = ledger.page(query); return new Promise(done => { resolve = done }) }
      return original(query)
    })
    await open()
    expect(api.readNotification).toHaveBeenCalledOnce(); expect(ledger.page().summary.unread).toBe(1)
    await act(async () => resolve(captured))
    expect(document.querySelector('.notification-panel__refresh')).toBeNull()
    expect(document.querySelector('.notification-panel__header')?.textContent).toContain('2 条记录')
    expect(document.querySelectorAll('.notification-row.is-unread')).toHaveLength(1)
  })
  it('a foreground modal defers the open request rather than hiding or marking a result behind it', async () => {
    const modal = document.createElement('section'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
    try {
      await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
      await open(); expect(document.querySelector('.notification-panel')).toBeNull(); expect(api.readNotification).not.toHaveBeenCalled()
      modal.remove(); await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
      expect(document.querySelector('.notification-row__detail')?.textContent).toContain('原始具体结果')
      expect(api.readNotification).toHaveBeenCalledOnce()
    } finally { modal.remove() }
  })
  it('a modal arriving during a slow lookup does not consume the request or read the stale hidden result', async () => {
    const original = vi.mocked(api.getNotificationPage).getMockImplementation()!
    let resolve!: (value: NotificationPage) => void
    vi.mocked(api.getNotificationPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await open()
    const modal = document.createElement('section'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
    try {
      await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
      await act(async () => resolve(ledger.page({ key: record.key })))
      expect(api.readNotification).not.toHaveBeenCalled()
      vi.mocked(api.getNotificationPage).mockImplementation(original); modal.remove()
      await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
      expect(document.querySelector('.notification-row__detail')?.textContent).toContain('原始具体结果'); expect(api.readNotification).toHaveBeenCalledOnce()
    } finally { modal.remove() }
  })
  it('a user close while source lookup is pending revokes presentation and never reopens the center on its late result',async()=>{
    record=ledger.put({...record,sourceRevision:2,target:{kind:'settings',section:'maintenance'}},200).record!
    let release!:(value:boolean)=>void,stillRelevant!:(()=>boolean)
    navigate.mockImplementationOnce(async(_target,_scope,guard)=>{stillRelevant=guard!;return new Promise(done=>{release=done})})
    await open('lookup-close')
    const source=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='查看维护')!
    await act(async()=>source.click());expect(stillRelevant()).toBe(true)
    await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="关闭通知中心"]')!.click())
    expect(stillRelevant()).toBe(false)
    await act(async()=>release(false))
    expect(document.querySelector('.notification-panel')).toBeNull();expect(navigate).toHaveBeenCalledOnce()
  })
  it('a cleared original opens an explanation, not a reused entity or a different notification', async () => {
    ledger.read(record.id, record.revision, 200); ledger.clearRead({ key: record.key }, 200)
    await open()
    expect(document.querySelector('.notification-panel')?.textContent).toContain('这条通知已归档或清理')
    expect(api.readNotification).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled(); expect(ledger.page().summary.unread).toBe(1)
  })
  it('a native click from an older private ledger cannot open an equal-ID/revision replacement', async () => {
    vi.mocked(api.getNotificationPage).mockImplementation(async query => ({ ...ledger.page(query), storageEpoch: 1 }))
    await act(async () => push({ health: 'ready', historyIncomplete: true, storageEpoch: 1, historyReload: true }))
    await act(async () => push({ health: 'ready', historyIncomplete: true, storageEpoch: 1,
      openRequested: { token: 'old-ledger-native', key: record.key, recordId: record.id, revision: record.revision, storageEpoch: 0 } }))
    expect(document.querySelector('.notification-panel')).toBeNull(); expect(api.readNotification).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  })
  it('a modal-deferred native request is cleared when storage changes rather than opening current data after the modal closes', async () => {
    const modal = document.createElement('section'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
    try {
      await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
      await open('deferred-before-epoch')
      vi.mocked(api.getNotificationPage).mockImplementation(async query => ({ ...ledger.page(query), storageEpoch: 1 }))
      await act(async () => push({ health: 'ready', historyIncomplete: true, storageEpoch: 1, historyReload: true }))
      modal.remove(); await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0) })
      expect(document.querySelector('.notification-panel')).toBeNull(); expect(api.readNotification).not.toHaveBeenCalled()
    } finally { modal.remove() }
  })
})
