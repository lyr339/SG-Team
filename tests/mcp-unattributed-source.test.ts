import { describe, expect, it, vi } from 'vitest'
import { McpWriteNotifications } from '../src/application/notifications/mcp-write-notifications'
import { unattributedMcpTool } from '../src/domain/mcp-unattributed-call'
import { notificationFrame, notificationTeam, notificationSourceHarness } from './notification-source-fixtures'
import type { ProcessBlockTool, ConversationEntry } from '../src/domain/conversation-entry'
import { originalUnattributedMcpResults, originalMcpDesktopFixture } from '../scripts/fixtures/mcp-unattributed-results'
import { nativeMcpResultBlock, nativeMcpResultFrame, nativeMcpHook } from '../scripts/fixtures/notification-mcp'
import { parseProcessStream } from '../src/infrastructure/cursor/cursor-cdp-session-creator'
import { createHash } from 'node:crypto'
import { readMcpWriteState } from '../src/domain/mcp-write-notification'
import { CursorStreamObserver, type CursorNativeProcessEvent } from '../src/infrastructure/cursor/cursor-stream-observer'
import { UsageBindingFixtureSocket } from '../scripts/fixtures/usage-binding-socket'
import { notificationTargetLabel } from '../src/renderer/src/notifications/notification-view'

describe('MCP failures before validated identity use actual SDK/native metadata', () => {
  it('keeps original SDK input validation/runtime errors and carries their typed result-error flag, not an invented Agent receipt', async () => {
    const result = await originalUnattributedMcpResults()
    expect(result.callsBeforeRuntime).toBe(0); expect(result.runtimeCalls).toBe(1)
    for (const shape of ['modern', 'legacy'] as const)
      for (const [value, input] of [[result.invalid, result.invalidArguments], [result.failedRuntime, result.runtimeArguments]] as const) {
        expect(value.isError).toBe(true); expect(value.structuredContent).toBeUndefined()
        const block = await nativeMcpResultBlock('team_task', input, value, 'unattributed', 1000, shape)
        expect(block.mcpResultError).toBe(true)
      }
  })
  it('invalidates the cached completed bubble when a direct native MCP error flag flips without changing content or references', async () => {
    const result = { isError: false, content: [{ type: 'text', text: 'unchanged original content' }] }
    for (const envelope of [result, { case: 'success', value: result }, { result: { result: { case: 'success', value: result } } }]) {
      const native = nativeMcpHook({ name: 'mcp-SG Team-team_task', status: 'completed', params: { channel_id: 1, action: 'claim' }, result: envelope }, 'same-object', 2000, true)
      const flags = []
      for (const error of [false, true, false]) {
        result.isError = error
        const frame = await native.next(), tool = parseProcessStream(frame.process)?.items[0]
        flags.push(tool?.kind === 'tool' ? tool.mcpResultError : undefined)
      }
      expect(flags).toEqual([undefined, true, undefined])
    }
  })
  it('accepts only typed envelope flags along known wrappers, never flags in body text, input or arbitrary nested metadata', async () => {
    const cases: Array<[unknown, boolean]> = [
      [{ content: [{ type: 'text', text: '{"isError":true}' }] }, false],
      [{ isError: 'true', content: [] }, false],
      [{ metadata: { isError: true }, content: [] }, false],
      [{ result: { case: 'success', value: { isError: true, content: [] } } }, true],
      [JSON.stringify({ result: JSON.stringify({ isError: true, content: [] }) }), true],
      [Array.from({ length: 10 }).reduce<object>(nested => ({ result: nested }), { isError: true }), false]
    ]
    for (const [result, accepted] of cases) {
      const raw = await nativeMcpHook({ name: 'mcp-SG Team-team_task', status: 'completed', params: { isError: true, channel_id: 99 }, result }, 'wrapper', 2000).next()
      const tool = parseProcessStream(raw.process)?.items[0]
      expect(tool?.kind === 'tool' && tool.mcpResultError === true).toBe(accepted)
    }
    const frame = { items: [{ kind: 'tool', id: 'lookalike', toolName: 'mcp-Other-team_task', toolKind: 'mcp', mcpResultError: true, status: 'done' }] }
    expect(parseProcessStream(frame)?.items[0]).not.toHaveProperty('mcpResultError')
  })
  it('strips new error evidence from unverified/foreign contexts without dropping the original process callback', async () => {
    const socket = new UsageBindingFixtureSocket(), received: CursorNativeProcessEvent[] = []
    const observer = new CursorStreamObserver({ fetchPageSocketUrl: async () => 'ws://127.0.0.1:1/never-connected', openSocket: () => socket,
      locateComposerService: async () => true, disarmLegacyPatch: async () => {}, onProcessEvent: event => received.push(event) })
    try {
      await observer.attach()
      const before = socket.sent.length
      for (const executionContextId of [1, 99, undefined]) socket.emit('message', JSON.stringify({ method: 'Runtime.bindingCalled', params: {
        name: 'sgTeamProcess', executionContextId, payload: JSON.stringify({ composerId: 'fixture-composer', isGenerating: false, observedAt: 2000,
          process: { items: [block()] } }) } }))
      expect(received).toHaveLength(3)
      expect(received.map(event => event.process?.items[0]).map(item => item?.kind === 'tool' ? item.mcpResultError : undefined)).toEqual([true, undefined, undefined])
      expect(socket.sent).toHaveLength(before)
    } finally { observer.dispose() }
  })
  it('passes real SDK errors through both native shapes, the parser and the actual desktop projection before recording them', async () => {
    const outcomes = await originalUnattributedMcpResults(), desktop = originalMcpDesktopFixture(), h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000)
    try {
      source.observe(desktop.service.getSnapshot(), desktop.team); await flush(source)
      const before = { ...desktop.counts }
      let at = 2000
      for (const shape of ['modern', 'legacy'] as const) {
        for (const [result, args] of [[outcomes.invalid, outcomes.invalidArguments], [outcomes.failedRuntime, outcomes.runtimeArguments]] as const) {
          const original = await nativeMcpResultFrame('team_task', args, result, `request-${at}`, at, shape)
          const snapshot = desktop.receive(original, at++)
          const tool = snapshot.liveProcess?.['1']?.blocks.find(item => item.kind === 'tool')
          expect(tool?.kind === 'tool' && tool.mcpResultError).toBe(true)
          source.observe(snapshot, desktop.team); await flush(source)
        }
      }
      expect(h.ledger.page().summary).toMatchObject({ total: 4, unread: 1 })
      expect(desktop.counts).toEqual(before); expect(outcomes.runtimeCalls).toBe(1)
      expect(JSON.stringify(h.ledger.page())).not.toContain('PRIVATE')
    } finally { desktop.service.dispose(); await source.close(); await h.owner.close() }
  })
})

