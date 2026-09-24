import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TeamCollaborationAgentService } from '../src/application/team-collaboration-agent-service'
import { TeamMemoryAgentService } from '../src/application/team-memory-agent-service'
import { createConfiguredTeamBundle } from '../src/domain/team-control'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'

/**
 * 协作消息与团队记忆按协作组作用域（任务书 I3 / I4 / §4.3 / §4.4）：
 * 会话池内两个组互不可见；身份实时解析——出组即失去组内视野；legacy 团队 run 行为不变。
 */

function code(operation: () => unknown): string | undefined {
  try {
    operation()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

function poolFixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-group-scope-')), 'team.sqlite3')
  const control = new SqliteTeamControlRepository(path)
  const tasks = new SqliteTaskPoolRepository(path)
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const memory = new SqliteTeamMemoryRepository(path)
  const workspaceId = 'pool'
  const channelIds = ['1', '2', '3', '4', '5']
  const bundle = createConfiguredTeamBundle({
    workspaceId, workspaceName: workspaceId, workspacePath: `/workspace/${workspaceId}`, now: 100,
    mode: 'independent', runKey: 'run-pool',
    members: channelIds.map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }))
  })
  control.upsertWorkspaceTeam(bundle)
  control.recordInstallation({
    workspaceId, runId: bundle.run.id, generation: 'gen',
    agents: bundle.slots.map((slot) => ({
      agentSessionId: `${workspaceId}:ch-${slot.channelId}:gen`, workspaceId,
      channelId: slot.channelId!, generation: 'gen', runId: bundle.run.id, capabilities: []
    }))
  })
  const slotIdOf = (channelId: string) => bundle.slots.find((slot) => slot.channelId === channelId)!.id
  // A 组：CH-1 lead + CH-2 builder + CH-3 reviewer；B 组：CH-4 lead + CH-5 builder。
  const groupA = control.createGroup({
    runId: bundle.run.id, name: 'A 组', goal: 'A 目标',
    members: [
      { slotId: slotIdOf('1'), roleTemplateKey: 'lead' },
      { slotId: slotIdOf('2'), roleTemplateKey: 'builder' },
      { slotId: slotIdOf('3'), roleTemplateKey: 'reviewer' }
    ],
    leadSlotId: slotIdOf('1')
  }).group
  const groupB = control.createGroup({
    runId: bundle.run.id, name: 'B 组',
    members: [{ slotId: slotIdOf('4'), roleTemplateKey: 'lead' }, { slotId: slotIdOf('5'), roleTemplateKey: 'builder' }],
    leadSlotId: slotIdOf('4')
  }).group
  /** 与 MCP 进程一致：身份每次从 team-control 仓储实时解析，再喂给三个 Agent 服务。 */
  const agentFor = (channelId: string) => {
    const identity = control.resolveChannelAgentIdentity(channelId)
    const runtimeIdentity = { ...identity, slotId: identity.slotId! }
    const taskService = new TaskAgentService(tasks, identity, tasks, control)
    const collaborationService = new TeamCollaborationAgentService(collaboration, runtimeIdentity, taskService)
    const memoryService = new TeamMemoryAgentService(memory, collaboration, collaborationService.identity)
    return { identity, tasks: taskService, collaboration: collaborationService, memory: memoryService }
  }
  return {
    path, control, tasks, collaboration, memory, runId: bundle.run.id, workspaceId, groupA, groupB, slotIdOf, agentFor,
    close: () => { memory.close(); collaboration.close(); tasks.close(); control.close() }
  }
}

