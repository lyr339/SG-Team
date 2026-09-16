import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskAgentService } from '../src/application/task-agent-service'
import { TaskDispatcher } from '../src/application/task-dispatcher'
import { TaskPoolService } from '../src/application/task-pool-service'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import { TeamGroupService } from '../src/application/team-group-service'
import { MEMBERSHIP_NOTICE_PREFIX } from '../src/domain/channel-message'
import { findUnansweredDirectives } from '../src/domain/team-collab-sweeps'
import { ORPHANED_RECEIPT_DETAIL, isOrphanedReceipt } from '../src/domain/team-collaboration'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'

/**
 * TeamGroupService（任务书 §5.2「事务外」列 + §7 拆组 / 移出规则）：仓储事务是真相源，
 * 成功后的副作用——成员关系通知 / 释放租约 / 孤儿回执 / lead 知情——逐条锁定；事务被拒时零副作用。
 */

class RecordingBridge implements TeamControlBridge {
  readonly sent: SendMessageInput[] = []
  failSends = false
  private command = 0
  constructor(private readonly snapshot: DesktopSnapshot) {}
  getSnapshot(): DesktopSnapshot { return structuredClone(this.snapshot) }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    listener(this.getSnapshot())
    return () => undefined
  }
  sendMessage(input: SendMessageInput) {
    if (this.failSends) throw new Error('relay unavailable')
    this.sent.push(input)
    return { commandId: `command-${++this.command}` }
  }
  membershipTo(channelId: string): string[] {
    return this.sent.filter((message) => message.channelId === channelId && message.kind === 'membership').map((message) => message.text)
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

function code(operation: () => unknown): string | undefined {
  try {
    operation()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

function poolFixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-group-service-')), 'team.sqlite3')
  const controlRepository = new SqliteTeamControlRepository(path)
  const taskRepository = new SqliteTaskPoolRepository(path)
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const channelIds = ['1', '2', '3', '4']
  const bridge = new RecordingBridge(desktopSnapshot(channelIds))
  const control = new TeamControlService(controlRepository, bridge)
  const selected = control.configureIndependentWorkspace({
    workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
    members: channelIds.map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }))
  })
  const runId = selected.activeRun!.id
  control.recordInstallation({
    workspaceId: 'alpha', runId, generation: 'gen',
    agents: channelIds.map((channelId) => ({
      agentSessionId: `alpha:ch-${channelId}:gen`, workspaceId: 'alpha', channelId, generation: 'gen', runId, capabilities: []
    }))
  })
  const tasks = new TaskPoolService(taskRepository, control)
  const errors: unknown[] = []
  const service = new TeamGroupService(controlRepository, control, tasks, collaboration, bridge, {
    onerror: (error) => errors.push(error)
  })
  const slotIdOf = (channelId: string) => selected.members.find((member) => member.slot.channelId === channelId)!.slot.id
  const taskAgent = (channelId: string) => new TaskAgentService(
    taskRepository, controlRepository.resolveChannelAgentIdentity(channelId), taskRepository, controlRepository
  )
  const messagesTo = (slotId: string) => {
    const snapshot = collaboration.loadRun(runId)
    return snapshot.messageOrder.map((id) => snapshot.messages[id]!)
      .filter((message) => message.recipient.type === 'agent' && message.recipient.slotId === slotId)
  }
  return {
    path, controlRepository, taskRepository, collaboration, bridge, control, tasks, service, runId, errors, slotIdOf, taskAgent, messagesTo,
    close: () => { tasks.stopWatcher(); control.dispose(); collaboration.close(); taskRepository.close(); controlRepository.close() }
  }
}