const block = (patch: Partial<ProcessBlockTool> = {}): ProcessBlockTool => ({ kind: 'tool', id: 'native:call-1', toolName: 'mcp-SG Team-team_task', toolKind: 'mcp', status: 'done', mcpResultError: true,
  mcpObservationComposerId: 'composer-a',
  input: { providerIdentifier: 'SG Team', toolName: 'team_task', args: { channel_id: 99, taskId: 'PRIVATE guessed entity', action: 'claim' } }, output: 'PRIVATE SDK runtime text', completedAt: 2000, ...patch })
const frame = (blocks: ProcessBlockTool[], turn = 'turn:a') => notificationFrame({ liveProcess: { '1': { blocks, turn, startedAt: 1000, updatedAt: 2000, generating: false } } })
const flush = (source: McpWriteNotifications) => source.source.flush()
const nativeEntry = (id: string, at: number, blocks: ProcessBlockTool[]): ConversationEntry => ({ id, turn: id, channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', text: '', timestamp: at, processBlocks: blocks })

describe('unattributed diagnostic never upgrades unverified input to business identity', () => {
  it('rejects a late old Composer and an invocation begun before installation, while retaining normal late initial binding', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000), team = notificationTeam()
    team.bindings[0]!.installedAt = 1000; team.bindings[0]!.composerBoundAt = 1500
    try {
      source.observe(frame([]), team); await flush(source)
      source.observe(frame([block({ id: 'foreign-composer', mcpObservationComposerId: 'previous-composer', completedAt: 2000 })]), team); await flush(source)
      source.observe(frame([block({ id: 'prior-installation', mcpObservationComposerId: 'composer-a', startedAt: 900, completedAt: 2000 })]), team); await flush(source)
      expect(h.ledger.page().summary.total).toBe(0)
      source.observe(frame([block({ id: 'same-installation', mcpObservationComposerId: 'composer-a', startedAt: 1200, completedAt: 2000 })]), team); await flush(source)
      expect(h.ledger.page().summary.unread).toBe(1)
    } finally { await source.close(); await h.owner.close() }
  })
  it('records a genuine empty error envelope but rejects contradictory native server/tool metadata', async () => {
    expect(unattributedMcpTool(block().toolName, true, undefined)).toBe('team_task')
    for (const field of ['providerIdentifier', 'server', 'serverName'])
      expect(unattributedMcpTool(block().toolName, true, block().output, { [field]: 'Other' })).toBeUndefined()
    expect(unattributedMcpTool(block().toolName, true, block().output, { toolName: 'team_run' })).toBeUndefined()
    const empty = await nativeMcpResultFrame('team_task', { channel_id: 99 }, { isError: true, content: [] }, 'empty-result', 2000, 'modern')
    const desktop = originalMcpDesktopFixture(), h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000)
    try {
      source.observe(desktop.service.getSnapshot(), desktop.team); await flush(source)
      source.observe(desktop.receive(empty, 2000), desktop.team); await flush(source)
      expect(h.ledger.page().summary.unread).toBe(1)
    } finally { desktop.service.dispose(); await source.close(); await h.owner.close() }
  })
  it('upgrades a legacy shared checkpoint without promoting its bare markers or manufacturing old unread calls', async () => {
    const h = notificationSourceHarness(), team = notificationTeam(), initial = new McpWriteNotifications(h.owner, () => 1000)
    initial.observe(frame([]), team); await flush(initial)
    const key = vi.mocked(h.port.sourceState).mock.calls[0]![0], checkpoint = h.ledger.sourceState(key), bare = createHash('sha256').update('uninspected-legacy-write').digest('hex')
    h.ledger.commitSource(key, checkpoint.revision, { version: 1, key, seen: [bare] }, [], 1000)
    await initial.close()
    const source = new McpWriteNotifications(h.owner, () => 3000)
    try {
      source.observe(frame([block()]), team); await flush(source)
      expect(h.ledger.page().summary.total).toBe(0)
      const state = readMcpWriteState(h.ledger.sourceState(key).data, key)!
      expect(state.seen).toContain(bare); expect(state.seen).not.toContain(`~${bare}`); expect(state.unattributedBaselineAt).toBe(3000)
      source.observe(frame([block({ id: 'actual-new', completedAt: 4000 })], 'next-turn'), team); await flush(source)
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
    } finally { await source.close(); await h.owner.close() }
    expect(() => readMcpWriteState({ version: 2, key, seen: [], unattributedBaselineAt: '3000' }, key)).toThrow()
  })
  it('does not let ignored cold stock consume the one notice for a later live failure in the same long native turn', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000), team = notificationTeam()
    try {
      source.observe(frame([block({ id: 'cold', completedAt: 900 })], 'long-turn'), team); await flush(source)
      expect(h.ledger.page().summary.total).toBe(0)
      source.observe(frame([block({ id: 'cold', completedAt: 900 }), block({ id: 'live', completedAt: 2000 })], 'long-turn'), team); await flush(source)
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
    } finally { await source.close(); await h.owner.close() }
  })
  it('keeps the cold-stock boundary across mixed batches even when newer native entries precede older restored entries', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000), team = notificationTeam()
    const known = Array.from({ length: 150 }, (_, i) => block({ id: `known-${i}`, input: { providerIdentifier: 'SG Team', toolName: 'team_task', args: { channel_id: '1', action: 'claim' } },
      output: JSON.stringify({ ok: false, agentSessionId: team.bindings[0]!.agentSessionId, code: 'internal_error', sgWriteFailure: { version: 1, reason: 'storage' } }) }))
    const fresh = nativeEntry('fresh-turn', 2000, Array.from({ length: 200 }, (_, i) => block({ id: `fresh-${i}` })))
    const stock = Array.from({ length: 50 }, (_, i) => nativeEntry(`old-turn-${i}`, 900, [block({ id: `stock-${i}`, completedAt: 900 })]))
    try {
      source.observe(notificationFrame({ ...frame(known, 'known-turn'), conversations: { '1': [fresh, ...stock] } }), team); await flush(source)
      expect(h.ledger.page().summary).toMatchObject({ total: 350, unread: 2 })
      expect(h.owner.status().historyIncomplete).toBe(false)
      expect(vi.mocked(h.port.sourceState)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(h.port.mcpWriteRecords)).not.toHaveBeenCalled()
      expect(vi.mocked(h.port.commitSource).mock.calls.filter(([, , , drafts]) => drafts.length).map(([, , , drafts]) => drafts.length)).toEqual([100, 100, 100, 50])
      await source.close()
      const resumed = new McpWriteNotifications(h.owner, () => 3000)
      try {
        resumed.observe(notificationFrame({ conversations: { '1': [nativeEntry('missed-new-turn', 2500, [block({ id: 'missed-new', completedAt: 2500 })]), fresh, ...stock] } }), team); await flush(resumed)
        expect(h.ledger.page().summary).toMatchObject({ total: 351, unread: 3 })
      } finally { await resumed.close() }
    } finally { await source.close(); await h.owner.close() }
  })
  it('rebases a concurrent checkpoint using its earlier durable boundary instead of the new observer startup time', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 3000), team = notificationTeam()
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => {
      const [key] = args
      h.ledger.commitSource(key, 0, { version: 2, key, seen: [], attentionFamilies: [], unattributedBaselineAt: 1000 }, [], 1000)
      return h.ledger.commitSource(...args)
    })
    try {
      source.observe(frame([block()]), team); await flush(source)
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
      expect(h.port.sourceState).toHaveBeenCalledTimes(1)
      const key = vi.mocked(h.port.sourceState).mock.calls[0]![0]
      expect(readMcpWriteState(h.ledger.sourceState(key).data, key)?.unattributedBaselineAt).toBe(1000)
      expect(h.owner.status().historyIncomplete).toBe(false)
    } finally { await source.close(); await h.owner.close() }
  })
  it('keeps a multi-batch cold boundary after a middle commit loses ACK, then resumes only on the next original frame', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000), team = notificationTeam()
    const entries = [nativeEntry('fresh-turn', 2000, Array.from({ length: 205 }, (_, i) => block({ id: `new-${i}` }))),
      ...Array.from({ length: 35 }, (_, i) => nativeEntry(`stock-turn-${i}`, 900, [block({ id: `old-${i}`, completedAt: 900 })]))]
    let attempt = 0
    try {
      source.observe(frame([]), team); await flush(source)
      vi.mocked(h.port.commitSource).mockImplementation(async (...args) => {
        const result = h.ledger.commitSource(...args)
        if (++attempt === 2) throw Error('isolated ACK lost after durable commit')
        return result
      })
      const input = notificationFrame({ conversations: { '1': entries } })
      source.observe(input, team); await flush(source)
      expect(h.ledger.page().summary.total).toBe(200); expect(attempt).toBe(2)
      source.observe(input, team); await flush(source)
      expect(h.ledger.page().summary).toMatchObject({ total: 205, unread: 1 })
      expect(h.port.sourceState).toHaveBeenCalledTimes(2)
      expect(vi.mocked(h.port.commitSource).mock.calls.every(([, , , drafts]) => drafts.length <= 100)).toBe(true)
      const key = vi.mocked(h.port.sourceState).mock.calls[0]![0]
      expect(readMcpWriteState(h.ledger.sourceState(key).data, key)?.seen).toHaveLength(240)
    } finally { await source.close(); await h.owner.close() }
  })
  it('records only observation workspace/run and exact native location, omitting alleged channel/task/Agent and raw error', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000), team = notificationTeam()
    try {
      source.observe(frame([]), team); await flush(source)
      source.observe(frame([block()]), team); await flush(source)
      const first = h.ledger.page().records[0]!
      expect(first).toMatchObject({ eventType: 'mcp.call-unattributed', subjectState: 'call-error-unattributed', scope: { workspaceId: 'workspace-a', runId: 'run-a' }, target: { kind: 'session', blockId: 'native:call-1', scope: { channelId: '1' } } })
      expect(first.scope.sessionId).toBeUndefined(); expect(first.scope.channelId).toBeUndefined()
      expect(first.target?.kind === 'session' ? first.target.mcpWrite : null).toBeUndefined()
      expect(notificationTargetLabel(first.target, first.subjectState)).toBe('查看原工具')
      expect(first.detail).toContain('不能据此判断失败发生在校验前')
      expect(JSON.stringify(h.ledger.page())).not.toMatch(/PRIVATE|taskId|agentSessionId/)
    } finally { await source.close(); await h.owner.close() }
  })
  it('deduplicates native invocations and keeps same-turn retries quiet while a new real turn is not swallowed', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000), team = notificationTeam(), announcements = vi.fn()
    h.owner.subscribe(event => { if (event.announcement) announcements(event) })
    try {
      source.observe(frame([]), team); await flush(source)
      source.observe(frame([block()]), team); await flush(source)
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision); await h.owner.clearRead({})
      source.observe(frame([block(), block({ id: 'native:call-2' })]), team); await flush(source)
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 0 })
      expect(h.ledger.page().records[0]?.attention).toBe('activity'); expect(h.ledger.marker(first.key).cleared).toBe(true)
      source.observe(frame([block({ id: 'native:call-3' })], 'turn:b'), team); await flush(source)
      expect(h.ledger.page().summary.unread).toBe(1); expect(announcements).toHaveBeenCalledTimes(2)
      const writes = vi.mocked(h.port.commitSource).mock.calls.length
      for (let i = 0; i < 100; i++) source.observe(frame([block({ id: 'native:call-3' })], 'turn:b'), team)
      await flush(source); expect(h.port.commitSource).toHaveBeenCalledTimes(writes)
    } finally { await source.close(); await h.owner.close() }
  })
  it('does not interpret ordinary structured business refusals, error-looking prose, wrong server, imported entries or old installations as this source', async () => {
    expect(unattributedMcpTool(block().toolName, undefined, 'Error: PRIVATE')).toBeUndefined()
    expect(unattributedMcpTool('mcp-Other-team_task', true, block().output)).toBeUndefined()
    expect(unattributedMcpTool(block().toolName, true, JSON.stringify({ ok: false, agentSessionId: 'untrusted-other-agent', code: 'invalid_input' }))).toBeUndefined()
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000), team = notificationTeam()
    try {
      source.observe(frame([]), team); await flush(source)
      const entry: ConversationEntry = { id: 'recovered', channelId: '1', role: 'assistant', source: 'recovery', status: 'complete', timestamp: 2000, text: '', processBlocks: [block()] }
      source.observe(notificationFrame({ conversations: { '1': [entry] } }), team); await flush(source)
      source.observe(frame([block({ completedAt: 0 })]), team); await flush(source)
      source.observe(frame([block({ mcpResultError: undefined })]), team); await flush(source)
      expect(h.ledger.page().summary.total).toBe(0)
    } finally { await source.close(); await h.owner.close() }
  })
  it('waits for the next original frame after an unknown ACK and restores the same diagnostic without replay', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 1000), team = notificationTeam()
    try {
      source.observe(frame([]), team); await flush(source)
      vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { h.ledger.commitSource(...args); throw Error('ACK lost') })
      source.observe(frame([block()]), team); await flush(source)
      source.observe(frame([block()]), team); await flush(source)
      expect(h.ledger.page().summary.total).toBe(1)
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision)
      await source.close(); const restored = new McpWriteNotifications(h.owner, () => 3000)
      restored.observe(frame([block()]), team); await flush(restored); await restored.close()
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 0 })
    } finally { await source.close(); await h.owner.close() }
  })
})
