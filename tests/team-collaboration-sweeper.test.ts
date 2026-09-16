import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamCollaborationSweeper, type TeamCollaborationSweeperOptions } from '../src/application/team-collaboration-sweeper'
import {
  createConfiguredTeamBundle,
  projectGroups,
  type TeamControlSnapshot,
  type TeamMemberRuntime,
  type WorkspaceTeamBundle
} from '../src/domain/team-control'
import type { TeamControlRepository } from '../src/application/team-control-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { createDefaultTeamBundle } from './legacy-team-fixtures'

interface RuntimeOverride {
  online: boolean
  lastSeenAt?: number
  lastAgentActivityAt?: number
  status?: TeamMemberRuntime['status']
  connectionPhase?: string
  runtimeEvidence?: TeamMemberRuntime['runtimeEvidence']
}

/**
 * 测试侧快照构造：sweeper 的心跳口径是 TeamControlSnapshot 成员视图的
 * runtime.lastSeenAt（随长轮询持续刷新），测试通过闭包内的 overrides
 * 模拟主控活性变化（静默/离线/恢复）。
 */
function snapshotProvider(
  control: TeamControlRepository,
  bundle: WorkspaceTeamBundle,
  runtimeOverrides: Map<string, RuntimeOverride>,
  nowRef: () => number
): () => TeamControlSnapshot {
  return () => {
    const state = control.loadTeamControl()
    const roleById = new Map(state.roles.map((role) => [role.id, role]))
    const bindingBySlot = new Map(
      state.bindings.filter((binding) => binding.runId === bundle.run.id).map((binding) => [binding.slotId, binding])
    )
    const members = state.slots
      .filter((slot) => slot.runId === bundle.run.id)
      .map((slot) => {
        const binding = bindingBySlot.get(slot.id)
        const channelId = binding?.channelId ?? slot.channelId ?? ''
        const override = runtimeOverrides.get(slot.id)
        const runtime: TeamMemberRuntime = {
          channelId,
          status: override?.status ?? (override?.online === false ? 'offline' : 'waiting'),
          online: override?.online ?? true,
          waiting: true,
          connectionPhase: override?.connectionPhase ?? 'waiting',
          runtimeEvidence: override?.runtimeEvidence ?? ((override?.online ?? true) ? 'active' : 'suspected'),
          queueDepth: 0,
          lastSeenAt: override?.lastSeenAt ?? nowRef(),
          lastAgentActivityAt: override?.lastAgentActivityAt,
          healthEvidence: [],
          workingFiles: []
        }
        return {
          slot,
          role: roleById.get(slot.roleId)!,
          binding,
          runtime,
          readiness: 'ready' as const
        }
      })
    return {
      ...state,
      activeRun: state.runs.find((run) => run.id === bundle.run.id),
      members,
      runtimeChannels: [],
      standbyChannels: [],
      failovers: [],
      groups: [],
      preflight: {
        bridgeConnected: true,
        workspaceBound: true,
        goalDefined: true,
        mcpInstalled: true,
        agentsWaiting: true,
        canLaunch: true,
        blockers: []
      }
    }
  }
}

function setup(options: Omit<TeamCollaborationSweeperOptions, 'now'> = {}, running = true) {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-sweeper-')), 'team.sqlite3')
  const control = new SqliteTeamControlRepository(path)
  const bundle = createDefaultTeamBundle({
    workspaceId: 'alpha',
    workspaceName: 'alpha',
    workspacePath: '/workspace/alpha',
    channelIds: ['1', '2', '3'],
    now: 100,
    goal: '完成本轮协作清扫'
  })
  control.upsertWorkspaceTeam(bundle)
  control.recordInstallation({
    workspaceId: 'alpha',
    runId: bundle.run.id,
    generation: 'generation123',
    agents: bundle.slots.map((slot) => ({
      agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
      workspaceId: 'alpha',
      channelId: slot.channelId!,
      generation: 'generation123',
      runId: bundle.run.id,
      capabilities: bundle.roles.find((role) => role.id === slot.roleId)!.capabilities
    }))
  })
  if (!running) control.completeRun(bundle.run.id, 200)
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const slot = (key: string) => {
    const role = bundle.roles.find((candidate) => candidate.key === key)!
    return bundle.slots.find((candidate) => candidate.roleId === role.id)!
  }
  let now = Date.now()
  const runtimeOverrides = new Map<string, RuntimeOverride>()
  const sweeper = new TeamCollaborationSweeper(
    collaboration,
    snapshotProvider(control, bundle, runtimeOverrides, () => now),
    { ...options, now: () => now }
  )
  const messageCount = () => collaboration.loadRun(bundle.run.id).messageOrder.length
  return {
    bundle,
    control,
    collaboration,
    slot,
    sweeper,
    messageCount,
    runtimeOverrides,
    setNow: (value: number) => { now = value },
    currentNow: () => now,
    close: () => {
      collaboration.close()
      control.close()
    }
  }
}