describe('TeamGroupService · 建组与加人', () => {
  it('creates the group, notifies every joined seat with a membership notice and drops the team-only preflight blockers', () => {
    const data = poolFixture()
    try {
      const snapshot = data.service.createGroup({
        name: '验收组', goal: '把接口重构收尾',
        members: [{ slotId: data.slotIdOf('1'), roleTemplateKey: 'lead' }, { slotId: data.slotIdOf('2'), roleTemplateKey: 'builder' }],
        leadSlotId: data.slotIdOf('1')
      })
      expect(snapshot.groups).toHaveLength(1)
      const view = snapshot.groups[0]!
      expect(view.group).toMatchObject({ name: '验收组', goal: '把接口重构收尾', status: 'active', leadSlotId: data.slotIdOf('1') })
      expect(view.members.map((member) => [member.slot.channelId, member.role.name, member.slot.solo])).toEqual([
        ['1', '主控协调', false], ['2', '架构实现', false]
      ])
      expect(snapshot.members.find((member) => member.slot.channelId === '3')?.slot.solo).toBe(true)

      // 两条 membership 通知，各到各的通道；独立席位 CH-3 / CH-4 什么都没收到。
      expect(data.bridge.sent.map((message) => [message.channelId, message.kind])).toEqual([['1', 'membership'], ['2', 'membership']])
      const [toLead] = data.bridge.membershipTo('1')
      const [toBuilder] = data.bridge.membershipTo('2')
      expect(toLead!.startsWith(MEMBERSHIP_NOTICE_PREFIX)).toBe(true)
      expect(toLead).toContain('你（CH-1）已加入协作组「验收组」，角色「主控协调」；lead：主控协调 · CH-1。')
      expect(toBuilder).toContain('角色「架构实现」；lead：主控协调 · CH-1。')
      expect(toBuilder).toContain('组目标：把接口重构收尾')
      expect(toBuilder).toContain("team_check_in({channel_id:'2'})")
      expect(data.bridge.membershipTo('3')).toEqual([])

      // 池 run 没有「团队目标」「团队已经运行」两条 blocker（§5.7）：run.goal 为空、入组成员全在线待命也不阻塞。
      expect(snapshot.activeRun?.goal ?? '').toBe('')
      expect(snapshot.preflight.agentsWaiting).toBe(true)
      expect(snapshot.preflight.blockers).toEqual([])
      expect(snapshot.preflight.canLaunch).toBe(true)
      expect(data.errors).toEqual([])
    } finally {
      data.close()
    }
  })

  it('addGroupMembers notifies only the newcomers and labels the lead for them', () => {
    const data = poolFixture()
    try {
      const { groups } = data.service.createGroup({
        name: 'G', members: [{ slotId: data.slotIdOf('1'), roleTemplateKey: 'lead' }], leadSlotId: data.slotIdOf('1')
      })
      data.bridge.sent.length = 0
      const snapshot = data.service.addGroupMembers({
        groupId: groups[0]!.group.id,
        members: [{ slotId: data.slotIdOf('3'), roleTemplateKey: 'reviewer' }]
      })
      expect(snapshot.groups[0]!.members.map((member) => member.slot.channelId)).toEqual(['1', '3'])
      expect(data.bridge.sent.map((message) => message.channelId)).toEqual(['3'])
      expect(data.bridge.membershipTo('3')[0]).toContain('角色「质量验证」；lead：主控协调 · CH-1。')
      // 已在其他组的席位不能再加：事务被拒，零通知。
      expect(code(() => data.service.addGroupMembers({ groupId: groups[0]!.group.id, members: [{ slotId: data.slotIdOf('3'), roleTemplateKey: 'builder' }] })))
        .toBe('group_member_already_grouped')
      expect(data.bridge.sent).toHaveLength(1)
    } finally {
      data.close()
    }
  })

  it('refuses to create groups outside a session pool with no side effect', () => {
    const data = poolFixture()
    try {
      data.control.configureWorkspace({
        workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }
        ]
      })
      const legacy = data.control.getSnapshot()
      expect(code(() => data.service.createGroup({
        name: 'G', members: [{ slotId: legacy.members[0]!.slot.id, roleTemplateKey: 'builder' }]
      }))).toBe('group_requires_pool_run')
      expect(data.bridge.sent).toEqual([])
    } finally {
      data.close()
    }
  })
})

