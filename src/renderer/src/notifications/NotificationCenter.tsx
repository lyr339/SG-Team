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
  return <svg className={`notification-status-icon is-${tone}`} viewBox="0 0 20 20" aria-hidden="true">
    {tone === 'success' ? <path d="m4 10 4 4 8-8" /> : <><circle cx="10" cy="10" r="7" /><path d={tone === 'error' ? 'm7.5 7.5 5 5m0-5-5 5' : 'M10 6.5v4M10 13.5v.1'} /></>}
  </svg>
}

interface Props {
  store: NotificationStore
  workspaceId?: string
  onClose: () => void
  onNavigate: (record: NotificationRecord) => Promise<void>
  focusRecord?: NotificationRecord
  navigationError?: string
}

export function NotificationCenter({ store, workspaceId, onClose, onNavigate, focusRecord, navigationError }: Props): React.JSX.Element {
  const panelId = useId()
  const [filter, setFilter] = useState<NotificationQuery['filter']>('all')
  const [currentWorkspace, setCurrentWorkspace] = useState(false)
  const [page, setPage] = useState<NotificationPage>()
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
  const projection = useMemo(() => new NotificationCenterProjection(), [store])
  const loadedScope = useRef<string | undefined>(undefined), currentScope = JSON.stringify([filter, currentWorkspace ? workspaceId ?? null : null])
  const scopeRef = useRef(currentScope); scopeRef.current = currentScope
  const activePage = loadedScope.current === currentScope ? page : undefined
  const activePageRef = useRef(activePage); activePageRef.current = activePage
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
      if (!mounted.current || sequence.current !== version || scopeRef.current !== scope
        || storageEpoch !== undefined && result.storageEpoch !== undefined && result.storageEpoch !== storageEpoch
        || result.storageEpoch !== undefined && store.snapshot().storageEpoch !== undefined && result.storageEpoch < store.snapshot().storageEpoch!) return
      loadedScope.current = scope
      const merged = projection.merge(result, more ? activePageRef.current : undefined, more, store.snapshot().summary.revision)
      setDirty(merged.dirty); setPage(merged.page)
    } catch { if (mounted.current && sequence.current === version && scopeRef.current === scope) setError('通知暂不可读取。可以重试，原操作不会受影响。') }
    finally { if (mounted.current && sequence.current === version && scopeRef.current === scope) setLoading(false) }
  }, [store, projection, query, currentScope, activePage?.nextCursor])
  const loadRef = useRef(load); loadRef.current = load
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++sequence.current }
  }, [])
  useEffect(() => {
    ++sequence.current; loadedScope.current = undefined; setPage(undefined); setConfirmation(false); setDirty(false)
    projection.reset(query(), store.snapshot().storageEpoch ?? 0); void loadRef.current(false)
  }, [store, projection, filter, currentWorkspace, workspaceId])
  useEffect(() => store.subscribe(event => {
    const snapshot = store.snapshot()
    setPreferences(snapshot.preferences)
    const storageChanged = projection.changeStorage(snapshot.storageEpoch)
    if (event?.historyReload || storageChanged) {
      ++sequence.current
      if (expanded) { setLoading(false); setDirty(true) }
      else void loadRef.current(false)
      return
    }
    if (!event?.change?.changed) {
      if (event?.change && activePage && event.change.summary.revision > activePage.summary.revision) setDirty(true)
      return
    }
    const update = projection.observe(event, activePage?.records ?? [], expanded ?? focusRecord)
    if (update.read) {
      setPage(previous => previous ? projection.applyRead(previous, update.read!) : previous)
      return
    }
    if (update.irrelevant) return
    // Keep exact opened content and row position until explicit refresh.
    if (snapshot.summary.revision !== activePage?.summary.revision) setDirty(true)
  }), [store, projection, activePage, currentWorkspace, workspaceId, expanded, focusRecord])
  useEffect(() => {
    if (!focusRecord) return
    setExpanded(focusRecord); setSettingsOpen(false)
  }, [focusRecord])
  const focusInPage = Boolean(activePage?.records.some(record => record.id === focusRecord?.id))
  useEffect(() => {
    if (!focusRecord || expanded?.id !== focusRecord.id || expanded.revision !== focusRecord.revision || settingsOpen || !detail.current) return
    detail.current.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
    return observeSourceNotificationRead(detail.current, store.api, { key: expanded.key, limit: 1 }, record => record.id === expanded.id && record.revision === expanded.revision
      && (record.storageEpoch ?? 0) === (expanded.storageEpoch ?? 0))
  }, [store, focusRecord, expanded, settingsOpen, focusInPage])
  const perform = async (run: () => Promise<unknown>): Promise<void> => {
    if (loading) return
    const scope = scopeRef.current
    setLoading(true); setError('')
    try { await run(); if (mounted.current && scopeRef.current === scope) { setConfirmation(false); await loadRef.current(false) } }
    catch (reason) { if (mounted.current && scopeRef.current === scope) { setLoading(false); setError(reason instanceof Error ? reason.message : '操作未完成，请重试。') } }
  }
  const openDetail = (record: NotificationRecord): void => {
    if (expanded?.id === record.id) { setExpanded(undefined); if (filter === 'unread' && !notificationIsUnread(record)) void loadRef.current(false); return }
    setExpanded(record)
    if ((record.storageEpoch ?? 0) !== (store.snapshot().storageEpoch ?? 0)) return // Saved old detail is readable prose, not a current-ledger mutation grant.
    void store.read(record).catch(() => { if (mounted.current) setError('已读状态暂未保存，通知仍会保留。') })
  }
  const summary = activePage?.summary
  const currentPage = Boolean(activePage && (activePage.storageEpoch ?? 0) === (store.snapshot().storageEpoch ?? 0))
  const count = filter === 'unread' ? summary?.unread : filter === 'pending' ? summary?.pending : summary?.total
  const renderRecord = (record: NotificationRecord): React.JSX.Element => {
    const open = expanded?.id === record.id
    const displayed = open ? expanded! : record
    return <li className={`notification-row${notificationIsUnread(record) ? ' is-unread' : ''}`} key={record.id}>
      <div className="notification-row__meta"><span>{record.source}</span><time dateTime={new Date(record.occurredAt).toISOString()} title={`${record.timeBasis === 'observed' ? '观察时间：' : ''}${formatFullClock(record.occurredAt)}`}>{record.timeBasis === 'observed' ? '观察于 ' : ''}{formatRelativeClock(record.occurredAt)}</time></div>
      <button type="button" className="notification-row__open" aria-expanded={open} onClick={() => openDetail(record)}>
        <NoticeIcon tone={displayed.tone} /><strong>{displayed.title}</strong><svg className={open ? 'is-open' : ''} viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
      </button>
      {!open && record.detail ? <p className="notification-row__preview">{record.detail}</p> : null}
      {notificationIsPending(record) ? <span className="notification-row__pending">需要处理</span> : null}
      {open ? <div ref={detail} className="notification-row__detail">
        {displayed.detail ? <p>{displayed.detail}</p> : <p>此结果已记录，可返回原功能查看。</p>}
        <div className="notification-row__actions">
          {displayed.target ? <button type="button" className="notification-text-button" onClick={() => void onNavigate(displayed)}>{notificationTargetLabel(displayed.target, ['mcp.write-result', 'mcp.call-unattributed'].includes(displayed.eventType ?? '') ? displayed.subjectState : undefined)}</button> : null}
          {!notificationIsPending(record) ? <button type="button" className="notification-text-button is-muted" disabled={loading || !currentPage} onClick={() => void perform(async () => {
            const change = await store.api.archiveNotification(record.id, record.storageEpoch)
            store.accept({ change, ...(change.storageEpoch !== undefined ? { storageEpoch: change.storageEpoch } : {}), health: 'ready', historyIncomplete: store.snapshot().historyIncomplete })
            if (mounted.current) setExpanded(undefined)
          })}>归档</button> : null}
          {(displayed.revision !== record.revision || displayed.storageEpoch !== record.storageEpoch) ? <button type="button" className="notification-text-button" onClick={() => {
            setExpanded(record); void store.read(record).catch(() => { if (mounted.current) setError('已读状态暂未保存，通知仍会保留。') })
          }}>查看最新结果</button> : dirty ? <span>正在阅读已展开的内容</span> : null}
        </div>
        {displayed.scope.sessionId && displayed.scope.generation !== undefined ? <label className="notification-session-preference"><span>此会话的提醒</span><select aria-label="此会话的提醒偏好" value={notificationSessionMode(displayed, preferences)} disabled={loading} onChange={event => {
          const mode = event.target.value, key = notificationSessionPreferenceKey(displayed.scope)
          void perform(async () => {
            const current = store.snapshot().preferences, values = (current.sessionPreferences ?? []).filter(value => notificationSessionPreferenceKey(value.scope) !== key)
            await store.savePreferences({ ...current, sessionPreferences: mode === 'default' ? values : [...values, { scope: displayed.scope, mode: mode === 'focus' ? 'focus' as const : 'quiet' as const }].slice(-256) })
          })
        }}><option value="default">默认</option><option value="focus">重点关注</option><option value="quiet">安静</option></select><small>重点关注仅增加后台新回复与连接提醒，仍遵循总开关、类别和安静时段。</small></label> : null}
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
      <div><h2>通知</h2><span>{count !== undefined ? `${count} 条${filter === 'pending' ? '待处理' : filter === 'unread' ? '未读' : '记录'}` : '重要结果与待处理事项'}</span></div>
      <div className="notification-panel__header-actions">
        {dirty ? <button type="button" className="notification-panel__refresh" aria-label="有更新，刷新列表" disabled={loading} onClick={() => void load(false)}>有更新 <span aria-hidden="true">↻</span></button> : null}
        <button type="button" className="notification-icon-button" aria-label="关闭通知中心" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
      </div>
    </header>
    <div className="notification-panel__toolbar">
      <div className="notification-tabs" role="tablist" aria-label="通知筛选">
        {(['all', 'pending', 'unread'] as const).map(value => <button type="button" role="tab" key={value} aria-selected={filter === value} id={`${panelId}-${value}`} aria-controls={panelId} tabIndex={filter === value ? 0 : -1}
          onKeyDown={event => {
            const values = ['all', 'pending', 'unread'] as const
            const index = values.indexOf(value)
            const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : undefined
            if (next === undefined) return
            event.preventDefault(); setFilter(values[next]); setExpanded(undefined)
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
          }}
          onClick={() => { setFilter(value); setExpanded(undefined) }}>{({ all: '全部', pending: '待处理', unread: '未读' } as const)[value]}</button>)}
      </div>
      {workspaceId ? <select aria-label="通知工作区范围" value={currentWorkspace ? 'current' : 'all'} onChange={event => { setCurrentWorkspace(event.target.value === 'current'); setExpanded(undefined) }}>
        <option value="all">所有工作区</option><option value="current">当前工作区</option>
      </select> : null}
    </div>
    {error ? <p className="notification-panel__feedback" role="alert">{error}</p> : null}
    {navigationError ? <p className="notification-panel__feedback" role="status">{navigationError}</p> : null}
    <HistoryGapNotice store={store} />
    {settingsOpen && store.snapshot().preferencesError ? <p className="notification-panel__feedback" role="status">{store.snapshot().preferencesError}</p> : null}
    <div className="notification-panel__body" id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${filter}`}>
      {!activePage && loading ? <p className="notification-empty" role="status">正在读取通知…</p> : null}
      {!loading && !activePage && error ? <button className="notification-text-button" type="button" onClick={() => void load(false)}>重新读取</button> : null}
      {activePage && !activePage.records.length ? <div className="notification-empty"><strong>{filter === 'pending' ? '没有待处理事项' : filter === 'unread' ? '未读通知已看完' : '暂时没有通知'}</strong><p>重要结果会留在这里，日常操作不会反复打扰。</p></div> : null}
      <ol className="notification-list">
        {focusRecord && !focusInPage ? renderRecord(focusRecord) : null}
        {activePage?.records.filter(record => record.attention !== 'activity').map(renderRecord)}
        {activePage?.records.some(record => record.attention === 'activity') ? <li><details className="notification-activities"><summary>日常动态 · {activePage.records.filter(record => record.attention === 'activity').length}</summary>
          <ol>{activePage.records.filter(record => record.attention === 'activity').map(renderRecord)}</ol>
        </details></li> : null}
      </ol>
      {activePage?.nextCursor ? <button type="button" className="notification-more" disabled={loading} onClick={() => void load(true)}>{loading ? '正在读取…' : '查看更多'}</button> : null}
    </div>
    <footer className="notification-panel__footer">
      <HistoryRetentionInfo store={store} />
      {confirmation ? <div className="notification-confirm" role="group" aria-label="清理已读通知确认"><p>清理{currentWorkspace ? '当前工作区及全局' : '所有工作区'}的已读记录？待处理事项保留。</p><div>
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
