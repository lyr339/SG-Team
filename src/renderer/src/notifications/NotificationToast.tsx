import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NoticeIcon } from './NotificationCenter'
import { notificationTargetLabel } from './notification-view'
import type { NotificationStore, ToastCandidate } from './notification-store'
import { notificationIsUnread, type NotificationPush, type NotificationRecord } from '../../../domain/notification'
import { notificationElementVisible } from './notification-visible'
import { notificationSessionScopeMatches } from './notification-session-scope'
import { notificationIsQuiet, notificationSessionMode } from '../../../domain/notification-delivery-policy'
import { mcpWriteResultElement } from './mcp-write-result-element'
import { operatorMessageResultElement } from './operator-message-result-element'

function nextReminder(store: NotificationStore): ToastCandidate[] {
  const preferences = store.snapshot().preferences
  const priority = (item: ToastCandidate) => (item.record.attention === 'action' ? 4 : 0) + (notificationSessionMode(item.record, preferences) === 'focus' ? 2 : 0)
    + (item.record.tone === 'warning' || item.record.tone === 'error' ? 1 : 0)
  // Sort only waiting opportunities. The active hovered/focused card stays pinned.
  return [...store.snapshot().toasts].sort((a, b) => priority(b) - priority(a))
}

interface Props { store: NotificationStore; blocked: boolean; onOpen: (record: NotificationRecord, grouped?: boolean) => void; onSnoozeUpdate?: (record: NotificationRecord) => Promise<void> }
function sourceResultVisible(record: NotificationRecord): boolean {
  if (!document.hasFocus() || !record.origin) return false
  if (record.eventType === 'mcp.write-result') {
    const result = mcpWriteResultElement(document, record)
    return Boolean(result && notificationElementVisible(result))
  }
  if (record.eventType === 'team.operator-message') {
    const result = operatorMessageResultElement(document, record)
    return Boolean(result && notificationElementVisible(result))
  }
  if (record.eventType === 'question.state' && record.target?.kind === 'session') {
    const toolCallId = record.target.toolCallId
    return [...document.querySelectorAll<HTMLElement>('[data-tool-call-id][data-notification-session]')].some(element =>
      element.dataset.toolCallId === toolCallId && element.dataset.questionStatus === record.subjectState
      && notificationSessionScopeMatches(record.scope, { sessionId: element.dataset.notificationSession, generation: element.dataset.notificationGeneration,
        composerId: element.dataset.notificationComposer, bindingGeneration: element.dataset.notificationBinding, channelId: record.scope.channelId }) && notificationElementVisible(element))
  }
  // Only suppress when the exact source result is visible; selecting a session alone is not evidence of reading its latest reply.
  const page = record.origin.module === 'account' ? `account:${record.origin.section ?? ''}` : record.origin.module
  const sections = [...document.querySelectorAll<HTMLElement>('[data-notification-page]')].filter(element => element.dataset.notificationPage === page
    && !element.closest('[hidden],[inert],[aria-hidden="true"]')
    && (!record.origin!.sessionId || element.dataset.notificationSession === record.origin!.sessionId))
  const result = sections.flatMap(section => section.matches('[data-notification-result]') ? [section] : [...section.querySelectorAll<HTMLElement>('[data-notification-result]')])
    .find(element => element.dataset.notificationKey === record.key && element.dataset.notificationEvent === record.eventId)
  if (!result) return false
  if (result.dataset.notificationKey !== record.key || result.dataset.notificationEvent !== record.eventId) return false
  return notificationElementVisible(result)
}

