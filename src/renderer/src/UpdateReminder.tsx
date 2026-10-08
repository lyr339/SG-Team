import { NotificationCard } from './notifications/NotificationCard'
import { useEffect, useRef, useState } from 'react'
import type { AppUpdateStatus } from '../../domain/app-update'

/** 小提醒框自动收起的时长；收起后齿轮角标仍在，直到用户处理或选择稍后。 */
export const UPDATE_REMINDER_AUTO_HIDE_MS = 15_000

type ReminderApi = Pick<Window['sgDesktop'], 'getAppUpdateStatus' | 'onAppUpdateStatus' | 'snoozeAppUpdate'>

function reminderApi(): ReminderApi | undefined {
  const api = typeof window !== 'undefined' ? window.sgDesktop : undefined
  return api && typeof api.getAppUpdateStatus === 'function' ? api : undefined
}

/** 订阅主进程的自更新状态（拉一次 + 推送）；没有桌面 API（测试 / 老预览）时恒为 undefined。 */
export function useAppUpdateStatus(initial?: AppUpdateStatus): AppUpdateStatus | undefined {
  const [status, setStatus] = useState<AppUpdateStatus | undefined>(initial)
  useEffect(() => {
    const api = reminderApi()
    if (!api) return
    let cancelled = false, pushed = false
    const unsubscribe = api.onAppUpdateStatus(next => { pushed = true; if (!cancelled) setStatus(next) })
    void api.getAppUpdateStatus().then(next => { if (!cancelled && !pushed) setStatus(next) }).catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return status
}

interface UpdateReminderProps {
  status: AppUpdateStatus | undefined
  /** 「查看」：跳到设置页的软件更新组。 */
  onOpen: () => void
  autoHideMs?: number
}

/**
 * 有新版本时的小提醒框：右下角一张小卡，不挡内容、不抢焦点；15 秒后自动收起，
 * 每个版本每次运行只出现一次。「稍后」= 24 小时内不再提醒（主进程记账）。
 */
export function UpdateReminder({ status, onOpen, autoHideMs = UPDATE_REMINDER_AUTO_HIDE_MS }: UpdateReminderProps): React.JSX.Element | null {
  const version = status?.reminderVersion
  const [shownFor, setShownFor] = useState<string>()
  const [hidden, setHidden] = useState(false)
  const remaining = useRef(autoHideMs)
  const [hovering, setHovering] = useState(false), [within, setWithin] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const busy = useRef(false), alive = useRef(true), currentVersion = useRef(version); currentVersion.current = version
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!version || shownFor === version) return
    remaining.current = autoHideMs; setShownFor(version); setHidden(false); setError('')
  }, [autoHideMs, shownFor, version])
  useEffect(() => {
    if (!version || shownFor !== version || hidden || hovering || within || saving) return
    const started = Date.now(), timer = setTimeout(() => setHidden(true), remaining.current)
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)) }
  }, [version, shownFor, hidden, hovering, within, saving])
  const snooze = async (): Promise<void> => {
    const wanted = version, api = reminderApi()
    if (busy.current || !wanted) return
    if (!api) { setError('稍后提醒暂未保存，可到软件更新页查看。'); return }
    busy.current = true; setSaving(true); setError('')
    try { await api.snoozeAppUpdate({ expectedVersion: wanted }); if (alive.current && currentVersion.current === wanted) setHidden(true) }
    catch { if (alive.current && currentVersion.current === wanted) setError('稍后提醒未能保存；当前版本提示仍保留。') }
    finally { busy.current = false; if (alive.current) setSaving(false) }
  }

  if (!version || hidden || shownFor !== version) return null
  const phase = status?.state.phase
  const ready = phase === 'downloaded'
  return <NotificationCard className="update-reminder" title={ready ? `拾光 ${version} 已下载好` : `拾光 ${version} 可用`} source="软件更新" detail={ready ? '到「软件更新」里点安装即可' : '有空时到「软件更新」看看'} error={error} onDismiss={() => setHidden(true)} onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)} onFocusCapture={() => setWithin(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setWithin(false) }} actions={<>
    <button type="button" className="update-reminder__button is-primary" onClick={() => { setHidden(true); onOpen() }}>查看</button>
    <button type="button" className="update-reminder__button" disabled={saving} aria-busy={saving} onClick={() => void snooze()}>{saving ? '保存中…' : '稍后'}</button>
  </>}/>
}
