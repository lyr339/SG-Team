import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NoticeIcon } from './NotificationCenter'
import { notificationTargetLabel } from './notification-view'
import type { NotificationStore, ToastCandidate } from './notification-store'
import { notificationIsUnread, type NotificationPush, type NotificationRecord } from '../../../domain/notification'

interface Props { store: NotificationStore; blocked: boolean; onOpen: (record: NotificationRecord) => void; onSnoozeUpdate?: (record: NotificationRecord) => Promise<void> }
function sourceResultVisible(record: NotificationRecord): boolean {
  if (!document.hasFocus() || !record.origin) return false
  // Only suppress when the exact source result is visible; selecting a session alone is not evidence of reading its latest reply.
  if (record.origin.module !== 'account' || !record.origin.section) return false
  const section = document.querySelector<HTMLElement>(`[data-notification-page="account:${record.origin.section}"]:not([hidden])`)
  const result = section?.querySelector<HTMLElement>('[data-notification-result]')
  if (!result) return false
  if (result.dataset.notificationKey !== record.key || result.dataset.notificationEvent !== record.eventId) return false
  const rect = result.getBoundingClientRect()
  return rect.width > 0 && Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0) >= Math.min(rect.height, 48)
}

export function NotificationToast({ store, blocked, onOpen, onSnoozeUpdate }: Props): React.JSX.Element | null {
  const [active, setActive] = useState<ToastCandidate>()
  const [focused, setFocused] = useState(() => document.hasFocus())
  const [hovering, setHovering] = useState(false)
  const [within, setWithin] = useState(false)
  const [error, setError] = useState('')
  const remaining = useRef({ key: '', ms: 5_000 })
  const choosing = useRef(false)
  const current = useRef(active); current.current = active
  const blockedRef = useRef(blocked); blockedRef.current = blocked
  const finish = (): void => {
    const item = current.current
    current.current = undefined
    setActive(undefined); setError(''); setHovering(false); setWithin(false)
    if (item) store.dismissToast(item.key)
  }
  const finishRef = useRef(finish); finishRef.current = finish
  useEffect(() => {
    const choose = (event?: NotificationPush): void => {
      if (choosing.current) return
      choosing.current = true
      try {
      const state = store.snapshot()
      if (current.current) {
        if (event?.change?.record?.id === current.current.record.id && (!notificationIsUnread(event.change.record) || event.change.record.state === 'expired')) { finishRef.current(); return }
        const preferences = state.preferences
        if (!preferences.enabled || preferences.quiet || preferences.mutedCategories.includes(current.current.record.category)) finishRef.current()
        return
      }
      if (!state.preferencesReady || !state.preferences.enabled || state.preferences.quiet || !document.hasFocus() || blockedRef.current) return
      const element = document.activeElement
      if (element instanceof HTMLElement && element.matches('textarea,input:not([type="checkbox"]):not([type="radio"]),[contenteditable="true"]')) return
      for (const item of state.toasts) {
        if (item.expiresAt <= Date.now() || sourceResultVisible(item.record)) { store.dismissToast(item.key); continue }
        remaining.current = { key: item.key, ms: item.record.category === 'updates' ? 15_000 : item.record.target ? 10_000 : 5_000 }
        current.current = item; setActive(item); break
      }
      } finally { choosing.current = false }
    }
    const stop = store.subscribe(choose)
    const onFocus = (): void => {
      setFocused(true)
      if (current.current && current.current.expiresAt <= Date.now()) finishRef.current()
      else choose()
    }
    const onBlur = (): void => { setFocused(false); setHovering(false) }
    window.addEventListener('focus', onFocus); window.addEventListener('blur', onBlur)
    choose()
    return () => { stop(); window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onBlur) }
  }, [store])
  useEffect(() => {
    if (!active || blocked || !focused || hovering || within) return
    if (active.expiresAt <= Date.now()) { finishRef.current(); return }
    const duration = remaining.current
    const started = performance.now()
    const timer = setTimeout(() => finishRef.current(), Math.max(0, duration.ms))
    return () => { clearTimeout(timer); duration.ms = Math.max(0, duration.ms - (performance.now() - started)) }
  }, [active, blocked, focused, hovering, within])
  useEffect(() => {
    if (active || blocked || !focused || !store.snapshot().preferencesReady || !store.snapshot().preferences.enabled || store.snapshot().preferences.quiet) return
    // Dismissal may be the last queue change. Re-check pending candidates once after the old card unmounts.
    const item = store.snapshot().toasts.find(value => value.expiresAt > Date.now() && !sourceResultVisible(value.record))
    if (item) { remaining.current = { key: item.key, ms: item.record.category === 'updates' ? 15_000 : item.record.target ? 10_000 : 5_000 }; current.current = item; setActive(item) }
  }, [active, blocked, focused, store])
  if (!active || blocked) return null
  return createPortal(<aside className="notification-toast" role="status" aria-live="polite" onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}
    onFocusCapture={() => setWithin(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setWithin(false) }}>
    <NoticeIcon tone={active.record.tone} />
    <div className="notification-toast__copy"><span>{active.record.source}</span><strong>{active.record.title}</strong>{active.record.detail ? <p>{active.record.detail}</p> : null}
      <div className="notification-toast__actions"><button type="button" onClick={() => { onOpen(active.record); finish() }}>{notificationTargetLabel(active.record.target)}</button>
        {active.record.category === 'updates' && (active.record.eventId?.startsWith('update:available:') || active.record.eventId?.startsWith('update:downloaded:')) && onSnoozeUpdate ? <button type="button" onClick={() => { void onSnoozeUpdate(active.record).then(finish).catch(() => setError('更新状态可能已变化；未延后其他版本，请到软件更新查看。')) }}>稍后</button> : null}</div>
      {error ? <p className="notification-toast__error" role="alert">{error}</p> : null}
    </div>
    <button className="notification-icon-button" type="button" aria-label="收起提醒" onClick={finish}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
  </aside>, document.body)
}
