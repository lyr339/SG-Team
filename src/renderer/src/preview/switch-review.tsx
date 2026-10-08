import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '../../../domain/notification'
import { ToggleSwitch } from '../lobby/ToggleSwitch'
import { NotificationPreferencesPanel } from '../notifications/NotificationPreferencesPanel'
import { NotificationStore, type NotificationApi } from '../notifications/notification-store'
import '../notifications/notifications.css'
import './switch-review.css'

function DemoSwitch({ label, checked, disabled, busy }: { label: string; checked: boolean; disabled?: boolean; busy?: boolean }): React.JSX.Element {
  const [value, setValue] = useState(checked)
  return <div className="switch-review__row"><span>{label}</span><ToggleSwitch checked={value} disabled={disabled} busy={busy} label={label} onChange={setValue} /></div>
}

/** Production switch components with an in-memory preference adapter. No
 * desktop bridge, account, source workflow or network request is used. */
export function SwitchReview(): React.JSX.Element {
  const [scale, setScale] = useState(1), [mode, setMode] = useState<'light' | 'dark'>('dark')
  const store = useMemo(() => {
    let preferences: NotificationPreferences = { ...structuredClone(DEFAULT_NOTIFICATION_PREFERENCES), nativeEnabled: true }
    const listeners = new Set<Parameters<NotificationApi['onNotificationChanged']>[0]>()
    const unused = async (): Promise<never> => { throw Error('Switch geometry fixture never mutates business notifications') }
    const api: NotificationApi = {
      getNotificationPage: async () => ({ records: [], reset: false, summary: { revision: 0, total: 0, pending: 0, unread: 0, clearable: 0 }, delivery: { state: 'ready', nativeSupported: true } }),
      getNotificationPreferences: async () => structuredClone(preferences),
      saveNotificationPreferences: async value => { preferences = structuredClone(value); for (const listener of listeners) listener({ preferences, health: 'ready', historyIncomplete: false }); return structuredClone(preferences) },
      onNotificationChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      readNotification: unused, readAllNotifications: unused, archiveNotification: unused, clearReadNotifications: unused
    }
    return new NotificationStore(api)
  }, [])
  useEffect(() => store.acquire(), [store])
  return <main className="switch-review" style={{ colorScheme: mode }}>
    <header><h1>开关 · 几何走查</h1><p>真实组件，纯内存状态；不修改软件设置或执行业务。</p>
      <div role="group" aria-label="走查主题"><button type="button" onClick={() => setMode('light')} aria-pressed={mode === 'light'}>浅色</button><button type="button" onClick={() => setMode('dark')} aria-pressed={mode === 'dark'}>深色</button></div>
      <div role="group" aria-label="走查缩放">{[1, 1.25, 1.5, 1.75, 2].map(value => <button type="button" key={value} onClick={() => setScale(value)} aria-pressed={scale === value}>{value * 100}%</button>)}</div>
    </header>
    <div className="switch-review__canvas" style={{ zoom: scale }} data-switch-scale={scale}>
      <section><h2>共用开关</h2><p>自动化、维护、更新、清理、模型和启动设置均使用此组件。</p>
        <DemoSwitch label="普通 · 关闭" checked={false} /><DemoSwitch label="普通 · 开启" checked />
        <DemoSwitch label="禁用 · 关闭" checked={false} disabled /><DemoSwitch label="禁用 · 开启" checked disabled />
        <DemoSwitch label="保存中 · 关闭" checked={false} busy /><DemoSwitch label="保存中 · 开启" checked busy />
      </section>
      <section><h2>通知开关</h2><NotificationPreferencesPanel store={store} /></section>
    </div>
  </main>
}
