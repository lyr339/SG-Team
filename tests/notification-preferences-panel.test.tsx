// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationPreferencesPanel } from '../src/renderer/src/notifications/NotificationPreferencesPanel'
import { NotificationStore, type NotificationApi } from '../src/renderer/src/notifications/notification-store'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import type { NotificationPush } from '../src/domain/notification'

describe('precise notification settings with real persistent preferences', () => {
  let host: HTMLDivElement, root: Root, ledger: SqliteNotificationRepository, store: NotificationStore, api: NotificationApi, release: () => void
  const listeners = new Set<(value: NotificationPush) => void>()
  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div'); document.body.append(host); root = createRoot(host); ledger = new SqliteNotificationRepository(':memory:')
    api = { getNotificationPage: vi.fn(async () => ({ ...ledger.page(), delivery: { nativeSupported: true, state: 'ready' as const } })), getNotificationPreferences: async () => ledger.preferences(),
      saveNotificationPreferences: vi.fn(async value => { const preferences = ledger.savePreferences(value); for (const listener of listeners) listener({ preferences, health: 'ready', historyIncomplete: false }); return preferences }),
      onNotificationChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, readNotification: vi.fn(), readAllNotifications: vi.fn(), archiveNotification: vi.fn(), clearReadNotifications: vi.fn() }
    store = new NotificationStore(api); release = store.acquire(); await Promise.resolve(); await Promise.resolve()
    await act(async () => root.render(<NotificationPreferencesPanel store={store} />))
  })
  afterEach(async () => { await act(async () => root.unmount()); release(); host.remove(); listeners.clear(); ledger.close() })
  const control = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  const click = async (label: string) => { await act(async () => control(label).click()) }
  it('keeps all new intrusive channels off by default, with independent accessible controls and no history reload', async () => {
    for (const name of ['系统通知', '系统通知声音', '显示通知摘要', '连接变化', '完整新回复', '按时间暂停提醒']) expect(control(name).checked).toBe(false)
    expect(control('系统通知声音').disabled).toBe(true)
    const queries = vi.mocked(api.getNotificationPage).mock.calls.length
    await click('系统通知'); expect(ledger.preferences().nativeEnabled).toBe(true); expect(control('系统通知声音').disabled).toBe(false)
    await click('安静模式'); expect(ledger.preferences().quiet).toBe(true)
    expect(api.getNotificationPage).toHaveBeenCalledTimes(queries); expect(api.readNotification).not.toHaveBeenCalled()
  })
  it('legacy category mute can be enabled for one channel without unexpectedly enabling the other', async () => {
    await act(async () => store.savePreferences({ ...store.snapshot().preferences, mutedCategories: ['automation'] }))
    expect(control('自动化流程应用内提醒').checked).toBe(false); expect(control('自动化流程系统提醒').checked).toBe(false)
    await click('自动化流程系统提醒')
    expect(control('自动化流程应用内提醒').checked).toBe(false); expect(control('自动化流程系统提醒').checked).toBe(true)
    expect(ledger.preferences()).toMatchObject({ mutedCategories: [], inAppMutedCategories: ['automation'], nativeMutedCategories: [] })
    expect(ledger.page().summary.total).toBe(0)
  })
  it('failed save is not optimistically shown as an enabled feature, and can retry without losing other prefs', async () => {
    vi.mocked(api.saveNotificationPreferences).mockRejectedValueOnce(Error('disk full'))
    await click('系统通知'); expect(control('系统通知').checked).toBe(false); expect(host.querySelector('[role="alert"]')?.textContent).toContain('原设置保持不变')
    await click('系统通知'); expect(control('系统通知').checked).toBe(true); expect(ledger.preferences().sound).toBe(false)
  })
  it('time controls are labelled and explicitly explain all-day versus cross-midnight quiet', async () => {
    expect(control('定时安静开始时间').value).toBe('22:00'); expect(control('定时安静结束时间').value).toBe('08:00')
    await click('按时间暂停提醒'); expect(control('定时安静开始时间').disabled).toBe(false); expect(host.textContent).toContain('跨过午夜')
    await act(async () => store.savePreferences({ ...store.snapshot().preferences, quietHours: { enabled: true, startMinute: 600, endMinute: 600 } }))
    expect(host.textContent).toContain('全天安静'); expect(control('定时安静开始时间').value).toBe('10:00')
  })
  it('unsupported native environment is disclosed without pretending an OS grant or sending a test notice', async () => {
    await act(async () => store.accept({ health: 'ready', historyIncomplete: false, delivery: { nativeSupported: false, state: 'unsupported' } }))
    expect(control('系统通知').disabled).toBe(true); expect(host.textContent).toContain('当前运行环境不支持系统通知')
    expect(api.saveNotificationPreferences).not.toHaveBeenCalled()
  })
  it('separates native submission from its display callback without asserting permission or playing a test sound', async () => {
    await act(async () => store.accept({ health: 'ready', historyIncomplete: false, delivery: { nativeSupported: true, state: 'ready', nativeFeedback: 'unconfirmed' } }))
    expect(host.textContent).toContain('显示尚未确认')
    await act(async () => store.accept({ health: 'ready', historyIncomplete: false, delivery: { nativeSupported: true, state: 'ready', nativeFeedback: 'reported' } }))
    expect(host.textContent).toContain('显示已收到系统回执'); expect(host.textContent).not.toContain('权限已获准')
    expect(api.saveNotificationPreferences).not.toHaveBeenCalled()
  })
})