describe('协作组作用域 · 消息', () => {
  it('scopes the member directory, lead authority and inbox to the agent\'s own group', () => {
    const data = poolFixture()
    try {
      const leadA = data.agentFor('1')
      const builderA = data.agentFor('2')
      const leadB = data.agentFor('4')
      const builderB = data.agentFor('5')

      // 成员目录只见本组；lead 判定来自组行而非 run 级 lead 角色。
      const contextA = leadA.collaboration.getContext() as { members: Array<{ slotId: string; isEffectiveLead?: boolean }>; self: { groupId?: string } }
      expect(contextA.self.groupId).toBe(data.groupA.id)
      expect(contextA.members.map((member) => member.slotId).sort()).toEqual([data.slotIdOf('1'), data.slotIdOf('2'), data.slotIdOf('3')].sort())
      expect(contextA.members.filter((member) => member.isEffectiveLead).map((member) => member.slotId)).toEqual([data.slotIdOf('1')])
      expect(leadA.collaboration.isCoordinator()).toBe(true)
      expect(builderA.collaboration.isCoordinator()).toBe(false)
      expect(leadB.collaboration.isCoordinator()).toBe(true)

      // 跨组发送被拒；本组发送带组快照。
      expect(code(() => leadA.collaboration.sendMessage({ recipientSlotId: data.slotIdOf('5'), kind: 'directive', content: '跨组指令' })))
        .toBe('recipient_not_found')
      const directive = leadA.collaboration.sendMessage({ recipientSlotId: data.slotIdOf('2'), kind: 'directive', content: '请实现 A 组接口' })
      expect(directive.groupId).toBe(data.groupA.id)
      const broadcastB = leadB.collaboration.broadcast({ kind: 'notice', content: 'B 组同步' })
      expect(broadcastB.map((message) => [message.recipient, message.groupId])).toEqual([[{ type: 'agent', slotId: data.slotIdOf('5') }, data.groupB.id]])

      // 收件箱：builderA 只见 A 组指令；builderB 只见 B 组广播。
      expect(builderA.collaboration.listInbox().map((entry) => entry.id)).toEqual([directive.id])
      expect(builderB.collaboration.listInbox().map((entry) => entry.id)).toEqual([broadcastB[0]!.id])
      // 别组消息在本组作用域里等于不存在（包括试图直接 read）。
      expect(code(() => builderB.collaboration.readMessage(directive.id))).toBe('message_recipient_mismatch')

      // 回应沿线程走，线程定组：回应同样带 A 组快照；lead 的回应收集只见本组。
      const response = builderA.collaboration.respondMessage({ messageId: directive.id, content: '收到，开始实现' })
      expect(response.groupId).toBe(data.groupA.id)
      expect(response.threadId).toBe(directive.threadId)
      // lead 的回应收集只见本组快照里自己发出的问题 / 通告。
      expect(leadB.collaboration.collectResponses().map((entry) => entry.messageId)).toEqual([broadcastB[0]!.id])

      // 操作员视角：run 级装载看全部，组级装载各归其位。
      const all = data.collaboration.loadRun(data.runId)
      expect(all.messageOrder).toHaveLength(3)
      expect(data.collaboration.loadRun(data.runId, data.groupA.id).messageOrder.sort()).toEqual([directive.id, response.id].sort())
      expect(data.collaboration.loadRun(data.runId, data.groupB.id).messageOrder).toEqual([broadcastB[0]!.id])
      expect(data.collaboration.loadRun(data.runId, data.groupA.id).threads.every((thread) => thread.groupId === data.groupA.id)).toBe(true)
    } finally {
      data.close()
    }
  })

  it('infers the group for operator notices from the recipient and rejects mixed-group threads', () => {
    const data = poolFixture()
    try {
      const notice = data.collaboration.createMessage({
        runId: data.runId, sender: { type: 'operator' }, recipient: { type: 'agent', slotId: data.slotIdOf('2') },
        kind: 'notice', content: '操作员提醒', clientMessageId: 'operator-notice-0001'
      })
      expect(notice.groupId).toBe(data.groupA.id)
      // 显式指定别组：接收方不在该组。
      expect(code(() => data.collaboration.createMessage({
        runId: data.runId, sender: { type: 'operator' }, recipient: { type: 'agent', slotId: data.slotIdOf('2') },
        kind: 'notice', content: '错组', clientMessageId: 'operator-notice-0002', groupId: data.groupB.id
      }))).toBe('actor_not_in_group')
      // 别组成员不能把消息挂进 A 组线程。
      expect(code(() => data.collaboration.createMessage({
        runId: data.runId, sender: { type: 'operator' }, recipient: { type: 'agent', slotId: data.slotIdOf('5') },
        kind: 'notice', content: '串线程', clientMessageId: 'operator-notice-0003', threadId: notice.threadId
      }))).toBe('thread_group_mismatch')
      // 两个 Agent 分属不同组不能互发（即使绕过 agent service 直接写仓储）。
      expect(code(() => data.collaboration.createMessage({
        runId: data.runId, sender: { type: 'agent', slotId: data.slotIdOf('1') }, recipient: { type: 'agent', slotId: data.slotIdOf('4') },
        kind: 'question', content: '跨组提问', clientMessageId: 'cross-group-0001'
      }))).toBe('recipient_not_in_group')
      // 内联投递按「接收席位 + 它当前的组」取未读。
      expect(data.collaboration.listUnreadForRecipient({
        runId: data.runId, slotId: data.slotIdOf('2'), groupId: data.groupA.id, limit: 10
      }).map((message) => message.id)).toEqual([notice.id])
    } finally {
      data.close()
    }
  })

  it('drops the group view the moment a seat leaves, and keeps legacy team runs unscoped', () => {
    const data = poolFixture()
    try {
      const leadA = data.agentFor('1')
      leadA.collaboration.sendMessage({ recipientSlotId: data.slotIdOf('2'), kind: 'directive', content: 'A 组指令' })
      data.control.removeGroupMember({ groupId: data.groupA.id, slotId: data.slotIdOf('2') })
      // 出组席位的身份解析回到 not_in_group：任何 team_* 都到不了业务层。
      expect(code(() => data.control.resolveChannelAgentIdentity('2'))).toBe('not_in_group')
      // 仍在组里的 lead 看到成员目录缩小；发给已出组席位的消息被拒。
      expect((leadA.collaboration.getContext() as { members: unknown[] }).members).toHaveLength(2)
      expect(code(() => leadA.collaboration.sendMessage({ recipientSlotId: data.slotIdOf('2'), kind: 'notice', content: '还在吗' })))
        .toBe('recipient_not_found')
      // 组内历史消息保留（只读），仍带原组快照。
      const kept = data.collaboration.loadRun(data.runId, data.groupA.id)
      expect(kept.messageOrder).toHaveLength(1)

      // legacy 团队 run：没有组，目录 = 全员，消息不带组，isEffectiveLead 仍由 lead 模板 / acting lead 决定。
      const legacy = createConfiguredTeamBundle({
        workspaceId: 'legacy', workspaceName: 'legacy', workspacePath: '/workspace/legacy', now: 200,
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }
        ]
      })
      data.control.upsertWorkspaceTeam(legacy)
      const members = data.collaboration.listRunMembers(legacy.run.id)
      expect(members.map((member) => [member.roleTemplateKey, member.isEffectiveLead, member.groupId])).toEqual([
        ['lead', true, undefined], ['builder', false, undefined]
      ])
      const legacyMessage = data.collaboration.createMessage({
        runId: legacy.run.id, sender: { type: 'operator' }, recipient: { type: 'agent', slotId: legacy.slots[1]!.id },
        kind: 'notice', content: 'legacy 通知', clientMessageId: 'legacy-notice-0001'
      })
      expect(legacyMessage.groupId).toBeUndefined()
      expect(data.collaboration.loadRun(legacy.run.id).groupId).toBeUndefined()
    } finally {
      data.close()
    }
  })

  it('adds the group_id columns to a pre-group collaboration database idempotently', () => {
    const data = poolFixture()
    const path = data.path
    data.close()
    const old = new DatabaseSync(path)
    old.exec('DROP INDEX IF EXISTS idx_team_messages_run_group')
    old.exec('ALTER TABLE team_messages DROP COLUMN group_id')
    old.exec('ALTER TABLE team_message_threads DROP COLUMN group_id')
    old.close()
    const first = new SqliteTeamCollaborationRepository(path)
    const second = new SqliteTeamCollaborationRepository(path)
    try {
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        for (const table of ['team_messages', 'team_message_threads']) {
          expect((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)).toContain('group_id')
        }
      } finally {
        database.close()
      }
      expect(first.loadRun('missing').messageOrder).toEqual([])
      expect(second.loadRun('missing').messageOrder).toEqual([])
    } finally {
      second.close()
      first.close()
    }
  })
})

