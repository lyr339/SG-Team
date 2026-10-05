import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationDeliveryService, type NotificationNativePort } from '../src/application/notification-delivery-service'
import type { NotificationDraft, NotificationPush } from '../src/domain/notification'
import { notificationSourceHarness } from './notification-source-fixtures'

const at = new Date(2026, 9, 5, 14, 0).getTime()
const draft = (patch: Partial<NotificationDraft> = {}): NotificationDraft => ({ key: 'notice:operation', category: 'automation', source: '自动化', title: '流程已完成', detail: '只陈述已确认结果',
  scope: {}, attention: 'notice', state: 'resolved', tone: 'success', occurredAt: at, sourceRevision: 1, announce: true, ...patch })
async function harness(preferences: Record<string, unknown> = {}) {
  const h = notificationSourceHarness(); await h.owner.savePreferences(preferences)
  let foreground = false
  const sources = new Set<(event: NotificationPush) => void>(), observed: NotificationPush[] = []
  const stop = h.owner.subscribe(event => { observed.push(event); for (const listener of sources) listener(event) })
  const source = { subscribe: (listener: (event: NotificationPush) => void) => { sources.add(listener); return () => { sources.delete(listener) } },
    preferences: h.owner.preferences.bind(h.owner), page: h.owner.page.bind(h.owner), sourceState: h.owner.sourceState.bind(h.owner), commitSource: h.owner.commitSource.bind(h.owner), status: h.owner.status.bind(h.owner) }
  const native = { supported: vi.fn(() => true), show: vi.fn((_content: Parameters<NotificationNativePort['show']>[0], _callbacks: Parameters<NotificationNativePort['show']>[1]) => ({ close: vi.fn() })) }
  const openWindow = vi.fn(), outputs: NotificationPush[] = []
  const options = { native, foreground: () => foreground, openWindow, now: () => at }
  let delivery = new NotificationDeliveryService(source, options); delivery.subscribe(event => outputs.push(event)); await delivery.flush()
  return { ...h, native, outputs, observed, source, options, openWindow, delivery,
    setForeground: (value: boolean) => { foreground = value },
    offer: async (value = draft()) => { h.owner.offer(value); await h.owner.flush(); await delivery.flush() },
    replay: (event: NotificationPush) => { for (const listener of sources) listener(event) },
    restart: async () => { delivery.dispose(); delivery = new NotificationDeliveryService(source, options); delivery.subscribe(event => outputs.push(event)); await delivery.flush(); return delivery },
    close: async () => { delivery.dispose(); stop(); await h.owner.close() } }
}
afterEach(() => vi.useRealTimers())
describe('native versus in-app election backed by real private ledger', () => {
  it('a preference saved during slow initial preference loading cannot be rewound by that initial reply', async () => {
    const h = notificationSourceHarness(); let release!: (value: Awaited<ReturnType<typeof h.owner.preferences>>) => void
    const old = await h.owner.preferences()
    vi.spyOn(h.owner, 'preferences').mockImplementationOnce(() => new Promise(done => { release = done }))
    const native = { supported: () => true, show: vi.fn(() => ({ close: vi.fn() })) }
    const delivery = new NotificationDeliveryService(h.owner, { native, foreground: () => false, openWindow: () => {}, now: () => at })
    try {
      await h.owner.savePreferences({ nativeEnabled: true }); release(old); await delivery.flush()
      h.owner.offer(draft()); await h.owner.flush(); await delivery.flush()
      expect(native.show).toHaveBeenCalledOnce()
    } finally { delivery.dispose(); await h.owner.close() }
  })
  it('defaults to in-app only, without creating a native notice or claiming it was read', async () => {
    const h = await harness()
    try { await h.offer(); expect(h.native.show).not.toHaveBeenCalled(); expect(h.outputs.filter(event => event.announcement)).toHaveLength(1); expect(h.ledger.page().summary.unread).toBe(1) }
    finally { await h.close() }
  })
  it('background normal completion uses one private native notice; click/dismiss are not human reading or workflow actions', async () => {
    const h = await harness({ nativeEnabled: true })
    try {
      await h.offer(); expect(h.native.show).toHaveBeenCalledOnce(); expect(h.native.show.mock.calls[0]![0]).toEqual({ title: '拾光', body: '有新的通知，请打开拾光查看。', silent: true })
      expect(h.outputs.filter(event => event.announcement)).toHaveLength(0)
      h.native.show.mock.calls[0]![1].clicked(); expect(h.openWindow).toHaveBeenCalledOnce()
      expect(h.outputs.at(-1)?.openRequested).toMatchObject({ key: draft().key, recordId: h.ledger.page().records[0]!.id })
      expect(h.ledger.page().summary.unread).toBe(1)
      h.native.show.mock.calls[0]![1].closed(); expect(h.ledger.page().summary.unread).toBe(1)
    } finally { await h.close() }
  })
  it('foreground wins even with native on, and delayed signal forwarding never replaces a global 3-record badge with a key-filtered count', async () => {
    const h = await harness({ nativeEnabled: true })
    try {
      h.setForeground(true)
      h.owner.offer(draft({ key: 'other:a', announce: false })); h.owner.offer(draft({ key: 'other:b', announce: false })); await h.owner.flush()
      await h.offer(); expect(h.native.show).not.toHaveBeenCalled()
      const delivered = h.outputs.filter(event => event.announcement).at(-1)!
      expect(delivered.change?.summary).toMatchObject({ total: 3, unread: 3 })
      expect(h.ledger.page().summary.total).toBe(3)
    } finally { await h.close() }
  })
  it('deduplicates channel delivery across a recreated owner without replaying a known source event', async () => {
    const h = await harness({ nativeEnabled: true })
    try {
      await h.offer(); const captured = h.observed.find(event => event.announcement)!
      const restored = await h.restart(); h.replay(captured); await restored.flush()
      expect(h.native.show).toHaveBeenCalledOnce(); expect(h.ledger.page().summary.total).toBe(1)
    } finally { await h.close() }
  })
  it('native click references stay unique if the delivery owner is rebuilt while the renderer remains alive', async () => {
    const h = await harness({ nativeEnabled: true })
    try {
      await h.offer(); h.native.show.mock.calls[0]![1].clicked(); const first = h.outputs.at(-1)!.openRequested!.token
      const restored = await h.restart(); await h.offer(draft({ key: 'after:owner-rebuild' })); await restored.flush()
      h.native.show.mock.calls[1]![1].clicked()
      expect(h.outputs.at(-1)!.openRequested!.token).not.toBe(first)
      expect(h.outputs.at(-1)!.openRequested!.key).toBe('after:owner-rebuild')
    } finally { await h.close() }
  })
  it('rechecks foreground and reading while the durable claim is in flight', async () => {
    const h = await harness({ nativeEnabled: true }); let started!: () => void, release!: () => void
    const entered = new Promise<void>(done => { started = done }), gate = new Promise<void>(done => { release = done })
    const original = vi.mocked(h.port.commitSource).getMockImplementation()!
    vi.mocked(h.port.commitSource).mockImplementation(async (...args) => { if (args[0] === 'notification-delivery:v1') { started(); await gate }; return original(...args) })
    try {
      h.owner.offer(draft()); await h.owner.flush(); await entered
      h.setForeground(true); const record = h.ledger.page().records[0]!; await h.owner.read(record.id, record.revision)
      release(); await h.delivery.flush()
      expect(h.native.show).not.toHaveBeenCalled(); expect(h.outputs.filter(event => event.announcement)).toHaveLength(0)
      expect(h.ledger.page().summary.unread).toBe(0)
    } finally { release(); await h.close() }
  })
  it('unknown commit outcome cannot send or resend; original business record remains available', async () => {
    const h = await harness({ nativeEnabled: true }), original = vi.mocked(h.port.commitSource).getMockImplementation()!
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { await original(...args); throw Error('response lost after commit') })
    try {
      await h.offer(); expect(h.native.show).not.toHaveBeenCalled(); expect(h.ledger.page().summary.total).toBe(1); expect(h.delivery.status().state).toBe('failed')
      const restored = await h.restart(); h.replay(h.observed.find(event => event.announcement)!); await restored.flush()
      expect(h.native.show).not.toHaveBeenCalled(); expect(h.ledger.page().summary.total).toBe(1)
    } finally { await h.close() }
  })
  it('explicit opt-in connects activity to native only without artificial unread, and never after source read/expiry', async () => {
    const h = await harness({ nativeEnabled: true, connectionUpdates: true })
    try {
      await h.offer(draft({ attention: 'activity', announce: false, liveSignal: 'connection', key: 'session:online' }))
      expect(h.native.show).toHaveBeenCalledOnce(); expect(h.ledger.page().summary.unread).toBe(0); expect(h.outputs.filter(event => event.announcement)).toHaveLength(0)
      expect(JSON.stringify(h.ledger.page())).not.toContain('liveSignal')
    } finally { await h.close() }
  })
  it('native failure is local, falls back once, and does not hammer permission again for every new result', async () => {
    const h = await harness({ nativeEnabled: true })
    h.native.show.mockImplementationOnce((_content, callbacks) => { callbacks.failed(); return { close: vi.fn() } })
    try {
      await h.offer(); expect(h.delivery.status().state).toBe('failed'); expect(h.native.show).toHaveBeenCalledOnce()
      await h.delivery.flush(); await Promise.resolve(); expect(h.outputs.filter(event => event.announcement)).toHaveLength(1)
      await h.offer(draft({ key: 'another:result' })); expect(h.native.show).toHaveBeenCalledOnce(); expect(h.ledger.page().summary.total).toBe(2)
      await h.owner.savePreferences({ nativeEnabled: false }); await h.owner.savePreferences({ nativeEnabled: true })
      await h.offer(draft({ key: 'after:user-reenabled' })); expect(h.native.show).toHaveBeenCalledTimes(2)
    } finally { await h.close() }
  })
  it('changing quiet/native/category preferences retracts shown native notices, without acknowledging the record', async () => {
    const h = await harness({ nativeEnabled: true })
    try {
      await h.offer(); const first = h.native.show.mock.results[0]!.value
      await h.owner.savePreferences({ nativeEnabled: false }); expect(first.close).toHaveBeenCalledOnce()
      expect(h.ledger.page().summary.unread).toBe(1)
      await h.offer(draft({ key: 'default-result' })); expect(h.native.show).toHaveBeenCalledOnce()
    } finally { await h.close() }
  })
  it('grouped lifecycle elects one aggregate, forwards global counts, and closes it when a captured member changes', async () => {
    const h = await harness({ nativeEnabled: true })
    try {
      const first = draft({ key: 'session:a', category: 'sessions', title: 'A 已离线', attention: 'action', state: 'active' }), second = { ...first, key: 'session:b', title: 'B 已离线' }
      await h.owner.commitSource('session:grouped', 0, {}, [first, second], { keys: [first.key, second.key], source: '会话连接', titleSuffix: '个会话已离线' }); await h.delivery.flush()
      expect(h.native.show).toHaveBeenCalledOnce(); expect(h.outputs.filter(event => event.announcement)).toHaveLength(0)
      const old = h.ledger.page().records.find(record => record.key === first.key)!
      await h.owner.read(old.id, old.revision)
      expect(h.native.show.mock.results[0]!.value.close).toHaveBeenCalledOnce()
    } finally { await h.close() }
  })
  it('scheduled quiet begins with one boundary timer, retracts native notices and emits no accumulated success when it ends', async () => {
    vi.useFakeTimers(); const start = new Date(2026, 9, 5, 21, 59, 59).getTime(); vi.setSystemTime(start)
    const h = notificationSourceHarness(); await h.owner.savePreferences({ nativeEnabled: true, quietHours: { enabled: true, startMinute: 1_320, endMinute: 480 } })
    const native = { supported: () => true, show: vi.fn(() => ({ close: vi.fn() })) }, outputs: NotificationPush[] = []
    const delivery = new NotificationDeliveryService(h.owner, { native, foreground: () => false, openWindow: () => {} }); delivery.subscribe(event => outputs.push(event)); await delivery.flush()
    try {
      h.owner.offer(draft({ occurredAt: start })); await h.owner.flush(); await delivery.flush(); expect(native.show).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1_010); expect(native.show.mock.results[0]!.value.close).toHaveBeenCalledOnce()
      h.owner.offer(draft({ key: 'during:quiet', occurredAt: Date.now() })); await h.owner.flush(); await delivery.flush(); expect(native.show).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(10 * 60 * 60_000); expect(native.show).toHaveBeenCalledOnce()
      expect(h.ledger.page().summary.unread).toBe(2)
    } finally { delivery.dispose(); await h.owner.close() }
  })
  it('shutdown cancels native/pending callbacks and cannot create a fresh window during quit', async () => {
    const h = await harness({ nativeEnabled: true })
    try {
      await h.offer(); const callbacks = h.native.show.mock.calls[0]![1]; h.delivery.dispose(); callbacks.clicked()
      expect(h.openWindow).not.toHaveBeenCalled(); expect(h.ledger.page().summary.unread).toBe(1)
      expect(h.native.show.mock.results[0]!.value.close).toHaveBeenCalledOnce()
    } finally { await h.close() }
  })
})

