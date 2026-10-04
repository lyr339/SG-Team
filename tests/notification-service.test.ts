import { describe, expect, it, vi } from 'vitest'
import { NotificationService } from '../src/application/notification-service'
import type { NotificationRepository } from '../src/application/notification-repository'
import { notificationContentSignature, type NotificationDraft, type NotificationRecord } from '../src/domain/notification'

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
    vi.mocked(port.marker).mockResolvedValue({ sourceRevision: 9, signature: notificationContentSignature(first), cleared: true })
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
