import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { NotificationRecord, NotificationScope, NotificationTarget } from '../../../domain/notification'
import { NotificationCenter } from './NotificationCenter'
import { NotificationStore } from './notification-store'
import { NotificationToast } from './NotificationToast'
import './notifications.css'
import { notificationPanelPlacement } from './notification-panel-placement'

interface Props {
  workspaceId?: string
  onNavigate: (target: NotificationTarget, scope?: NotificationScope,stillRelevant?:()=>boolean) => boolean | Promise<boolean>
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
  const [position, setPosition] = useState({ top: 52, right: 16, height: 672 })
  const [navigationError, setNavigationError] = useState('')
  const [otherModal, setOtherModal] = useState(false)
  const [blockingDialog, setBlockingDialog] = useState(false)
  const [nativeOpenToken, setNativeOpenToken] = useState('')
  const consumedNativeOpen = useRef('')
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
        const modal = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
        setOtherModal(Boolean(editing || modal)); setBlockingDialog(modal)
      }, 0)
    }
    for (const name of ['pointerup', 'keyup', 'focusin']) document.addEventListener(name, check)
    window.addEventListener('focus', check); check()
    return () => { if (timer) clearTimeout(timer); window.removeEventListener('focus', check); for (const name of ['pointerup', 'keyup', 'focusin']) document.removeEventListener(name, check) }
  }, [])
  useEffect(() => {
    const request = snapshot.openRequested
    if (!request || consumedNativeOpen.current === request.token || blockingDialog || document.querySelector('[role="dialog"][aria-modal="true"]')) return
    consumedNativeOpen.current = request.token
    const epoch = ++toastEpoch.current
    let active = true, applied = false
    setOpen(true); setFocusRecord(undefined); setNavigationError(''); setNativeOpenToken(request.token)
    void store.api.getNotificationPage({ key: request.key, limit: 1 }).then(page => {
      if (!active || toastEpoch.current !== epoch) return
      applied = true
      const record = page.records.find(record => record.id === request.recordId)
      if (!record) { setNavigationError('这条通知已归档或清理。其他保存记录仍可查看。'); return }
      if (!request.grouped) setFocusRecord(record)
      if (record.revision !== request.revision) setNavigationError('这条通知已有新结果，当前显示的是已保存的最新内容。')
    }).catch(() => { if (active && toastEpoch.current === epoch) { applied = true; setNavigationError('这条通知暂不可读取，可在通知中心重试。') } })
    return () => {
      active = false
      // A blocking modal arriving during lookup is not a completed navigation.
      // An explicit user close increments the epoch and intentionally consumes it.
      if (!applied && toastEpoch.current === epoch && consumedNativeOpen.current === request.token) consumedNativeOpen.current = ''
    }
  }, [snapshot.openRequested, blockingDialog, store])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect) {
        const next = notificationPanelPlacement({ width: innerWidth, height: innerHeight }, rect)
        setPosition(old => old.top === next.top && old.right === next.right && old.height === next.height ? old : next)
      }
    }
    place(); panel.current?.querySelector<HTMLElement>('.notification-panel')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (trigger.current) observer?.observe(trigger.current)
    if (trigger.current?.parentElement) observer?.observe(trigger.current.parentElement)
    return () => { window.removeEventListener('resize', place); observer?.disconnect() }
  }, [open])
  useEffect(() => {
    if (!toastRecord) return
    const epoch = ++toastEpoch.current
    void (async () => {
      try {
        if (toastRecord.target && await navigationRef.current(toastRecord.target, toastRecord.scope,()=>epoch===toastEpoch.current)) {
          // Navigating to a route is not proof the specific result was rendered.
          // Source visibility hooks or explicit center reading own the human receipt.
          if (epoch === toastEpoch.current) close(false)
        } else if (epoch === toastEpoch.current) {
          setFocusRecord(groupedToast.current ? undefined : toastRecord)
          if (toastRecord.target) setNavigationError('来源内容或执行范围已变化，或原正文尚未准备好。通知记录保留，可在此阅读详情。')
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
    const epoch=++toastEpoch.current
    try {
      const available=await onNavigate(record.target, record.scope,()=>epoch===toastEpoch.current)
      if(epoch!==toastEpoch.current)return // A user close/new navigation cancels presentation, not the original read.
      if (available) close(false)
      else { setOpen(true); setFocusRecord(record); setNavigationError('来源内容或执行范围已变化，或原正文尚未准备好。通知记录保留，可在此阅读详情。') }
    } catch { if(epoch===toastEpoch.current){setOpen(true);setNavigationError('暂时无法打开来源，记录仍保留。')} }
  }
  const unread = snapshot.summary.unread
  return <>
    <button ref={trigger} className={`panel-button notification-trigger${open ? ' is-active' : ''}`} type="button" aria-label={`通知${unread ? `，${unread} 条未读` : ''}`} aria-expanded={open} aria-haspopup="dialog"
      title={snapshot.preferences.quiet ? '通知 · 安静模式' : '通知'} onClick={() => { if (open) close(); else { setFocusRecord(undefined); setOpen(true); void store.refresh() } }}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 8a4.5 4.5 0 0 1 9 0v3.2l1.4 2.3H4.1l1.4-2.3V8ZM8.2 16a2 2 0 0 0 3.6 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {unread > 0 ? <span>{unread > 99 ? '99+' : unread}</span> : null}
    </button>
    {open ? createPortal(<div ref={panel} className="notification-panel-anchor" style={{ top: position.top, right: position.right, '--notification-panel-height': `${position.height}px` } as React.CSSProperties}>
      <NotificationCenter key={nativeOpenToken} store={store} workspaceId={workspaceId} onClose={close} onNavigate={navigate} focusRecord={focusRecord} navigationError={navigationError} />
    </div>, document.body) : null}
    <NotificationToast store={store} blocked={open || otherModal} onOpen={(record, grouped) => {
      // Open a focusable surface synchronously before removing the toast button; then navigate from an effect.
      groupedToast.current = grouped === true
      setToastRecord(record); setFocusRecord(undefined); setNavigationError(''); setToastFocus(value => value + 1); setOpen(true)
    }} onSnoozeUpdate={onSnoozeUpdate} />
  </>
}
