import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runInNewContext } from 'node:vm'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { CURSOR_STREAM_HOOK_EXPRESSION } from '../../src/infrastructure/cursor/cursor-stream-observer'
import { SqliteTeamControlRepository } from '../../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTaskPoolRepository } from '../../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamMemoryRepository } from '../../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { SqliteChannelMessageRepository } from '../../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { TeamControlService } from '../../src/application/team-control-service'
import { TaskAgentService } from '../../src/application/task-agent-service'
import { TeamCollaborationAgentService } from '../../src/application/team-collaboration-agent-service'
import { TeamMemoryAgentService } from '../../src/application/team-memory-agent-service'
import { ChannelMessageService } from '../../src/application/channel-message-service'
import { createConfiguredTeamBundle } from '../../src/domain/team-control'
import type { ProcessBlockTool } from '../../src/domain/conversation-entry'
import type { DesktopSnapshot } from '../../src/shared/desktop-api'
import type { NotificationService } from '../../src/application/notification-service'
import { McpWriteNotifications } from '../../src/application/notifications/mcp-write-notifications'
import { sessionNotificationObservation } from '../../src/application/notifications/session-lifecycle-notifications'
import { readMcpWriteState } from '../../src/domain/mcp-write-notification'
import { createHash } from 'node:crypto'
import type { NotificationDraft } from '../../src/domain/notification'
import { createUnifiedChannelServer } from '../../src/mcp/unified-channel-server'
import type { TeamChannelRuntime } from '../../src/mcp/team-tools'
import { parseProcessStream } from '../../src/infrastructure/cursor/cursor-cdp-session-creator'

/** Original hook only, with a mutable native bubble for cache/wrapper tests. */
export function nativeMcpHook(toolFormerData: Record<string, unknown>, bubbleId: string, at: number, generating = false, turnId = 'user') {
  const frames: Array<{ composerId: string; observedAt: number; isGenerating: boolean; process?: unknown }> = []
  class Manager { loadedComposers = { ids: ['fixture-composer'] }; markDirty() {} }
  const context = { Promise, queueMicrotask, setTimeout, globalThis: {
    __sgComposerService: { composerDataService: { composerDataHandleManager: new Manager(), getComposerDataIfLoaded: () => ({
      status: generating ? 'generating' : 'completed',
      fullConversationHeadersOnly: [{ type: 1, bubbleId: turnId }, { type: 2, bubbleId }],
      conversationMap: { [bubbleId]: { createdAt: at, toolFormerData } }, generatingBubbleIds: []
    }) } },
    __sgTeamProcessThrottleMs: 0, sgTeamStream: () => {}, sgTeamProcess: (text: string) => frames.push(JSON.parse(text))
  } }
  runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
  return { next: async () => {
    frames.length = 0
    ;(context.globalThis as unknown as { __sgTeamProcessSchedule: (id: string) => void }).__sgTeamProcessSchedule('fixture-composer')
    await Promise.resolve()
    const frame = frames.at(-1); assert.ok(frame?.process)
    return frame
  } }
}