const unansweredOnly = {}

describe('TeamCollaborationSweeper · TeamRun 生命周期边界', () => {
  it('已结束的 run 不生成主控失联或未回应提醒', () => {
    const data = setup({}, false)
    try {
      const lead = data.slot('lead')
      data.runtimeOverrides.set(lead.id, { online: false, lastSeenAt: 100 })
      data.setNow(10 * 60_000)
      expect(data.sweeper.sweep()).toBe(0)
      expect(data.messageCount()).toBe(0)
    } finally {
      data.close()
    }
  })
})

describe('TeamCollaborationSweeper · sweepUnanswered（未应答指令/提问）', () => {
  it('超时未获回应：只回执发送者（不再抄送主控「请介入」，2A），且不改动原消息状态', () => {
    const data = setup(unansweredOnly)
    try {
      const builder = data.slot('builder')
      const reviewer = data.slot('reviewer')
      const lead = data.slot('lead')
      const question = data.collaboration.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: builder.id },
        recipient: { type: 'agent', slotId: reviewer.id },
        kind: 'question',
        content: '接口的分页参数口径是什么？',
        clientMessageId: 'test:question:0001'
      })
      const before = data.messageCount()
      data.setNow(data.currentNow() + 31 * 60_000)

      expect(data.sweeper.sweep()).toBe(1)
      const snapshot = data.collaboration.loadRun(data.bundle.run.id)
      expect(data.messageCount()).toBe(before + 1)
      const reminders = snapshot.messageOrder
        .map((id) => snapshot.messages[id]!)
        .filter((message) => message.content.includes('【清扫提醒】'))
      expect(reminders).toHaveLength(1)
      const [toSender] = reminders
      expect(toSender!.recipient).toEqual({ type: 'agent', slotId: builder.id })
      expect(toSender!.kind).toBe('notice')
      expect(toSender!.content).toContain(question.id)
      // 主控不再收到「请介入协调」：催办 / 改派是编排器的事，lead 只收 done / failed / attention。
      expect(snapshot.messageOrder.map((id) => snapshot.messages[id]!).some((message) => (
        message.recipient.type === 'agent' && message.recipient.slotId === lead.id
      ))).toBe(false)
      // 只提醒不改状态：原消息仍保持未回应，发送者可继续等待或升级
      expect(snapshot.messages[question.id]!.receipt.respondedAt).toBeUndefined()
    } finally {
      data.close()
    }
  })

  it('未超时不提醒', () => {
    const data = setup(unansweredOnly)
    try {
      data.collaboration.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: data.slot('builder').id },
        recipient: { type: 'agent', slotId: data.slot('reviewer').id },
        kind: 'directive',
        content: '请先不要动，等待联调',
        clientMessageId: 'test:directive:0002'
      })
      const before = data.messageCount()
      data.setNow(data.currentNow() + 29 * 60_000)
      expect(data.sweeper.sweep()).toBe(0)
      expect(data.messageCount()).toBe(before)
    } finally {
      data.close()
    }
  })

  it('重复触发幂等：内存防抖 + clientMessageId 桶双保险（新实例也不重复）', () => {
    const data = setup(unansweredOnly)
    try {
      data.collaboration.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: data.slot('builder').id },
        recipient: { type: 'agent', slotId: data.slot('reviewer').id },
        kind: 'question',
        content: '这个字段允许为空吗？',
        clientMessageId: 'test:question:0003'
      })
      data.setNow(data.currentNow() + 31 * 60_000)
      expect(data.sweeper.sweep()).toBe(1)
      const afterFirst = data.messageCount()
      expect(data.sweeper.sweep()).toBe(0)
      // 模拟进程重启：全新实例内存防抖为空，仍由持久化幂等键兜住
      const fresh = new TeamCollaborationSweeper(
        data.collaboration,
        snapshotProvider(data.control, data.bundle, data.runtimeOverrides, () => data.currentNow()),
        { ...unansweredOnly, now: () => data.currentNow() }
      )
      expect(fresh.sweep()).toBe(0)
      expect(data.messageCount()).toBe(afterFirst)
    } finally {
      data.close()
    }
  })

  it('已回应的消息不提醒', () => {
    const data = setup(unansweredOnly)
    try {
      const directive = data.collaboration.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: data.slot('lead').id },
        recipient: { type: 'agent', slotId: data.slot('builder').id },
        kind: 'directive',
        content: '请在今天内完成接口改造',
        clientMessageId: 'test:directive:0004'
      })
      data.collaboration.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'agent', slotId: data.slot('builder').id },
        recipient: { type: 'agent', slotId: data.slot('lead').id },
        kind: 'response',
        content: '收到，预计 17:00 前提测',
        clientMessageId: 'test:response:0004',
        threadId: directive.threadId,
        replyToMessageId: directive.id
      })
      const before = data.messageCount()
      data.setNow(data.currentNow() + 45 * 60_000)
      expect(data.sweeper.sweep()).toBe(0)
      expect(data.messageCount()).toBe(before)
    } finally {
      data.close()
    }
  })

  it('控制台发出的超时消息不产生任何提醒（无回执对象，也不再抄送主控），不触发 operator 自回环', () => {
    const data = setup(unansweredOnly)
    try {
      data.collaboration.createMessage({
        runId: data.bundle.run.id,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: data.slot('builder').id },
        kind: 'directive',
        content: '请回报当前进度',
        clientMessageId: 'test:directive:0005'
      })
      const before = data.messageCount()
      data.setNow(data.currentNow() + 31 * 60_000)
      expect(data.sweeper.sweep()).toBe(0)
      expect(data.messageCount()).toBe(before)
    } finally {
      data.close()
    }
  })
})

