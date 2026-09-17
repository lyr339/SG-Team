import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import type { CursorComposerTelemetrySource } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import { workspaceRunMode, type TeamMemberConfiguration } from '../src/domain/team-control'
import { createDefaultTeamBundle } from './legacy-team-fixtures'

class FakeBridge implements TeamControlBridge {
  readonly sent: SendMessageInput[] = []
  readonly conversationScopes: Array<{ runId: string; startedAt: number }> = []
  private listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  private nextCommand = 0

  constructor(private snapshot: DesktopSnapshot) {}

  getSnapshot(): DesktopSnapshot {
    return structuredClone(this.snapshot)
  }

  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  sendMessage(input: SendMessageInput) {
    const commandId = `command-${++this.nextCommand}`
    this.sent.push(input)
    return { commandId }
  }

  beginConversationScope(input: { runId: string; startedAt: number }): DesktopSnapshot {
    this.conversationScopes.push(structuredClone(input))
    this.snapshot = { ...this.snapshot, conversations: {}, updatedAt: this.snapshot.updatedAt + 1 }
    return this.getSnapshot()
  }

  addWaitingChannel(channelId: string): void {
    const template = this.snapshot.sessions[0]!
    this.snapshot = {
      ...this.snapshot,
      sessions: [...this.snapshot.sessions, {
        ...template,
        id: `sg-channel:${channelId}`,
        channelId,
        displayName: `SG Team CH-${channelId}`
      }],
      updatedAt: this.snapshot.updatedAt + 1
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }

  patchSession(channelId: string, patch: Partial<DesktopSnapshot['sessions'][number]>): void {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) => session.channelId === channelId ? { ...session, ...patch } : session),
      updatedAt: this.snapshot.updatedAt + 1
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }

  setAllOffline(connectionPhase = 'offline'): void {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) => ({
        ...session,
        online: false,
        connected: false,
        waiting: false,
        status: 'offline',
        connectionPhase
      })),
      updatedAt: this.snapshot.updatedAt + 1
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
  }
}

function desktopSnapshot(waiting = true, channelIds = ['1', '2']): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
    sessions: channelIds.map((channelId) => ({
      id: `sg-channel:${channelId}`,
      channelId,
      generation: 0,
      displayName: `SG Team CH-${channelId}`,
      roleName: '未绑定外置团队',
      status: waiting ? 'waiting' : 'idle',
      currentTask: '',
      queueDepth: 0,
      connectionPhase: waiting ? 'waiting' : '',
      online: true,
      connected: waiting,
      waiting,
      workingFiles: [],
      healthEvidence: [waiting ? 'check_messages 正在待命' : '尚未待命']
    })),
    conversations: {},
    protocolIssues: [],
    updatedAt: Date.now()
  }
}

