import { HistoryGapNotice, HistoryRetentionInfo } from './NotificationHistoryNotice'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { notificationIsPending, notificationIsUnread, notificationSessionPreferenceKey, type NotificationPage, type NotificationQuery, type NotificationRecord } from '../../../domain/notification'
import { formatFullClock, formatRelativeClock } from '../format'
import type { NotificationStore } from './notification-store'
import { notificationTargetLabel } from './notification-view'
import { NotificationPreferencesPanel } from './NotificationPreferencesPanel'
import { notificationSessionMode } from '../../../domain/notification-delivery-policy'
import { observeSourceNotificationRead } from './observe-source-read'

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
  const receipts = useRef(new Map<string, NotificationRecord>())
  const receiptRevisions = useRef(new Set<number>())
  const businessRevision = useRef(-1)
  const settingsButton = useRef<HTMLButtonElement>(null), settingsBack = useRef<HTMLButtonElement>(null), wasSettings = useRef(false)
  useLayoutEffect(() => {
    if (settingsOpen) settingsBack.current?.focus({ preventScroll: true })
    else if (wasSettings.current) settingsButton.current?.focus({ preventScroll: true })
    wasSettings.current = settingsOpen
  }, [settingsOpen])
  const query = useCallback((): NotificationQuery => ({ filter, ...(currentWorkspace && workspaceId ? { workspaceId } : {}), limit: 30 }), [filter, currentWorkspace, workspaceId])
  const load = useCallback(async (more = false): Promise<void> => {
    const version = ++sequence.current
    setLoading(true); setError('')
    try {
      const result = await store.api.getNotificationPage({ ...query(), ...(more && page?.nextCursor ? { cursor: page.nextCursor } : {}) })
      if (!mounted.current || sequence.current !== version) return
      let unreadDelta = 0, clearableDelta = 0
      const clearable = (record: NotificationRecord) => record.attention !== 'activity' && !notificationIsUnread(record) && !notificationIsPending(record)
      const records = result.records.map(record => {
        const receipt = receipts.current.get(record.id)
        if (!receipt || receipt.revision !== record.revision || receipt.readRevision <= record.readRevision) return record
        unreadDelta += Number(notificationIsUnread(receipt)) - Number(notificationIsUnread(record))
        clearableDelta += Number(clearable(receipt)) - Number(clearable(record))
        return receipt
      })
      const latest = store.snapshot().summary.revision
      let onlyReads = latest - result.summary.revision <= 256 && businessRevision.current <= result.summary.revision
      for (let version = result.summary.revision + 1; onlyReads && version <= latest; version++) if (!receiptRevisions.current.has(version)) onlyReads = false
      const merged = { ...result, records, summary: { ...result.summary,
        unread: Math.max(0, result.summary.unread + unreadDelta), clearable: Math.max(0, result.summary.clearable + clearableDelta) } }
      setPage(previous => more && !result.reset && previous
        ? { ...merged, records: [...previous.records, ...records.filter(record => !previous.records.some(old => old.id === record.id))] } : merged)
      setDirty(latest > result.summary.revision && !onlyReads)
    } catch { if (mounted.current && sequence.current === version) setError('通知暂不可读取。可以重试，原操作不会受影响。') }
    finally { if (mounted.current && sequence.current === version) setLoading(false) }
  }, [store, query, page?.nextCursor])
  const loadRef = useRef(load); loadRef.current = load
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++sequence.current }
  }, [])
  useEffect(() => { setConfirmation(false); void loadRef.current(false) }, [filter, currentWorkspace, workspaceId])
  useEffect(() => store.subscribe(event => {
    const snapshot = store.snapshot()
    setPreferences(snapshot.preferences)
    if (event?.historyReload) {
      if (expanded) setDirty(true)
      else void loadRef.current(false)
      return
    }
    if (!event?.change?.changed) return
    if (currentWorkspace && workspaceId && event?.change?.record?.scope.workspaceId
      && event.change.record.scope.workspaceId !== workspaceId) return
    const incoming = event.change.record
    const old = incoming ? page?.records.find(record => record.id === incoming.id) ?? (expanded?.id === incoming.id ? expanded : undefined)
      ?? (focusRecord?.id === incoming.id ? focusRecord : undefined) : undefined
    if (incoming && old && incoming.revision === old.revision && incoming.archivedAt === old.archivedAt) {
      // Read receipts aren't new business results. Update their style/count without moving or replacing the opened content.
      const clearable = (record: NotificationRecord) => record.attention !== 'activity' && !notificationIsUnread(record) && !notificationIsPending(record)
      receipts.current.set(incoming.id, incoming); receiptRevisions.current.add(event.change.summary.revision)
      if (receipts.current.size > 256) receipts.current.delete(receipts.current.keys().next().value!)
      if (receiptRevisions.current.size > 256) receiptRevisions.current.delete(receiptRevisions.current.values().next().value!)
      setPage(previous => {
        const before = previous?.records.find(record => record.id === incoming.id)
        if (!previous || !before || incoming.readRevision < before.readRevision) return previous
        return { ...previous, records: previous.records.map(record => record.id === incoming.id ? incoming : record),
          summary: { ...previous.summary, unread: Math.max(0, previous.summary.unread + Number(notificationIsUnread(incoming)) - Number(notificationIsUnread(before))),
            clearable: Math.max(0, previous.summary.clearable + Number(clearable(incoming)) - Number(clearable(before))) } }
      })
      return
    }
    businessRevision.current = Math.max(businessRevision.current, event.change.summary.revision)
    // Keep list position and the exact detail being read stable; don't move a row under the pointer.
    if (snapshot.summary.revision !== page?.summary.revision) setDirty(true)
  }), [store, page, currentWorkspace, workspaceId, expanded, focusRecord])
  useEffect(() => {
    if (!focusRecord) return
    setExpanded(focusRecord); setSettingsOpen(false)
  }, [focusRecord])
  const focusInPage = Boolean(page?.records.some(record => record.id === focusRecord?.id))
  useEffect(() => {
    if (!focusRecord || expanded?.id !== focusRecord.id || expanded.revision !== focusRecord.revision || settingsOpen || !detail.current) return
    detail.current.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
    return observeSourceNotificationRead(detail.current, store.api, { key: expanded.key, limit: 1 }, record => record.id === expanded.id && record.revision === expanded.revision)
  }, [store, focusRecord, expanded, settingsOpen, focusInPage])
  const perform = async (run: () => Promise<unknown>): Promise<void> => {
    if (loading) return
    setLoading(true); setError('')
    try { await run(); if (mounted.current) { setConfirmation(false); await loadRef.current(false) } }
    catch (reason) { if (mounted.current) { setLoading(false); setError(reason instanceof Error ? reason.message : '操作未完成，请重试。') } }
  }
  const openDetail = (record: NotificationRecord): void => {
    if (expanded?.id === record.id) { setExpanded(undefined); if (filter === 'unread' && !notificationIsUnread(record)) void loadRef.current(false); return }
    setExpanded(record)
    void store.read(record).catch(() => { if (mounted.current) setError('已读状态暂未保存，通知仍会保留。') })
  }
  const summary = page?.summary
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
          {displayed.target ? <button type="button" className="notification-text-button" onClick={() => void onNavigate(displayed)}>{notificationTargetLabel(displayed.target)}</button> : null}
          {!notificationIsPending(record) ? <button type="button" className="notification-text-button is-muted" disabled={loading} onClick={() => void perform(async () => {
            const change = await store.api.archiveNotification(record.id)
            store.accept({ change, health: 'ready', historyIncomplete: store.snapshot().historyIncomplete })
            if (mounted.current) setExpanded(undefined)
          })}>归档</button> : null}
          {displayed.revision !== record.revision ? <button type="button" className="notification-text-button" onClick={() => {
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
      {!page && loading ? <p className="notification-empty" role="status">正在读取通知…</p> : null}
      {!loading && !page && error ? <button className="notification-text-button" type="button" onClick={() => void load(false)}>重新读取</button> : null}
      {page && !page.records.length ? <div className="notification-empty"><strong>{filter === 'pending' ? '没有待处理事项' : filter === 'unread' ? '未读通知已看完' : '暂时没有通知'}</strong><p>重要结果会留在这里，日常操作不会反复打扰。</p></div> : null}
      <ol className="notification-list">
        {focusRecord && !focusInPage ? renderRecord(focusRecord) : null}
        {page?.records.filter(record => record.attention !== 'activity').map(renderRecord)}
        {page?.records.some(record => record.attention === 'activity') ? <li><details className="notification-activities"><summary>日常动态 · {page.records.filter(record => record.attention === 'activity').length}</summary>
          <ol>{page.records.filter(record => record.attention === 'activity').map(renderRecord)}</ol>
        </details></li> : null}
      </ol>
      {page?.nextCursor ? <button type="button" className="notification-more" disabled={loading} onClick={() => void load(true)}>{loading ? '正在读取…' : '查看更多'}</button> : null}
    </div>
    <footer className="notification-panel__footer">
      <HistoryRetentionInfo store={store} />
      {confirmation ? <div className="notification-confirm" role="group" aria-label="清理已读通知确认"><p>清理{currentWorkspace ? '当前工作区及全局' : '所有工作区'}的已读记录？待处理事项保留。</p><div>
        <button type="button" className="notification-text-button is-muted" disabled={loading} onClick={() => setConfirmation(false)}>取消</button>
        <button type="button" className="notification-text-button" disabled={loading} onClick={() => void perform(async () => {
          const change = await store.api.clearReadNotifications({ query: { ...(currentWorkspace && workspaceId ? { workspaceId } : {}) }, confirmed: true })
          store.accept({ change, health: 'ready', historyIncomplete: store.snapshot().historyIncomplete })
        })}>清理已读</button>
      </div></div> : <div className="notification-panel__footer-actions">
        <button type="button" className="notification-text-button" disabled={loading || !summary?.unread} onClick={() => void perform(async () => {
          const change = await store.api.readAllNotifications({ query: query(), revision: summary!.revision })
          store.accept({ change, health: 'ready', historyIncomplete: store.snapshot().historyIncomplete })
        })}>全部已读</button>
        <button type="button" className="notification-text-button is-muted" disabled={loading || !summary?.clearable} onClick={() => setConfirmation(true)}>清理已读…</button>
        <button ref={settingsButton} type="button" className="notification-text-button is-muted" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>提醒设置</button>
      </div>}
    </footer>
  </section>
}