describe('TeamCollaborationSweeper · sweepMemberAttention（组内成员确认离线 → lead notice，2A）', () => {
  function poolSetup() {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-sweeper-pool-')), 'team.sqlite3')
    const control = new SqliteTeamControlRepository(path)
    const channelIds = ['1', '2', '3', '4']
    const pool = createConfiguredTeamBundle({
      workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha', now: 100,
      mode: 'independent', runKey: 'run-pool-sweeper',
      members: channelIds.map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }))
    })
    control.upsertWorkspaceTeam(pool)
    control.recordInstallation({
      workspaceId: 'alpha', runId: pool.run.id, generation: 'gen',
      agents: pool.slots.map((slot) => ({
        agentSessionId: `alpha:ch-${slot.channelId}:gen`, workspaceId: 'alpha', channelId: slot.channelId!, generation: 'gen', runId: pool.run.id, capabilities: []
      }))
    })
    const slotOf = (channelId: string) => pool.slots.find((slot) => slot.channelId === channelId)!
    // 组「G」：CH-1 lead、CH-2 builder、CH-3 reviewer；CH-4 独立席位。
    const group = control.createGroup({
      runId: pool.run.id, name: 'G', leadSlotId: slotOf('1').id,
      members: [{ slotId: slotOf('1').id, roleTemplateKey: 'lead' }, { slotId: slotOf('2').id, roleTemplateKey: 'builder' }, { slotId: slotOf('3').id, roleTemplateKey: 'reviewer' }]
    }).group
    const collaboration = new SqliteTeamCollaborationRepository(path)
    let now = Date.now()
    const runtimeOverrides = new Map<string, RuntimeOverride>()
    const baseProvider = snapshotProvider(control, pool, runtimeOverrides, () => now)
    // 把成员视图按组投影出来（与 TeamControlService.project 的 projectGroups 同口径）。
    const provider = (): TeamControlSnapshot => {
      const snapshot = baseProvider()
      return { ...snapshot, groups: projectGroups(control.loadTeamControl().groups, snapshot.activeRun!, snapshot.members, now) }
    }
    const sweeper = new TeamCollaborationSweeper(collaboration, provider, { now: () => now })
    const messagesTo = (slotId: string) => {
      const snapshot = collaboration.loadRun(pool.run.id)
      return snapshot.messageOrder.map((id) => snapshot.messages[id]!)
        .filter((message) => message.recipient.type === 'agent' && message.recipient.slotId === slotId)
    }
    const stop = (channelId: string, lastSeenAt: number) => runtimeOverrides.set(slotOf(channelId).id, {
      online: false, status: 'offline', connectionPhase: 'cursor_stopped', runtimeEvidence: 'stopped', lastSeenAt
    })
    return {
      control, collaboration, pool, group, slotOf, sweeper, provider, messagesTo, stop, runtimeOverrides,
      setNow: (value: number) => { now = value }, currentNow: () => now,
      close: () => { collaboration.close(); control.close() }
    }
  }

  it('notifies the group lead once per confirmed-offline cycle, resets when the member recovers, and never for the lead itself or ungrouped seats', () => {
    const data = poolSetup()
    try {
      expect(data.sweeper.sweep()).toBe(0)
      // builder（CH-2）明确终止：lead 收到一条 attention notice，落在本组；reviewer 与独立席位什么都没收到。
      data.stop('2', data.currentNow() - 10_000)
      expect(data.sweeper.sweep()).toBe(1)
      const [notice] = data.messagesTo(data.slotOf('1').id)
      expect(notice).toMatchObject({ kind: 'notice', sender: { type: 'operator' }, groupId: data.group.id })
      expect(notice!.content).toContain('【成员离线提醒】')
      expect(notice!.content).toContain('架构实现 · CH-2')
      expect(data.messagesTo(data.slotOf('3').id)).toEqual([])
      expect(data.messagesTo(data.slotOf('4').id)).toEqual([])
      // 同一离线周期不重复；进程重启（新实例）也由 clientMessageId 兜住。
      expect(data.sweeper.sweep()).toBe(0)
      const fresh = new TeamCollaborationSweeper(data.collaboration, data.provider, { now: () => data.currentNow() })
      expect(fresh.sweep()).toBe(0)
      expect(data.messagesTo(data.slotOf('1').id)).toHaveLength(1)

      // 成员恢复后再次离线：新周期，再提醒一次。
      data.runtimeOverrides.delete(data.slotOf('2').id)
      expect(data.sweeper.sweep()).toBe(0)
      data.setNow(data.currentNow() + 60_000)
      data.stop('2', data.currentNow() - 1_000)
      expect(data.sweeper.sweep()).toBe(1)
      expect(data.messagesTo(data.slotOf('1').id)).toHaveLength(2)

      // lead 自己离线：走主控失联广播（提醒其他成员），不给自己发 attention。
      data.runtimeOverrides.delete(data.slotOf('2').id)
      data.stop('1', data.currentNow() - 1_000)
      const sent = data.sweeper.sweep()
      expect(sent).toBeGreaterThan(0)
      expect(data.messagesTo(data.slotOf('1').id)).toHaveLength(2)
      expect(data.messagesTo(data.slotOf('2').id).map((message) => message.content.slice(0, 8))).toEqual(['【主控失联提醒】'])
    } finally {
      data.close()
    }
  })

  it('stays silent in a lead-less group (nobody to notify) and only counts positive stop evidence', () => {
    const data = poolSetup()
    try {
      data.control.setGroupLead({ groupId: data.group.id, slotId: null })
      data.stop('2', data.currentNow() - 10_000)
      expect(data.sweeper.sweep()).toBe(0)
      data.control.setGroupLead({ groupId: data.group.id, slotId: data.slotOf('1').id })
      // online=false 但没有明确终止证据：只是 suspected，不打扰 lead。
      data.runtimeOverrides.set(data.slotOf('2').id, { online: false, lastSeenAt: data.currentNow() - 10 * 60_000 })
      expect(data.sweeper.sweep()).toBe(0)
      expect(data.messagesTo(data.slotOf('1').id)).toEqual([])
    } finally {
      data.close()
    }
  })
})

