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
    let cancelled = false
    void api.getAppUpdateStatus().then((next) => { if (!cancelled) setStatus(next) }).catch(() => {})
    const unsubscribe = api.onAppUpdateStatus((next) => setStatus(next))
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
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!version || shownFor === version) return
    setShownFor(version)
    setHidden(false)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setHidden(true), autoHideMs)
  }, [autoHideMs, shownFor, version])
  // 只在卸载时清定时器：上面的 effect 因 shownFor 变化会立刻重跑，不能把清理挂在它身上。
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!version || hidden || shownFor !== version) return null
  const phase = status?.state.phase
  const ready = phase === 'downloaded'
  return (
    <div className="update-reminder" role="status" aria-live="polite">
      <div className="update-reminder__copy">
        <strong>{ready ? `拾光 ${version} 已下载好` : `拾光 ${version} 可用`}</strong>
        <span>{ready ? '到「软件更新」里点安装即可' : '有空时到「软件更新」看看'}</span>
      </div>
      <div className="update-reminder__actions">
        <button
          type="button"
          className="update-reminder__button is-primary"
          onClick={() => {
            setHidden(true)
            onOpen()
          }}
        >
          查看
        </button>
        <button
          type="button"
          className="update-reminder__button"
          onClick={() => {
            setHidden(true)
            void reminderApi()?.snoozeAppUpdate().catch(() => {})
          }}
        >
          稍后
        </button>
      </div>
      <button type="button" className="update-reminder__close" aria-label="收起提醒" onClick={() => setHidden(true)}>×</button>
    </div>
  )
}