describe('TeamGroupService · 移出', () => {
  it('releases the leaving member\'s lease, orphans its pending directives, notifies it and briefs the lead (§7 rules 1–3)', () => {
    const data = poolFixture()
    try {
      const { groups } = data.service.createGroup({
        name: '验收组', goal: 'G',
        members: [
          { slotId: data.slotIdOf('1'), roleTemplateKey: 'lead' },
          { slotId: data.slotIdOf('2'), roleTemplateKey: 'builder' },
          { slotId: data.slotIdOf('3'), roleTemplateKey: 'reviewer' }
        ],
        leadSlotId: data.slotIdOf('1')
      })
      const groupId = groups[0]!.group.id
      const lead = data.taskAgent('1')
      const builder = data.taskAgent('2')
      const [targeted] = lead.plan([{ key: 'impl', title: '实现', requiredCapabilities: ['code'], targetSlotId: data.slotIdOf('2') }])
      builder.claim(targeted!.id)
      builder.start(targeted!.id)
      // lead 给 builder 的两条指令：一条尚未投递（queued），一条已投递（notified）。
      const queued = data.collaboration.createMessage({
        runId: data.runId, sender: { type: 'agent', slotId: data.slotIdOf('1') }, recipient: { type: 'agent', slotId: data.slotIdOf('2') },
        kind: 'directive', content: '请先补测试', clientMessageId: 'lead-directive-0001'
      })
      const notified = data.collaboration.createMessage({
        runId: data.runId, sender: { type: 'agent', slotId: data.slotIdOf('1') }, recipient: { type: 'agent', slotId: data.slotIdOf('2') },
        kind: 'question', content: '接口版本定了吗', clientMessageId: 'lead-question-0001'
      })
      data.collaboration.markNotificationResult(notified.id, 'notified', '已通知')
      // 给 reviewer 的指令不受影响（对照组）。
      const untouched = data.collaboration.createMessage({
        runId: data.runId, sender: { type: 'agent', slotId: data.slotIdOf('1') }, recipient: { type: 'agent', slotId: data.slotIdOf('3') },
        kind: 'directive', content: '准备验收', clientMessageId: 'lead-directive-0002'
      })
      data.bridge.sent.length = 0

      const snapshot = data.service.removeGroupMember({ groupId, slotId: data.slotIdOf('2') })
      // 成员关系：CH-2 回到独立席位，组内剩 CH-1 / CH-3。
      expect(snapshot.groups[0]!.members.map((member) => member.slot.channelId)).toEqual(['1', '3'])
      expect(snapshot.members.find((member) => member.slot.channelId === '2')?.slot).toMatchObject({ solo: true, groupId: undefined })
      expect(code(() => data.controlRepository.resolveChannelAgentIdentity('2'))).toBe('not_in_group')

      // 规则 1：attempt cancelled(member_left)、任务回 queued、对该席位的定向清空 → 组内其他成员可领。
      const pool = data.taskRepository.load()
      const task = pool.tasks[targeted!.id]!
      expect(task).toMatchObject({ status: 'queued', assigneeSessionId: undefined, targetSlotId: undefined, failureReason: 'member_left' })
      expect(Object.values(pool.attempts).find((attempt) => attempt.taskId === task.id)).toMatchObject({ status: 'cancelled', error: 'member_left' })

      // 规则 2：未投递的改 not_required（不再投给出组会话），已投递的保留状态；两条都带孤儿标记，清扫器不再催办。
      const run = data.collaboration.loadRun(data.runId)
      expect(run.messages[queued.id]!.receipt).toMatchObject({ notificationState: 'not_required', notificationCommandId: undefined })
      expect(run.messages[queued.id]!.receipt.notificationDetail).toBe(`等待通知目标 Agent；${ORPHANED_RECEIPT_DETAIL}`)
      expect(run.messages[notified.id]!.receipt.notificationState).toBe('notified')
      expect(run.messages[notified.id]!.receipt.notificationDetail).toBe(`已通知；${ORPHANED_RECEIPT_DETAIL}`)
      expect(isOrphanedReceipt(run.messages[untouched.id]!.receipt)).toBe(false)
      // 待投递队列：出组者的指令已不在其中；剩下 reviewer 的指令 + 刚给 lead 的移出通知。
      const pending = data.collaboration.listPendingNotifications(data.runId)
      expect(pending.map((message) => message.id)).not.toContain(queued.id)
      expect(pending.map((message) => message.kind)).toEqual(['directive', 'notice'])
      expect(pending[0]!.id).toBe(untouched.id)
      expect(findUnansweredDirectives(run, Date.now() + 60 * 60_000).map((item) => item.id)).toEqual([untouched.id])
      expect(run.events.filter((event) => event.type === 'message.orphaned')).toHaveLength(2)
      // 幂等：再标一次没有新的受影响消息。
      expect(data.collaboration.orphanPendingReceipts({ runId: data.runId, slotId: data.slotIdOf('2'), groupId })).toEqual([])

      // 成员关系通知只发给出组者；lead 收到一条团队 notice（自动落进本组），reviewer 没有新消息。
      expect(data.bridge.sent.map((message) => [message.channelId, message.kind])).toEqual([['2', 'membership']])
      expect(data.bridge.membershipTo('2')[0]).toContain('已被移出协作组「验收组」，恢复为独立席位')
      const leadNotices = data.messagesTo(data.slotIdOf('1'))
      expect(leadNotices).toHaveLength(1)
      expect(leadNotices[0]).toMatchObject({ kind: 'notice', sender: { type: 'operator' }, groupId })
      expect(leadNotices[0]!.content).toContain('成员「架构实现 · CH-2」已被移出协作组「验收组」')
      expect(leadNotices[0]!.content).toContain('与其相关的 1 项任务已回到队列')
      expect(leadNotices[0]!.content).toContain('尚未回应的 2 条消息已标记为无人应答')
      expect(data.messagesTo(data.slotIdOf('3')).map((message) => message.id)).toEqual([untouched.id])
      expect(data.errors).toEqual([])
    } finally {
      data.close()
    }
  })

  it('rejects removing the effective lead while others remain, with zero side effects (§7 rule 4)', () => {
    const data = poolFixture()
    try {
      const { groups } = data.service.createGroup({
        name: 'G', members: [{ slotId: data.slotIdOf('1'), roleTemplateKey: 'lead' }, { slotId: data.slotIdOf('2'), roleTemplateKey: 'builder' }],
        leadSlotId: data.slotIdOf('1')
      })
      const groupId = groups[0]!.group.id
      const [task] = data.taskAgent('1').plan([{ key: 'plan', title: '规划' }])
      data.taskAgent('1').claim(task!.id)
      data.bridge.sent.length = 0
      const revision = data.controlRepository.revision!()

      expect(code(() => data.service.removeGroupMember({ groupId, slotId: data.slotIdOf('1') }))).toBe('lead_must_transfer_first')
      expect(data.bridge.sent).toEqual([])
      expect(data.taskRepository.load().tasks[task!.id]?.status).toBe('leased')
      expect(data.controlRepository.revision!()).toBe(revision)
      expect(data.messagesTo(data.slotIdOf('2'))).toEqual([])

      // 先换 lead 再移出：允许，且原 lead 收到出组通知。
      data.service.setGroupLead({ groupId, slotId: data.slotIdOf('2') })
      data.bridge.sent.length = 0
      const snapshot = data.service.removeGroupMember({ groupId, slotId: data.slotIdOf('1') })
      expect(snapshot.groups[0]!.members.map((member) => member.slot.channelId)).toEqual(['2'])
      expect(snapshot.groups[0]!.effectiveLeadSlotId).toBe(data.slotIdOf('2'))
      expect(data.bridge.sent.map((message) => [message.channelId, message.kind])).toEqual([['1', 'membership']])
      // 释放原 lead 的租约：任务回 queued。
      expect(data.taskRepository.load().tasks[task!.id]?.status).toBe('queued')
    } finally {
      data.close()
    }
  })

  it('still applies the membership change when notice delivery fails, and reports the failure', () => {
    const data = poolFixture()
    try {
      data.bridge.failSends = true
      const snapshot = data.service.createGroup({
        name: 'G', members: [{ slotId: data.slotIdOf('1'), roleTemplateKey: 'lead' }, { slotId: data.slotIdOf('2'), roleTemplateKey: 'builder' }]
      })
      expect(snapshot.groups[0]!.members).toHaveLength(2)
      expect(data.errors).toHaveLength(2)
      expect(String((data.errors[0] as Error).message)).toContain('向 CH-1 投递成员关系通知失败：relay unavailable')
    } finally {
      data.close()
    }
  })
})