describe('delivery across storage recovery', () => {
  it('a lost claim is not resent after recovery; fresh results can use the recovered ledger', async () => {
    const h = await harness({ nativeEnabled: true }), original = vi.mocked(h.port.commitSource).getMockImplementation()!
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { await original(...args); throw Error('reply lost') })
    try {
      await h.offer(); expect(h.delivery.status().state).toBe('failed'); expect(h.native.show).not.toHaveBeenCalled()
      await h.owner.page()
      h.replay({ health: 'ready', historyIncomplete: true, historyReload: true, preferences: await h.owner.preferences() })
      h.replay(h.observed.find(event => event.announcement)!); await h.delivery.flush()
      expect(h.native.show).not.toHaveBeenCalled()
      await h.offer(draft({ key: 'after:recovery' })); expect(h.native.show).toHaveBeenCalledOnce()
      expect(h.ledger.page().summary).toMatchObject({ total: 2, unread: 2 })
    } finally { await h.close() }
  })
  it('an in-flight pre-exit claim cannot turn into a late OS alert after history was reopened', async () => {
    const h = await harness({ nativeEnabled: true }), original = vi.mocked(h.port.commitSource).getMockImplementation()!
    let committed!: () => void, release!: () => void
    const reachedCommit = new Promise<void>(done => { committed = done }), acknowledgement = new Promise<void>(done => { release = done })
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { const result = await original(...args); committed(); await acknowledgement; return result })
    try {
      h.owner.offer(draft()); await h.owner.flush(); await reachedCommit
      h.replay({ health: 'degraded', historyIncomplete: true }); h.replay({ health: 'ready', historyIncomplete: true, historyReload: true })
      release(); await h.delivery.flush(); expect(h.native.show).not.toHaveBeenCalled()
      await h.offer(draft({ key: 'new:after:recovery' })); expect(h.native.show).toHaveBeenCalledOnce()
    } finally { release(); await h.close() }
  })
  it('late recovery history synchronization does not discard a genuinely new post-recovery result', async () => {
    const h = await harness({ nativeEnabled: true }), original = vi.mocked(h.port.commitSource).getMockImplementation()!
    let committed!: () => void, release!: () => void
    const reachedCommit = new Promise<void>(done => { committed = done }), acknowledgement = new Promise<void>(done => { release = done })
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { const result = await original(...args); committed(); await acknowledgement; return result })
    try {
      h.replay({ health: 'degraded', historyIncomplete: true }); h.replay({ health: 'ready', historyIncomplete: true })
      h.owner.offer(draft({ key: 'fresh:before:late:history:reload' })); await h.owner.flush(); await reachedCommit
      h.replay({ health: 'ready', historyIncomplete: true, historyReload: true, preferences: await h.owner.preferences() })
      release(); await h.delivery.flush(); expect(h.native.show).toHaveBeenCalledOnce()
    } finally { release(); await h.close() }
  })
  it('a storage recovery does not pretend an OS display/permission failure was repaired', async () => {
    const h = await harness({ nativeEnabled: true })
    h.native.show.mockImplementationOnce((_content, callbacks) => { callbacks.failed(); return { close: vi.fn() } })
    try {
      await h.offer(); expect(h.delivery.status().state).toBe('failed')
      h.replay({ health: 'degraded', historyIncomplete: true }); h.replay({ health: 'ready', historyIncomplete: true, historyReload: true, preferences: await h.owner.preferences() })
      await h.offer(draft({ key: 'after:storage:not:os:recovery' })); expect(h.native.show).toHaveBeenCalledOnce()
      expect(h.delivery.status().state).toBe('failed')
    } finally { await h.close() }
  })
})
