import { expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { RuntimeUsageNotifications } from '../src/application/notifications/runtime-usage-notifications'
import { notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
import { CursorCdpSessionCreator, buildRuntimeInspectionExpression, type CursorCdpSessionCreatorOptions } from '../src/infrastructure/cursor/cursor-cdp-session-creator'
import type { RuntimeUsageReadResult } from '../src/domain/runtime-usage-observation'
import { readRuntimeUsageState } from '../src/domain/runtime-usage-notification'

const path = process.platform === 'win32' ? 'C:\\fixture\\workspace' : '/fixture/workspace'
function team() {
  const value = notificationTeam()
  value.workspaces = [{ id: value.activeWorkspaceId!, name: 'PRIVATE workspace', path, createdAt: 1, updatedAt: 1 }]
  return value
}
function fixture() {
  const h = notificationSourceHarness(); let at = 10000
  const source = new RuntimeUsageNotifications(h.owner, () => at), snapshot = team()
  source.setTeam(snapshot)
  const context = { workspacePath: path, composerIds: ['composer-a'] }
  const frame = (value: RuntimeUsageReadResult) => source.begin(context)?.complete(value)
  return { h, source, snapshot, context, frame, at: (value: number) => { at = value }, close: async () => { await source.close(); await h.owner.close() } }
}
function reader(options: Partial<CursorCdpSessionCreatorOptions>, raw: () => unknown = () => ({ ok: true, rows: [] })) {
  const fetchTargets = vi.fn(async () => [{ id: 'fixture', type: 'page', title: 'fixture', url: 'file:///fixture/workbench.html', webSocketDebuggerUrl: 'ws://127.0.0.1:1/never-connected' }])
  const evaluate = vi.fn(async (_url: string, expression: string) => expression.includes('document.title') ? { bridge: true, title: 'fixture' } : raw())
  return { value: new CursorCdpSessionCreator({ fetchTargets, evaluate, ...options }), fetchTargets, evaluate }
}

it('original runtime expression distinguishes normal empty/zero/long estimated usage from genuine read exceptions without changing liveness', async () => {
  const data: any = { status: 'generating', fullConversationHeadersOnly: [], conversationMap: {}, chatGenerationUUID: 'g', turnTokenUsage: { inputTokens: 0, outputTokens: 0 } }
  const window = { __sgComposerService: { createComposer: () => ({}), composerDataService: {
    getComposerDataIfLoaded: () => data, allComposersData: { allComposers: [{ composerId: 'composer-a' }] }
  } } }
  const invoke = async () => (await runInNewContext(buildRuntimeInspectionExpression(['composer-a']), { window, Map, Date })).rows[0]
  expect(await invoke()).toMatchObject({ usageRead: { state: 'waiting' }, usage: null, state: 'active' })
  data.contextTokensUsed = 500
  expect(await invoke()).toMatchObject({ usageRead: { state: 'ready' }, usage: { contextTokensUsed: 500, generationId: 'g' } })
  Object.defineProperty(data, 'turnTokenUsage', { configurable: true, get: () => { throw Error('PRIVATE native getter') } })
  const failed = await invoke()
  expect(failed).toMatchObject({ usageRead: { state: 'failed', reason: 'read' }, usage: null, state: 'active' })
  expect(JSON.stringify(failed.usageRead)).not.toContain('PRIVATE')
  window.__sgComposerService.composerDataService.getComposerDataIfLoaded = () => undefined as any
  expect(await invoke()).toMatchObject({ usageRead: { state: 'waiting' } })
})

it('observes one original call outcome, preserves the original fetch/evaluate count and all returned usage/process data, and never exports health as liveness', async () => {
  const raw = { ok: true, rows: [{ composerId: 'composer-a', state: 'active', observedAt: 10, usageRead: { state: 'ready' }, usage: { generationId: 'g', inputTokens: 123, contextTokensUsed: 500 } }] }
  const plain = reader({}, () => raw), complete = vi.fn(), observed = reader({ usageReadObserver: { begin: () => ({ complete, unavailable: vi.fn() }), unavailable: vi.fn() } }, () => raw)
  expect(await observed.value.inspectComposerRuntime(path, [' composer-a ', 'composer-a'])).toEqual(await plain.value.inspectComposerRuntime(path, [' composer-a ', 'composer-a']))
  expect(observed.fetchTargets).toHaveBeenCalledTimes(plain.fetchTargets.mock.calls.length)
  expect(observed.evaluate).toHaveBeenCalledTimes(plain.evaluate.mock.calls.length)
  expect(complete).toHaveBeenCalledExactlyOnceWith({ state: 'ready' })
  const returned = await observed.value.inspectComposerRuntime(path, ['composer-a'])
  expect(returned['composer-a']).not.toHaveProperty('usageRead')
})

it('keeps unavailable target/bridge, empty rows and legacy or unloaded data quiet, but reports genuine read/record exceptions with no raw text', async () => {
  const complete = vi.fn(), observer = { begin: () => ({ complete, unavailable: vi.fn() }), unavailable: vi.fn() }
  for (const [raw, expected] of [[{ ok: false, error: 'bridge_not_ready' }, 'waiting'], [{ ok: true, rows: [] }, 'waiting'],
    [{ ok: true, rows: [{ composerId: 'composer-a', usage: { inputTokens: 1 } }] }, 'waiting'],
    [{ ok: true, rows: [{ composerId: 'composer-a', usageRead: { state: 'waiting' } }] }, 'waiting'],
    [{ ok: true, rows: [{ composerId: 'composer-a', usageRead: { state: 'ready' } }] }, 'waiting'],
    [{ ok: true, rows: [{ composerId: 'composer-a', usageRead: { state: 'ready' }, usage: { inputTokens: 1 } }] }, 'waiting'],
    [{ ok: true, rows: [{ composerId: 'composer-a', usageRead: { state: 'ready' }, usage: { generationId: 'g', inputTokens: 1, cacheReadTokens: 2 } }] }, 'waiting'],
    [{ ok: true, rows: 'invalid' }, 'failed'], [{ ok: true, rows: [null] }, 'failed']] as const) {
    const r = reader({ usageReadObserver: observer }, () => raw)
    await r.value.inspectComposerRuntime(path, ['composer-a']); expect(complete.mock.calls.at(-1)?.[0]?.state).toBe(expected)
  }
  const bad = reader({ usageReadObserver: observer }, () => { throw Error('PRIVATE error with credential') })
  expect(await bad.value.inspectComposerRuntime(path, ['composer-a'])).toEqual({})
  expect(complete.mock.calls.at(-1)?.[0]).toEqual({ state: 'failed', reason: 'read' })
  const absent = reader({ usageReadObserver: observer, fetchTargets: async () => [] })
  expect(await absent.value.inspectComposerRuntime(path, ['composer-a'])).toEqual({}); expect(complete.mock.calls.at(-1)?.[0]).toEqual({ state: 'waiting' })
  expect(JSON.stringify(complete.mock.calls)).not.toContain('PRIVATE')
})

it('a throwing observer/begin/gap listener cannot change a healthy original result or swallow an original parser exception', async () => {
  const row: any = { composerId: 'composer-a', state: 'active', usage: { inputTokens: 1 } }
  const raw = () => ({ ok: true, rows: [row] })
  const r = reader({ usageReadObserver: { begin: () => { throw Error('broken begin') }, unavailable: () => { throw Error('broken gap') } } }, raw)
  expect((await r.value.inspectComposerRuntime(path, ['composer-a']))['composer-a']?.usage?.inputTokens).toBe(1)
  const brokenComplete = reader({ usageReadObserver: { begin: () => ({ complete: () => { throw Error('broken complete') }, unavailable: () => { throw Error('broken gap') } }), unavailable: vi.fn() } }, raw)
  expect((await brokenComplete.value.inspectComposerRuntime(path, ['composer-a']))['composer-a']?.usage?.inputTokens).toBe(1)
  Object.defineProperty(row, 'usageRead', { get: () => { throw Error('diagnostic getter only') } })
  expect((await brokenComplete.value.inspectComposerRuntime(path, ['composer-a']))['composer-a']?.usage?.inputTokens).toBe(1)
  const original = Error('original native result getter')
  Object.defineProperty(row.usage, 'inputTokens', { get: () => { throw original } })
  await expect(r.value.inspectComposerRuntime(path, ['composer-a'])).rejects.toBe(original)
  await expect(brokenComplete.value.inspectComposerRuntime(path, ['composer-a'])).rejects.toBe(original)
})

it('uses consecutive real reads only, keeps one episode through a new cause, and reading is not a source recovery', async () => {
  const f = fixture(), events: any[] = []; f.h.owner.subscribe(event => events.push(event))
  try {
    f.frame({ state: 'ready' }); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.at(11000); f.frame({ state: 'failed', reason: 'read' }); f.frame({ state: 'failed', reason: 'read' })
    f.at(12000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.at(17000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush()
    const incident = f.h.ledger.page().records[0]!
    expect(incident).toMatchObject({ eventType: 'usage.runtime-source', scope: {}, state: 'active', target: { kind: 'settings', section: 'stats' } })
    await f.h.owner.read(incident.id, incident.revision); expect(f.h.ledger.page().records[0]?.state).toBe('active')
    for (let n = 0; n < 20; n++) { f.at(18000 + n * 1000); f.frame({ state: 'failed', reason: 'read' }) }
    await f.source.source.flush(); expect(events.filter(event => event.announcement)).toHaveLength(1)
    f.at(40000); f.frame({ state: 'failed', reason: 'record' }); f.at(46000); f.frame({ state: 'failed', reason: 'record' }); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.id).toBe(incident.id); expect(f.h.ledger.page().summary.unread).toBe(1)
    f.at(47000); f.frame({ state: 'waiting' }); await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.at(48000); f.frame({ state: 'ready' }); await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
    expect(JSON.stringify(f.h.ledger.page())).not.toMatch(/PRIVATE|composer-a|fixture\/workspace/)
  } finally { await f.close() }
})

it('rejects mismatched/partial/foreign ownership and late pre-switch or pre-sleep receipts; scope change is not recovery', async () => {
  const f = fixture()
  try {
    f.frame({ state: 'ready' }); f.at(11000); f.frame({ state: 'failed', reason: 'read' }); f.at(17000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush()
    const old = f.source.begin(f.context)!
    expect(f.source.begin({ ...f.context, composerIds: ['other-composer'] })).toBeUndefined()
    expect(f.source.begin({ ...f.context, workspacePath: path + '-other' })).toBeUndefined()
    const changed = structuredClone(f.snapshot); changed.bindings[0]!.generation = 'new-binding'; changed.members[0]!.binding = changed.bindings[0]
    f.source.setTeam(changed); old.complete({ state: 'ready' }); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('expired'); expect(f.h.ledger.page().records[0]?.subjectState).toBe('monitor-unconfirmed')
    f.at(18000); f.frame({ state: 'ready' }); await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('expired')
    const sleeping = f.source.begin(f.context)!; f.source.suspend(); sleeping.complete({ state: 'failed', reason: 'record' }); f.source.resume()
    f.at(19000); f.frame({ state: 'failed', reason: 'read' }); f.at(20000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(1)
    f.at(26000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(2)
    const ended = structuredClone(changed); ended.activeRun!.status = 'completed'; f.source.setTeam(ended); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('expired'); expect(f.source.begin(f.context)).toBeUndefined()
    // A copied/restored workspace ID does not make a different path the same
    // original read source, even if the composer/binding IDs happen to match.
    const moved = structuredClone(changed); moved.workspaces[0]!.path += '-moved'; f.source.setTeam(moved)
    f.source.begin({ ...f.context, workspacePath: moved.workspaces[0]!.path })?.complete({ state: 'ready' }); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('expired')
  } finally { await f.close() }
})

it('same ownership frames do not cancel in-flight reads; a later completed read fences an older delayed failure and long gaps/clocks are not continuous proof', async () => {
  const f = fixture()
  try {
    const old = f.source.begin(f.context)!, latest = f.source.begin(f.context)!
    const cosmetic = structuredClone(f.snapshot); cosmetic.revision++; cosmetic.members[0]!.slot.name = 'new label'
    f.source.setTeam(cosmetic); latest.complete({ state: 'ready' }); old.complete({ state: 'failed', reason: 'read' })
    f.at(17000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.at(10000); f.frame({ state: 'failed', reason: 'read' }); f.at(100000); f.frame({ state: 'failed', reason: 'read' })
    await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.at(106000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(1)
    const two = structuredClone(f.snapshot); two.bindings.push({ ...two.bindings[0]!, id: 'second', slotId: 'slot-b', channelId: '2', composerId: 'composer-b' })
    f.source.setTeam(two)
    expect(f.source.begin({ workspacePath: path, composerIds: ['composer-a'] })).toBeUndefined()
    expect(f.source.begin({ workspacePath: path, composerIds: ['composer-a', 'composer-a'] })).toBeUndefined()
  } finally { await f.close() }
})

it('durable unknown ACK is reconciled on the next real read, not replayed or business-retried; empty startup cannot retain a falsely current monitor', async () => {
  const f = fixture(), commit = f.h.port.commitSource.bind(f.h.port)
  try {
    f.frame({ state: 'ready' }); await f.source.source.flush()
    vi.mocked(f.h.port.commitSource).mockImplementationOnce(async (...args) => { await commit(...args); throw Error('private ACK missing') })
    f.at(11000); f.frame({ state: 'failed', reason: 'read' }); f.at(17000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush()
    f.at(18000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush()
    const record = f.h.ledger.page().records[0]!; expect(f.h.ledger.page().summary.total).toBe(1); expect(f.h.owner.status().historyIncomplete).toBe(true)
    await f.source.close()
    const restarted = new RuntimeUsageNotifications(f.h.owner, () => 19000)
    try {
      const empty = team(); empty.activeRun = undefined; restarted.setTeam(empty); await restarted.source.flush()
      expect(f.h.ledger.page().records[0]?.state).toBe('expired')
      restarted.setTeam(f.snapshot); restarted.begin(f.context)?.complete({ state: 'failed', reason: 'read' })
      // A return to the same scope does not invent a new incident before proof.
      await restarted.source.flush(); expect(f.h.ledger.page().records[0]?.id).toBe(record.id)
    } finally { await restarted.close() }
    expect(readRuntimeUsageState(undefined, 'test')).toBeUndefined()
    expect(() => readRuntimeUsageState({ version: 2 }, 'test')).toThrow()
    expect(() => readRuntimeUsageState({ version: 1, key: 'test', scope: '1'.repeat(64), incident: {
      key: 'usage-runtime:' + '2'.repeat(64), scope: '3'.repeat(64), active: true, monitoring: true, reason: 'read'
    } }, 'test')).toThrow()
  } finally { await f.close() }
})

it('diagnostic gaps and malformed team frames fence late receipts and tentative failures without failing the original team publisher', async () => {
  const f = fixture()
  try {
    f.frame({ state: 'ready' }); f.at(11000); f.frame({ state: 'failed', reason: 'read' })
    const old = f.source.begin(f.context)!
    f.source.unavailable(); old.complete({ state: 'failed', reason: 'read' })
    f.at(17000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(0)
    const prior = f.source.begin(f.context)!
    expect(() => f.source.setTeam({ ...f.snapshot, workspaces: null } as any)).not.toThrow()
    prior.complete({ state: 'ready' }); expect(f.source.begin(f.context)).toBeUndefined()
    f.source.setTeam(f.snapshot); f.at(18000); f.frame({ state: 'failed', reason: 'read' })
    f.at(24000); f.frame({ state: 'failed', reason: 'read' }); await f.source.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(1)
  } finally { await f.close() }
})