describe('协作组作用域 · 记忆', () => {
  it('keeps run-scoped memory inside the proposer\'s group while project memory stays shared', () => {
    const data = poolFixture()
    try {
      const leadA = data.agentFor('1')
      const builderA = data.agentFor('2')
      const reviewerA = data.agentFor('3')
      const leadB = data.agentFor('4')
      const source = [{ type: 'file' as const, ref: 'docs/ARCHITECTURE.md', label: '架构' }]

      const proposal = builderA.memory.propose({ scope: 'run', kind: 'decision', title: 'A 组决定', content: '接口走 v2', sources: source })
      expect(proposal.groupId).toBe(data.groupA.id)
      // B 组 lead 看不到、也审不了 A 组的提案；A 组 reviewer 可以。
      expect(leadB.memory.search({ includeProposed: true })).toEqual([])
      expect(code(() => leadB.memory.review({ memoryId: proposal.id, decision: 'accept' }))).toBe('memory_not_found')
      expect(code(() => data.memory.review({ memoryId: proposal.id, decision: 'accept', reviewer: { type: 'agent', slotId: data.slotIdOf('4') } })))
        .toBe('memory_group_mismatch')
      expect(reviewerA.memory.review({ memoryId: proposal.id, decision: 'accept' }).status).toBe('accepted')
      expect(leadA.memory.contextBrief()).toMatchObject({ itemCount: 1 })
      expect(leadB.memory.contextBrief()).toMatchObject({ itemCount: 0 })

      // 项目级记忆跨组共享（操作员写入，不带组）。
      const project = data.memory.propose({
        workspaceId: data.workspaceId, runId: data.runId, scope: 'project', kind: 'constraint', title: '项目约束', content: '不用 any',
        proposedBy: { type: 'operator' }, sources: source, clientProposalId: 'operator-project-0001', groupId: data.groupA.id
      })
      expect(project.groupId).toBeUndefined()
      data.memory.review({ memoryId: project.id, decision: 'accept', reviewer: { type: 'operator' } })
      expect(leadB.memory.search({}).map((item) => item.id)).toEqual([])
      expect(data.memory.load(data.workspaceId, data.runId, data.groupB.id).itemOrder).toEqual([project.id])
      expect(data.memory.load(data.workspaceId, data.runId).itemOrder.sort()).toEqual([proposal.id, project.id].sort())

      // 修订只能取代本组记忆。
      expect(code(() => data.memory.propose({
        workspaceId: data.workspaceId, runId: data.runId, scope: 'run', kind: 'decision', title: '篡改', content: 'x',
        proposedBy: { type: 'agent', slotId: data.slotIdOf('5') }, sources: source, clientProposalId: 'b-supersede-0001', supersedesId: proposal.id
      }))).toBe('memory_group_mismatch')
      // 操作员显式指定与提出者不符的组被拒。
      expect(code(() => data.memory.propose({
        workspaceId: data.workspaceId, runId: data.runId, scope: 'run', kind: 'fact', title: '错组', content: 'x',
        proposedBy: { type: 'agent', slotId: data.slotIdOf('5') }, sources: source, clientProposalId: 'b-wrong-group-0001', groupId: data.groupA.id
      }))).toBe('actor_not_in_group')
    } finally {
      data.close()
    }
  })
})
