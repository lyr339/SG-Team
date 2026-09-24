import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { createChannelTeamInbox } from '../src/application/channel-team-inbox'
import { LocalSessionBridge } from '../src/application/local-session-bridge'
import { MemoryReviewCoordinator } from '../src/application/memory-review-coordinator'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TaskDispatcher } from '../src/application/task-dispatcher'
import { TaskPoolService } from '../src/application/task-pool-service'
import { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamMemoryAgentService } from '../src/application/team-memory-agent-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { TeamOrchestrator } from '../src/application/team-orchestrator'
import { INTERNAL_COLLABORATION_NOTIFICATION_PREFIX, TEAM_MESSAGES_DELIVERY_PREFIX } from '../src/domain/channel-message'
import { createConfiguredTeamBundle } from '../src/domain/team-control'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n')
}

interface ConnectedAgent {
  client: Client
  server: McpServer
  channelId: string
}

/**
 * 会话池里的一个协作组（CH-1 lead · CH-2 builder · CH-3 reviewer）从用户下达规划到独立验收、记忆审核的全程。
 * 阶段 4 · 4C 的完成定义：团队消息随 check_messages 内联送达（投递即已读），全程 outbox 没有信封行；
 * 拾光系统的调度按正文执行即是回应，成员拿到派单后直接 claim，不需要 team_message read / respond。
 */
