import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryReviewCoordinator } from '../src/application/memory-review-coordinator'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TaskDispatcher } from '../src/application/task-dispatcher'
import { TaskPoolService } from '../src/application/task-pool-service'
import { TeamCollaborationSweeper } from '../src/application/team-collaboration-sweeper'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import { TeamMemoryAgentService } from '../src/application/team-memory-agent-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { TeamOrchestrator } from '../src/application/team-orchestrator'
import { createConfiguredTeamBundle } from '../src/domain/team-control'
import type { DesktopSnapshot, SendMessageAccepted, SendMessageInput } from '../src/shared/desktop-api'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'

/**
 * 编排器按组迭代（任务书 §5.5）：分派、验收派单、催办 / 预警、记忆审核、主控失联广播
 * 都限定在对象所属的协作组内；跨组不分派、不打扰。
 */

class MutableBridge implements TeamControlBridge {
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  constructor(private snapshot: DesktopSnapshot) {}
  getSnapshot(): DesktopSnapshot { return structuredClone(this.snapshot) }
  sendMessage(_input: SendMessageInput): SendMessageAccepted { throw new Error('not used') }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }
  stopChannel(channelId: string): void {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) => session.channelId === channelId
        ? { ...session, status: 'offline', online: false, connected: false, runtimeEvidence: 'stopped', waiting: false, connectionPhase: 'cursor_stopped', healthEvidence: ['Cursor Agent 已停止监听'] }
        : session),
      updatedAt: this.snapshot.updatedAt + 1
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }
}

function desktopSnapshot(channelIds: string[]): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: channelIds.map((channelId) => ({
      id: `sg-channel:${channelId}`, channelId, generation: 0, displayName: `SG Team CH-${channelId}`, roleName: '',
      status: 'waiting', currentTask: '', queueDepth: 0, connectionPhase: 'waiting', online: true, connected: true,
      runtimeEvidence: 'active' as const, waiting: true, workingFiles: [], healthEvidence: ['check_messages 正在待命']
    })),
    conversations: {},
    protocolIssues: [],
    updatedAt: 1
  }
}

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-orchestration-groups-')), 'team.sqlite3')
  const controlRepository = new SqliteTeamControlRepository(path)
  const channelIds = ['1', '2', '3', '4', '5', '6']
  const bridge = new MutableBridge(desktopSnapshot(channelIds))
  const team = new TeamControlService(controlRepository, bridge)
  const selected = team.createSessionPool({
    workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
    members: channelIds.map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }))
  })
  const runId = selected.activeRun!.id
  team.recordInstallation({
    workspaceId: 'alpha', runId, generation: 'gen',
    agents: channelIds.map((channelId) => ({
      agentSessionId: `alpha:ch-${channelId}:gen`, workspaceId: 'alpha', channelId, generation: 'gen', runId, capabilities: []
    }))
  })
  const slotIdOf = (channelId: string) => selected.members.find((member) => member.slot.channelId === channelId)!.slot.id
  // A 组：CH-1 lead、CH-2 builder、CH-3 reviewer；B 组：CH-4 lead、CH-5 builder、CH-6 reviewer。
  const groupA = controlRepository.createGroup({
    runId, name: 'A', members: [
      { slotId: slotIdOf('1'), roleTemplateKey: 'lead' }, { slotId: slotIdOf('2'), roleTemplateKey: 'builder' }, { slotId: slotIdOf('3'), roleTemplateKey: 'reviewer' }
    ], leadSlotId: slotIdOf('1')
  }).group
  const groupB = controlRepository.createGroup({
    runId, name: 'B', members: [
      { slotId: slotIdOf('4'), roleTemplateKey: 'lead' }, { slotId: slotIdOf('5'), roleTemplateKey: 'builder' }, { slotId: slotIdOf('6'), roleTemplateKey: 'reviewer' }
    ], leadSlotId: slotIdOf('4')
  }).group
  for (const channelId of channelIds) {
    controlRepository.recordAgentCheckIn(controlRepository.resolveChannelAgentIdentity(channelId), 'ready')
  }
  const tasksRepository = new SqliteTaskPoolRepository(path)
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const memoryRepository = new SqliteTeamMemoryRepository(path)
  const tasks = new TaskPoolService(tasksRepository, team)
  const memory = new TeamMemoryService(memoryRepository, team)
  const identityOf = (channelId: string) => controlRepository.resolveChannelAgentIdentity(channelId)
  const taskAgent = (channelId: string) => new TaskAgentService(tasksRepository, identityOf(channelId), tasksRepository, controlRepository)
  const memoryAgent = (channelId: string) => {
    const identity = identityOf(channelId)
    return new TeamMemoryAgentService(memoryRepository, collaboration, { ...identity, slotId: identity.slotId! })
  }
  const messagesTo = (channelId: string) => collaboration.loadRun(runId).messageOrder
    .map((id) => collaboration.loadRun(runId).messages[id]!)
    .filter((message) => message.recipient.type === 'agent' && message.recipient.slotId === slotIdOf(channelId))
  return {
    bridge, team, controlRepository, tasksRepository, collaboration, memoryRepository, tasks, memory, runId, groupA, groupB,
    slotIdOf, taskAgent, memoryAgent, messagesTo,
    close: () => {
      memory.dispose(); team.dispose(); memoryRepository.close(); collaboration.close(); tasksRepository.close(); controlRepository.close()
    }
  }
}