/** Actual installed hook, in an isolated VM; no Cursor, CDP or browser connection. */
export async function nativeMcpResultFrame(
  tool: string, args: Record<string, unknown>, result: Awaited<ReturnType<Client['callTool']>>,
  bubbleId: string, at: number, shape: 'modern' | 'legacy', turnId = 'user'
) {
  const content = result.content ?? []
  const legacy = { name: `mcp-SG Team-${tool}`, status: 'completed', params: args,
    result: JSON.stringify({ result: JSON.stringify({ content, isError: result.isError }) }) }
  const toolFormerData = shape === 'legacy' ? legacy : { ...legacy, toolCall: { tool: {
    case: 'mcpToolCall', value: {
      args: { providerIdentifier: 'SG Team', toolName: tool, args: JSON.stringify(args) },
      result: { result: { case: 'success', value: { isError: result.isError,
        content: content.map(item => ({ content: { case: item.type, value: item } })) } } }
    }
  } } }
  const frame = await nativeMcpHook(toolFormerData, bubbleId, at, false, turnId).next(), process = parseProcessStream(frame.process)
  assert.ok(process)
  const block = process.items.find(item => item.id === `cursor:${bubbleId}`)
  assert.ok(block?.kind === 'tool')
  assert.equal(block?.toolName, `mcp-SG Team-${tool}`)
  assert.equal(block?.toolKind, 'mcp')
  assert.equal(block?.status, 'done')
  // The real hook's clipping/redaction must leave the machine outcome intact.
  if (result.structuredContent !== undefined) {
    assert.ok(block.output)
    assert.deepEqual(JSON.parse(block.output), JSON.parse(JSON.stringify(result.structuredContent)))
  } else if (content.length) assert.equal(block.output ?? '', content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n'))
  else {
    // The original presenter falls back to the complete wrapper when no text
    // exists. Check that exact envelope rather than assuming an empty string.
    const envelope = 'toolCall' in toolFormerData ? toolFormerData.toolCall.tool.value.result : JSON.parse(legacy.result)
    assert.deepEqual(JSON.parse(block.output!), envelope)
  }
  return { ...frame, process }
}
export async function nativeMcpResultBlock(
  tool: string, args: Record<string, unknown>, result: Awaited<ReturnType<Client['callTool']>>,
  bubbleId: string, at: number, shape: 'modern' | 'legacy'
): Promise<ProcessBlockTool> {
  const frame = await nativeMcpResultFrame(tool, args, result, bubbleId, at, shape)
  const block = frame.process.items.find(item => item.id === `cursor:${bubbleId}`)
  assert.ok(block?.kind === 'tool')
  return block
}

/** Shared protocol/evidence fixture for Vitest and the compiled-worker Node/Electron smoke. */
export async function verifyOriginalMcpWrites(owner: NotificationService, options: { legacyComparison?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sg-notification-mcp-business-'))
  const cleanup: Array<() => void | Promise<void>> = []
  const calls: Record<string, number> = {}
  let statusWriteFails = false
  const counted = <T extends object>(target: T, label: string): T => {
    const methods = new Map<PropertyKey, unknown>()
    return new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key, object)
      if (typeof value !== 'function') return value
      if (!methods.has(key)) methods.set(key, (...args: unknown[]) => {
        const name = `${label}.${String(key)}`
        calls[name] = (calls[name] ?? 0) + 1
        if (label === 'messages' && key === 'createMessage' && statusWriteFails)
          throw Object.assign(Error('PRIVATE fixture status IO'), { code: 'EIO' })
        return Reflect.apply(value, object, args)
      })
      return methods.get(key)
    } })
  }
  try {
    const path = join(directory, 'business.sqlite'), memoryPath = path
    const teamRepo = new SqliteTeamControlRepository(path); cleanup.push(() => teamRepo.close())
    const tasks = new SqliteTaskPoolRepository(path); cleanup.push(() => tasks.close())
    const messages = new SqliteTeamCollaborationRepository(path); cleanup.push(() => messages.close())
    const memoryRepo = new SqliteTeamMemoryRepository(memoryPath); cleanup.push(() => memoryRepo.close())
    const channels = new SqliteChannelMessageRepository(join(directory, 'channel.sqlite')); cleanup.push(() => channels.close())
    const bundle = createConfiguredTeamBundle({ workspaceId: 'fixture-mcp', workspaceName: 'fixture', workspacePath: '/fixture-no-cursor', mode: 'independent',
      members: ['1', '2'].map(channelId => ({ channelId, roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true })), now: Date.now() })
    teamRepo.upsertWorkspaceTeam(bundle)
    teamRepo.createGroup({ runId: bundle.run.id, name: 'fixture group', members: bundle.slots.map((slot, i) => ({ slotId: slot.id, roleTemplateKey: i === 0 ? 'lead' : 'builder' })), leadSlotId: bundle.slots[0]!.id })
    const grouped = teamRepo.loadTeamControl()
    teamRepo.recordInstallation({ workspaceId: bundle.workspace.id, runId: bundle.run.id, generation: 'fixture-generation', agents: bundle.slots.map(slot => ({
      agentSessionId: `fixture-mcp:ch-${slot.channelId}:fixture-generation`, workspaceId: bundle.workspace.id,
      runId: bundle.run.id, channelId: slot.channelId!, generation: 'fixture-generation',
      capabilities: grouped.roles.find(role => role.id === grouped.slots.find(candidate => candidate.id === slot.id)!.roleId)!.capabilities
    })) })
    for (const binding of teamRepo.loadTeamControl().bindings)
      assert.equal(teamRepo.recordComposerBinding({ runId: binding.runId, slotId: binding.slotId, generation: binding.generation,
        bindingKey: binding.composerBindingKey!, composerId: `fixture-composer-${binding.channelId}`, method: 'launch_marker', at: Date.now() }), true)
    const frame: DesktopSnapshot = { connection: { state: 'connected', endpoint: 'isolated-fixture', attempt: 0, lastError: '' }, sessions: [], conversations: {}, protocolIssues: [], updatedAt: Date.now() }
    const control = new TeamControlService(counted(teamRepo, 'control'), { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: () => { throw Error('fixture has no outbound bridge') } })
    cleanup.push(() => control.dispose())
    let team = control.getSnapshot(), clock = Date.now()
    frame.runtimeScope = { workspaceId: team.activeWorkspaceId, runId: team.activeRun?.id, teamRevision: team.revision }
    frame.sessions = team.members.map(member => ({ id: member.binding!.agentSessionId, channelId: member.binding!.channelId, generation: 1,
      composerId: member.binding!.composerId, displayName: member.slot.name, roleName: member.slot.name, status: 'running', currentTask: '', queueDepth: 0,
      connectionPhase: 'working', online: true, connected: true, waiting: false, workingFiles: [], healthEvidence: [], runtimeEvidence: 'active', lastSeenAt: clock }))
    const messagePort = counted(messages, 'messages'), taskPort = counted(tasks, 'tasks'), memoryPort = counted(memoryRepo, 'memory')
    const runtimes = new Map<string, TeamChannelRuntime>()
    for (const member of team.members) {
      const binding = member.binding!, identity = { agentSessionId: binding.agentSessionId, runId: bundle.run.id, slotId: member.slot.id, capabilities: member.role!.capabilities, groupId: member.slot.groupId }
      const service = new TaskAgentService(taskPort, identity, taskPort, counted(teamRepo, 'presence'))
      runtimes.set(binding.channelId, { service, collaboration: new TeamCollaborationAgentService(messagePort, identity, service),
        memory: new TeamMemoryAgentService(memoryPort, messagePort, identity), controlRepository: counted(teamRepo, 'run-control'),
        channelPresence: () => ({ connectionPhase: 'cursor_stopped' }) as never })
    }
    const server = createUnifiedChannelServer({ runtimeFor: channel => {
      calls.runtimeFor = (calls.runtimeFor ?? 0) + 1
      const runtime = runtimes.get(channel); assert.ok(runtime); return runtime
    }, channelServiceFor: () => { calls.channelServiceFor = (calls.channelServiceFor ?? 0) + 1; return new ChannelMessageService(channels) } })
    cleanup.push(() => server.close())
    const client = new Client({ name: 'notification-original-MCP-fixture', version: '1.0.0' }); cleanup.push(() => client.close())
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport); await client.connect(clientTransport)
    const tools = (await client.listTools()).tools
    assert.equal(tools.length, 9); assert.ok(JSON.stringify(tools).length < 9700)
    const source = new McpWriteNotifications(owner, () => clock); cleanup.push(() => source.close())
    source.observe(frame, team); await source.source.flush()
    const blocks: Record<string, ProcessBlockTool[]> = { '1': [], '2': [] }
    let requests = 0
    const call = async (tool: string, args: Record<string, unknown>, bubble: string) => {
      requests++; ++clock
      const result = await client.callTool({ name: tool, arguments: args })
      const modern = await nativeMcpResultBlock(tool, args, result, bubble, clock, 'modern')
      const legacy = await nativeMcpResultBlock(tool, args, result, bubble, clock, 'legacy')
      assert.equal(modern.output, legacy.output)
      const channel = args.channel_id as string
      blocks[channel]!.push(modern)
      frame.liveProcess = Object.fromEntries(Object.entries(blocks).map(([id, value]) => [id, { turn: `fixture-turn-${id}`, blocks: [...value], startedAt: clock, updatedAt: clock }]))
      const before = { ...calls }
      source.observe(frame, team); await source.source.flush()
      assert.deepEqual(calls, before, 'notification observation must never read/write/retry original services')
      assert.equal(calls.runtimeFor, requests)
      assert.equal(calls.channelServiceFor ?? 0, 0)
      return result
    }
    const proposalArgs = { channel_id: '1', action: 'propose', kind: 'fact', title: 'PRIVATE proposal title', content: 'PRIVATE proposal body', sources: [{ type: 'file', ref: 'src/private-fixture.ts', label: 'PRIVATE source' }], clientProposalId: 'fixture-proposal-first' }
    const healthy = await call('team_memory', proposalArgs, 'healthy')
    assert.notEqual(healthy.isError, true, JSON.stringify(healthy.structuredContent))
    assert.equal((await owner.page()).summary.total, 0)
    const memoryId = (healthy.structuredContent as { memory: { id: string } }).memory.id
    const refused = await call('team_memory', { channel_id: '1', action: 'review', memoryId, decision: 'accept' }, 'domain-refusal')
    assert.equal(refused.isError, true)
    assert.equal((refused.structuredContent as { code: string }).code, 'memory_self_review_forbidden')
    assert.equal((await owner.page()).summary.total, 0)
    const locker = new DatabaseSync(memoryPath)
    try {
      locker.exec('BEGIN IMMEDIATE')
      const locked = await call('team_memory', { ...proposalArgs, channel_id: '2', clientProposalId: 'fixture-proposal-locked' }, 'native-storage')
      assert.equal(locked.isError, true)
      assert.deepEqual((locked.structuredContent as { sgWriteFailure: unknown }).sgWriteFailure, { version: 1, reason: 'storage' })
    } finally { locker.exec('ROLLBACK'); locker.close() }
    const uncertain = (await owner.page()).records[0]!
    assert.equal((await owner.page()).summary.unread, 1)
    const planned = await call('team_task', { channel_id: '1', action: 'plan', tasks: [{ key: 'fixture-task', title: 'PRIVATE task title' }] }, 'plan')
    const taskId = (planned.structuredContent as { tasks: Array<{ id: string }> }).tasks[0]!.id
    assert.notEqual((await call('team_task', { channel_id: '2', action: 'claim', taskId }, 'claim')).isError, true)
    statusWriteFails = true
    const started = await call('team_task', { channel_id: '2', action: 'start', taskId }, 'secondary-warning')
    assert.notEqual(started.isError, true)
    assert.equal(typeof (started.structuredContent as { coordinationWarning: unknown }).coordinationWarning, 'string')
    assert.equal(tasks.load().tasks[taskId]?.status, 'running')
    const claimedLead = await client.callTool({ name: 'team_run', arguments: { channel_id: '2', action: 'claim_lead' } })
    requests++; ++clock
    assert.notEqual(claimedLead.isError, true)
    assert.equal(typeof (claimedLead.structuredContent as { auditWarning: unknown }).auditWarning, 'string')
    team = control.getSnapshot(); frame.runtimeScope = { workspaceId: team.activeWorkspaceId, runId: team.activeRun?.id, teamRevision: team.revision }
    const runArgs = { channel_id: '2', action: 'claim_lead' }
    blocks['2']!.push(await nativeMcpResultBlock('team_run', runArgs, claimedLead, 'lead-audit', clock, 'modern'))
    frame.liveProcess = { ...frame.liveProcess, '2': { turn: 'fixture-turn-2', blocks: [...blocks['2']!], startedAt: clock, updatedAt: clock } }
    const before = { ...calls }; source.observe(frame, team); await source.source.flush(); assert.deepEqual(calls, before)
    assert.equal(team.groups[0]!.group.actingLeadSlotId, team.members.find(member => member.binding!.channelId === '2')!.slot.id)
    statusWriteFails = false
    await call('team_memory', { ...proposalArgs, channel_id: '2', clientProposalId: 'fixture-proposal-after-lock' }, 'new-explicit-attempt')
    // A distinct successful request cannot turn the previous uncertain request into success.
    assert.deepEqual((await owner.page()).records.find(record => record.id === uncertain.id), uncertain)
    const afterBusiness = { ...calls }
    for (let i = 0; i < 200; ++i) source.observe(frame, team)
    await source.source.flush(); assert.deepEqual(calls, afterBusiness)
    assert.equal(calls.runtimeFor, requests)
    const page = await owner.page()
    assert.equal(page.summary.total, 3); assert.equal(page.summary.unread, 3)
    assert.equal(page.records.some(record => record.subjectState === 'secondary-unconfirmed' && record.title.includes('已返回')), true)
    assert.equal(/PRIVATE|fixture status IO|database is locked|proposal body/.test(JSON.stringify(page)), false)
    assert.equal(calls['memory.propose'], 3) // Three explicit MCP requests, never an observer retry.
    if (options.legacyComparison) {
      // Convert only this fixture's PRIVATE checkpoint/records to the supported
      // older format. Original MCP/server/SQLite outcomes remain untouched.
      const observations = sessionNotificationObservation(frame, team, clock, clock).facts
      const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
      for (const observation of observations) {
        const key = `mcp-write-source:${observation.identity}`, checkpoint = await owner.sourceState(key)
        const state = readMcpWriteState(checkpoint.data, key)
        if (!state) continue
        const rows = page.records.filter(row => state.seen.some(id => row.key === `mcp-write:${id.replace(/^~/, '')}`))
        const drafts: NotificationDraft[] = rows.map(({ id: _id, revision: _revision, attentionRevision: _attention, readRevision: _read, createdAt: _created, updatedAt: _updated,
          readAt: _readAt, archivedAt: _archived, storageEpoch: _epoch, ...row }) => ({ ...row, sourceRevision: row.sourceRevision + 1,
          target: row.target?.kind === 'session' ? { ...row.target, mcpWrite: undefined } : row.target, renewAttention: false, announce: false }))
        assert.equal((await owner.commitSource(key, checkpoint.revision, { ...state, version: 1, seen: state.seen.map(id => id.replace(/^~/, '')) }, drafts)).applied, true)
        source.source.invalidateCheckpoint(key)
      }
      const announced: unknown[] = [], stop = owner.subscribe(event => { if (event.announcement) announced.push(event.announcement) })
      const beforeComparison = { ...calls }
      try {
        source.observe(frame, team); await source.source.flush()
        assert.deepEqual(calls, beforeComparison)
        const compared = await owner.page()
        assert.equal(compared.summary.total, page.summary.total); assert.equal(compared.summary.unread, page.summary.unread)
        assert.equal(compared.records.filter(row => row.subjectState === 'legacy-comparison').length, page.records.length)
        assert.ok(compared.records.every(row => row.detail?.includes('当前结果仅供对照')))
        assert.equal(announced.length, 0)
        assert.equal(/PRIVATE|proposal body/.test(JSON.stringify(compared)), false)
      } finally { stop() }
    }
    return { realOriginalMcpServer: true, realSqliteWriteLock: true, realNativeHookModernAndLegacy: true, originalRequests: requests,
      definitions: tools.length, healthyAndDomainRefusalsQuiet: true, successfulPrimaryWithUnconfirmedSecondary: true,
      originalBusinessCountsPreserved: true, previousUnknownAttemptImmutable: true, noRawParametersOrBodies: true,
      ...(options.legacyComparison ? { currentComparisonWithoutHistoricalIdentityClaim: true, comparisonDidNotReadOldSummariesOrReplayModelCalls: true } : {}), isolated: true }
  } finally {
    for (const close of cleanup.reverse()) { try { await close() } catch {} }
    rmSync(directory, { recursive: true, force: true })
  }
}