describe('TeamGroupService · lead、目标与解散', () => {
  it('setGroupLead notifies the previous and the next lead only, skips no-op changes and supports clearing the lead', () => {
    const data = poolFixture()
    try {
      const { groups } = data.service.createGroup({
        name: 'G', members: [
          { slotId: data.slotIdOf('1'), roleTemplateKey: 'lead' },
          { slotId: data.slotIdOf('2'), roleTemplateKey: 'builder' },
          { slotId: data.slotIdOf('3'), roleTemplateKey: 'reviewer' }
        ],
        leadSlotId: data.slotIdOf('1')
      })
      const groupId = groups[0]!.group.id
      data.bridge.sent.length = 0

      const snapshot = data.service.setGroupLead({ groupId, slotId: data.slotIdOf('2') })
      expect(snapshot.groups[0]!.effectiveLeadSlotId).toBe(data.slotIdOf('2'))
      expect(data.bridge.sent.map((message) => [message.channelId, message.kind])).toEqual([['1', 'membership'], ['2', 'membership']])
      expect(data.bridge.membershipTo('1')[0]).toContain('lead 已变更：现在的 lead 是 架构实现 · CH-2')
      expect(data.bridge.membershipTo('1')[0]).toContain('不再持有主控权限')
      expect(data.bridge.membershipTo('2')[0]).toContain('已成为本组唯一有效主控')
      expect(data.bridge.membershipTo('3')).toEqual([])
      // 有效 lead 现在是 builder 模板：授权时叠加协调 / 规划能力（lead 与模板解耦）。
      expect(data.controlRepository.resolveChannelAgentIdentity('2').capabilities).toEqual(expect.arrayContaining(['coordination', 'planning']))

      // 同一个 lead 再设一次：无变化、无通知。
      data.bridge.sent.length = 0
      data.service.setGroupLead({ groupId, slotId: data.slotIdOf('2') })
      expect(data.bridge.sent).toEqual([])

      // 清空 lead：只有原 lead 收到通知，文案写「无」。
      const cleared = data.service.setGroupLead({ groupId, slotId: null })
      expect(cleared.groups[0]!.effectiveLeadSlotId).toBeUndefined()
      expect(data.bridge.sent.map((message) => message.channelId)).toEqual(['2'])
      expect(data.bridge.membershipTo('2')[0]).toContain('现在的 lead 是 无')
    } finally {
      data.close()
    }
  })

  it('updateGroupGoal briefs every member through a team notice (not a membership notice)', () => {
    const data = poolFixture()
    try {
      const { groups } = data.service.createGroup({
        name: 'G', goal: '旧目标',
        members: [{ slotId: data.slotIdOf('1'), roleTemplateKey: 'lead' }, { slotId: data.slotIdOf('2'), roleTemplateKey: 'builder' }],
        leadSlotId: data.slotIdOf('1')
      })
      const groupId = groups[0]!.group.id
      data.bridge.sent.length = 0
      const snapshot = data.service.updateGroupGoal({ groupId, goal: '新目标：先修 CI' })
      expect(snapshot.groups[0]!.group.goal).toBe('新目标：先修 CI')
      expect(data.bridge.sent).toEqual([])
      for (const channelId of ['1', '2']) {
        const notices = data.messagesTo(data.slotIdOf(channelId))
        expect(notices).toHaveLength(1)
        expect(notices[0]).toMatchObject({ kind: 'notice', sender: { type: 'operator' }, groupId })
        expect(notices[0]!.content).toContain('目标已更新：\n新目标：先修 CI')
      }
      expect(data.messagesTo(data.slotIdOf('3'))).toEqual([])
    } finally {
      data.close()
    }
  })

  it('setGroupPlanPolicy gates team_task plan in a lead-less group and briefs members only when their planning right actually changed (2A)', () => {
    const data = poolFixture()
    try {
      // 无 lead 组默认 any_member：两个成员都能 plan，规划出的任务落在本组。
      const { groups } = data.service.createGroup({
        name: '扁平组', members: [{ slotId: data.slotIdOf('1'), roleTemplateKey: 'builder' }, { slotId: data.slotIdOf('2'), roleTemplateKey: 'reviewer' }]
      })
      const groupId = groups[0]!.group.id
      expect(groups[0]!.group.planPolicy).toBe('any_member')
      const [planned] = data.taskAgent('2').plan([{ key: 'flat-1', title: '扁平组任务' }])
      expect(planned).toMatchObject({ groupId, status: 'queued' })

      // 收紧为 lead_only：成员失去规划权（coordinator_only），每人一条 notice 说明任务改由用户创建。
      const tightened = data.service.setGroupPlanPolicy({ groupId, planPolicy: 'lead_only' })
      expect(tightened.groups[0]!.group.planPolicy).toBe('lead_only')
      expect(code(() => data.taskAgent('2').plan([{ key: 'flat-2', title: '再规划' }]))).toBe('coordinator_only')
      for (const channelId of ['1', '2']) {
        const notices = data.messagesTo(data.slotIdOf(channelId))
        expect(notices).toHaveLength(1)
        expect(notices[0]).toMatchObject({ kind: 'notice', sender: { type: 'operator' }, groupId })
        expect(notices[0]!.content).toContain('不再允许成员规划任务')
      }
      expect(data.bridge.sent.filter((message) => message.kind !== 'membership')).toEqual([])

      // 同值重复设置：无变化、不再通知。
      data.service.setGroupPlanPolicy({ groupId, planPolicy: 'lead_only' })
      expect(data.messagesTo(data.slotIdOf('1'))).toHaveLength(1)

      // 放开回 any_member：规划权回来，再各收一条「允许全体成员规划」。
      data.service.setGroupPlanPolicy({ groupId, planPolicy: 'any_member' })
      expect(data.taskAgent('1').plan([{ key: 'flat-3', title: '放开后规划' }])[0]).toMatchObject({ groupId })
      expect(data.messagesTo(data.slotIdOf('2')).map((message) => message.content.includes('允许全体成员规划任务'))).toEqual([false, true])

      // 有 lead 的组：策略切换不改变任何人的规划权，成员不被打扰。
      const led = data.service.createGroup({
        name: '有 lead', members: [{ slotId: data.slotIdOf('3'), roleTemplateKey: 'lead' }, { slotId: data.slotIdOf('4'), roleTemplateKey: 'builder' }],
        leadSlotId: data.slotIdOf('3')
      }).groups.find((view) => view.group.name === '有 lead')!.group
      expect(led.planPolicy).toBe('lead_only')
      data.service.setGroupPlanPolicy({ groupId: led.id, planPolicy: 'any_member' })
      expect(code(() => data.taskAgent('4').plan([{ key: 'led-1', title: '成员规划' }]))).toBe('coordinator_only')
      expect(data.messagesTo(data.slotIdOf('3'))).toEqual([])
      expect(data.messagesTo(data.slotIdOf('4'))).toEqual([])
      expect(data.errors).toEqual([])
    } finally {
      data.close()
    }
  })

  it('planGroupTasks lets the user plan into a group (lead or not) with the same scope and capability checks as team_task plan, and the dispatcher picks the tasks up (2A)', () => {
    const data = poolFixture()
    try {
      const { groups } = data.service.createGroup({
        name: '共享组', planPolicy: 'lead_only',
        members: [{ slotId: data.slotIdOf('1'), roleTemplateKey: 'builder' }, { slotId: data.slotIdOf('2'), roleTemplateKey: 'reviewer' }]
      })
      const groupId = groups[0]!.group.id
      // 无 lead + lead_only：成员不能 plan，但用户可以。
      expect(code(() => data.taskAgent('1').plan([{ key: 'm', title: '成员规划' }]))).toBe('coordinator_only')
      const planned = data.service.planGroupTasks({
        groupId,
        tasks: [
          { key: 'impl', title: '实现', requiredCapabilities: ['code'], targetSlotId: data.slotIdOf('1') },
          { key: 'verify', title: '验证', dependsOn: ['impl'], requiredCapabilities: ['qa'] }
        ]
      })
      expect(planned.map((task) => [task.key, task.status, task.groupId, task.targetSlotId])).toEqual([
        ['impl', 'queued', groupId, data.slotIdOf('1')],
        ['verify', 'queued', groupId, undefined]
      ])
      // 派单器按组自动派给能力匹配的成员：只有 impl 可执行（verify 依赖它）。
      new TaskDispatcher(data.tasks, data.control, data.collaboration).reconcile()
      const directives = data.messagesTo(data.slotIdOf('1')).filter((message) => message.kind === 'directive')
      expect(directives).toHaveLength(1)
      expect(directives[0]!.content).toContain(planned[0]!.id)
      expect(data.messagesTo(data.slotIdOf('2')).filter((message) => message.kind === 'directive')).toEqual([])

      // 校验与 Agent 侧同口径：目标席位必须在组内、能力必须有人具备、key 在 run 内唯一、组必须存在且活跃。
      expect(code(() => data.service.planGroupTasks({ groupId, tasks: [{ key: 'x', title: 'x', targetSlotId: data.slotIdOf('3') }] }))).toBe('target_slot_not_found')
      expect(code(() => data.service.planGroupTasks({ groupId, tasks: [{ key: 'x', title: 'x', requiredCapabilities: ['ops'] }] }))).toBe('team_capability_unavailable')
      expect(code(() => data.service.planGroupTasks({ groupId, tasks: [{ key: 'x', title: 'x', targetSlotId: data.slotIdOf('2'), requiredCapabilities: ['code'] }] }))).toBe('target_capability_mismatch')
      expect(code(() => data.service.planGroupTasks({ groupId, tasks: [{ key: 'impl', title: '重复 key' }] }))).toBe('duplicate_task_key')
      expect(code(() => data.service.planGroupTasks({ groupId: 'team-group:nope', tasks: [{ key: 'x', title: 'x' }] }))).toBe('group_not_found')
      data.service.dissolveGroup({ groupId })
      expect(code(() => data.service.planGroupTasks({ groupId, tasks: [{ key: 'y', title: 'y' }] }))).toBe('group_not_active')
      expect(data.tasks.getSnapshot().taskOrder).toHaveLength(2)
    } finally {
      data.close()
    }
  })

  it('dissolveGroup cancels the group\'s open tasks, orphans pending directives, restores every seat and notifies each member (§7 rules 5–7)', () => {
    const data = poolFixture()
    try {
      const { groups } = data.service.createGroup({
        name: '验收组', members: [{ slotId: data.slotIdOf('1'), roleTemplateKey: 'lead' }, { slotId: data.slotIdOf('2'), roleTemplateKey: 'builder' }],
        leadSlotId: data.slotIdOf('1')
      })
      const groupId = groups[0]!.group.id
      // 另一个组的任务不受影响（对照组）。
      const other = data.service.createGroup({
        name: '另一组', members: [{ slotId: data.slotIdOf('3'), roleTemplateKey: 'lead' }], leadSlotId: data.slotIdOf('3')
      }).groups.find((view) => view.group.name === '另一组')!
      const [otherTask] = data.taskAgent('3').plan([{ key: 'other', title: '别组任务' }])
      const lead = data.taskAgent('1')
      const builder = data.taskAgent('2')
      const [running, queuedTask] = lead.plan([
        { key: 'impl', title: '实现', requiredCapabilities: ['code'] },
        { key: 'later', title: '稍后', requiredCapabilities: ['code'] }
      ])
      builder.claim(running!.id)
      builder.start(running!.id)
      const directive = data.collaboration.createMessage({
        runId: data.runId, sender: { type: 'agent', slotId: data.slotIdOf('1') }, recipient: { type: 'agent', slotId: data.slotIdOf('2') },
        kind: 'directive', content: '继续', clientMessageId: 'lead-directive-0001'
      })
      data.bridge.sent.length = 0

      const snapshot = data.service.dissolveGroup({ groupId })
      // 规则 5：本组任务全部 cancelled(group_dissolved)；别组任务照旧。
      const pool = data.taskRepository.load()
      expect(pool.tasks[running!.id]).toMatchObject({ status: 'cancelled', failureReason: 'group_dissolved' })
      expect(pool.tasks[queuedTask!.id]).toMatchObject({ status: 'cancelled', failureReason: 'group_dissolved' })
      expect(Object.values(pool.attempts).find((attempt) => attempt.taskId === running!.id)).toMatchObject({ status: 'cancelled', leaseToken: undefined })
      expect(pool.tasks[otherTask!.id]?.status).toBe('queued')
      // 规则 6 / 7：席位恢复独立、令牌不动；组以 dissolved 状态留在快照里（24h 只读卡片）。
      for (const channelId of ['1', '2']) {
        expect(snapshot.members.find((member) => member.slot.channelId === channelId)?.slot).toMatchObject({ solo: true, groupId: undefined })
        expect(code(() => data.controlRepository.resolveChannelAgentIdentity(channelId))).toBe('not_in_group')
      }
      expect(snapshot.bindings.filter((binding) => binding.runId === data.runId)).toHaveLength(4)
      const dissolved = snapshot.groups.find((view) => view.group.id === groupId)!
      expect(dissolved.group.status).toBe('dissolved')
      expect(dissolved.members).toEqual([])
      expect(snapshot.groups.find((view) => view.group.id === other.group.id)?.members.map((member) => member.slot.channelId)).toEqual(['3'])
      // 消息保留只读，待回应的指令标记为孤儿。
      const run = data.collaboration.loadRun(data.runId, groupId)
      expect(run.messageOrder).toEqual([directive.id])
      expect(isOrphanedReceipt(run.messages[directive.id]!.receipt)).toBe(true)
      // 每个成员一条 dissolved 通知；别组的 CH-3 安静。
      expect(data.bridge.sent.map((message) => [message.channelId, message.kind])).toEqual([['1', 'membership'], ['2', 'membership']])
      for (const channelId of ['1', '2']) {
        expect(data.bridge.membershipTo(channelId)[0]).toContain(`协作组「验收组」已解散，你（CH-${channelId}）恢复为独立席位`)
      }
      // 解散后的组不能再操作。
      expect(code(() => data.service.addGroupMembers({ groupId, members: [{ slotId: data.slotIdOf('4'), roleTemplateKey: 'builder' }] }))).toBe('group_dissolved')
      expect(data.errors).toEqual([])
    } finally {
      data.close()
    }
  })
})
