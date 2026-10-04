import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { notificationIsPending, notificationIsUnread, type NotificationPage, type NotificationQuery, type NotificationRecord } from '../../../domain/notification'
import { formatFullClock, formatRelativeClock } from '../format'
import type { NotificationStore } from './notification-store'
import { notificationTargetLabel } from './notification-view'

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
  const [quiet, setQuiet] = useState(store.snapshot().preferences.quiet)
  const [dirty, setDirty] = useState(false)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const query = useCallback((): NotificationQuery => ({ filter, ...(currentWorkspace && workspaceId ? { workspaceId } : {}), limit: 30 }), [filter, currentWorkspace, workspaceId])
  const load = useCallback(async (more = false): Promise<void> => {
    const version = ++sequence.current
    setLoading(true); setError('')
    try {
      const result = await store.api.getNotificationPage({ ...query(), ...(more && page?.nextCursor ? { cursor: page.nextCursor } : {}) })
      if (!mounted.current || sequence.current !== version) return
      setPage(previous => more && !result.reset && previous
        ? { ...result, records: [...previous.records, ...result.records.filter(record => !previous.records.some(old => old.id === record.id))] } : result)
      setDirty(store.snapshot().summary.revision > result.summary.revision)
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
    setQuiet(snapshot.preferences.quiet)
    if (!event?.change?.changed) return
    if (currentWorkspace && workspaceId && event?.change?.record?.scope.workspaceId
      && event.change.record.scope.workspaceId !== workspaceId) return
    const incoming = event.change.record
    const old = incoming ? page?.records.find(record => record.id === incoming.id) : undefined
    if (incoming && old && incoming.revision === old.revision && incoming.archivedAt === old.archivedAt) {
      // Read receipts aren't new business results. Update their style/count without moving or replacing the opened content.
      const clearable = (record: NotificationRecord) => record.attention !== 'activity' && !notificationIsUnread(record) && !notificationIsPending(record)
      setPage(previous => {
        const before = previous?.records.find(record => record.id === incoming.id)
        if (!previous || !before || incoming.readRevision < before.readRevision) return previous
        return { ...previous, records: previous.records.map(record => record.id === incoming.id ? incoming : record),
          summary: { ...previous.summary, unread: Math.max(0, previous.summary.unread + Number(notificationIsUnread(incoming)) - Number(notificationIsUnread(before))),
            clearable: Math.max(0, previous.summary.clearable + Number(clearable(incoming)) - Number(clearable(before))) } }
      })
      return
    }
    // Keep list position and the exact detail being read stable; don't move a row under the pointer.
    if (snapshot.summary.revision !== page?.summary.revision) setDirty(true)
  }), [store, page, currentWorkspace, workspaceId])
  useEffect(() => {
    if (!focusRecord) return
    void store.read(focusRecord).catch(() => { if (mounted.current) setError('已读状态暂未保存，通知仍会保留。') })
  }, [store, focusRecord])
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
      {open ? <div className="notification-row__detail">
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
      </div> : null}
    </li>
  }

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
    {store.snapshot().historyIncomplete ? <p className="notification-panel__feedback" role="status">部分历史未能保存。现有业务结果不受影响。</p> : null}
    {settingsOpen && store.snapshot().preferencesError ? <p className="notification-panel__feedback" role="status">{store.snapshot().preferencesError}</p> : null}
    <div className="notification-panel__body" id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${filter}`}>
      {!page && loading ? <p className="notification-empty" role="status">正在读取通知…</p> : null}
      {!loading && !page && error ? <button className="notification-text-button" type="button" onClick={() => void load(false)}>重新读取</button> : null}
      {page && !page.records.length ? <div className="notification-empty"><strong>{filter === 'pending' ? '没有待处理事项' : filter === 'unread' ? '未读通知已看完' : '暂时没有通知'}</strong><p>重要结果会留在这里，日常操作不会反复打扰。</p></div> : null}
      <ol className="notification-list">
        {page?.records.filter(record => record.attention !== 'activity').map(renderRecord)}
        {page?.records.some(record => record.attention === 'activity') ? <li><details className="notification-activities"><summary>日常动态 · {page.records.filter(record => record.attention === 'activity').length}</summary>
          <ol>{page.records.filter(record => record.attention === 'activity').map(renderRecord)}</ol>
        </details></li> : null}
      </ol>
      {page?.nextCursor ? <button type="button" className="notification-more" disabled={loading} onClick={() => void load(true)}>{loading ? '正在读取…' : '查看更多'}</button> : null}
    </div>
    <footer className="notification-panel__footer">
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
        <button type="button" className="notification-text-button is-muted" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>提醒设置</button>
      </div>}
      {settingsOpen ? <label className="notification-quiet"><input type="checkbox" checked={quiet} disabled={loading || !store.snapshot().preferencesReady} onChange={event => {
        const next = event.target.checked
        setLoading(true); setError('')
        void store.savePreferences({ ...store.snapshot().preferences, quiet: next }).catch(() => {
          if (mounted.current) setError('安静模式未能保存，原设置保持不变。')
        }).finally(() => { if (mounted.current) setLoading(false) })
      }} /><span>安静模式<small>不弹出提醒，结果与待处理事项仍保留。</small></span></label> : null}
    </footer>
  </section>
}
