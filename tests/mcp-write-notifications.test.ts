import { describe, it, expect, vi } from 'vitest'
import { observedMcpWrite, mcpWriteFailureHint } from '../src/domain/mcp-write-observation'
import { McpWriteNotifications } from '../src/application/notifications/mcp-write-notifications'
import {
  notificationSourceHarness,
  notificationFrame,
  notificationTeam
} from './notification-source-fixtures'
import type { ProcessBlockTool } from '../src/domain/conversation-entry'
import { createHash } from 'node:crypto'
import { readMcpWriteState, reduceMcpWriteNotifications, type McpWriteFact } from '../src/domain/mcp-write-notification'
const output = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: false,
    agentSessionId: 'sg-channel:1',
    code: 'internal_error',
    message: 'private raw original output',
    sgWriteFailure: { version: 1, reason: 'storage' },
    ...patch
  })
const block = (patch: Partial<ProcessBlockTool> = {}): ProcessBlockTool => ({
  kind: 'tool',
  id: 'cursor:native-call',
  toolName: 'mcp-SG Team-team_memory',
  toolKind: 'mcp',
  toolCase: 'mcpToolCall',
  status: 'done',
  startedAt: 12000,
  input: {
    providerIdentifier: 'SG Team',
    toolName: 'team_memory',
    args: JSON.stringify({
      channel_id: '1',
      action: 'review',
      memoryId: 'original-memory',
      note: 'private original note'
    })
  },
  output: output(),
  ...patch
})
describe('machine-classified original outcomes only, without changing retry grants', () => {
  it('does not classify constraint/argument/domain errors by text, and preserves original operational categories', () => {
    expect(
      mcpWriteFailureHint(
        Object.assign(Error('busy by text only'), { code: 'ERR_SQLITE_ERROR', errcode: 19 })
      )
    ).toBeUndefined()
    expect(
      mcpWriteFailureHint(Object.assign(Error('private'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }))
    ).toEqual({ version: 1, reason: 'storage' })
    expect(mcpWriteFailureHint(Error('database is locked'))).toBeUndefined()
    for (const errcode of ['5', [5], { valueOf: () => 5 }, null, 5.1, 19])
      expect(mcpWriteFailureHint({ code: 'ERR_SQLITE_ERROR', errcode })).toBeUndefined()
    expect(mcpWriteFailureHint(Object.assign(Error('private'), { code: 'EACCES' }))).toEqual({
      version: 1,
      reason: 'permission'
    })
  })
  it('rejects wrong provider, non-write actions, truncated JSON, missing identity and normal permissions/input rejections', () => {
    expect(observedMcpWrite('mcp-other-team_memory', block().input, output())).toBeUndefined()
    expect(observedMcpWrite(block().toolName, { action: 'search' }, output())).toBeUndefined()
    expect(observedMcpWrite(block().toolName, block().input, output().slice(0, 20))).toBeUndefined()
    expect(observedMcpWrite(block().toolName, block().input, output({ agentSessionId: '' }))).toBeUndefined()
    expect(
      observedMcpWrite(
        block().toolName,
        block().input,
        output({ code: 'memory_self_review_forbidden', sgWriteFailure: undefined })
      )
    ).toBeUndefined()
    expect(observedMcpWrite(block().toolName, block().input, output())).toMatchObject({
      action: 'review',
      reason: 'storage',
      status: 'unconfirmed',
      entity: { kind: 'memory', id: 'original-memory' }
    })
  })
  it('a null success is not a confirmed mutation, while a coordination warning remains success-with-unconfirmed-secondary, never a repeatable failed primary', () => {
    expect(
      observedMcpWrite(block().toolName, block().input, output({ ok: true, memory: null }))
    ).toBeUndefined()
    expect(
      observedMcpWrite(
        'mcp-SG Team-team_task',
        { channel_id: '1', action: 'submit', taskId: 't' },
        output({ ok: true, action: 'submit', task: { id: 't' }, coordinationWarning: 'private raw warning' })
      )
    ).toMatchObject({ status: 'secondary-unconfirmed', reason: 'coordination' })
    expect(observedMcpWrite('mcp-SG Team-team_task', { channel_id: '1', action: 'submit' },
      output({ ok: true, action: 'submit', task: null, coordinationWarning: 'not a primary receipt' }))).toBeUndefined()
  })
  it('requires one intact invocation envelope and exact action, provider and returned entity, without coercing channel or hint types', () => {
    for (const input of [
      { action: 'review' }, { channel_id: 1, action: 'review' },
      { action: 'review', channel_id: '1', args: '{', arguments: { action: 'review', channel_id: '1' } },
      { action: 'review', channel_id: '1', args: [] },
      { ...block().input, providerIdentifier: 'not SG Team' }, { ...block().input, toolName: 'team_run' }
    ]) expect(observedMcpWrite(block().toolName, input, output())).toBeUndefined()
    expect(observedMcpWrite(block().toolName, { parameters: { action: 'review', channel_id: '1' } }, output())).toMatchObject({ channelId: '1' })
    expect(observedMcpWrite(block().toolName, block().input, output({ sgWriteFailure: { version: 1, reason: ['storage'] } }))).toMatchObject({ reason: 'unclassified' })
    expect(observedMcpWrite(block().toolName, block().input, output({ ok: true, action: 'propose', memory: { id: 'original-memory' } }))).toBeUndefined()
    expect(observedMcpWrite(block().toolName, block().input, output({ ok: true, action: 'review', memory: { id: 'wrong-memory' } }))).toBeUndefined()
  })
})
describe('read-only native observation, exact installed session scope and durable dedup', () => {
  it('one current terminal original failure is recorded once, unclassified internals stay quiet, stale bind/identity and running/tool lookalikes do not become notices', async () => {
    const h = notificationSourceHarness(),
      source = new McpWriteNotifications(h.owner, () => 10000),
      team = notificationTeam()
    const blocks = [
      block(),
      block({ id: 'generic', output: output({ sgWriteFailure: undefined }) }),
      block({ id: 'running', status: 'running' }),
      block({ id: 'wrong', output: output({ agentSessionId: 'foreign' }) }),
      block({ id: 'not-sg', toolName: 'mcp-notSG-team_memory' })
    ]
    const frame = notificationFrame({
      liveProcess: { '1': { channelId: '1', state: 'ready', blocks, updatedAt: 12000 } } as never
    })
    try {
      source.observe(frame, team)
      await source.source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 2, unread: 1, pending: 0 })
      expect(h.ledger.page().records.filter((row) => row.attention === 'notice')[0]).toMatchObject({
        target: { kind: 'session', blockId: 'cursor:native-call' },
        scope: { runId: 'run-a', slotId: 'slot-a' }
      })
      expect(JSON.stringify(h.ledger.page())).not.toMatch(/private raw|private original note/)
      const calls = vi.mocked(h.port.commitSource).mock.calls.length
      source.observe(frame, team)
      await source.source.flush()
      expect(vi.mocked(h.port.commitSource).mock.calls.length).toBe(calls)
      const other = structuredClone(team)
      other.members[0]!.binding!.generation = 'new-bind'
      other.bindings[0]!.generation = 'new-bind'
      other.members[0]!.binding!.agentSessionId = 'new-agent'
      source.observe(frame, other)
      await source.source.flush()
      expect(h.ledger.page().summary.total).toBe(2)
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('a historical hydrated native failure never replays a live reminder on restart', async () => {
    const h = notificationSourceHarness(),
      source = new McpWriteNotifications(h.owner, () => 10000),
      push: unknown[] = []
    h.owner.subscribe((event) => push.push(event))
    try {
      const history = notificationFrame({
        conversations: {
          '1': [
            {
              id: 'old',
              channelId: '1',
              role: 'assistant',
              text: 'private reply',
              timestamp: 100,
              status: 'complete',
              source: 'cursor',
              processBlocks: [block({ startedAt: 100 })]
            }
          ]
        }
      })
      source.observe(history, notificationTeam())
      await source.source.flush()
      expect(h.ledger.page().summary.unread).toBe(1)
      expect(push.some((event) => (event as { announcement?: unknown }).announcement)).toBe(false)
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('keeps live → sealed → continuation identity once and never lets a later successful call erase an uncertain attempt', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 10000), team = notificationTeam()
    try {
      const original = block()
      source.observe(notificationFrame({ liveProcess: { '1': { turn: 'turn', blocks: [original], startedAt: 12000, updatedAt: 12000 } } }), team)
      await source.source.flush()
      const first = h.ledger.page().records[0]!
      source.observe(notificationFrame({ conversations: { '1': [{ id: 'entry', channelId: '1', role: 'assistant', text: '', timestamp: 12000, source: 'cursor', status: 'complete',
        processBlocks: [original], continuationBlocks: [original, block({ id: 'later', output: output({ ok: true, action: 'review', memory: { id: 'original-memory' }, sgWriteFailure: undefined }) })] }] } }), team)
      await source.source.flush()
      expect(h.ledger.page().records).toEqual([first])
      expect(first.state).toBe('active')
    } finally { await source.close(); await h.owner.close() }
  })
  it('fences current native channel, installed composer, runtime scope and old blocks even when an agent ID is reused', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 10000), team = notificationTeam()
    const frame = notificationFrame({ liveProcess: { '1': { turn: 'turn', blocks: [block()], startedAt: 12000, updatedAt: 12000 } } })
    try {
      const crossedChannel = block({ input: { args: { channel_id: '2', action: 'review' } } })
      source.observe(notificationFrame({ liveProcess: { '1': { ...frame.liveProcess!['1']!, blocks: [crossedChannel, block({ id: 'shell', toolKind: 'command' })] } } }), team)
      const unbound = structuredClone(team); delete unbound.members[0]!.binding!.composerId
      source.observe(frame, unbound)
      const rebinding = structuredClone(team); rebinding.members[0]!.binding!.generation = 'later-generation'; rebinding.members[0]!.binding!.installedAt = 15000
      source.observe(frame, rebinding)
      source.observe({ ...frame, runtimeScope: { workspaceId: 'foreign', runId: team.activeRun!.id, teamRevision: team.revision } }, team)
      source.observe(notificationFrame({ sessions: [{ ...frame.sessions[0]!, composerId: 'foreign' }], liveProcess: frame.liveProcess }), team)
      await source.source.flush()
      expect(h.ledger.page().summary.total).toBe(0)
      source.observe(frame, team); await source.source.flush()
      expect(h.ledger.page().summary.total).toBe(1)
      const foreign = structuredClone(team); foreign.activeWorkspaceId = 'foreign'; foreign.activeRun!.workspaceId = 'foreign'
      foreign.members[0]!.binding!.workspaceId = 'foreign'; foreign.members[0]!.binding!.installedAt = 15000
      source.observe(frame, foreign); await source.source.flush()
      expect(h.ledger.page().summary.total).toBe(1)
    } finally { await source.close(); await h.owner.close() }
  })
  it('rechecks an unknown private ACK on the next real frame, while 1000 unchanged heartbeats never serialize the process history again', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 10000), team = notificationTeam()
    const blocks = [block()], frame = notificationFrame({ liveProcess: { '1': { turn: 'turn', blocks, startedAt: 12000, updatedAt: 12000 } } })
    const original = h.port.commitSource.bind(h.port)
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { await original(...args); throw Error('private ACK lost after commit') })
    try {
      source.observe(frame, team); await source.source.flush()
      expect(h.owner.status().historyIncomplete).toBe(true)
      expect(h.ledger.page().summary.total).toBe(1)
      source.observe(frame, team); await source.source.flush()
      expect(vi.mocked(h.port.sourceState).mock.calls.length).toBe(2)
      const calls = vi.mocked(h.port.commitSource).mock.calls.length
      const stringify = vi.spyOn(JSON, 'stringify')
      try {
        for (let i = 0; i < 1000; i++) source.observe(frame, team)
        expect(stringify.mock.calls.some(([value]) => value === blocks || Array.isArray(value) && value.some(v => v?.identity))).toBe(false)
      } finally { stringify.mockRestore() }
      await source.source.flush()
      expect(vi.mocked(h.port.commitSource).mock.calls.length).toBe(calls)
      expect(h.ledger.page().summary.total).toBe(1)
    } finally { await source.close(); await h.owner.close() }
  })
  it('records genuine attempts but limits repeated Agent failures to quiet history, persists that policy and silences wake/restart replay', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 10000), team = notificationTeam(), events: any[] = []
    h.owner.subscribe(event => events.push(event))
    try {
      source.observe(notificationFrame(), team); await source.source.flush()
      const failures = Array.from({ length: 75 }, (_, i) => block({ id: `attempt-${i}` }))
      source.observe(notificationFrame({ liveProcess: { '1': { turn: 'turn', blocks: failures, startedAt: 12000, updatedAt: 12000 } } }), team)
      await source.source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 75, unread: 1 })
      expect(events.filter(event => event.announcement)).toHaveLength(1)
      source.suspend()
      const timeout = block({ id: 'new-timeout', output: output({ sgWriteFailure: { version: 1, reason: 'timeout' } }) })
      const nextFrame = notificationFrame({ liveProcess: { '1': { turn: 'turn', blocks: [...failures, timeout], startedAt: 12000, updatedAt: 12000 } } })
      source.observe(nextFrame, team); await source.source.flush(); expect(h.ledger.page().summary.total).toBe(75)
      source.resume(); source.observe(nextFrame, team); await source.source.flush()
      expect(h.ledger.page().summary.unread).toBe(2)
      expect(events.filter(event => event.announcement)).toHaveLength(1)
      await source.close()
      const restart = new McpWriteNotifications(h.owner, () => 20000)
      try { restart.observe(nextFrame, team); await restart.source.flush(); expect(h.ledger.page().summary.total).toBe(76) } finally { await restart.close() }
    } finally { await source.close(); await h.owner.close() }
  })
  it('groups distinct current diagnostic families into one summary without hiding their exact native references', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 10000), team = notificationTeam(), events: any[] = []
    h.owner.subscribe(event => events.push(event))
    try {
      source.observe(notificationFrame(), team); await source.source.flush()
      source.observe(notificationFrame({ liveProcess: { '1': { turn: 'turn', blocks: [block(), block({ id: 'timeout', output: output({ sgWriteFailure: { version: 1, reason: 'timeout' } }) })], startedAt: 12000, updatedAt: 12000 } } }), team)
      await source.source.flush()
      const announcements = events.filter(event => event.announcement)
      expect(announcements).toHaveLength(1)
      expect(announcements[0].announcement.group.title).toBe('2 项协作写入结果待核对')
      expect(announcements[0].announcement.group.target.scope).toMatchObject({ composerId: 'composer-a', bindingGeneration: 'bind-a' })
      expect(h.ledger.page().records.map(r => r.target && 'blockId' in r.target ? r.target.blockId : null).sort()).toEqual(['cursor:native-call', 'timeout'])
    } finally { await source.close(); await h.owner.close() }
  })
  it('new live tokens do not rescan sealed history or manufacture source commits, and non-native/recovery bodies have no authority', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 10000), team = notificationTeam()
    let reads = 0
    const original = block()
    Object.defineProperty(original, 'input', { get: () => { reads++; return block().input } })
    const conversations = { '1': [{ id: 'sealed', channelId: '1', role: 'assistant' as const, text: '', timestamp: 12000, source: 'cursor' as const, status: 'complete' as const, processBlocks: [original] }] }
    try {
      source.observe(notificationFrame({ conversations }), team); await source.source.flush()
      const firstReads = reads, commits = vi.mocked(h.port.commitSource).mock.calls.length
      for (let i = 0; i < 100; i++) source.observe(notificationFrame({ conversations, liveProcess: { '1': { turn: 'live', blocks: [{ kind: 'message', id: 'stream', text: String(i), status: 'running' }], startedAt: 12000, updatedAt: 12000 + i } } }), team)
      await source.source.flush()
      expect(reads).toBe(firstReads); expect(vi.mocked(h.port.commitSource).mock.calls.length).toBe(commits)
      for (const sourceKind of ['desktop', 'recovery'] as const) source.observe(notificationFrame({ conversations: { '1': [{ ...conversations['1'][0]!, source: sourceKind, processBlocks: [block({ id: sourceKind })] }] } }), team)
      await source.source.flush(); expect(h.ledger.page().summary.total).toBe(1)
    } finally { await source.close(); await h.owner.close() }
  })
  it('a later real native turn gets its own important result rather than being muted for the entire long session', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 10000), team = notificationTeam(), events: any[] = []
    h.owner.subscribe(event => events.push(event))
    try {
      source.observe(notificationFrame(), team); await source.source.flush()
      for (const turn of ['user-one', 'user-two']) {
        source.observe(notificationFrame({ liveProcess: { '1': { turn, blocks: [block({ id: turn })], startedAt: 12000, updatedAt: 12000 } } }), team)
        await source.source.flush()
      }
      expect(h.ledger.page().summary).toMatchObject({ total: 2, unread: 2 })
      expect(events.filter(event => event.announcement)).toHaveLength(2)
    } finally { await source.close(); await h.owner.close() }
  })
  it('persists more than one source batch without dropping attempts or turning the burst into many unread alerts', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 10000), team = notificationTeam()
    try {
      source.observe(notificationFrame(), team); await source.source.flush()
      source.observe(notificationFrame({ liveProcess: { '1': { turn: 'single-native-turn', blocks: Array.from({ length: 240 }, (_, i) => block({ id: `native-${i}` })), startedAt: 12000, updatedAt: 12000 } } }), team)
      await source.source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 240, unread: 1 })
      expect(vi.mocked(h.port.commitSource).mock.calls.filter(([, , , drafts]) => drafts.length > 0).map(([, , , drafts]) => drafts.length)).toEqual([100, 100, 40])
      expect(h.owner.status().historyIncomplete).toBe(false)
    } finally { await source.close(); await h.owner.close() }
  })
  it('does not attribute an old native write to the current group merely because membership changed', async () => {
    const h = notificationSourceHarness(), source = new McpWriteNotifications(h.owner, () => 10000), team = notificationTeam()
    const frame = notificationFrame({ liveProcess: { '1': { turn: 'native-turn', blocks: [block()], startedAt: 12000, updatedAt: 12000 } } })
    team.members[0]!.slot.groupId = 'group-current'
    try {
      source.observe(frame, team); await source.source.flush()
      const row = h.ledger.page().records[0]!
      expect(row.scope.groupId).toBeUndefined()
      expect(row.target?.kind === 'session' && row.target.scope.groupId).toBeUndefined()
      team.members[0]!.slot.groupId = 'group-other'
      source.observe(frame, team); await source.source.flush()
      expect(h.ledger.page().records).toEqual([row])
    } finally { await source.close(); await h.owner.close() }
  })
})
it('rejects corrupt/over-capacity checkpoints rather than silently dropping diagnostics', () => {
  expect(() => readMcpWriteState({ version: 1, key: 'x', seen: [], attentionFamilies: ['forged:action:storage'] }, 'x')).toThrow()
  const identity = (i: number) => createHash('sha256').update(String(i)).digest('hex')
  const f = { ...observedMcpWrite(block().toolName, block().input, output())!, identity: identity(20001), attentionKey: identity(30001), blockId: 'original', at: 12000, name: 'test', scope: {} } satisfies McpWriteFact
  expect(() => reduceMcpWriteNotifications({ version: 1, key: 'x', seen: Array.from({ length: 20000 }, (_, i) => identity(i)) }, { key: 'x', facts: [f], signature: 'facts', now: 12000, monitorStartedAt: 10000 }, false, 1)).toThrow('有界容量')
})
