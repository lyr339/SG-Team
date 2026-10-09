import { DisclosureChevron, DisclosureSummary } from '../DisclosureSummary'
import { FeedbackIcon } from '../feedback/FeedbackIcon'
import { useDelayedBusy } from '../feedback/use-delayed-busy'
import { MenuSelect } from '../lobby/MenuSelect'
import { HistoryGapNotice, HistoryRetentionInfo } from './NotificationHistoryNotice'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { notificationIsPending, notificationIsUnread, notificationSessionPreferenceKey, type NotificationPage, type NotificationQuery, type NotificationRecord } from '../../../domain/notification'
import { formatFullClock, formatRelativeClock } from '../format'
import type { NotificationStore } from './notification-store'
import { notificationTargetLabel } from './notification-view'
import { NotificationPreferencesPanel } from './NotificationPreferencesPanel'
import { notificationSessionMode } from '../../../domain/notification-delivery-policy'
import { observeSourceNotificationRead } from './observe-source-read'
import { NotificationCenterProjection } from './notification-center-projection'

export function NoticeIcon({ tone }: { tone: NotificationRecord['tone'] }): React.JSX.Element {
  return <FeedbackIcon tone={tone} className="notification-status-icon" />
}

interface Props {
  store: NotificationStore
  workspaceId?: string
  onClose: () => void
  onNavigate: (record: NotificationRecord) => Promise<void>
  focusRecord?: NotificationRecord
  navigationError?: string
}

interface CenterView {
  store: NotificationStore
  scope: string
  filter: NotificationQuery['filter']
  currentWorkspace: boolean
  page?: NotificationPage
}