const soloSeat = (channelId: string): TeamMemberConfiguration => (
  { channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
)

const alpha = { workspaceId: 'alpha', workspaceName: 'alpha', workspacePath: '/workspace/alpha' }

function install(service: TeamControlService, workspaceId = 'alpha', generation = 'generation123') {
  const snapshot = service.getSnapshot()
  return service.recordInstallation({
    workspaceId,
    runId: snapshot.activeRun!.id,
    generation,
    agents: snapshot.members.map((member) => ({
      agentSessionId: `${workspaceId}:ch-${member.slot.channelId}:${generation}`,
      workspaceId,
      channelId: member.slot.channelId!,
      generation,
      runId: snapshot.activeRun!.id,
      capabilities: [...member.role.capabilities]
    }))
  })
}

/** 两席会话池（CH-1 / CH-2，全部 solo），已安装 MCP，会话在线待命。 */
function poolFixture(options: { waiting?: boolean; installed?: boolean; telemetry?: CursorComposerTelemetrySource } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-service-')), 'control.sqlite3')
  const repository = new SqliteTeamControlRepository(path)
  const bridge = new FakeBridge(desktopSnapshot(options.waiting ?? true))
  const clearedRuns: string[] = []
  const service = new TeamControlService(repository, bridge, options.telemetry, {
    clearRun: (runId) => {
      clearedRuns.push(runId)
      return true
    }
  })
  service.createSessionPool({ ...alpha, members: [soloSeat('1'), soloSeat('2')] })
  if (options.installed !== false) install(service)
  return { path, repository, bridge, service, clearedRuns }
}

describe('TeamControlService · 会话池', () => {
  it('createSessionPool creates a running independent run of solo seats, sends no launch prompt and moves the conversation scope', () => {
    const data = poolFixture({ waiting: false, installed: false })
    try {
      const snapshot = data.service.getSnapshot()
      expect(workspaceRunMode(snapshot.activeRun)).toBe('independent')
      expect(snapshot.activeRun).toMatchObject({ status: 'running', goal: '' })
      expect(snapshot.activeRun?.id).toMatch(/^session-run:alpha:run-/)
      expect(snapshot.members.map((member) => [member.slot.channelId, member.role.templateKey, member.slot.solo])).toEqual([
        ['1', 'solo', true], ['2', 'solo', true]
      ])
      expect(snapshot.groups).toEqual([])
      expect(data.bridge.sent).toHaveLength(0)
      expect(data.bridge.conversationScopes.at(-1)?.runId).toBe(snapshot.activeRun?.id)
      // 新池的协作域从零开始：目标 / 消息 / 记忆都属于组，建池时清掉同 run id 下可能残留的协作行。
      expect(data.clearedRuns).toEqual([snapshot.activeRun?.id])
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('creates a fresh run id every time a pool is created for the same workspace', () => {
    const data = poolFixture({ installed: false })
    try {
      const first = data.service.getSnapshot().activeRun!
      const second = data.service.createSessionPool({ ...alpha, members: [soloSeat('1')] }).activeRun!
      expect(first.id).toMatch(/^session-run:alpha:run-/)
      expect(second.id).toMatch(/^session-run:alpha:run-/)
      expect(second.id).not.toBe(first.id)
      expect(second.createdAt).toBeGreaterThan(first.createdAt)
      expect(data.bridge.conversationScopes.map((scope) => scope.runId)).toEqual([first.id, second.id])
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('replaces a live pool with a new batch even while its sessions still look online (soft guard: the fence retires them)', () => {
    const data = poolFixture()
    try {
      const previous = data.service.getSnapshot().activeRun!
      expect(previous.status).toBe('running')
      const snapshot = data.service.createSessionPool({ ...alpha, members: [soloSeat('1')] })
      expect(snapshot.activeRun?.id).not.toBe(previous.id)
      expect(snapshot.members.map((member) => member.slot.channelId)).toEqual(['1'])
      // 旧池显式收尾并写明原因：大厅不会把它说成「全员离线」。
      expect(snapshot.runs.find((run) => run.id === previous.id)?.status).toBe('completed')
      const retired = data.repository.loadTeamControl().bindings.filter((binding) => binding.runId === previous.id)
      expect(retired).toHaveLength(2)
      expect(retired[0]?.launchDetail).toContain('已被新的运行替换')
      expect(retired[0]?.launchDetail).toContain('会话围栏')
      expect(data.bridge.conversationScopes.at(-1)?.runId).toBe(snapshot.activeRun?.id)
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('ends the pool explicitly with the user-initiated reason; the fence then sees run_completed; ending twice is refused', () => {
    const data = poolFixture()
    try {
      const run = data.service.getSnapshot().activeRun!
      const snapshot = data.service.endActiveRun()
      expect(snapshot.activeRun).toMatchObject({ id: run.id, status: 'completed' })
      expect(workspaceRunMode(snapshot.activeRun)).toBe('independent')
      expect(snapshot.bindings.every((binding) => binding.launchDetail === '用户已结束本轮运行')).toBe(true)
      expect(snapshot.preflight.blockers).toContain('本次运行已经结束')
      expect(data.repository.resolveChannelSessionOwner('1')).toMatchObject({ runId: run.id, runStatus: 'completed' })
      expect(() => data.service.endActiveRun()).toThrow(/已经结束/)
      // 已结束的池拒绝签到：run 没有别的状态可以回到。
      const binding = snapshot.bindings[0]!
      expect(() => data.repository.recordAgentCheckIn({
        agentSessionId: binding.agentSessionId, runId: binding.runId, slotId: binding.slotId, capabilities: []
      }, 'late')).toThrowError(/已经结束/)
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('refuses to end when there is no run at all', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-end-empty-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const service = new TeamControlService(repository, new FakeBridge(desktopSnapshot(false)))
    try {
      expect(service.getSnapshot().activeRun).toBeUndefined()
      expect(() => service.endActiveRun()).toThrow(/没有可结束的运行/)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('preflight: MCP is incomplete until every seat is installed; outside channels never block; there is no goal / launch gate', () => {
    const data = poolFixture({ installed: false })
    try {
      const before = data.service.getSnapshot().preflight
      expect(before).toMatchObject({ bridgeConnected: true, workspaceBound: true, mcpInstalled: false })
      expect(before.blockers).toEqual(['Agent MCP 尚未接入全部本轮通道'])

      install(data.service)
      const installed = data.service.getSnapshot()
      expect(installed.preflight).toMatchObject({ mcpInstalled: true, blockers: [] })
      expect(installed.members.every((member) => member.readiness === 'ready')).toBe(true)

      // 局外通道（未加入池的待机运行时）出现在 runtimeChannels，但不拦截。
      data.bridge.addWaitingChannel('3')
      const withOutsider = data.service.getSnapshot()
      expect(withOutsider.runtimeChannels.map((channel) => [channel.channelId, channel.registered])).toEqual([
        ['1', true], ['2', true], ['3', false]
      ])
      expect(withOutsider.preflight.blockers).toEqual([])
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('projects a checked-in seat as active and an offline seat as offline', () => {
    const data = poolFixture()
    try {
      const binding = data.service.getSnapshot().bindings.find((candidate) => candidate.channelId === '1')!
      data.repository.recordAgentCheckIn({
        agentSessionId: binding.agentSessionId, runId: binding.runId, slotId: binding.slotId, capabilities: []
      }, 'ready')
      expect(data.service.getSnapshot().members.map((member) => [member.slot.channelId, member.readiness])).toEqual([
        ['1', 'active'], ['2', 'ready']
      ])
      expect(data.service.getSnapshot().activeRun?.status).toBe('running')
      data.bridge.setAllOffline()
      expect(data.service.getSnapshot().members.every((member) => member.readiness === 'offline')).toBe(true)
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('reuses assembled team state until the repository revision changes', () => {
    const { repository, service } = poolFixture()
    const load = vi.spyOn(repository, 'loadTeamControl')
    try {
      service.getSnapshot()
      service.getSnapshot()
      service.getActiveRunId()
      expect(load).not.toHaveBeenCalled()

      // 另一个进程（MCP）写库：revision 变化后才重装配。
      const slot = service.getSnapshot().members.find((member) => member.slot.channelId === '2')!.slot
      repository.setSlotModelSelection(slot.id, { modelId: 'external', displayName: 'External', parameters: [], maxMode: false })
      expect(service.getSnapshot().members.find((member) => member.slot.channelId === '2')?.slot.modelSelection?.modelId).toBe('external')
      expect(load).toHaveBeenCalledTimes(1)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('persists per-channel model selection to the slot and reads it back after reopen', () => {
    const data = poolFixture({ installed: false })
    try {
      data.service.setSlotModelSelection('2', {
        modelId: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        parameters: [{ id: 'effort', value: 'max' }, { id: 'context', value: '1m' }],
        maxMode: true
      })
      const selection = {
        modelId: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        parameters: [{ id: 'effort', value: 'high' }, { id: 'context', value: '1m' }],
        maxMode: true
      }
      data.service.setSlotModelSelection('2', selection)
      expect(data.service.getSnapshot().members.find((member) => member.slot.channelId === '2')?.slot.modelSelection)
        .toEqual(selection)
      expect(() => data.service.setSlotModelSelection('9', selection)).toThrow(/不属于当前 TeamRun/)
      expect(() => data.service.setSlotModelSelection('x', selection)).toThrow(/通道号无效/)

      // 重启回读：新仓库实例重装配同一库，选定值仍一一对应
      const reopened = new SqliteTeamControlRepository(data.path)
      try {
        const slot = reopened.loadTeamControl().slots.find((candidate) => candidate.channelId === '2')
        expect(slot?.modelSelection).toEqual(selection)
      } finally {
        reopened.close()
      }
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('prepareComposerRelaunch：只放行离线席位；在线（待命 / keepalive 间隙 / 处理中）与离线但在途的席位一律拒绝', () => {
    const { repository, bridge, service } = poolFixture()
    try {
      const before = service.getSnapshot()
      const binding = before.bindings.find((candidate) => candidate.channelId === '1')!
      service.recordComposerBinding({
        runId: binding.runId, slotId: binding.slotId, generation: binding.generation,
        bindingKey: binding.composerBindingKey, composerId: 'composer-1', method: 'launch_marker'
      })
      const bound = service.getSnapshot().bindings.find((candidate) => candidate.channelId === '1')!
      expect(bound.composerId).toBe('composer-1')
      const oldToken = bound.sessionToken
      expect(oldToken).toBeTruthy()

      // 在线：待命中、keepalive 间隙、处理中——换席重建只对离线席位开放
      expect(service.prepareComposerRelaunch('1')).toBeUndefined()
      bridge.patchSession('1', { waiting: false, connectionPhase: 'keepalive' })
      expect(service.prepareComposerRelaunch('1')).toBeUndefined()
      bridge.patchSession('1', { waiting: false, connectionPhase: 'processing' })
      expect(service.prepareComposerRelaunch('1')).toBeUndefined()
      // 离线但仍持有在途执行（processing 相位）：同样拒绝
      bridge.patchSession('1', { online: false, connected: false, waiting: false, status: 'offline', connectionPhase: 'processing' })
      expect(service.prepareComposerRelaunch('1')).toBeUndefined()
      expect(service.getSnapshot().bindings.find((candidate) => candidate.channelId === '1')?.composerId).toBe('composer-1')

      // 离线且无在途：原子轮换绑定键与会话令牌，清空 composer 绑定
      bridge.patchSession('1', { online: false, connected: false, waiting: false, status: 'offline', connectionPhase: 'offline' })
      const key = service.prepareComposerRelaunch('1')
      expect(key).toMatch(/^[0-9a-f-]{36}$/)
      const rotated = service.getSnapshot().bindings.find((candidate) => candidate.channelId === '1')!
      expect(rotated.composerBindingKey).toBe(key)
      expect(rotated.composerId).toBeUndefined()
      expect(rotated.sessionToken).toBeTruthy()
      expect(rotated.sessionToken).not.toBe(oldToken)

      // 另一席位离线：同样放行
      bridge.patchSession('2', { online: false, connected: false, waiting: false, status: 'offline', connectionPhase: 'offline' })
      expect(service.prepareComposerRelaunch('2')).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('重建收口（2C）：入组席位重建完成后补投 joined 通知并写审计事件；独立席位与刷新不投递', () => {
    const { repository, bridge, service } = poolFixture()
    try {
      const bindOf = (channelId: string) => service.getSnapshot().bindings.find((candidate) => candidate.channelId === channelId)!
      const bind = (channelId: string, composerId: string) => {
        const binding = bindOf(channelId)
        return service.recordComposerBinding({
          runId: binding.runId, slotId: binding.slotId, generation: binding.generation,
          bindingKey: binding.composerBindingKey, composerId, method: 'channel_marker'
        })
      }
      // 初次绑定（两席都未入组）：不投递任何成员关系通知。
      expect(bind('1', 'composer-1')).toBe(true)
      expect(bind('2', 'composer-2')).toBe(true)
      expect(bridge.sent.filter((message) => message.kind === 'membership')).toHaveLength(0)

      // CH-1 入组（直接走仓储：不经 TeamGroupService 的入组通知，保持 bridge.sent 干净）。
      const snapshot = service.getSnapshot()
      const slotId = snapshot.members.find((member) => member.slot.channelId === '1')!.slot.id
      const { group } = repository.createGroup({
        runId: snapshot.activeRun!.id,
        name: '接口重构',
        goal: '把查询路径收成一个入口',
        members: [{ slotId, roleTemplateKey: 'lead' }],
        leadSlotId: slotId
      })

      // 换席重建：轮换后新会话以新绑定键绑上新 Composer → 补投 joined 通知 + 审计事件。
      bridge.patchSession('1', { online: false, connected: false, waiting: false, status: 'offline', connectionPhase: 'cursor_stopped' })
      const tokenBefore = bindOf('1').sessionToken
      expect(service.prepareComposerRelaunch('1')).toMatch(/^[0-9a-f-]{36}$/)
      expect(bind('1', 'composer-1b')).toBe(true)
      const notices = bridge.sent.filter((message) => message.kind === 'membership')
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({ channelId: '1', kind: 'membership' })
      expect(notices[0]!.text).toContain('已加入协作组「接口重构」')
      expect(notices[0]!.text).toContain('主控协调')
      expect(notices[0]!.text).toContain('team_check_in')
      expect(repository.listGroupEvents(group.id).at(-1)).toMatchObject({
        type: 'member_rejoined_after_rebuild', slotId, channelId: '1', actor: 'system', detail: '主控协调'
      })
      // 席位的组关系与令牌语义不受通知影响：group_id 原样、令牌已在 prepare 时轮换。
      const rebound = service.getSnapshot().members.find((member) => member.slot.channelId === '1')!
      expect(rebound.slot.groupId).toBe(group.id)
      expect(rebound.binding?.sessionToken).not.toBe(tokenBefore)

      // 同一 Composer 的重复上报（遥测刷新）与换绑尝试：仓储视为无变化（首绑即定），不再投递第二条。
      expect(bind('1', 'composer-1b')).toBe(false)
      expect(bind('1', 'composer-1c')).toBe(false)
      expect(bridge.sent.filter((message) => message.kind === 'membership')).toHaveLength(1)
      expect(repository.listGroupEvents(group.id).filter((event) => event.type === 'member_rejoined_after_rebuild')).toHaveLength(1)

      // 独立席位（CH-2）重建：无组可言，不投递。
      bridge.patchSession('2', { online: false, connected: false, waiting: false, status: 'offline', connectionPhase: 'cursor_stopped' })
      expect(service.prepareComposerRelaunch('2')).toMatch(/^[0-9a-f-]{36}$/)
      expect(bind('2', 'composer-2b')).toBe(true)
      expect(bridge.sent.filter((message) => message.kind === 'membership')).toHaveLength(1)
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('uses verified Cursor activity for seat status instead of MCP heartbeat alone', () => {
    const telemetry: CursorComposerTelemetrySource = {
      readWorkspace: (_workspace, bindings) => ({
        availability: 'available',
        workspacePath: '/workspace/alpha',
        composers: bindings.flatMap((binding) => binding.composerId ? [{
          composerId: binding.composerId,
          title: `CH-${binding.channelId}`,
          activity: {
            state: 'stopped' as const,
            channelId: binding.channelId,
            detail: 'Agent 已停止监听'
          }
        }] : []),
        bindingCandidates: [],
        updatedAt: Date.now()
      })
    }
    const data = poolFixture({ telemetry })
    try {
      for (const binding of data.service.getSnapshot().bindings) {
        data.service.recordComposerBinding({
          runId: binding.runId,
          slotId: binding.slotId,
          generation: binding.generation,
          bindingKey: binding.composerBindingKey,
          composerId: `composer-${binding.channelId}-verified`,
          method: 'launch_marker'
        })
      }
      const snapshot = data.service.getSnapshot()
      expect(snapshot.members.every((member) => member.runtime?.online === false)).toBe(true)
      expect(snapshot.members.every((member) => member.readiness === 'offline')).toBe(true)
    } finally {
      data.service.dispose()
      data.repository.close()
    }
  })

  it('projects an archived legacy team run read-only: it is the active run of its workspace until a pool replaces it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-legacy-')), 'control.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bundle = createDefaultTeamBundle({ ...alpha, channelIds: ['1', '2'], now: 1_000 })
    repository.upsertWorkspaceTeam(bundle)
    expect(repository.completeRun(bundle.run.id, 2_000)).toBe(true)
    const bridge = new FakeBridge(desktopSnapshot())
    const service = new TeamControlService(repository, bridge)
    try {
      const legacy = service.getSnapshot()
      expect(legacy.activeRun).toMatchObject({ id: bundle.run.id, status: 'completed' })
      expect(workspaceRunMode(legacy.activeRun)).toBe('team')
      expect(legacy.members.map((member) => member.role.templateKey)).toEqual(['lead', 'builder'])
      expect(() => service.endActiveRun()).toThrow(/已经结束/)

      const pool = service.createSessionPool({ ...alpha, members: [soloSeat('1')] })
      expect(workspaceRunMode(pool.activeRun)).toBe('independent')
      expect(pool.runs.map((run) => run.status)).toEqual(['completed', 'running'])
    } finally {
      service.dispose()
      repository.close()
    }
  })
})
