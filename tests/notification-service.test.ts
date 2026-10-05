import { notificationFingerprint } from '../src/application/notification-fingerprint'
import { describe, expect, it, vi } from 'vitest'
import { NotificationService } from '../src/application/notification-service'
import type { NotificationRepository } from '../src/application/notification-repository'
import { type NotificationDraft, type NotificationRecord } from '../src/domain/notification'

const draft = (patch: Partial<NotificationDraft> = {}): NotificationDraft => ({
  key: 'result:1', category: 'accounts', source: '账号', title: '导入完成', tone: 'success', attention: 'notice',
  state: 'resolved', scope: { accountId: 'account-1' }, occurredAt: 100, sourceRevision: 1, ...patch
})
const change = { changed: true, summary: { revision: 1, total: 1, unread: 1, pending: 0, clearable: 0 } }
function repository(): NotificationRepository {
  return { marker: vi.fn(async () => ({ sourceRevision: 0 })), sourceState: vi.fn(async () => ({ revision: 0 })), commitSource: vi.fn(async () => ({ applied: true, source: { revision: 1 }, changes: [] })),
    put: vi.fn(async () => change), page: vi.fn(async () => ({ records: [], summary: change.summary, reset: false })),
    read: vi.fn(async () => change), readAll: vi.fn(async () => change), archive: vi.fn(async () => change), clearRead: vi.fn(async () => change),
    preferences: vi.fn(async () => ({ enabled: true, nativeEnabled: false, sound: false, preview: false, quiet: false, mutedCategories: [] })),
    savePreferences: vi.fn(async value => value), close: vi.fn(async () => {}) }
}

