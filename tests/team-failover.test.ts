import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import { RUN_CLOSED_TASK_REASON, TeamFailoverService } from '../src/application/team-failover-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'

/**
 * TeamFailoverService（阶段 2 · 2C 收敛后）只剩一件事：活动 run 变为 completed 后把它的
 * 未完成任务取消一次（含启动时订阅回放补做）。全员离线收尾 / standby 自动接替 / lead 自动
 * 转移随一次性团队 run 退役（2B-2）；手动交接门面改为 TeamGroupService.transferMembership（2C）。
 */

class MutableBridge implements TeamControlBridge {
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  private command = 0

  constructor(private snapshot: DesktopSnapshot) {}

  getSnapshot(): DesktopSnapshot { return structuredClone(this.snapshot) }

  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  sendMessage(_input: SendMessageInput) { return { commandId: `command-${++this.command}` } }

  setChannelOnline(channelId: string, online: boolean): void {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) => session.channelId === channelId
        ? {
            ...session,
            status: online ? 'waiting' : 'offline',
            online,
            connected: online,
            runtimeEvidence: online ? 'active' : 'stopped',
            waiting: online,
            connectionPhase: online ? 'waiting' : 'cursor_stopped',
            lastSeenAt: online ? Date.now() : session.lastSeenAt,
            healthEvidence: online ? ['check_messages 正在待命'] : ['Cursor Agent 已停止监听']
          }
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
      id: `sg-channel:${channelId}`,
      channelId,
      generation: 0,
      displayName: `SG Team CH-${channelId}`,
      roleName: '未绑定外置团队',
      status: 'waiting',
      currentTask: '',
      queueDepth: 0,
      connectionPhase: 'waiting',
      online: true,
      connected: true,
      runtimeEvidence: 'active' as const,
      waiting: true,
      workingFiles: [],
      healthEvidence: ['check_messages 正在待命']
    })),
    conversations: {},
    protocolIssues: [],
    updatedAt: 1
  }
}

/**
 * 会话池：三个 solo 席位，CH-1（lead）与 CH-2（builder）入组并签到，CH-3 保持独立在线；
 * CH-2 持有一条 running 任务。池 run 长生命周期：只有用户 endActiveRun / createSessionPool 能结束它。
 */
function poolFixture(options: { onerror?: (error: unknown) => void } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-pool-failover-')), 'team.sqlite3')
  const controlRepository = new SqliteTeamControlRepository(path)
  const taskRepository = new SqliteTaskPoolRepository(path)
  const channelIds = ['1', '2', '3']
  const bridge = new MutableBridge(desktopSnapshot(channelIds))
  const control = new TeamControlService(controlRepository, bridge)
  const selected = control.createSessionPool({
    workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha',
    members: channelIds.map((channelId) => ({
      channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true
    }))
  })
  const runId = selected.activeRun!.id
  control.recordInstallation({
    workspaceId: 'alpha',
    runId,
    generation: 'generation123',
    agents: channelIds.map((channelId) => ({
      agentSessionId: `alpha:ch-${channelId}:generation123`,
      workspaceId: 'alpha',
      channelId,
      generation: 'generation123',
      runId,
      capabilities: []
    }))
  })
  const slotIdOf = (channelId: string) => selected.members.find((member) => member.slot.channelId === channelId)!.slot.id
  const { group } = controlRepository.createGroup({
    runId,
    name: '验收组',
    goal: '把接口重构收尾',
    members: [{ slotId: slotIdOf('1'), roleTemplateKey: 'lead' }, { slotId: slotIdOf('2'), roleTemplateKey: 'builder' }],
    leadSlotId: slotIdOf('1')
  })
  for (const channelId of ['1', '2']) {
    controlRepository.recordAgentCheckIn(controlRepository.resolveChannelAgentIdentity(channelId), 'ready')
  }
  const tasks = new TaskPoolService(taskRepository, control)
  const builder = control.getSnapshot().members.find((member) => member.slot.channelId === '2')!
  const task = transactTaskPool(taskRepository, (pool) => {
    const [planned] = pool.plan(runId, [{
      key: 'build-core',
      title: '实现核心接口',
      targetSlotId: builder.slot.id,
      requiredCapabilities: ['code']
    }])
    const lease = pool.leaseTask(planned!.id, {
      runId,
      slotId: builder.slot.id,
      agentSessionId: builder.binding!.agentSessionId,
      capabilities: builder.role.capabilities
    })!
    pool.startAttempt(lease.attempt.id, lease.leaseToken)
    return planned!
  })
  const failover = new TeamFailoverService(control, tasks, { onerror: options.onerror })
  return {
    bridge, control, controlRepository, taskRepository, tasks, failover, runId, group, task, slotIdOf,
    close: () => {
      failover.stop()
      control.dispose()
      taskRepository.close()
      controlRepository.close()
    }
  }
}

