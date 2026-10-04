// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { NotificationStore, type NotificationApi } from '../src/renderer/src/notifications/notification-store'
import { NotificationCenter } from '../src/renderer/src/notifications/NotificationCenter'
import type { NotificationDraft, NotificationPush, NotificationRecord } from '../src/domain/notification'

const draft = (patch: Partial<NotificationDraft> = {}): NotificationDraft => ({ key: 'test:1', category: 'run', source: '运行', title: '批量发起结束', detail: '成员结果已保存。',
  tone: 'success', attention: 'notice', state: 'resolved', scope: { workspaceId: 'a' }, sourceRevision: 1, occurredAt: Date.now(), ...patch })
describe('notification center real-ledger interactions', () => {
  let host: HTMLDivElement; let root: Root; let repository: SqliteNotificationRepository; let store: NotificationStore; let api: NotificationApi; let release: () => void
  const listeners = new Set<(event: NotificationPush) => void>()
  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div'); document.body.append(host); root = createRoot(host); repository = new SqliteNotificationRepository(':memory:')
    repository.put(draft(), Date.now()); repository.put(draft({ key: 'test:2', title: '请回答问卷', attention: 'action', state: 'active' }), Date.now())
    const changed = (change: ReturnType<SqliteNotificationRepository['read']>) => { for (const listener of listeners) listener({ change, health: 'ready', historyIncomplete: false }); return change }
    api = { getNotificationPage: vi.fn(async query => repository.page(query)), getNotificationPreferences: async () => repository.preferences(), saveNotificationPreferences: async value => { const saved = repository.savePreferences(value); for (const listener of listeners) listener({ preferences: saved, health: 'ready', historyIncomplete: false }); return saved },
      onNotificationChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
      readNotification: vi.fn(async input => changed(repository.read(input.id, input.revision, Date.now()))), readAllNotifications: vi.fn(async input => changed(repository.readAll(input.query ?? {}, input.revision, Date.now()))),
      archiveNotification: vi.fn(async id => changed(repository.archive(id, Date.now()))), clearReadNotifications: vi.fn(async input => { if (!input.confirmed) throw Error('confirmation required'); return changed(repository.clearRead(input.query ?? {}, Date.now())) }) }
    store = new NotificationStore(api); release = store.acquire(); await Promise.resolve(); await Promise.resolve()
    await act(async () => root.render(<NotificationCenter store={store} workspaceId="a" onClose={() => {}} onNavigate={async () => {}} />))
  })
  afterEach(async () => { await act(async () => root.unmount()); release(); listeners.clear(); repository.close(); host.remove() })
  const button = (text: string): HTMLButtonElement => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!
  const click = async (text: string) => { await act(async () => { button(text).click() }) }
  it('does not mark the whole center read merely by opening; detail reading does not resolve business work', async () => {
    expect(repository.page().summary.unread).toBe(2)
    await click('请回答问卷')
    expect(repository.page().summary.unread).toBe(1); expect(repository.page().summary.pending).toBe(1)
    expect(host.querySelector('.notification-panel__refresh')).toBeNull()
    const row = [...host.querySelectorAll('.notification-row')].find(node => node.textContent?.includes('请回答问卷'))!
    expect(row.textContent).not.toContain('归档')
  })
  it('keeps the opened content stable across incoming changed results and exposes an explicit refresh', async () => {
    await click('批量发起结束')
    const original = host.querySelector('.notification-row__detail')!.textContent
    const next = repository.put(draft({ sourceRevision: 2, detail: '晚到的新结果，不应替换正在阅读的内容。', renewAttention: true }), Date.now())
    await act(async () => { for (const listener of listeners) listener({ change: next, health: 'ready', historyIncomplete: false }) })
    expect(host.querySelector('.notification-row__detail')!.textContent).toContain('成员结果已保存。')
    expect(host.querySelector('.notification-row__detail')!.textContent).not.toContain('晚到的新结果')
    expect(original).toBeTruthy(); expect(host.querySelector('.notification-panel__refresh')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('.notification-panel__refresh')!.click())
    expect(host.querySelector('.notification-row__detail')!.textContent).not.toContain('晚到的新结果')
    await click('查看最新结果')
    expect(host.querySelector('.notification-row__detail')!.textContent).toContain('晚到的新结果')
  })
  it('requires explicit clear confirmation and preserves pending actions when clearing read history', async () => {
    await click('全部已读')
    await click('清理已读…')
    expect(api.clearReadNotifications).not.toHaveBeenCalled()
    await click('取消'); expect(api.clearReadNotifications).not.toHaveBeenCalled()
    await click('清理已读…'); await click('清理已读')
    expect(api.clearReadNotifications).toHaveBeenCalledWith({ query: {}, confirmed: true })
    expect(repository.page().summary.total).toBe(1); expect(repository.page().summary.pending).toBe(1)
  })
  it('tabs support arrow-key navigation and only the selected tab is in the normal Tab order', async () => {
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    tabs[0]!.focus()
    await act(async () => { tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(document.activeElement).toBe(tabs[1]); expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]!.tabIndex).toBe(-1); expect(host.querySelectorAll('.notification-row')).toHaveLength(1)
  })
  it('preferences do not reload or jump the history list', async () => {
    await click('提醒设置'); const count = vi.mocked(api.getNotificationPage).mock.calls.length
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => checkbox.click())
    expect(repository.preferences().quiet).toBe(true)
    expect(vi.mocked(api.getNotificationPage).mock.calls.length).toBe(count)
  })
})