describe('non-blocking notification owner', () => {
  it('combines delivery, not records or unread count, and uses the final committed global revision', async () => {
    const port = repository(); const service = new NotificationService(port, () => 300); const events = vi.fn(); service.subscribe(events)
    const first = draft({ key: 'session:1', category: 'sessions', title: 'CH-1 已离线', announce: true })
    const second = draft({ key: 'session:2', category: 'sessions', title: 'CH-2 已离线', announce: true })
    const quiet = draft({ key: 'restart:1', attention: 'activity', announce: false })
    const asRecord = (item: NotificationDraft, revision: number): NotificationRecord => ({ ...item, id: item.key, createdAt: 100, updatedAt: 200, revision,
      attentionRevision: item.attention === 'activity' ? 0 : revision, readRevision: 0 })
    vi.mocked(port.commitSource).mockResolvedValue({ applied: true, source: { revision: 1 }, changes: [first, second, quiet].map((item, index) => ({
      changed: true, record: asRecord(item, index + 1), summary: { revision: index + 1, total: index + 1, unread: Math.min(2, index + 1), pending: 0, clearable: 0 } })) })
    await service.commitSource('session-lifecycle:test', 0, {}, [first, second, quiet], { keys: [first.key, second.key], source: '会话连接', titleSuffix: '个会话已离线', tone: 'warning', target: { kind: 'run', runId: 'original-run' } })
    const announcements = events.mock.calls.map(([event]) => event).filter(event => event.announcement)
    expect(announcements).toHaveLength(1)
    expect(announcements[0]).toMatchObject({ change: { summary: { revision: 3, total: 3, unread: 2 } }, announcement: { group: { title: '2 个会话已离线', recordIds: [first.key, second.key] } } })
    await service.close()
  })
  it('initial current-state delivery deduplicates persisted markers, including cleared history, without using a wall-clock version', async () => {
    const port = repository(); const first = draft(); const { sourceRevision: _sequence, ...current } = first
    vi.mocked(port.marker).mockResolvedValue({ sourceRevision: 9, signature: notificationFingerprint(first), cleared: true })
    const service = new NotificationService(port)
    service.offerCurrent(current); await service.flush()
    expect(port.put).not.toHaveBeenCalled()
    service.offerCurrent({ ...current, title: '新的真实结果' }); await service.flush()
    expect(vi.mocked(port.put).mock.calls[0]?.[0].sourceRevision).toBe(10)
    await service.close()
  })
  it('coalesces a new current state while the first durable marker is still loading', async () => {
    const port = repository(); let resolve!: (value: { sourceRevision: number }) => void
    vi.mocked(port.marker).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const service = new NotificationService(port)
    const { sourceRevision: _sequence, ...current } = draft()
    service.offerCurrent(current); service.offerCurrent({ ...current, title: '下载已完成', renewAttention: true })
    resolve({ sourceRevision: 5 }); await service.flush()
    expect(port.put).toHaveBeenCalledTimes(1); expect(vi.mocked(port.put).mock.calls[0]?.[0]).toMatchObject({ title: '下载已完成', sourceRevision: 6 })
    await service.close()
  })
  it('offers immediately while storage waits, coalesces newer queued results and isolates listeners', async () => {
    const port = repository(); let release!: (value: typeof change) => void
    vi.mocked(port.put).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const service = new NotificationService(port, () => 200)
    service.subscribe(() => { throw Error('broken presentation') })
    expect(service.offer(draft())).toBeUndefined()
    service.offer(draft({ key: 'result:2' }))
    service.offer(draft({ key: 'result:2', sourceRevision: 2, title: '新的结果' }))
    service.offer(draft({ key: 'result:2', sourceRevision: 1, title: '旧结果' }))
    expect(port.put).toHaveBeenCalledTimes(1)
    release(change); await service.flush()
    expect(port.put).toHaveBeenCalledTimes(2)
    expect(vi.mocked(port.put).mock.calls[1]?.[0].title).toBe('新的结果')
    await service.close()
  })
  it('reports degraded storage without throwing into business intake or recursively producing another record', async () => {
    const port = repository(); vi.mocked(port.put).mockRejectedValue(Error('disk unavailable'))
    const service = new NotificationService(port); const events = vi.fn(); service.subscribe(events)
    expect(() => service.offer(draft())).not.toThrow()
    await service.flush()
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ health: 'degraded' }))
    expect(port.put).toHaveBeenCalledTimes(1)
    vi.mocked(port.put).mockResolvedValue(change)
    service.offer(draft({ key: 'recovered' })); await service.flush()
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ health: 'ready', historyIncomplete: true }))
    await service.close()
  })
  it('treats invalid archival of a pending item as user feedback, not a database outage', async () => {
    const port = repository(); vi.mocked(port.archive).mockRejectedValue(Object.assign(Error('pending item'), { code: 'notification_action_invalid' }))
    const service = new NotificationService(port); const events = vi.fn(); service.subscribe(events)
    await expect(service.archive('pending')).rejects.toThrow('pending item')
    expect(events).not.toHaveBeenCalled(); await service.close()
  })
  it('closes once and no longer admits new events during shutdown', async () => {
    const port = repository(); const service = new NotificationService(port)
    const first = service.close(); const second = service.close()
    expect(first).toBe(second); service.offer(draft())
    await first; expect(port.put).not.toHaveBeenCalled(); expect(port.close).toHaveBeenCalledOnce()
  })
  it('limits backlog and favours a meaningful action over queued quiet activity', async () => {
    const port = repository(); let release!: (value: typeof change) => void
    vi.mocked(port.put).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const service = new NotificationService(port); const events = vi.fn(); service.subscribe(events)
    service.offer(draft())
    for (let i = 0; i < 256; i++) service.offer(draft({ key: `quiet:${i}`, attention: 'activity' }))
    service.offer(draft({ key: 'question', attention: 'action', state: 'active' }))
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ health: 'degraded' }))
    release(change); await service.flush()
    expect(port.put).toHaveBeenCalledTimes(257)
    expect(vi.mocked(port.put).mock.calls.some(([item]) => item.key === 'question')).toBe(true)
    await service.close()
  })
})