describe('TeamFailoverService', () => {
  it('never completes the pool, cancels its tasks or touches bindings when members confirm offline (I5)', () => {
    const data = poolFixture()
    try {
      const tokensBefore = data.controlRepository.loadTeamControl().bindings
        .filter((binding) => binding.runId === data.runId)
        .map((binding) => [binding.channelId, binding.sessionToken, binding.composerBindingKey])
      expect(data.control.getSnapshot().groups[0]?.attention).toBe(false)

      // 有效 lead（CH-1）与成员（CH-2）都明确终止；CH-3 在线待命——一次性团队 run 里它正是会被
      // 选中的 standby，在池里绝不能被挪去接替别人的身份。
      data.bridge.setChannelOnline('1', false)
      data.bridge.setChannelOnline('2', false)
      data.failover.reconcile()

      const snapshot = data.control.getSnapshot()
      expect(snapshot.activeRun?.status).toBe('running')
      expect(data.controlRepository.listFailovers(data.runId)).toEqual([])
      expect(snapshot.groups[0]).toMatchObject({
        attention: true,
        effectiveLeadSlotId: data.slotIdOf('1'),
        group: { id: data.group.id, status: 'active', actingLeadSlotId: undefined }
      })
      // 令牌、Composer 键、注册全部原样；任务不被取消。
      expect(data.controlRepository.loadTeamControl().bindings
        .filter((binding) => binding.runId === data.runId)
        .map((binding) => [binding.channelId, binding.sessionToken, binding.composerBindingKey])).toEqual(tokensBefore)
      expect(data.controlRepository.listAgentRegistrations(data.runId)).toHaveLength(3)
      expect(data.taskRepository.load().tasks[data.task.id]?.status).toBe('running')

      // 连独立席位也全部离线：池依旧不收尾（只有用户显式 endActiveRun 才结束池）。
      data.bridge.setChannelOnline('3', false)
      data.failover.reconcile()
      expect(data.control.getSnapshot().activeRun?.status).toBe('running')
      expect(data.controlRepository.listFailovers(data.runId)).toEqual([])

      // 成员恢复在线：attention 立即回落，无需任何人工复位。
      data.bridge.setChannelOnline('1', true)
      data.bridge.setChannelOnline('2', true)
      expect(data.control.getSnapshot().groups[0]?.attention).toBe(false)
    } finally {
      data.close()
    }
  })

  it('cancels the leftover tasks exactly once after the user ends the pool', () => {
    const data = poolFixture()
    try {
      const originalCloseRun = data.tasks.closeRun.bind(data.tasks)
      const closeRunCalls: Array<{ runId: string; reason?: string }> = []
      data.tasks.closeRun = (runId: string, reason?: string) => {
        closeRunCalls.push({ runId, reason })
        return originalCloseRun(runId, reason)
      }

      data.control.endActiveRun()
      data.failover.reconcile()
      expect(data.taskRepository.load().tasks[data.task.id]).toMatchObject({
        status: 'cancelled',
        failureReason: RUN_CLOSED_TASK_REASON
      })

      // 已收尾的 run 不再重复取消（closedRuns 记账）。
      data.failover.reconcile()
      expect(closeRunCalls).toEqual([{ runId: data.runId, reason: RUN_CLOSED_TASK_REASON }])
    } finally {
      data.close()
    }
  })

  it('repairs unfinished tasks left by a previously completed run when start() replays the snapshot', () => {
    const data = poolFixture()
    try {
      // run 在应用离线期间结束（直接落库），任务残留 running。
      data.controlRepository.completeRun(data.runId, 1_000)
      expect(data.taskRepository.load().tasks[data.task.id]?.status).toBe('running')

      // 订阅即回放当前快照：不需要显式 reconcile，启动补做立即发生。
      data.failover.start()

      expect(data.taskRepository.load().tasks[data.task.id]).toMatchObject({
        status: 'cancelled',
        failureReason: RUN_CLOSED_TASK_REASON
      })
    } finally {
      data.close()
    }
  })

  it('reports a failed close via onerror and retries it at the next snapshot', () => {
    const errors: unknown[] = []
    const data = poolFixture({ onerror: (error) => errors.push(error) })
    try {
      const originalCloseRun = data.tasks.closeRun.bind(data.tasks)
      let failOnce = true
      data.tasks.closeRun = (runId: string, reason?: string) => {
        if (failOnce) {
          failOnce = false
          throw new Error('close boom')
        }
        return originalCloseRun(runId, reason)
      }

      data.control.endActiveRun()
      data.failover.reconcile()
      expect(errors).toHaveLength(1)
      expect((errors[0] as Error).message).toBe('close boom')
      expect(data.taskRepository.load().tasks[data.task.id]?.status).toBe('running')

      // 失败的 run 不进 closedRuns：下一次快照重试成功。
      data.failover.reconcile()
      expect(data.taskRepository.load().tasks[data.task.id]).toMatchObject({
        status: 'cancelled',
        failureReason: RUN_CLOSED_TASK_REASON
      })
    } finally {
      data.close()
    }
  })

})
