import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { NOTIFICATION_CATEGORIES, type NotificationCategory, type NotificationPreferences } from '../../../domain/notification'
import type { NotificationStore } from './notification-store'

const names: Record<NotificationCategory, string> = { sessions: '会话与问卷', run: '批量运行', team: '团队协作', accounts: '账号操作', automation: '自动化流程', processing: '处理服务', maintenance: 'Cursor 维护', storage: '存储与文件', updates: '软件更新', usage: '用量与上下文' }
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const minute = (text: string) => /^\d{2}:\d{2}$/.test(text) && Number(text.slice(0, 2)) < 24 && Number(text.slice(3)) < 60 ? Number(text.slice(0, 2)) * 60 + Number(text.slice(3)) : undefined

/** Independent scrolling settings view; no source workflow is executed by any of these controls. */
export function NotificationPreferencesPanel({ store }: { store: NotificationStore }): React.JSX.Element {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot), preferences = snapshot.preferences
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const alive = useRef(true), busy = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const save = async (update: (current: NotificationPreferences) => NotificationPreferences): Promise<void> => {
    if (busy.current || !store.snapshot().preferencesReady) return
    busy.current = true; setSaving(true); setError('')
    try { await store.savePreferences(update(store.snapshot().preferences)) }
    catch { if (alive.current) setError('设置未能保存，原设置保持不变。') }
    finally { busy.current = false; if (alive.current) setSaving(false) }
  }
  const disabled = saving || !snapshot.preferencesReady
  const flag = (key: 'enabled' | 'quiet' | 'nativeEnabled' | 'sound' | 'preview' | 'connectionUpdates' | 'replyUpdates', title: string, description: string, off = false) =>
    <label className="notification-preference"><span><strong>{title}</strong><small>{description}</small></span><input type="checkbox" role="switch" aria-label={title} checked={preferences[key] === true}
      disabled={disabled || off} onChange={event => { const next = event.target.checked; void save(current => ({ ...current, [key]: next })) }} /><i aria-hidden="true" /></label>
  const hours = preferences.quietHours ?? { enabled: false, startMinute: 1_320, endMinute: 480 }
  const category = (id: NotificationCategory, channel: 'inAppMutedCategories' | 'nativeMutedCategories', enabled: boolean): void => {
    void save(current => {
      let app = [...current.inAppMutedCategories ?? []], native = [...current.nativeMutedCategories ?? []]
      if (current.mutedCategories.includes(id)) { app = [...new Set([...app, id])]; native = [...new Set([...native, id])] }
      const values = channel === 'inAppMutedCategories' ? app : native
      return { ...current, mutedCategories: current.mutedCategories.filter(value => value !== id), inAppMutedCategories: app, nativeMutedCategories: native,
        [channel]: enabled ? values.filter(value => value !== id) : [...new Set([...values, id])] }
    })
  }
  return <div className="notification-preferences">
    <p className="notification-preferences__intro">只控制如何提醒。关闭或静音后，结果和待处理事项仍会保留。</p>
    {error ? <p className="notification-preferences__feedback" role="alert">{error}</p> : null}
    {snapshot.preferencesError ? <p className="notification-preferences__feedback" role="status">{snapshot.preferencesError}</p> : null}
    <section aria-label="提醒总开关">
      {flag('enabled', '开启提醒', '不影响业务执行、通知记录和未读状态。')}
      {flag('quiet', '安静模式', '暂停应用内与系统提醒，不会把事项标为已读。', !preferences.enabled)}
    </section>
    <section aria-labelledby="notification-native-heading"><h3 id="notification-native-heading">离开拾光时</h3>
      {flag('nativeEnabled', '系统通知', '仅在拾光不处于前台时使用，不与应用内提醒重复。', !preferences.enabled || snapshot.delivery?.nativeSupported === false)}
      <p className="notification-preferences__note">{snapshot.delivery?.nativeSupported === false ? '当前运行环境不支持系统通知。' : '是否显示还取决于系统权限和勿扰设置；开启不会立即发送测试通知。'}</p>
      {snapshot.delivery?.message ? <p className="notification-preferences__feedback" role="status">{snapshot.delivery.message}</p> : null}
      {snapshot.delivery?.state === 'failed' ? <p className="notification-preferences__note">排除问题后，可关闭再开启系统通知；只尝试新的提醒，不重发旧结果。</p> : null}
      {flag('sound', '系统通知声音', '默认静音；仍遵循系统声音和勿扰设置。', !preferences.enabled || !preferences.nativeEnabled)}
      {flag('preview', '显示通知摘要', '默认仅提示有通知，不显示模型消息或账号信息。', !preferences.enabled || !preferences.nativeEnabled)}
    </section>
    <section aria-labelledby="notification-density-heading"><h3 id="notification-density-heading">额外动态</h3>
      {flag('connectionUpdates', '连接变化', '后台额外提醒真实上线与恢复，不增加待处理数量。', !preferences.enabled || !preferences.nativeEnabled)}
      {flag('replyUpdates', '完整新回复', '后台额外提醒完整回复，不提醒每个 Token 或过程步骤。', !preferences.enabled || !preferences.nativeEnabled)}
      <p className="notification-preferences__note">这两项默认关闭。可在某条会话通知的详情中设置重点关注或安静。</p>
    </section>
    <section aria-labelledby="notification-hours-heading"><h3 id="notification-hours-heading">定时安静</h3>
      <label className="notification-preference"><span><strong>按时间暂停提醒</strong><small>使用本机时间，不会删除或自动已读通知。</small></span><input type="checkbox" role="switch" aria-label="按时间暂停提醒" checked={hours.enabled} disabled={disabled || !preferences.enabled}
        onChange={event => { const enabled = event.target.checked; void save(current => ({ ...current, quietHours: { ...hours, enabled } })) }} /><i aria-hidden="true" /></label>
      <div className="notification-hours"><label>开始<input type="time" aria-label="定时安静开始时间" value={clock(hours.startMinute)} disabled={disabled || !hours.enabled || !preferences.enabled} onChange={event => {
        const startMinute = minute(event.target.value); if (startMinute !== undefined) void save(current => ({ ...current, quietHours: { ...hours, startMinute } }))
      }} /></label><span aria-hidden="true">—</span><label>结束<input type="time" aria-label="定时安静结束时间" value={clock(hours.endMinute)} disabled={disabled || !hours.enabled || !preferences.enabled} onChange={event => {
        const endMinute = minute(event.target.value); if (endMinute !== undefined) void save(current => ({ ...current, quietHours: { ...hours, endMinute } }))
      }} /></label></div>
      {hours.enabled ? <p className="notification-preferences__note">{hours.startMinute === hours.endMinute ? '开始与结束相同：全天安静。' : hours.startMinute > hours.endMinute ? '跨过午夜，次日恢复提醒。' : '仅在所选时段暂停提醒。'}不会补播期间积压的普通成功提醒。</p> : null}
    </section>
    <section aria-labelledby="notification-category-heading"><h3 id="notification-category-heading">通知类别</h3><p className="notification-preferences__note">分别选择应用内提醒和系统提醒。记录不受影响。</p>
      <table className="notification-category-table"><thead><tr><th scope="col">类别</th><th scope="col">应用内</th><th scope="col">系统</th></tr></thead><tbody>{NOTIFICATION_CATEGORIES.map(id => <tr key={id}><th scope="row">{names[id]}</th>
        <td><label><input type="checkbox" aria-label={`${names[id]}应用内提醒`} disabled={disabled || !preferences.enabled} checked={!preferences.mutedCategories.includes(id) && !preferences.inAppMutedCategories?.includes(id)}
          onChange={event => category(id, 'inAppMutedCategories', event.target.checked)} /></label></td>
        <td><label><input type="checkbox" aria-label={`${names[id]}系统提醒`} disabled={disabled || !preferences.enabled || snapshot.delivery?.nativeSupported === false} checked={!preferences.mutedCategories.includes(id) && !preferences.nativeMutedCategories?.includes(id)}
          onChange={event => category(id, 'nativeMutedCategories', event.target.checked)} /></label></td></tr>)}</tbody></table>
    </section>
    <p className="notification-preferences__save" role="status" aria-live="polite">{saving ? '正在保存…' : '设置自动保存'}</p>
  </div>
}