describe('storage recovery is history synchronization, not event replay', () => {
  it('drops cached markers and rereads committed content after an acknowledgement was lost', async () => {
    const port = repository()
    let lifecycle!: Parameters<NonNullable<NotificationRepository['subscribeLifecycle']>>[0]
    const detach = vi.fn(); port.subscribeLifecycle = listener => { lifecycle = listener; return detach }
    const service = new NotificationService(port), events = vi.fn(); service.subscribe(events)
    const { sourceRevision: _revision, ...current } = draft()
    const record: NotificationRecord = { ...draft(), id: 'record', createdAt: 1, updatedAt: 2, revision: 3, attentionRevision: 3, readRevision: 0 }
    vi.mocked(port.put).mockResolvedValue({ ...change, record })
    service.offerCurrent(current); await service.flush(); expect(port.put).toHaveBeenCalledOnce()
    // The old cached signature says "import finished", but the interrupted worker
    // committed something else before exit. Only its persisted marker is authority.
    const actual = { ...draft(), title: '原入口已确认另一结果' }
    vi.mocked(port.marker).mockResolvedValue({ sourceRevision: 9, signature: notificationFingerprint(actual) })
    lifecycle({ state: 'unavailable', generation: 1 }); lifecycle({ state: 'recovered', generation: 2 }); await service.flush()
    expect(service.status()).toMatchObject({ health: 'ready', historyIncomplete: true })
    expect(events.mock.calls.some(([event]) => event.historyReload && !event.announcement)).toBe(true)
    service.offerCurrent(current); await service.flush()
    expect(vi.mocked(port.put).mock.calls.at(-1)?.[0].sourceRevision).toBe(10)
    await service.close(); expect(detach).toHaveBeenCalledOnce()
  })
  it('reloads an already committed unknown final result without a new write, unread bump or announcement', async () => {
    const port = repository()
    let lifecycle!: Parameters<NonNullable<NotificationRepository['subscribeLifecycle']>>[0]
    port.subscribeLifecycle = listener => { lifecycle = listener; return () => {} }
    const service = new NotificationService(port), events = vi.fn(); service.subscribe(events)
    const { sourceRevision: _revision, ...current } = draft()
    vi.mocked(port.marker).mockResolvedValue({ sourceRevision: 9, signature: notificationFingerprint(draft()) })
    lifecycle({ state: 'unavailable', generation: 1 }); lifecycle({ state: 'recovered', generation: 2 }); await service.flush()
    service.offerCurrent({ ...current, announce: true }); await service.flush()
    expect(port.put).not.toHaveBeenCalled(); expect(events.mock.calls.every(([event]) => !event.announcement)).toBe(true)
    await service.close()
  })
  it('a late old recovery snapshot cannot hide another outage or rewind newer user preferences', async () => {
    const port = repository()
    let lifecycle!: Parameters<NonNullable<NotificationRepository['subscribeLifecycle']>>[0]
    port.subscribeLifecycle = listener => { lifecycle = listener; return () => {} }
    let release!: (value: Awaited<ReturnType<NotificationRepository['page']>>) => void
    vi.mocked(port.page).mockImplementationOnce(() => new Promise(done => { release = done }))
    const service = new NotificationService(port), events = vi.fn(); service.subscribe(events)
    lifecycle({ state: 'unavailable', generation: 1 }); lifecycle({ state: 'recovered', generation: 2 })
    lifecycle({ state: 'unavailable', generation: 2 }); release({ records: [], summary: change.summary, reset: false }); await service.flush()
    expect(service.status().health).toBe('degraded'); expect(events.mock.calls.some(([event]) => event.historyReload)).toBe(false)
    let preferencesRelease!: (value: Awaited<ReturnType<NotificationRepository['preferences']>>) => void
    const old = await port.preferences()
    vi.mocked(port.preferences).mockImplementationOnce(() => new Promise(done => { preferencesRelease = done }))
    lifecycle({ state: 'recovered', generation: 3 }); await service.savePreferences({ nativeEnabled: true }); preferencesRelease(old); await service.flush()
    expect(events.mock.calls.filter(([event]) => event.preferences).at(-1)![0].preferences.nativeEnabled).toBe(true)
    expect(service.status().health).toBe('ready'); await service.close()
  })
})

describe('quiet summary recovery from a lost live-worker acknowledgement',()=>{
  it('checkpoint recovery refreshes the global unread/pending summary without replaying a source presentation or business call',async()=>{
    const port=repository(),service=new NotificationService(port),events=vi.fn();service.subscribe(events)
    vi.mocked(port.commitSource).mockRejectedValueOnce(Error('ack lost after commit'))
    await expect(service.commitSource('source:test',0,{},[])).rejects.toThrow('ack lost')
    vi.mocked(port.page).mockResolvedValue({records:[],reset:false,summary:{revision:9,total:4,unread:3,pending:1,clearable:0}})
    await service.sourceState('source:test');await service.flush()
    expect(port.page).toHaveBeenCalledOnce()
    expect(events.mock.calls.find(([event])=>event.historyReload)?.[0]).toMatchObject({historyIncomplete:true,change:{changed:false,summary:{total:4,unread:3,pending:1}}})
    expect(events.mock.calls.every(([event])=>!event.announcement)).toBe(true);expect(port.commitSource).toHaveBeenCalledOnce()
    await service.sourceState('source:test');await service.flush();expect(port.page).toHaveBeenCalledOnce();await service.close()
  })
})