export function NotificationCenter({ store, workspaceId, onClose, onNavigate, focusRecord, navigationError }: Props): React.JSX.Element {
  const panelId = useId()
  const [filter, setFilter] = useState<NotificationQuery['filter']>('all')
  const [currentWorkspace, setCurrentWorkspace] = useState(false)
  const [view, setView] = useState<CenterView>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<NotificationRecord | undefined>(focusRecord)
  const [confirmation, setConfirmation] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [preferences, setPreferences] = useState(store.snapshot().preferences)
  const [dirty, setDirty] = useState(false)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const detail = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const projection = useMemo(() => new NotificationCenterProjection(), [store])
  const currentScope = JSON.stringify([filter, currentWorkspace ? workspaceId ?? null : null])
  const scopeRef = useRef(currentScope); scopeRef.current = currentScope
  const storeRef = useRef(store); storeRef.current = store
  const viewRef = useRef(view); viewRef.current = view
  const switching = Boolean(view && (view.store !== store || view.scope !== currentScope))
  const slowSwitch = useDelayedBusy(switching)
  const displayedFilter = view?.filter ?? filter, displayedWorkspace = view?.currentWorkspace ?? currentWorkspace
  const activePage = !switching ? view?.page : undefined
  const displayedPage = view?.page
  const activePageRef = useRef(activePage); activePageRef.current = activePage
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0
  }, [view?.scope, view?.store])
  const settingsButton = useRef<HTMLButtonElement>(null), settingsBack = useRef<HTMLButtonElement>(null), wasSettings = useRef(false)
  useLayoutEffect(() => {
    if (settingsOpen) settingsBack.current?.focus({ preventScroll: true })
    else if (wasSettings.current) settingsButton.current?.focus({ preventScroll: true })
    wasSettings.current = settingsOpen
  }, [settingsOpen])
  const query = useCallback((): NotificationQuery => ({ filter, ...(currentWorkspace && workspaceId ? { workspaceId } : {}), limit: 30 }), [filter, currentWorkspace, workspaceId])
  const load = useCallback(async (more = false): Promise<void> => {
    const version = ++sequence.current, scope = currentScope, storageEpoch = store.snapshot().storageEpoch
    setLoading(true); setError('')
    try {
      const result = await store.api.getNotificationPage({ ...query(), ...(more && activePage?.nextCursor ? { cursor: activePage.nextCursor } : {}) })
      if (!mounted.current || sequence.current !== version || scopeRef.current !== scope || storeRef.current !== store
        || storageEpoch !== undefined && result.storageEpoch !== undefined && result.storageEpoch !== storageEpoch
        || result.storageEpoch !== undefined && store.snapshot().storageEpoch !== undefined && result.storageEpoch < store.snapshot().storageEpoch!) return
      const merged = projection.merge(result, more ? activePageRef.current : undefined, more, store.snapshot().summary.revision)
      // Commit the scope label, scoped counts and body as one view. Never clear
      // the previous body while IPC is pending, or label it as the new scope.
      if (viewRef.current && (viewRef.current.scope !== scope || viewRef.current.store !== store)) setExpanded(undefined)
      setDirty(merged.dirty); setView({ store, scope, filter, currentWorkspace, page: merged.page })
    } catch {
      if (mounted.current && sequence.current === version && scopeRef.current === scope && storeRef.current === store) {
        if (viewRef.current?.scope !== scope || viewRef.current?.store !== store) { setExpanded(undefined); setView({ store, scope, filter, currentWorkspace }) }
        setError('通知暂不可读取。可以重试，原操作不会受影响。')
      }
    }
    finally { if (mounted.current && sequence.current === version && scopeRef.current === scope && storeRef.current === store) setLoading(false) }
  }, [store, projection, query, currentScope, filter, currentWorkspace, activePage?.nextCursor])
  const loadRef = useRef(load); loadRef.current = load
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++sequence.current }
  }, [])
  useEffect(() => {
    ++sequence.current; setConfirmation(false); setDirty(false)
    projection.reset(query(), store.snapshot().storageEpoch ?? 0); void loadRef.current(false)
  }, [store, projection, filter, currentWorkspace, workspaceId])
  useEffect(() => store.subscribe(event => {
    const snapshot = store.snapshot()
    setPreferences(snapshot.preferences)
    const storageChanged = projection.changeStorage(snapshot.storageEpoch)
    if (event?.historyReload || storageChanged) {
      ++sequence.current
      if (expanded && !switching) { setLoading(false); setDirty(true) }
      else void loadRef.current(false)
      return
    }
    if (!event?.change?.changed) {
      if (event?.change && activePage && event.change.summary.revision > activePage.summary.revision) setDirty(true)
      return
    }
    const update = projection.observe(event, activePage?.records ?? [], expanded ?? focusRecord)
    if (update.read) {
      setView(previous => previous?.page && previous.store === store && previous.scope === scopeRef.current ? { ...previous, page: projection.applyRead(previous.page, update.read!) } : previous)
      return
    }
    if (update.irrelevant) return
    // Keep exact opened content and row position until explicit refresh.
    if (snapshot.summary.revision !== activePage?.summary.revision) setDirty(true)
  }), [store, projection, activePage, currentWorkspace, workspaceId, expanded, focusRecord, switching])
  useEffect(() => {
    if (!focusRecord) return
    setExpanded(focusRecord); setSettingsOpen(false)
  }, [focusRecord])
  const focusInPage = Boolean(displayedPage?.records.some(record => record.id === focusRecord?.id))
  useEffect(() => {
    if (switching || !focusRecord || expanded?.id !== focusRecord.id || expanded.revision !== focusRecord.revision || settingsOpen || !detail.current) return
    detail.current.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
    return observeSourceNotificationRead(detail.current, store.api, { key: expanded.key, limit: 1 }, record => record.id === expanded.id && record.revision === expanded.revision
      && (record.storageEpoch ?? 0) === (expanded.storageEpoch ?? 0))
  }, [store, focusRecord, expanded, settingsOpen, focusInPage, switching])
  const perform = async (run: () => Promise<unknown>): Promise<void> => {
    if (loading || switching) return
    const scope = scopeRef.current
    setLoading(true); setError('')
    try { await run(); if (mounted.current && scopeRef.current === scope) { setConfirmation(false); await loadRef.current(false) } }
    catch (reason) { if (mounted.current && scopeRef.current === scope) { setLoading(false); setError(reason instanceof Error ? reason.message : '操作未完成，请重试。') } }
  }
  const openDetail = (record: NotificationRecord): void => {
    if (switching) return
    if (expanded?.id === record.id) { setExpanded(undefined); if (filter === 'unread' && !notificationIsUnread(record)) void loadRef.current(false); return }
    setExpanded(record)
    if ((record.storageEpoch ?? 0) !== (store.snapshot().storageEpoch ?? 0)) return // Saved old detail is readable prose, not a current-ledger mutation grant.
    void store.read(record).catch(() => { if (mounted.current) setError('已读状态暂未保存，通知仍会保留。') })
  }
  const summary = activePage?.summary, displayedSummary = displayedPage?.summary
  const currentPage = Boolean(activePage && (activePage.storageEpoch ?? 0) === (store.snapshot().storageEpoch ?? 0))
  const count = displayedFilter === 'unread' ? displayedSummary?.unread : displayedFilter === 'pending' ? displayedSummary?.pending : displayedSummary?.total
  const renderRecord = (record: NotificationRecord): React.JSX.Element => {
    const open = expanded?.id === record.id
    const displayed = open ? expanded! : record
    return <li className={`notification-row${notificationIsUnread(record) ? ' is-unread' : ''}`} key={record.id}>
      <div className="notification-row__meta"><span>{record.source}</span><time dateTime={new Date(record.occurredAt).toISOString()} title={`${record.timeBasis === 'observed' ? '观察时间：' : ''}${formatFullClock(record.occurredAt)}`}>{record.timeBasis === 'observed' ? '观察于 ' : ''}{formatRelativeClock(record.occurredAt)}</time></div>
      <button type="button" className="notification-row__open" aria-expanded={open} disabled={switching} onClick={() => openDetail(record)}>
        <NoticeIcon tone={displayed.tone} /><strong>{displayed.title}</strong><DisclosureChevron open={open} />
      </button>
      {!open && record.detail ? <p className="notification-row__preview">{record.detail}</p> : null}
      {notificationIsPending(record) ? <span className="notification-row__pending">需要处理</span> : null}
      {open ? <div ref={detail} className="notification-row__detail">
        {displayed.detail ? <p>{displayed.detail}</p> : <p>此结果已记录，可返回原功能查看。</p>}
        <div className="notification-row__actions">
          {displayed.target ? <button type="button" className="notification-text-button" disabled={switching} onClick={() => void onNavigate(displayed)}>{notificationTargetLabel(displayed.target, ['mcp.write-result', 'mcp.call-unattributed', 'question.original-recheck', 'session.reply'].includes(displayed.eventType ?? '') ? displayed.subjectState : undefined)}</button> : null}
          {!notificationIsPending(record) ? <button type="button" className="notification-text-button is-muted" disabled={loading || !currentPage} onClick={() => void perform(async () => {
            const change = await store.api.archiveNotification(record.id, record.storageEpoch)
            store.accept({ change, ...(change.storageEpoch !== undefined ? { storageEpoch: change.storageEpoch } : {}), health: 'ready', historyIncomplete: store.snapshot().historyIncomplete })
            if (mounted.current) setExpanded(undefined)
          })}>归档</button> : null}
          {(displayed.revision !== record.revision || displayed.storageEpoch !== record.storageEpoch) ? <button type="button" className="notification-text-button" disabled={switching} onClick={() => {
            setExpanded(record); void store.read(record).catch(() => { if (mounted.current) setError('已读状态暂未保存，通知仍会保留。') })
          }}>查看最新结果</button> : dirty ? <span>正在阅读已展开的内容</span> : null}
        </div>
        {displayed.scope.sessionId && displayed.scope.generation !== undefined ? <div className="notification-session-preference"><span>此会话的提醒</span><MenuSelect ariaLabel="此会话的提醒偏好" value={notificationSessionMode(displayed, preferences)} disabled={loading || switching} menuMinWidth={168} onChange={mode => {
          const key = notificationSessionPreferenceKey(displayed.scope)
          void perform(async () => {
            await store.updatePreferences(current => {
              const values = (current.sessionPreferences ?? []).filter(value => notificationSessionPreferenceKey(value.scope) !== key)
              return { ...current, sessionPreferences: mode === 'default' ? values : [...values, { scope: displayed.scope, mode: mode === 'focus' ? 'focus' as const : 'quiet' as const }].slice(-256) }
            })
          })
        }} options={[{ value: 'default', label: '默认' }, { value: 'focus', label: '重点关注' }, { value: 'quiet', label: '安静' }]} /><small>重点关注仅增加后台新回复与连接提醒，仍遵循总开关、类别和安静时段。</small></div> : null}
      </div> : null}
    </li>
  }

  if (settingsOpen) return <section className="notification-panel notification-panel--settings" role="dialog" aria-label="提醒设置" tabIndex={-1}>
    <header className="notification-panel__header"><div><button ref={settingsBack} type="button" className="notification-icon-button" aria-label="返回通知" onClick={() => setSettingsOpen(false)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9 3-5 5 5 5" /></svg></button><h2>提醒设置</h2></div>
      <button type="button" className="notification-icon-button" aria-label="关闭通知中心" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></header>
    <div className="notification-panel__body"><NotificationPreferencesPanel store={store} /></div>
  </section>
  return <section className="notification-panel" role="dialog" aria-label="通知中心" tabIndex={-1}>
    <header className="notification-panel__header">
      <div><h2>通知</h2><span role="status">{switching && slowSwitch ? '正在读取…' : count !== undefined ? `${count} 条${displayedFilter === 'pending' ? '待处理' : displayedFilter === 'unread' ? '未读' : '记录'}` : '重要结果与待处理事项'}</span></div>
      <div className="notification-panel__header-actions">
        {dirty ? <button type="button" className="notification-panel__refresh" aria-label="有更新，刷新列表" disabled={loading} aria-busy={loading} onClick={() => void load(false)}>{loading ? '读取中…' : '有更新'} <svg className={loading ? 'notification-refresh is-loading' : 'notification-refresh'} viewBox="0 0 16 16" aria-hidden="true"><path d="M13 5a5.5 5.5 0 1 0 .5 5M13 2v3H10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button> : null}
        <button type="button" className="notification-icon-button" aria-label="关闭通知中心" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
      </div>
    </header>
    <div className="notification-panel__toolbar">
      <div className="notification-tabs" role="tablist" aria-label="通知筛选">
        {(['all', 'pending', 'unread'] as const).map(value => <button type="button" role="tab" key={value} aria-selected={displayedFilter === value} aria-busy={switching && filter === value} id={`${panelId}-${value}`} aria-controls={panelId} tabIndex={displayedFilter === value ? 0 : -1}
          onKeyDown={event => {
            const values = ['all', 'pending', 'unread'] as const
            const index = values.indexOf(value)
            const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : undefined
            if (next === undefined) return
            event.preventDefault(); setFilter(values[next])
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
          }}
          onClick={() => setFilter(value)}>{({ all: '全部', pending: '待处理', unread: '未读' } as const)[value]}</button>)}
      </div>
      {workspaceId ? <MenuSelect className="notification-scope" ariaLabel="通知工作区范围" value={displayedWorkspace ? 'current' : 'all'} menuMinWidth={176} options={[{ value: 'all', label: '所有工作区' }, { value: 'current', label: '当前工作区' }]} onChange={value => setCurrentWorkspace(value === 'current')} /> : null}
    </div>
    {error ? <p className="notification-panel__feedback" role="alert">{error}</p> : null}
    {navigationError ? <p className="notification-panel__feedback" role="status">{navigationError}</p> : null}
    <HistoryGapNotice store={store} />
    {settingsOpen && store.snapshot().preferencesError ? <p className="notification-panel__feedback" role="status">{store.snapshot().preferencesError}</p> : null}
    <div ref={body} className="notification-panel__body" id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${displayedFilter}`} aria-busy={loading || switching}>
      {!displayedPage && !error ? <p className="notification-empty" role="status">正在读取通知…</p> : null}
      {!loading && !displayedPage && error ? <div className="notification-empty"><strong>读取未完成</strong><button className="notification-text-button" type="button" onClick={() => void load(false)}>重新读取</button></div> : null}
      {displayedPage && !displayedPage.records.length ? <div className="notification-empty"><strong>{displayedFilter === 'pending' ? '没有待处理事项' : displayedFilter === 'unread' ? '未读通知已看完' : '暂时没有通知'}</strong><p>重要结果会留在这里，日常操作不会反复打扰。</p></div> : null}
      <ol className="notification-list">
        {focusRecord && !focusInPage ? renderRecord(focusRecord) : null}
        {displayedPage?.records.filter(record => record.attention !== 'activity').map(renderRecord)}
        {displayedPage?.records.some(record => record.attention === 'activity') ? <li><details className="notification-activities"><DisclosureSummary>日常动态 · {displayedPage.records.filter(record => record.attention === 'activity').length}</DisclosureSummary>
          <ol>{displayedPage.records.filter(record => record.attention === 'activity').map(renderRecord)}</ol>
        </details></li> : null}
      </ol>
      {displayedPage?.nextCursor ? <button type="button" className="notification-more" disabled={loading || switching} onClick={() => void load(true)}>{loading ? '正在读取…' : '查看更多'}</button> : null}
    </div>
    <footer className="notification-panel__footer">
      <HistoryRetentionInfo store={store} />
      {confirmation ? <div className="notification-confirm" role="group" aria-label="清理已读通知确认"><p>清理{displayedWorkspace ? '当前工作区及全局' : '所有工作区'}的已读记录？待处理事项保留。</p><div>
        <button type="button" className="notification-text-button is-muted" disabled={loading} onClick={() => setConfirmation(false)}>取消</button>
        <button type="button" className="notification-text-button" disabled={loading || !currentPage} onClick={() => void perform(async () => {
          const change = await store.api.clearReadNotifications({ query: { ...(currentWorkspace && workspaceId ? { workspaceId } : {}) }, confirmed: true, ...(activePage?.storageEpoch !== undefined ? { storageEpoch: activePage.storageEpoch } : {}) })
          store.accept({ change, ...(change.storageEpoch !== undefined ? { storageEpoch: change.storageEpoch } : {}), health: 'ready', historyIncomplete: store.snapshot().historyIncomplete })
        })}>清理已读</button>
      </div></div> : <div className="notification-panel__footer-actions">
        <button type="button" className="notification-text-button" disabled={loading || !summary?.unread || !currentPage} onClick={() => void perform(async () => {
          const change = await store.api.readAllNotifications({ query: query(), revision: summary!.revision, ...(activePage?.storageEpoch !== undefined ? { storageEpoch: activePage.storageEpoch } : {}) })
          store.accept({ change, ...(change.storageEpoch !== undefined ? { storageEpoch: change.storageEpoch } : {}), health: 'ready', historyIncomplete: store.snapshot().historyIncomplete })
        })}>全部已读</button>
        <button type="button" className="notification-text-button is-muted" disabled={loading || !summary?.clearable || !currentPage} onClick={() => setConfirmation(true)}>清理已读…</button>
        <button ref={settingsButton} type="button" className="notification-text-button is-muted" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>提醒设置</button>
      </div>}
    </footer>
  </section>
}