describe('TeamCollaborationSweeper · sweepLeadHeartbeat（主控心跳失联）', () => {
  it('主控 lastSeenAt 被动静默超阈值也不广播（静默不是终止证据）', () => {
    const data = setup()
    try {
      const lead = data.slot('lead')
      const before = data.messageCount()
      // 主控心跳停在 121 秒前（其余成员活性新鲜）
      data.runtimeOverrides.set(lead.id, { online: true, lastSeenAt: data.currentNow() - 121_000 })
      expect(data.sweeper.sweep()).toBe(0)
      const snapshot = data.collaboration.loadRun(data.bundle.run.id)
      const alerts = snapshot.messageOrder
        .map((id) => snapshot.messages[id]!)
        .filter((message) => message.content.includes('【主控失联提醒】'))
      expect(alerts).toHaveLength(0)
      expect(data.messageCount()).toBe(before)
    } finally {
      data.close()
    }
  })

  it('主控 runtime online=false 仍只算 suspected，不广播接管提示', () => {
    const data = setup()
    try {
      const lead = data.slot('lead')
      data.runtimeOverrides.set(lead.id, { online: false, lastSeenAt: data.currentNow() })
      expect(data.sweeper.sweep()).toBe(0)
      const snapshot = data.collaboration.loadRun(data.bundle.run.id)
      const alert = snapshot.messageOrder
        .map((id) => snapshot.messages[id]!)
        .find((message) => message.content.includes('【主控失联提醒】'))
      expect(alert).toBeUndefined()
    } finally {
      data.close()
    }
  })

  it('Cursor 明确终止才广播一次，且主控自己不收', () => {
    const data = setup()
    try {
      const lead = data.slot('lead')
      const before = data.messageCount()
      data.runtimeOverrides.set(lead.id, {
        online: false,
        status: 'offline',
        connectionPhase: 'cursor_stopped',
        runtimeEvidence: 'stopped',
        lastSeenAt: data.currentNow()
      })
      expect(data.sweeper.sweep()).toBe(2)
      const alerts = Object.values(data.collaboration.loadRun(data.bundle.run.id).messages)
        .filter((message) => message.content.includes('【主控失联提醒】'))
      expect(alerts).toHaveLength(2)
      expect(alerts.every((message) => message.recipient.type === 'agent'
        && message.recipient.slotId !== lead.id)).toBe(true)
      expect(alerts[0]!.content).toContain('Cursor 已明确终止')
      expect(data.messageCount()).toBe(before + 2)
    } finally {
      data.close()
    }
  })

  it('心跳新鲜不广播（健康主控长轮询持续刷新 lastSeenAt，不误报）', () => {
    const data = setup()
    try {
      const before = data.messageCount()
      // 默认快照里主控 runtime 健康（lastSeenAt = now），时间推进 119s 也不报
      data.setNow(data.currentNow() + 119_000)
      expect(data.sweeper.sweep()).toBe(0)
      expect(data.messageCount()).toBe(before)
    } finally {
      data.close()
    }
  })

  it('主控执行长任务时即使 MCP lastSeenAt 陈旧也不广播、不诱导接管', () => {
    const data = setup()
    try {
      const lead = data.slot('lead')
      data.runtimeOverrides.set(lead.id, {
        online: false,
        status: 'running',
        connectionPhase: 'processing',
        lastSeenAt: data.currentNow() - 45 * 60_000,
        lastAgentActivityAt: data.currentNow() - 1_000
      })
      data.collaboration.recordLiveness({
        channelId: '1', runId: data.bundle.run.id, verified: false, at: data.currentNow()
      })
      const before = data.messageCount()
      expect(data.sweeper.sweep()).toBe(0)
      expect(data.messageCount()).toBe(before)
    } finally {
      data.close()
    }
  })

  it('被动疑似状态跨多个周期、lastSeenAt 多次变化也始终零提醒', () => {
    const data = setup()
    try {
      const lead = data.slot('lead')
      const before = data.messageCount()
      for (let cycle = 1; cycle <= 6; cycle += 1) {
        data.setNow(data.currentNow() + 5 * 60_000)
        data.runtimeOverrides.set(lead.id, {
          online: false,
          status: 'offline',
          connectionPhase: 'waiting',
          runtimeEvidence: 'suspected',
          lastSeenAt: data.currentNow() - 130_000
        })
        expect(data.sweeper.sweep()).toBe(0)
      }
      expect(data.messageCount()).toBe(before)
    } finally {
      data.close()
    }
  })

  it('重复触发幂等；主控活性恢复后复位、再次静默可再次报警', () => {
    const data = setup()
    try {
      const lead = data.slot('lead')
      data.runtimeOverrides.set(lead.id, {
        online: false, status: 'offline', connectionPhase: 'cursor_stopped',
        runtimeEvidence: 'stopped', lastSeenAt: data.currentNow()
      })
      expect(data.sweeper.sweep()).toBe(2)
      const afterFirst = data.messageCount()
      expect(data.sweeper.sweep()).toBe(0)
      // 模拟进程重启：持久化幂等键兜住
      const fresh = new TeamCollaborationSweeper(
        data.collaboration,
        snapshotProvider(data.control, data.bundle, data.runtimeOverrides, () => data.currentNow()),
        { now: () => data.currentNow() }
      )
      expect(fresh.sweep()).toBe(0)
      expect(data.messageCount()).toBe(afterFirst)

      // 主控活性恢复：lastSeenAt 刷新到当前，证据消失，周期复位
      data.setNow(data.currentNow() + 1_000)
      data.runtimeOverrides.set(lead.id, {
        online: true, status: 'waiting', connectionPhase: 'waiting',
        runtimeEvidence: 'active', lastSeenAt: data.currentNow()
      })
      expect(data.sweeper.sweep()).toBe(0)
      // 再次失联：lastSeenAt 停在恢复时刻不再刷新（真实时序下 lastSeenAt 单调推进，
      // 新周期键与上一轮不同，持久幂等键不冲突）
      const recoveredAt = data.currentNow()
      data.setNow(recoveredAt + 200_000)
      data.runtimeOverrides.set(lead.id, {
        online: false, status: 'offline', connectionPhase: 'cursor_stopped',
        runtimeEvidence: 'stopped', lastSeenAt: recoveredAt
      })
      expect(data.sweeper.sweep()).toBe(2)
      expect(data.messageCount()).toBe(afterFirst + 2)
    } finally {
      data.close()
    }
  })

  it('活性记录 suspected_offline 也不触发（忙碌 Agent 可能无法 pong）', () => {
    const data = setup()
    try {
      const runId = data.bundle.run.id
      // runtime 置为离线（主控会话无活性）：ping 探测的离线记录成为有效佐证
      data.runtimeOverrides.set(data.slot('lead').id, { online: false, lastSeenAt: undefined })
      data.collaboration.recordLiveness({ channelId: '1', runId, verified: false, at: Date.now() })
      const before = data.messageCount()
      expect(data.sweeper.sweep()).toBe(0)
      const snapshot = data.collaboration.loadRun(runId)
      const alert = snapshot.messageOrder
        .map((id) => snapshot.messages[id]!)
        .find((message) => message.content.includes('【主控失联提醒】'))
      expect(alert).toBeUndefined()
      expect(data.messageCount()).toBe(before)
    } finally {
      data.close()
    }
  })

  it('陈旧 liveness 离线记录 + runtime 新鲜：不误报（主控复审裁决回归）', () => {
    const data = setup()
    try {
      const runId = data.bundle.run.id
      // ping 失败残留的 suspected 记录，但主控 runtime 持续新鲜（长轮询在岗，默认快照即新鲜）
      data.collaboration.recordLiveness({ channelId: '1', runId, verified: false, at: Date.now() })
      const before = data.messageCount()
      data.setNow(data.currentNow() + 10 * 60_000)
      expect(data.sweeper.sweep()).toBe(0)
      expect(data.messageCount()).toBe(before)
    } finally {
      data.close()
    }
  })
})
