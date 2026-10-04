import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { NotificationRecord, NotificationScope, NotificationTarget } from '../../../domain/notification'
import { NotificationCenter } from './NotificationCenter'
import { NotificationStore } from './notification-store'
import { NotificationToast } from './NotificationToast'
import './notifications.css'

interface Props {
  workspaceId?: string
  onNavigate: (target: NotificationTarget, scope?: NotificationScope) => boolean | Promise<boolean>
  onAvailable: (available: boolean) => void
  onSnoozeUpdate: (record: NotificationRecord) => Promise<void>
}
export function NotificationSystem({ workspaceId, onNavigate, onAvailable, onSnoozeUpdate }: Props): React.JSX.Element | null {
  const api = typeof window !== 'undefined' ? window.sgDesktop : undefined
  const store = useMemo(() => api && typeof api.getNotificationPage === 'function' && typeof api.onNotificationChanged === 'function' ? new NotificationStore(api) : undefined, [api])
  return store ? <NotificationEntry store={store} workspaceId={workspaceId} onNavigate={onNavigate} onAvailable={onAvailable} onSnoozeUpdate={onSnoozeUpdate} /> : null
}

function NotificationEntry({ store, workspaceId, onNavigate, onAvailable, onSnoozeUpdate }: Props & { store: NotificationStore }): React.JSX.Element {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [open, setOpen] = useState(false)
  const [focusRecord, setFocusRecord] = useState<NotificationRecord>()
  const [position, setPosition] = useState({ top: 52, right: 16 })
  const [navigationError, setNavigationError] = useState('')
  const [otherModal, setOtherModal] = useState(false)
  const [toastRecord, setToastRecord] = useState<NotificationRecord>()
  const [toastFocus, setToastFocus] = useState(0)
  const groupedToast = useRef(false)
  const toastEpoch = useRef(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const navigationRef = useRef(onNavigate); navigationRef.current = onNavigate
  const close = useCallback((restore = true): void => { ++toastEpoch.current; setOpen(false); setNavigationError(''); setFocusRecord(undefined); if (restore) trigger.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => store.acquire(), [store])
  useEffect(() => onAvailable(snapshot.available && snapshot.health === 'ready'), [onAvailable, snapshot.available, snapshot.health])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const element = document.activeElement
        const editing = element instanceof HTMLElement && (element.matches('textarea,input:not([type="checkbox"]):not([type="radio"]),[contenteditable="true"]') || element.isContentEditable)
        setOtherModal(Boolean(editing || document.querySelector('[role="dialog"][aria-modal="true"]')))
      }, 0)
    }
    for (const name of ['pointerup', 'keyup', 'focusin']) document.addEventListener(name, check)
    check()
    return () => { if (timer) clearTimeout(timer); for (const name of ['pointerup', 'keyup', 'focusin']) document.removeEventListener(name, check) }
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) setPosition({ top: rect.bottom + 8, right: Math.max(12, innerWidth - rect.right) })
    }
    place(); panel.current?.querySelector<HTMLElement>('.notification-panel')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])
  useEffect(() => {
    if (!toastRecord) return
    const epoch = ++toastEpoch.current
    void (async () => {
      try {
        if (toastRecord.target && await navigationRef.current(toastRecord.target, toastRecord.scope)) {
          if (!groupedToast.current) await store.read(toastRecord).catch(() => {})
          if (epoch === toastEpoch.current) close(false)
        } else if (epoch === toastEpoch.current) {
          setFocusRecord(groupedToast.current ? undefined : toastRecord)
          if (toastRecord.target) setNavigationError('来源对象或执行范围已变化。原结果保留，可在此阅读详情。')
        }
      } catch { if (epoch === toastEpoch.current) setNavigationError('暂时无法打开来源，记录仍保留。') }
    })()
  }, [toastFocus, toastRecord, store, close])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event): void => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close() }
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape) }
  }, [open, close])
  const navigate = async (record: NotificationRecord): Promise<void> => {
    if (!record.target) { setFocusRecord(record); setOpen(true); return }
    try {
      if (await onNavigate(record.target, record.scope)) close(false)
      else { setOpen(true); setFocusRecord(record); setNavigationError('来源对象或执行范围已变化。原结果保留，可在此阅读详情。') }
    } catch { setOpen(true); setNavigationError('暂时无法打开来源，记录仍保留。') }
  }
  const unread = snapshot.summary.unread
  return <>
    <button ref={trigger} className={`panel-button notification-trigger${open ? ' is-active' : ''}`} type="button" aria-label={`通知${unread ? `，${unread} 条未读` : ''}`} aria-expanded={open} aria-haspopup="dialog"
      title={snapshot.preferences.quiet ? '通知 · 安静模式' : '通知'} onClick={() => { if (open) close(); else { setFocusRecord(undefined); setOpen(true); void store.refresh() } }}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 8a4.5 4.5 0 0 1 9 0v3.2l1.4 2.3H4.1l1.4-2.3V8ZM8.2 16a2 2 0 0 0 3.6 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {unread > 0 ? <span>{unread > 99 ? '99+' : unread}</span> : null}
    </button>
    {open ? createPortal(<div ref={panel} className="notification-panel-anchor" style={position}>
      <NotificationCenter store={store} workspaceId={workspaceId} onClose={close} onNavigate={navigate} focusRecord={focusRecord} navigationError={navigationError} />
    </div>, document.body) : null}
    <NotificationToast store={store} blocked={open || otherModal} onOpen={(record, grouped) => {
      // Open a focusable surface synchronously before removing the toast button; then navigate from an effect.
      groupedToast.current = grouped === true
      setToastRecord(record); setFocusRecord(undefined); setNavigationError(''); setToastFocus(value => value + 1); setOpen(true)
    }} onSnoozeUpdate={onSnoozeUpdate} />
  </>
}