describe('编排器 · 按协作组迭代', () => {
  it('dispatches execution and review inside the task\'s group only, and never for ungrouped pool tasks', () => {
    const data = fixture()
    try {
      const dispatcher = new TaskDispatcher(data.tasks, data.team, data.collaboration)
      const [taskA] = data.taskAgent('1').plan([{ key: 'a-impl', title: 'A 组实现', requiredCapabilities: ['code'] }])
      // 操作员在池里建了一条不带组的任务：没有执行者，不能被派给任何组的成员。
      const ungrouped = data.tasks.createTask({ title: '池级无组任务', requiredCapabilities: ['code'] })
      dispatcher.reconcile()

      const directives = data.collaboration.loadRun(data.runId)
      const dispatched = directives.messageOrder.map((id) => directives.messages[id]!)
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]).toMatchObject({
        kind: 'directive', recipient: { type: 'agent', slotId: data.slotIdOf('2') }, groupId: data.groupA.id
      })
      expect(dispatched[0]!.content).toContain(taskA!.id)
      expect(dispatched.some((message) => message.content.includes(ungrouped.id))).toBe(false)
      expect(data.messagesTo('5')).toEqual([])

      // A 组 builder 提交后，验收只派给 A 组 reviewer（CH-3），B 组 reviewer（CH-6）不被打扰。
      const builderA = data.taskAgent('2')
      builderA.claim(taskA!.id)
      builderA.start(taskA!.id)
      builderA.submit(taskA!.id, 'diff + tests')
      dispatcher.reconcile()
      expect(data.messagesTo('3').map((message) => message.content.split('\n')[0])).toEqual(['【系统独立验收调度】'])
      expect(data.messagesTo('6')).toEqual([])
      expect(data.messagesTo('3')[0]?.groupId).toBe(data.groupA.id)
    } finally {
      data.close()
    }
  })

  it('reminds only the assignee about stale tasks — no lead copy in any group (2A)', () => {
    const data = fixture()
    try {
      const [taskB] = data.taskAgent('4').plan([{ key: 'b-impl', title: 'B 组实现', requiredCapabilities: ['code'] }])
      const builderB = data.taskAgent('5')
      builderB.claim(taskB!.id)
      builderB.start(taskB!.id)
      const dispatcher = new TaskDispatcher(data.tasks, data.team, data.collaboration)
      const coordinator = new MemoryReviewCoordinator(data.memory, data.team, data.collaboration)
      const orchestrator = new TeamOrchestrator(data.team, data.tasks, data.collaboration, dispatcher, coordinator)
      // 通过私有方法入口推进时间：用 Date.now 偏移 10 分钟触发催办窗口。
      const realNow = Date.now
      Date.now = () => realNow() + 10 * 60_000
      try {
        orchestrator.reconcile()
      } finally {
        Date.now = realNow
      }
      expect(data.messagesTo('5').map((message) => message.content.split('\n')[0])).toEqual(['【系统催办】'])
      // B 组 lead 不再收到「请关注」预警（催办是编排器的事，lead 只收 done / failed / attention）。
      expect(data.messagesTo('4')).toEqual([])
      // A 组 lead 与成员没有收到任何 B 组的催办。
      expect(data.messagesTo('1')).toEqual([])
      expect(data.messagesTo('2')).toEqual([])
    } finally {
      data.close()
    }
  })

  it('notifies the group lead exactly once when a task ends done or failed, and never for progress (2A)', () => {
    const data = fixture()
    try {
      const dispatcher = new TaskDispatcher(data.tasks, data.team, data.collaboration)
      const [task] = data.taskAgent('1').plan([{ key: 'a-1', title: 'A 组交付', requiredCapabilities: ['code'], maxAttempts: 1 }])
      const [doomed] = data.taskAgent('1').plan([{ key: 'a-2', title: 'A 组必败', requiredCapabilities: ['code'], maxAttempts: 1 }])
      const leadNotices = () => data.messagesTo('1').filter((message) => message.kind === 'notice')
      const builder = data.taskAgent('2')
      dispatcher.reconcile()
      // 领取 / 开始 / 进度：lead 只收到成员自动生成的 status 上报（现状），没有系统 notice。
      builder.claim(task!.id)
      builder.start(task!.id)
      builder.report(task!.id, 40, '一半')
      dispatcher.reconcile()
      expect(leadNotices()).toEqual([])

      builder.submit(task!.id, 'diff + tests')
      dispatcher.reconcile()
      const reviewer = data.taskAgent('3')
      reviewer.claimReview(task!.id)
      reviewer.submitReview(task!.id, 'accept', '复现通过')
      dispatcher.reconcile()
      dispatcher.reconcile()
      expect(leadNotices().map((message) => [message.content.split('\n')[0], message.groupId])).toEqual([['【任务完成】', data.groupA.id]])
      expect(leadNotices()[0]!.content).toContain(task!.id)
      expect(leadNotices()[0]!.content).toContain('交付摘要：diff + tests')

      // 用尽重试后 failed：一条【任务失败】带原因；进程重启（新派单器）不重复。
      builder.claim(doomed!.id)
      builder.start(doomed!.id)
      builder.fail(doomed!.id, '依赖库不可用')
      dispatcher.reconcile()
      new TaskDispatcher(data.tasks, data.team, data.collaboration).reconcile()
      const failed = leadNotices().filter((message) => message.content.startsWith('【任务失败】'))
      expect(failed).toHaveLength(1)
      expect(failed[0]!.content).toContain('失败原因：依赖库不可用')
      expect(failed[0]!.content).toContain('已用尽 1 次重试')
      // B 组 lead 对 A 组的终态一无所知。
      expect(data.messagesTo('4')).toEqual([])
    } finally {
      data.close()
    }
  })

  it('routes run-scoped memory review to the proposer\'s group lead / reviewer and project memory to any pool reviewer', () => {
    const data = fixture()
    try {
      const coordinator = new MemoryReviewCoordinator(data.memory, data.team, data.collaboration)
      const source = [{ type: 'file' as const, ref: 'docs/ARCHITECTURE.md', label: '架构' }]
      const proposal = data.memoryAgent('2').propose({ scope: 'run', kind: 'decision', title: 'A 组决定', content: '接口走 v2', sources: source })
      coordinator.reconcile()
      // run 级记忆：审核派给 A 组有效 lead（CH-1），而不是 B 组 lead 或 B 组 reviewer。
      const reviewDirectives = data.collaboration.loadRun(data.runId).messageOrder
        .map((id) => data.collaboration.loadRun(data.runId).messages[id]!)
        .filter((message) => message.content.includes(proposal.id))
      expect(reviewDirectives.map((message) => message.recipient)).toEqual([{ type: 'agent', slotId: data.slotIdOf('1') }])
      expect(reviewDirectives[0]?.groupId).toBe(data.groupA.id)

      // 项目级记忆跨组共享：池内任一质量角色可审（按 role.order 取最早的 reviewer）。
      const project = data.memoryRepository.propose({
        workspaceId: 'alpha', runId: data.runId, scope: 'project', kind: 'constraint', title: '项目约束', content: '禁 any',
        proposedBy: { type: 'operator' }, sources: source, clientProposalId: 'operator-project-0001'
      })
      coordinator.reconcile()
      const projectDirectives = data.collaboration.loadRun(data.runId).messageOrder
        .map((id) => data.collaboration.loadRun(data.runId).messages[id]!)
        .filter((message) => message.content.includes(project.id))
      expect(projectDirectives).toHaveLength(1)
      expect([data.slotIdOf('3'), data.slotIdOf('6')]).toContain((projectDirectives[0]!.recipient as { slotId: string }).slotId)
    } finally {
      data.close()
    }
  })

  it('broadcasts a lead-silent alert only inside the group whose lead confirmed offline', () => {
    const data = fixture()
    try {
      const sweeper = new TeamCollaborationSweeper(data.collaboration, () => data.team.getSnapshot())
      expect(sweeper.sweep()).toBe(0)
      // B 组 lead（CH-4）明确终止：只有 CH-5、CH-6 收到接管提醒；A 组三席安静。
      data.bridge.stopChannel('4')
      expect(sweeper.sweep()).toBe(2)
      expect(data.messagesTo('5').map((message) => message.content.slice(0, 8))).toEqual(['【主控失联提醒】'])
      expect(data.messagesTo('6')).toHaveLength(1)
      expect(data.messagesTo('5')[0]?.groupId).toBe(data.groupB.id)
      for (const channelId of ['1', '2', '3']) expect(data.messagesTo(channelId)).toEqual([])
      // 同一终止周期不重复广播。
      expect(sweeper.sweep()).toBe(0)
    } finally {
      data.close()
    }
  })
})
