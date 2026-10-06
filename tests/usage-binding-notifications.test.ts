import { expect, it, vi } from 'vitest'
import { CursorStreamObserver, type CursorStreamObserverOptions } from '../src/infrastructure/cursor/cursor-stream-observer'
import { UsageBindingFixtureSocket } from '../scripts/fixtures/usage-binding-socket'
import { UsageBindingNotifications } from '../src/application/notifications/usage-binding-notifications'
import { notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
import { CursorUsageTracker } from '../src/application/cursor-usage-tracker'
import { readUsageBindingState, reduceUsageBindingNotifications, type UsageBindingState } from '../src/domain/usage-binding-notification'

const good = (c = 'composer-a') => ({ c, g: 'generation-a', i: 100, o: 10, r: 50, w: 0, t: 10000 })
const bad = (c = 'composer-a') => ({ ...good(c), i: 'bad' })
function stream(options: CursorStreamObserverOptions = {}) {
  const socket = new UsageBindingFixtureSocket()
  const observer = new CursorStreamObserver({ fetchPageSocketUrl: async () => 'ws://127.0.0.1:1/never-connected', openSocket: () => socket,
    locateComposerService: async () => true, disarmLegacyPatch: async () => undefined, ...options })
  return { socket, observer }
}
function fixture() {
  const h = notificationSourceHarness(), team = notificationTeam(); let at = 10000
  team.workspaces = [{ id: team.activeWorkspaceId!, name: 'PRIVATE workspace', path: '/fixture/private-workspace', createdAt: 1, updatedAt: 1 }]
  const first = team.members[0]!, binding = { ...first.binding!, id: 'binding-b', slotId: 'slot-b', channelId: '2', composerId: 'composer-b' }
  team.bindings.push(binding); team.members.push({ ...first, slot: { ...first.slot, id: 'slot-b', channelId: '2' }, binding })
  const source = new UsageBindingNotifications(h.owner, () => at); source.setTeam(team)
  const callback = vi.fn(), samples = vi.fn()
  const s = stream({ usageObserver: source, onUsageEvent: callback, onUsageSample: samples })
  return { ...s, team, h, source, callback, samples, at: (value: number) => { at = value },
    close: async () => { s.observer.dispose(); await source.close(); await h.owner.close() } }
}

it('retains original parser/callback arguments and command sequence with observation enabled; healthy traffic never makes a success log or extra private queries', async () => {
  const f = fixture(), callbacks = vi.fn(), samples = vi.fn(), plain = stream({ onUsageEvent: callbacks, onUsageSample: samples })
  try {
    expect(await f.observer.attach()).toBe(true); expect(await plain.observer.attach()).toBe(true)
    const commands = f.socket.sent.map(call => [call.method, call.params])
    expect(commands).toEqual(plain.socket.sent.map(call => [call.method, call.params]))
    for (const payload of [good(), { c: 'composer-a', i: 20 }, { ...good(), kind: 'sample', used: 300 }, bad(), { ...good(), i: 0, o: 0, r: 0 },
      { ...good(), kind: 'unknown' }, { ...good(), kind: 'sample', used: 0 }, 'invalid PRIVATE JSON', null]) {
      f.socket.usage(payload); plain.socket.usage(payload)
    }
    expect(f.callback.mock.calls).toEqual(callbacks.mock.calls); expect(f.samples.mock.calls).toEqual(samples.mock.calls)
    await f.source.source.flush(); const count = vi.mocked(f.h.port.sourceState).mock.calls.length
    for (let i = 0; i < 300; i++) { f.at(11000 + i * 100); f.socket.usage(good(i % 2 ? 'composer-a' : 'composer-b')) }
    await f.source.source.flush()
    expect(vi.mocked(f.h.port.sourceState).mock.calls.length).toBe(count); expect(f.h.ledger.page().summary.total).toBe(0)
    expect(f.socket.sent.map(call => [call.method, call.params])).toEqual(commands)
  } finally { plain.observer.dispose(); await f.close() }
})

it('aggregates two original affected bindings into one episode; a healthy other member and zero/legacy frames cannot resolve them', async () => {
  const f = fixture(), events: any[] = []; f.h.owner.subscribe(event => events.push(event))
  try {
    await f.observer.attach(); f.socket.usage(good()); await f.source.source.flush()
    f.at(11000); f.socket.usage(bad()); f.socket.usage(bad('composer-b'))
    f.at(17000); f.socket.usage(bad()); f.socket.usage(bad('composer-b')); await f.source.source.flush()
    const incident = f.h.ledger.page().records[0]!
    expect(f.h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
    expect(incident.detail).toContain('2 个绑定来源'); expect(incident.detail).toContain('CH-1'); expect(incident.detail).toContain('CH-2')
    expect(incident.scope).toEqual({ workspaceId: f.team.activeWorkspaceId, runId: f.team.activeRun!.id })
    f.at(18000); f.socket.usage({ ...good(), i: 0, o: 0, r: 0 }); f.socket.usage({ c: 'composer-a', i: 100 })
    await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
    await f.h.owner.read(incident.id, incident.revision)
    f.at(19000); f.socket.usage(good()); await f.source.source.flush()
    const partially = f.h.ledger.page().records[0]!
    expect(partially.state).toBe('active'); expect(partially.detail).toContain('1 个绑定来源'); expect(partially.detail).not.toContain('CH-1')
    expect(f.h.ledger.page().summary.unread).toBe(0)
    const announced = events.filter(event => event.announcement).length
    f.at(20000); f.socket.usage(good('composer-b')); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('resolved'); expect(events.filter(event => event.announcement)).toHaveLength(announced)
    expect(f.h.ledger.page().records[0]?.detail).toContain('不保证载荷已入账或落盘')
    expect(JSON.stringify(f.h.ledger.page())).not.toMatch(/PRIVATE|composer-a|generation-a|private-workspace/)
  } finally { await f.close() }
})

it('reports only genuine original callback failures and never invokes a callback again, changes its payload or fails the write-signal channel', async () => {
  const f = fixture(); let fails = true
  const calls: unknown[] = []; f.callback.mockImplementation(event => { calls.push(event); if (fails) throw Error('PRIVATE original callback') })
  try {
    await f.observer.attach(); f.socket.usage(good()); f.at(16000); f.socket.usage(good()); await f.source.source.flush()
    expect(calls).toHaveLength(2); expect(f.h.ledger.page().records[0]?.detail).toContain('原计数回调没有正常返回')
    fails = false; f.at(17000); f.socket.usage(good()); await f.source.source.flush()
    expect(calls).toHaveLength(3); expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
    expect(calls[0]).toEqual(calls[1]); expect(JSON.stringify(f.h.ledger.page())).not.toContain('PRIVATE')
  } finally { await f.close() }
})

it('unattributable malformed frames report one private evidence gap per document, not a fake bound error or a retry', async () => {
  const f = fixture()
  try {
    await f.observer.attach()
    const gap = vi.spyOn(f.h.owner, 'reportHistoryGap')
    for (let n = 0; n < 100; n++) f.socket.usage('PRIVATE malformed')
    await f.source.source.flush(); expect(gap).toHaveBeenCalledOnce(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.socket.usage(bad('unbound-composer')); f.at(20000); f.socket.usage(bad('unbound-composer')); await f.source.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(0); expect(f.callback).not.toHaveBeenCalled()
    f.source.reset(); f.socket.usage('PRIVATE malformed'); expect(gap).toHaveBeenCalledTimes(2)
  } finally { await f.close() }
})

it('binding/sleep/document scope changes expire monitoring, not silently repair old failures; stale execution contexts never feed diagnostics', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    await f.observer.attach(); f.socket.usage(good()); f.at(11000); f.socket.usage(bad()); f.at(17000); f.socket.usage(bad()); await f.source.source.flush()
    const incident = f.h.ledger.page().records[0]!
    f.socket.emit('message', JSON.stringify({ method: 'Runtime.executionContextsCleared' })); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('expired')
    f.socket.context(2); await vi.advanceTimersByTimeAsync(301)
    f.at(18000); f.socket.usage(good(), 1); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('expired')
    f.socket.usage(good(), 2); f.at(19000); f.socket.usage(bad(), 2); f.at(25000); f.socket.usage(bad(), 2); await f.source.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(2); expect(f.h.ledger.page().records[0]?.key).not.toBe(incident.key)
    const old = f.source.begin('composer-a')!
    const changed = structuredClone(f.team); changed.bindings[0]!.generation = 'new-binding'; changed.members[0]!.binding = changed.bindings[0]
    f.source.setTeam(changed); old.complete({ state: 'ready' }); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('expired')
    f.source.suspend(); f.socket.usage(bad(), 2); f.source.resume(); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('expired')
  } finally { await f.close(); vi.useRealTimers() }
})

it('observer faults and diagnostic callback errors remain isolated from original healthy accounting and source commands', async () => {
  const samples = vi.fn(), events = vi.fn(), tracker = new CursorUsageTracker({ boundComposers: [{ composerId: 'composer-a', slotId: 'slot-a' }] })
  const observer = { begin: () => ({ complete: () => { throw Error('diagnostic') }, unavailable: () => { throw Error('diagnostic gap') } }),
    reset: () => { throw Error('diagnostic reset') }, unattributed: () => { throw Error('diagnostic unknown') }, unavailable: () => { throw Error('diagnostic gap') } }
  const s = stream({ usageObserver: observer, onUsageEvent: event => { events(event); tracker.record(event) }, onUsageSample: samples })
  try {
    expect(await s.observer.attach()).toBe(true); s.socket.usage(good())
    expect(events).toHaveBeenCalledOnce(); expect(tracker.getSnapshot()['composer-a']?.inputTokens).toBe(100)
    expect(tracker.getSnapshot()['composer-a']?.quality).toBe('exact')
    s.socket.usage('PRIVATE invalid'); s.socket.emit('message', JSON.stringify({ method: 'Runtime.executionContextsCleared' }))
    expect(s.observer.connected).toBe(true)
  } finally { s.observer.dispose(); tracker.dispose() }
})

it('sampling echoes, rollback, source gaps and diagnostic restart are not continuous failure proof; unknown ACK is reconciled without replay', async () => {
  const f = fixture(), original = f.h.port.commitSource.bind(f.h.port)
  try {
    await f.observer.attach(); f.socket.usage(good()); await f.source.source.flush()
    f.at(11000); f.socket.usage(bad()); f.socket.usage(bad()); f.at(9000); f.socket.usage(bad()); f.at(100000); f.socket.usage(bad())
    await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    vi.mocked(f.h.port.commitSource).mockImplementationOnce(async (...args) => { await original(...args); throw Error('private ACK lost') })
    f.at(106000); f.socket.usage(bad()); await f.source.source.flush(); f.at(107000); f.socket.usage(bad()); await f.source.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(1); expect(f.h.owner.status().historyIncomplete).toBe(true)
    const prior = f.h.ledger.page().records[0]!
    await f.source.close(); const restarted = new UsageBindingNotifications(f.h.owner, () => 108000)
    try { restarted.setTeam(f.team); await restarted.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('expired'); expect(f.h.ledger.page().records[0]?.id).toBe(prior.id) }
    finally { await restarted.close() }
  } finally { await f.close() }
})

it('validates the durable cause set and preserves attribution on malformed team frames', async () => {
  expect(readUsageBindingState(undefined, 'health')).toBeUndefined()
  for (const value of [null, [], { version: 2 }, { version: 1, key: 'health', episode: { causes: [{ identity: 'PRIVATE raw identity' }] } }]) expect(() => readUsageBindingState(value, 'health')).toThrow()
  const f = fixture()
  try {
    const stale = f.source.begin('composer-a')!
    const mismatch = structuredClone(f.team); mismatch.members[0]!.binding = { ...mismatch.members[0]!.binding!, agentSessionId: 'different-agent' }
    f.source.setTeam(mismatch); expect(f.source.begin('composer-a')).toBeUndefined()
    expect(() => f.source.setTeam({ ...f.team, workspaces: null } as any)).not.toThrow()
    stale.complete({ state: 'ready' }); expect(f.source.begin('composer-a')).toBeUndefined()
  } finally { await f.close() }
})

it('does not stop watching recovery merely because its private write lost an ACK, and normal traffic becomes quiet after proven recovery', async () => {
  const f = fixture(), original = f.h.port.commitSource.bind(f.h.port)
  try {
    await f.observer.attach(); f.socket.usage(good()); await f.source.source.flush()
    f.at(11000); f.socket.usage(bad()); f.at(17000); f.socket.usage(bad()); await f.source.source.flush()
    vi.mocked(f.h.port.commitSource).mockRejectedValueOnce(Error('private ready commit not written'))
    f.at(18000); f.socket.usage(good()); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.at(19000); f.socket.usage(good()); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
    f.at(20000); f.socket.usage(bad()); f.at(26000); f.socket.usage(bad()); await f.source.source.flush()
    vi.mocked(f.h.port.commitSource).mockImplementationOnce(async (...args) => { await original(...args); throw Error('private ready ACK lost') })
    f.at(27000); f.socket.usage(good()); await f.source.source.flush()
    f.at(28000); f.socket.usage(good()); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
    const loads = vi.mocked(f.h.port.sourceState).mock.calls.length, commits = vi.mocked(f.h.port.commitSource).mock.calls.length
    for (let i = 0; i < 200; i++) { f.at(29000 + i * 100); f.socket.usage(good()) }
    await f.source.source.flush(); expect(f.h.port.sourceState).toHaveBeenCalledTimes(loads); expect(f.h.port.commitSource).toHaveBeenCalledTimes(commits)
  } finally { await f.close() }
})

it('a delayed old recovery commit cannot erase a newly confirmed failure watch; context destruction stops original monitoring without an extra probe', async () => {
  const f = fixture(), original = f.h.port.commitSource.bind(f.h.port)
  try {
    await f.observer.attach(); f.socket.usage(good()); await f.source.source.flush()
    f.at(11000); f.socket.usage(bad()); f.at(17000); f.socket.usage(bad()); await f.source.source.flush()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(done => { entered = done }), hold = new Promise<void>(done => { release = done })
    vi.mocked(f.h.port.commitSource).mockImplementationOnce(async (...args) => { entered(); await hold; return original(...args) })
    f.at(18000); f.socket.usage(good()); await waiting
    f.at(19000); f.socket.usage(bad()); f.at(25000); f.socket.usage(bad()); release(); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.at(26000); f.socket.usage(good()); await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
    f.at(27000); f.socket.usage(bad()); f.at(33000); f.socket.usage(bad()); await f.source.source.flush()
    const commands = f.socket.sent.length
    f.socket.emit('message', JSON.stringify({ method: 'Runtime.executionContextDestroyed', params: { executionContextId: 1 } }))
    await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('expired'); expect(f.socket.sent).toHaveLength(commands)
    f.socket.usage(good(), 1); await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('expired')
  } finally { await f.close() }
})

it('bounds presentation, not the stored affected identities, for a large genuinely known binding set', () => {
  let state: UsageBindingState | undefined
  for (let index = 1; index <= 128; index++) {
    const input = { key: 'usage-binding-health', scope: '1'.repeat(64), scopeRef: { workspaceId: 'workspace-fixture', runId: 'run-fixture' },
      id: index.toString(16).padStart(64, '0'), at: index, fact: { state: 'failed' as const, reason: 'record' as const, identity: index.toString(16).padStart(64, '0'), channel: String(index) } }
    const projection = reduceUsageBindingNotifications(state, input, true, index); state = projection.state
    expect(projection.drafts[0]!.detail!.length).toBeLessThanOrEqual(4000)
  }
  expect(state!.episode?.causes).toHaveLength(128)
  expect(readUsageBindingState(state, 'usage-binding-health')?.episode?.causes).toHaveLength(128)
})

it('reconnecting captions do not repeatedly invent document scopes or private checkpoint writes', async () => {
  const f = fixture()
  try {
    await f.observer.attach(); const reset = vi.spyOn(f.source, 'reset')
    f.socket.emit('close'); await f.source.source.flush(); const commits = vi.mocked(f.h.port.commitSource).mock.calls.length
    ;(f.observer as any).setStatus('reconnecting', 'different retry caption')
    ;(f.observer as any).setStatus('unavailable', 'still unavailable')
    await f.source.source.flush(); expect(reset).toHaveBeenCalledOnce(); expect(f.h.port.commitSource).toHaveBeenCalledTimes(commits)
  } finally { await f.close() }
})

it('wake alone is not a new native document; the original affected binding can genuinely recover without inventing a new incident', async () => {
  const f = fixture()
  try {
    await f.observer.attach(); f.socket.usage(good()); f.at(11000); f.socket.usage(bad()); f.at(17000); f.socket.usage(bad()); await f.source.source.flush()
    const incident = f.h.ledger.page().records[0]!
    const sleeping = f.source.begin('composer-a')!; f.source.suspend(); sleeping.complete({ state: 'ready' }); f.source.resume()
    await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.at(18000); f.socket.usage(good()); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('resolved'); expect(f.h.ledger.page().records[0]?.id).toBe(incident.id)
  } finally { await f.close() }
})