export function NotificationToast({ store, blocked, onOpen, onSnoozeUpdate }: Props): React.JSX.Element | null {
  const [active, setActive] = useState<ToastCandidate>()
  const [focused, setFocused] = useState(() => document.hasFocus())
  const [hovering, setHovering] = useState(false)
  const [within, setWithin] = useState(false)
  const [error, setError] = useState('')
  const [placement, setPlacement] = useState({ bottom: 16, visible: true })
  const toastRef = useRef<HTMLElement>(null)
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
  useLayoutEffect(() => {
    if (!active || blocked) return
    const composer = document.querySelector<HTMLElement>('.workspace-composer')
    const place = (): void => {
      const height = toastRef.current?.getBoundingClientRect().height ?? 0
      const composerRect = composer?.getBoundingClientRect()
      const headerBottom = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 48
      const bottom = composerRect && composerRect.width > 0 && composerRect.height > 0 ? Math.max(16, innerHeight - composerRect.top + 12) : 16
      const visible = innerHeight - bottom - height >= headerBottom + 8
      setPlacement(old => old.bottom === bottom && old.visible === visible ? old : { bottom, visible })
    }
    place()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : undefined
    if (composer) observer?.observe(composer)
    if (toastRef.current) observer?.observe(toastRef.current)
    window.addEventListener('resize', place)
    return () => { observer?.disconnect(); window.removeEventListener('resize', place) }
  }, [active, blocked])
  useEffect(() => {
    const choose = (event?: NotificationPush): void => {
      if (choosing.current) return
      choosing.current = true
      try {
      const state = store.snapshot()
      if (current.current) {
        if (event?.change?.record?.id === current.current.record.id && (!notificationIsUnread(event.change.record) || event.change.record.state === 'expired')) { finishRef.current(); return }
        const preferences = state.preferences
        if (notificationIsQuiet(preferences, Date.now()) || preferences.mutedCategories.includes(current.current.record.category)
          || preferences.inAppMutedCategories?.includes(current.current.record.category) || notificationSessionMode(current.current.record, preferences) === 'quiet') finishRef.current()
        return
      }
      if (!state.preferencesReady || notificationIsQuiet(state.preferences, Date.now()) || !document.hasFocus() || blockedRef.current) return
      const element = document.activeElement
      if (element instanceof HTMLElement && element.matches('textarea,input:not([type="checkbox"]):not([type="radio"]),[contenteditable="true"]')) return
      for (const item of nextReminder(store)) {
        const visible = item.grouped ? Boolean(item.sourceRecords?.length && item.sourceRecords.every(sourceResultVisible)) : sourceResultVisible(item.record)
        if (item.expiresAt <= Date.now() || visible) { store.dismissToast(item.key); continue }
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
    if (!active || blocked || !focused || hovering || within || !placement.visible) return
    if (active.expiresAt <= Date.now()) { finishRef.current(); return }
    const duration = remaining.current
    const started = performance.now()
    const timer = setTimeout(() => finishRef.current(), Math.max(0, duration.ms))
    return () => { clearTimeout(timer); duration.ms = Math.max(0, duration.ms - (performance.now() - started)) }
  }, [active, blocked, focused, hovering, within, placement.visible])
  useEffect(() => {
    if (active || blocked || !focused || !store.snapshot().preferencesReady || notificationIsQuiet(store.snapshot().preferences, Date.now())) return
    // Dismissal may be the last queue change. Re-check pending candidates once after the old card unmounts.
    const item = nextReminder(store).find(value => value.expiresAt > Date.now() && !sourceResultVisible(value.record))
    if (item) { remaining.current = { key: item.key, ms: item.record.category === 'updates' ? 15_000 : item.record.target ? 10_000 : 5_000 }; current.current = item; setActive(item) }
  }, [active, blocked, focused, store])
  if (!active || blocked) return null
  return createPortal(<aside ref={toastRef} className="notification-toast" role="status" aria-live="polite" aria-hidden={!placement.visible} inert={!placement.visible}
    style={{ bottom: placement.bottom, visibility: placement.visible ? undefined : 'hidden' }} onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}
    onFocusCapture={() => setWithin(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setWithin(false) }}>
    <NoticeIcon tone={active.record.tone} />
    <div className="notification-toast__copy"><span>{active.record.source}</span><strong>{active.record.title}</strong>{active.record.detail ? <p>{active.record.detail}</p> : null}
      <div className="notification-toast__actions"><button type="button" onClick={() => { onOpen(active.record, active.grouped); finish() }}>{notificationTargetLabel(active.record.target)}</button>
        {active.record.category === 'updates' && (active.record.eventId?.startsWith('update:available:') || active.record.eventId?.startsWith('update:downloaded:')) && onSnoozeUpdate ? <button type="button" onClick={() => { void onSnoozeUpdate(active.record).then(finish).catch(() => setError('更新状态可能已变化；未延后其他版本，请到软件更新查看。')) }}>稍后</button> : null}</div>
      {error ? <p className="notification-toast__error" role="alert">{error}</p> : null}
    </div>
    <button className="notification-icon-button" type="button" aria-label="收起提醒" onClick={finish}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
  </aside>, document.body)
}