describe('three-channel collaboration group end to end', () => {
  it('plans, dispatches, implements, reviews and governs memory with team messages delivered inline by check_messages', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-three-channel-')), 'team.sqlite3')
    const controlRepository = new SqliteTeamControlRepository(path)
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'alpha',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      mode: 'independent',
      runKey: 'run-three-channel',
      members: ['1', '2', '3'].map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true })),
      now: 100
    })
    controlRepository.upsertWorkspaceTeam(bundle)
    controlRepository.recordInstallation({
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      generation: 'generation123',
      agents: bundle.slots.map((slot) => ({
        agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
        workspaceId: bundle.workspace.id,
        channelId: slot.channelId!,
        generation: 'generation123',
        runId: bundle.run.id,
        capabilities: []
      }))
    })
    const slotOf = (channelId: string) => bundle.slots.find((slot) => slot.channelId === channelId)!
    controlRepository.createGroup({
      runId: bundle.run.id,
      name: '可靠功能组',
      goal: '交付一个由实现与质量角色共同完成的可靠功能',
      leadSlotId: slotOf('1').id,
      members: [
        { slotId: slotOf('1').id, roleTemplateKey: 'lead' },
        { slotId: slotOf('2').id, roleTemplateKey: 'builder' },
        { slotId: slotOf('3').id, roleTemplateKey: 'reviewer' }
      ]
    })
    const taskRepository = new SqliteTaskPoolRepository(path)
    const collaboration = new SqliteTeamCollaborationRepository(path)
    const memoryRepository = new SqliteTeamMemoryRepository(path)
    const channelRepository = new SqliteChannelMessageRepository(path)
    for (const channelId of ['1', '2', '3']) {
      channelRepository.markChannelEmbedded(channelId, bundle.workspace.id, '/workspace/alpha')
      channelRepository.touchPresence(channelId, { waiting: true, connectionPhase: 'waiting', lastSeenAt: Date.now() })
    }
    const relay = new ChannelMessageRelay(channelRepository)
    const bridge = new LocalSessionBridge(relay)
    const team = new TeamControlService(controlRepository, bridge)
    const tasks = new TaskPoolService(taskRepository, team)
    const memory = new TeamMemoryService(memoryRepository, team)
    const taskDispatcher = new TaskDispatcher(tasks, team, collaboration)
    const memoryCoordinator = new MemoryReviewCoordinator(memory, team, collaboration)
    const orchestrator = new TeamOrchestrator(team, tasks, collaboration, taskDispatcher, memoryCoordinator)
    const teamInbox = createChannelTeamInbox({
      ownershipFor: (channelId) => controlRepository.resolveChannelSessionOwner(channelId),
      collaboration
    })

    const agents: ConnectedAgent[] = []
    const connectAgent = async (channelId: string): Promise<ConnectedAgent> => {
      const identity = controlRepository.resolveChannelAgentIdentity(channelId)
      const taskService = new TaskAgentService(taskRepository, { ...identity }, taskRepository, controlRepository)
      const coordination = new TeamCollaborationAgentService(collaboration, { ...identity, slotId: identity.slotId! }, taskService)
      const agentMemory = new TeamMemoryAgentService(memoryRepository, collaboration, coordination.identity)
      const server = createUnifiedChannelServer({
        runtimeFor: () => ({ service: taskService, collaboration: coordination, memory: agentMemory, controlRepository }),
        channelServiceFor: () => new ChannelMessageService(channelRepository, teamInbox),
        refreshIdentity: () => {
          const current = controlRepository.resolveChannelAgentIdentity(channelId)
          Object.assign(taskService.identity, current)
          Object.assign(coordination.identity, current)
        },
        keepaliveTimeoutMs: 1_000
      })
      const client = new Client({ name: `agent-ch-${channelId}`, version: '1.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const connected = { client, server, channelId }
      agents.push(connected)
      return connected
    }
    const calls: string[] = []
    const callFor = (agent: ConnectedAgent) => async (name: string, args: Record<string, unknown> = {}) => {
      calls.push(`CH-${agent.channelId}:${name}${typeof args.action === 'string' ? `:${args.action}` : ''}`)
      const result = await agent.client.callTool({ name, arguments: { channel_id: agent.channelId, ...args } })
      expect(result.isError, textOf(result)).not.toBe(true)
      return result
    }
    const envelopeRows = () => channelRepository.listOutboundSince(0)
      .filter((message) => message.kind === 'internal' || message.text.startsWith(INTERNAL_COLLABORATION_NOTIFICATION_PREFIX))
    const messageBy = (fragment: string) => Object.values(collaboration.loadRun(bundle.run.id).messages)
      .find((message) => message.clientMessageId.includes(fragment))

    try {
      const lead = await connectAgent('1')
      const builder = await connectAgent('2')
      const reviewer = await connectAgent('3')
      const leadCall = callFor(lead)
      const builderCall = callFor(builder)
      const reviewerCall = callFor(reviewer)
      for (const call of [leadCall, builderCall, reviewerCall]) await call('team_check_in')

      // 用户要求开始：lead 的下一次 check_messages 直接带回正文，回执即刻记为已读。
      const planningMessage = collaboration.createMessage({
        runId: bundle.run.id,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: slotOf('1').id },
        kind: 'directive',
        subject: '用户要求开始执行',
        content: '【用户明确指令】请根据组目标拆分并分配任务。',
        clientMessageId: 'operator:user-start-planning'
      })
      const planningDelivery = textOf(await leadCall('check_messages'))
      expect(planningDelivery.startsWith(`${TEAM_MESSAGES_DELIVERY_PREFIX}CH-1 · 1 条`)).toBe(true)
      expect(planningDelivery).toContain('【用户明确指令】请根据组目标拆分并分配任务。')
      expect(planningDelivery).toContain(`来自 拾光系统 · messageId: ${planningMessage.id}`)
      expect(collaboration.loadRun(bundle.run.id).messages[planningMessage.id]?.receipt.readAt).toBeDefined()

      const planned = await leadCall('team_task', {
        action: 'plan',
        tasks: [{
          key: 'feature',
          title: '实现可靠功能',
          description: '实现功能并留下完整测试证据',
          acceptance: '构建通过、测试通过、失败路径有证据',
          targetSlotId: slotOf('2').id,
          requiredCapabilities: ['code']
        }]
      })
      const taskId = (planned.structuredContent as { tasks?: Array<{ id?: string }> }).tasks?.[0]?.id
      expect(taskId).toMatch(/^task-/)

      // 派单：builder 醒来即见任务正文，直接 claim。
      tasks.pollExternalChanges()
      orchestrator.reconcile()
      const dispatch = textOf(await builderCall('check_messages'))
      expect(dispatch).toContain('【系统任务调度】')
      expect(dispatch).toContain(`任务 ID：${taskId}`)
      expect(dispatch).toContain('验收标准：构建通过、测试通过、失败路径有证据')
      expect(dispatch).not.toContain('· 需回应 ·')
      await builderCall('team_task', { action: 'claim', taskId })
      await builderCall('team_task', { action: 'start', taskId })
      await builderCall('team_task', { action: 'progress', taskId, progress: 90, summary: '实现与测试完成' })
      await builderCall('team_task', { action: 'submit', taskId, output: '生产构建成功；单元测试与错误路径测试全部通过。' })

      tasks.pollExternalChanges()
      orchestrator.reconcile()
      const reviewDispatch = textOf(await reviewerCall('check_messages'))
      expect(reviewDispatch).toContain('【系统独立验收调度】')
      expect(reviewDispatch).toContain('实现方交付摘要：生产构建成功')
      await reviewerCall('team_review', { action: 'claim', taskId })
      await reviewerCall('team_review', {
        action: 'submit',
        taskId,
        decision: 'accept',
        evidence: '重新运行构建、单测和失败路径检查，所有验收标准通过。'
      })
      expect(taskRepository.load().tasks[taskId!]).toMatchObject({ status: 'done' })

      // lead 一次取回成员的自动上报与【任务完成】通知（同一批次），不需要 inbox / read。
      tasks.pollExternalChanges()
      orchestrator.reconcile()
      const leadReports = textOf(await leadCall('check_messages'))
      expect(leadReports).toContain('已领取任务：实现可靠功能')
      expect(leadReports).toContain('已提交验收：实现可靠功能')
      expect(leadReports).toContain('验收通过：实现可靠功能')
      expect(leadReports).toContain('【任务完成】')
      expect(leadReports).not.toContain('· 需回应 ·')

      const proposal = await builderCall('team_memory', {
        action: 'propose',
        kind: 'lesson',
        title: '独立验收必须保留证据',
        content: '实现结论不能直接作为完成依据，必须由质量角色复跑并提交证据。',
        sources: [{ type: 'task', ref: taskId, label: '可靠功能任务' }],
        clientProposalId: 'builder-e2e-memory-01'
      })
      const memoryId = (proposal.structuredContent as { memory?: { id?: string } }).memory?.id
      expect(memoryId).toMatch(/^team-memory:/)
      memoryCoordinator.reconcile()
      const memoryMessage = messageBy(':memory:')!
      const memoryReviewer = agents.find((agent) => memoryMessage.recipient.type === 'agent'
        && slotOf(agent.channelId).id === memoryMessage.recipient.slotId)!
      expect(textOf(await callFor(memoryReviewer)('check_messages'))).toContain('【系统记忆审核调度】')
      await callFor(memoryReviewer)('team_memory', { action: 'review', memoryId, decision: 'accept', note: '任务和独立验收证据完整' })
      expect(memoryRepository.load(bundle.workspace.id, bundle.run.id).items[memoryId!]).toMatchObject({ status: 'accepted' })

      // 完成定义：全程没有信封行，所有发给 Agent 的消息都已随投递记为已读，没人调用 read / inbox / respond。
      expect(envelopeRows()).toEqual([])
      const unread = Object.values(collaboration.loadRun(bundle.run.id).messages)
        .filter((message) => message.recipient.type === 'agent' && message.receipt.readAt === undefined)
      expect(unread.map((message) => message.content.slice(0, 40))).toEqual([])
      expect(calls.filter((call) => /team_message/.test(call))).toEqual([])
    } finally {
      orchestrator.stop()
      memory.dispose()
      team.dispose()
      bridge.dispose()
      relay.stop()
      for (const agent of agents) {
        await agent.client.close()
        await agent.server.close()
      }
      memoryRepository.close()
      collaboration.close()
      taskRepository.close()
      channelRepository.close()
      controlRepository.close()
    }
  })
})
