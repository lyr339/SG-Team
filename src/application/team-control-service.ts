import { randomUUID } from 'node:crypto'
import type { AgentRegistrationBatch } from './agent-authorization'
import type { ComposerBindingMethod } from '../domain/cursor-telemetry'
import type { TeamControlRepository } from './team-control-repository'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { AgentSession } from '../domain/agent-session'
import type { CursorModelSelection } from '../domain/cursor-model'
import { hasInFlightExecution, isAgentOnDuty } from '../domain/channel-message'
import {
  createConfiguredTeamBundle,
  isSessionPoolRun,
  projectGroups,
  type TeamControlSnapshot,
  type TeamControlState,
  type TeamMemberConfiguration,
  type TeamMemberReadiness,
  type TeamMemberView,
  type TeamRun,
  type WorkspaceTeamBundle
} from '../domain/team-control'
import type {
  DesktopSnapshot,
  SendMessageAccepted,
  SendMessageInput
} from '../shared/desktop-api'
import type { CursorComposerTelemetrySource } from '../infrastructure/cursor/cursor-composer-telemetry'
import { verifyAgentRuntime } from './verify-agent-runtime'

/** 逐会话模型选定的形状校验：只信结构，目录可用性由渲染层弹层选项保证。 */
function sanitizeModelSelection(value: unknown): CursorModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型配置无效')
  const candidate = value as Partial<CursorModelSelection>
  const modelId = typeof candidate.modelId === 'string' ? candidate.modelId.trim() : ''
  if (!modelId || modelId.length > 160) throw new Error('modelId 无效')
  const displayName = typeof candidate.displayName === 'string' && candidate.displayName.trim()
    ? candidate.displayName.trim().slice(0, 160)
    : modelId
  const parameters = Array.isArray(candidate.parameters)
    ? candidate.parameters.slice(0, 16).flatMap((parameter) => {
      if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) return []
      const { id, value: parameterValue } = parameter as { id?: unknown; value?: unknown }
      return typeof id === 'string' && id.trim() && typeof parameterValue === 'string' && parameterValue.trim()
        ? [{ id: id.trim().slice(0, 80), value: parameterValue.trim().slice(0, 160) }]
        : []
    })
    : []
  return { modelId, displayName, parameters, maxMode: candidate.maxMode === true }
}

export interface TeamControlBridge {
  getSnapshot(): DesktopSnapshot
  sendMessage(input: SendMessageInput): SendMessageAccepted
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void
  beginConversationScope?(input: { runId: string; startedAt: number }): DesktopSnapshot
}

/** 新建会话池的工作区标识 + 席位配置（全部 solo；入组是运行中的操作员动作）。 */
export interface CreateSessionPoolInput {
  workspaceId: string
  workspaceName: string
  workspacePath: string
  members: TeamMemberConfiguration[]
}

type TeamControlListener = (snapshot: TeamControlSnapshot) => void

/** completeRun 收尾原因（写入绑定 launch_detail，供大厅/审计区分收尾方式）。 */
const RUN_ENDED_BY_USER_DETAIL = '用户已结束本轮运行'
const RUN_REPLACED_DETAIL = '已被新的运行替换；旧会话将在下一次轮询收到会话围栏终止指令'

function activeRunOf(state: TeamControlState) {
  if (!state.activeWorkspaceId) return undefined
  return state.runs
    .filter((run) => run.workspaceId === state.activeWorkspaceId)
    .sort((left, right) => right.createdAt - left.createdAt)[0]
}

function freshTeamRunKey(): string {
  return `run-${randomUUID()}`
}

function readinessOf(input: {
  binding: TeamMemberView['binding']
  runtime?: AgentSession
}): TeamMemberReadiness {
  const { binding, runtime } = input
  if (!binding) return 'mcp_missing'
  if (binding.launchStatus === 'failed' || binding.launchStatus === 'uncertain') return 'attention'
  if (!runtime?.online) return 'offline'
  if (binding.launchStatus === 'acknowledged') return 'active'
  if (binding.launchStatus === 'sending' || binding.launchStatus === 'delivered') return 'launching'
  // 就绪判定与大厅/launcher 同源：online 之上认协议内相位（含 processing/keepalive），
  // 裸 waiting 会在 Agent 处理消息期间把就绪成员误标 not_waiting。
  if (!isAgentOnDuty(runtime)) return 'not_waiting'
  return 'ready'
}

/**
 * 团队控制服务：会话池（活动 run）的读投影与池级操作（新建池、结束池、席位模型、Composer 绑定）。
 * 阶段 2 · 2B 起没有一次性团队 run 的创建 / 启动 / 新一轮：run 只有 running / completed，
 * 协作在池内以组的形式随时建拆（TeamGroupService）。
 */
export class TeamControlService {
  private listeners = new Set<TeamControlListener>()
  private lastRevision: number
  private cachedState?: TeamControlState
  /** Date.now() can repeat within one millisecond; activeRun ordering requires a strict clock. */
  private lastRunCreatedAt = 0
  private watchTimer?: ReturnType<typeof setInterval>
  private readonly unsubscribeBridge: () => void

  constructor(
    private readonly repository: TeamControlRepository,
    private readonly bridge: TeamControlBridge,
    private readonly telemetrySource?: CursorComposerTelemetrySource,
    private readonly collaborationLifecycle?: Pick<TeamCollaborationRepository, 'clearRun'>
  ) {
    const state = repository.loadTeamControl()
    this.lastRunCreatedAt = Math.max(0, ...state.runs.map((run) => run.createdAt))
    this.cachedState = state
    this.lastRevision = state.revision
    this.syncConversationScope(state)
    this.unsubscribeBridge = bridge.subscribe(() => this.emit())
  }

  /**
   * 团队结构只在 revision 变化时重载。旧实现每次 getSnapshot 都执行十余条
   * SQLite 查询并重新装配全部角色/席位/绑定；多个 250–1000ms watcher 叠加后
   * 让主进程长期占用一个 CPU 核心。外部 MCP 写入仍由轻量 revision 查询发现。
   */
  private loadState(): TeamControlState {
    const revision = this.repository.revision?.()
    if (this.cachedState && revision !== undefined && revision === this.cachedState.revision) {
      return this.cachedState
    }
    const state = this.repository.loadTeamControl()
    this.cachedState = state
    return state
  }

  private nextRunCreatedAt(): number {
    const at = Math.max(Date.now(), this.lastRunCreatedAt + 1)
    this.lastRunCreatedAt = at
    return at
  }

  getSnapshot(): TeamControlSnapshot {
    const state = this.loadState()
    let runtime = this.bridge.getSnapshot()
    const workspace = state.workspaces.find((candidate) => candidate.id === state.activeWorkspaceId)
    if (workspace && this.telemetrySource) {
      const run = activeRunOf(state)
      const bindings = run ? state.bindings.filter((binding) => binding.runId === run.id) : []
      const telemetry = this.telemetrySource.readWorkspace(workspace.path, bindings)
      runtime = verifyAgentRuntime(runtime, state, telemetry)
    }
    return this.project(state, runtime)
  }

  getActiveRunId(): string | undefined {
    return activeRunOf(this.loadState())?.id
  }

  getActiveRunStatus(): TeamRun['status'] | undefined {
    return activeRunOf(this.loadState())?.status
  }

  getActiveTaskScope(): { workspaceId?: string; runId?: string; scopeRevision: number } {
    const state = this.loadState()
    return {
      workspaceId: state.activeWorkspaceId,
      runId: activeRunOf(state)?.id,
      scopeRevision: state.revision
    }
  }

  subscribe(listener: TeamControlListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  /**
   * 新建会话池（独立批次 run），替换当前活动 run：旧池显式收尾 → 写入新拓扑 → 切换会话作用域。
   * 会话围栏（session 令牌）让被替换的旧会话在下一次轮询就收到终止指令自行退出，且不能刷新新席位的
   * presence；后果（旧会话结束、排队消息归档）由渲染层在替换前向用户确认。
   */
  createSessionPool(input: CreateSessionPoolInput): TeamControlSnapshot {
    const bundle = createConfiguredTeamBundle({
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      workspacePath: input.workspacePath,
      members: input.members,
      mode: 'independent',
      runKey: freshTeamRunKey(),
      now: this.nextRunCreatedAt()
    })
    const previous = activeRunOf(this.loadState())
    if (previous && previous.status !== 'completed' && previous.id !== bundle.run.id) {
      this.repository.completeRun(previous.id, Date.now(), RUN_REPLACED_DETAIL)
    }
    this.repository.upsertWorkspaceTeam(bundle)
    this.collaborationLifecycle?.clearRun(bundle.run.id)
    this.syncConversationScope(this.loadState())
    this.emit()
    return this.getSnapshot()
  }

  /** 显式结束当前会话池：结束后携带令牌的旧会话在下一次轮询被围栏拒绝。 */
  endActiveRun(): TeamControlSnapshot {
    const run = activeRunOf(this.loadState())
    if (!run) throw new Error('当前没有可结束的运行')
    if (run.status === 'completed') throw new Error('当前运行已经结束')
    if (!this.repository.completeRun(run.id, Date.now(), RUN_ENDED_BY_USER_DETAIL)) {
      throw new Error('运行状态已变化，请刷新后重试')
    }
    this.emit()
    return this.getSnapshot()
  }

  setActiveWorkspace(workspaceId: string): TeamControlSnapshot {
    this.repository.setActiveWorkspace(workspaceId)
    this.syncConversationScope(this.loadState())
    this.emit()
    return this.getSnapshot()
  }

  recordInstallation(batch: AgentRegistrationBatch): TeamControlSnapshot {
    this.repository.recordInstallation(batch)
    this.emit()
    return this.getSnapshot()
  }

  recordComposerBinding(input: {
    runId: string
    slotId: string
    generation: string
    bindingKey: string
    composerId: string
    method: ComposerBindingMethod
    at?: number
  }): boolean {
    const changed = this.repository.recordComposerBinding({
      ...input,
      at: input.at ?? Date.now()
    })
    if (changed) this.emit()
    return changed
  }

  /**
   * 换席重建前原子轮换绑定键与会话令牌。默认只对离线席位开放；`allowIdleOnline` 供席位
   * 自动轮换使用——席位在线但正待命（长轮询中、队列为空、无待回复）时也允许：旧会话在
   * 下一轮取队列复核围栏时退出（ChannelMessageService 逐轮复核），不会取走之后的消息。
   * 有在途执行（processing / 待同步回复）一律拒绝。
   */
  prepareComposerRelaunch(channelId: string, options: { allowIdleOnline?: boolean } = {}): string | undefined {
    const snapshot = this.getSnapshot()
    const member = snapshot.members.find((candidate) => (
      (candidate.binding?.channelId ?? candidate.slot.channelId) === channelId
    ))
    if (!member?.binding || !member.runtime || hasInFlightExecution(member.runtime)) return undefined
    if (member.runtime.online) {
      const idle = options.allowIdleOnline === true
        && member.runtime.waiting
        && member.runtime.queueDepth === 0
        && member.runtime.pendingOutboundId === undefined
        && member.runtime.awaitingUser !== true
      if (!idle) return undefined
    }
    const bindingKey = randomUUID()
    const changed = this.repository.prepareComposerRelaunch({
      runId: member.binding.runId,
      slotId: member.slot.id,
      bindingKey
    })
    if (!changed) return undefined
    this.emit()
    return bindingKey
  }

  /**
   * Lobby 逐会话模型配置持久化：写入当前 run 对应席位，重启/换 run 后回读仍一一对应。
   */
  setSlotModelSelection(channelId: string, selection: CursorModelSelection): TeamControlSnapshot {
    const normalized = String(channelId ?? '').trim()
    if (!/^\d{1,12}$/.test(normalized)) throw new Error('通道号无效')
    const snapshot = this.getSnapshot()
    if (!snapshot.activeRun) throw new Error('当前没有活跃 TeamRun，无法保存会话模型配置')
    const member = snapshot.members.find((candidate) => (
      (candidate.binding?.channelId ?? candidate.slot.channelId) === normalized
    ))
    if (!member) throw new Error(`CH-${normalized} 不属于当前 TeamRun`)
    this.repository.setSlotModelSelection(member.slot.id, sanitizeModelSelection(selection), Date.now())
    this.emit()
    return this.getSnapshot()
  }

  startWatcher(intervalMs = 1_000): void {
    this.stopWatcher()
    this.watchTimer = setInterval(() => {
      const revision = this.repository.revision?.() ?? this.repository.loadTeamControl().revision
      if (revision !== this.lastRevision) this.emit()
    }, Math.max(250, intervalMs))
    this.watchTimer.unref?.()
  }

  stopWatcher(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = undefined
  }

  dispose(): void {
    this.stopWatcher()
    this.unsubscribeBridge()
    this.listeners.clear()
  }

  private project(state: TeamControlState, bridgeSnapshot: DesktopSnapshot): TeamControlSnapshot {
    const activeRun = activeRunOf(state)
    const roles = activeRun
      ? state.roles.filter((role) => role.runId === activeRun.id).sort((left, right) => left.order - right.order)
      : []
    const slots = activeRun
      ? state.slots.filter((slot) => slot.runId === activeRun.id).sort((left, right) => left.order - right.order)
      : []
    const bindings = activeRun
      ? state.bindings.filter((binding) => binding.runId === activeRun.id)
      : []
    const roleById = new Map(roles.map((role) => [role.id, role]))
    const bindingBySlot = new Map(bindings.map((binding) => [binding.slotId, binding]))
    const bindingByChannel = new Map(bindings.map((binding) => [binding.channelId, binding]))
    const runtimeByChannel = new Map(bridgeSnapshot.sessions.map((session) => [session.channelId, session]))
    const registrations = activeRun ? this.repository.listAgentRegistrations(activeRun.id) : []
    const registrationByChannel = new Map(registrations.map((registration) => [registration.channelId, registration]))
    const runtimeChannelIds = new Set([
      ...bridgeSnapshot.sessions.map((session) => session.channelId),
      ...slots.flatMap((slot) => slot.channelId ? [slot.channelId] : []),
      ...bindings.map((binding) => binding.channelId),
      ...registrations.map((registration) => registration.channelId)
    ])
    const runtimeChannels = [...runtimeChannelIds]
      .sort((left, right) => Number(left) - Number(right) || left.localeCompare(right))
      .map((channelId) => {
        const runtime = runtimeByChannel.get(channelId)
        const registration = registrationByChannel.get(channelId)
        const binding = bindingByChannel.get(channelId)
        return {
          channelId,
          displayName: runtime?.displayName ?? `SG Team CH-${channelId}`,
          status: runtime?.status ?? 'offline' as const,
          online: runtime?.online ?? false,
          runtimeEvidence: runtime?.runtimeEvidence,
          waiting: runtime?.waiting ?? false,
          connectionPhase: runtime?.connectionPhase,
          queueDepth: runtime?.queueDepth ?? 0,
          registered: Boolean(registration),
          assignedSlotId: binding?.slotId,
          agentSessionId: registration?.agentSessionId,
          generation: registration?.generation
        }
      })
    const standbyChannels = runtimeChannels.filter((channel) => channel.registered && !channel.assignedSlotId)
    const failovers = activeRun ? this.repository.listFailovers(activeRun.id) : []
    const members: TeamMemberView[] = slots.flatMap((slot) => {
      const role = roleById.get(slot.roleId)
      if (!role) return []
      const binding = bindingBySlot.get(slot.id)
      const runtimeChannelId = binding?.channelId ?? slot.channelId
      const runtime = runtimeChannelId ? runtimeByChannel.get(runtimeChannelId) : undefined
      const readiness = slot.channelId
        ? readinessOf({ binding, runtime })
        : 'unbound'
      return [{
        slot,
        role,
        binding,
        runtime: runtime ? {
          channelId: runtime.channelId,
          status: runtime.status,
          online: runtime.online,
          runtimeEvidence: runtime.runtimeEvidence,
          awaitingUser: runtime.awaitingUser,
          waiting: runtime.waiting,
          connectionPhase: runtime.connectionPhase,
          pendingOutboundId: runtime.pendingOutboundId,
          pendingReplySyncSince: runtime.pendingReplySyncSince,
          queueDepth: runtime.queueDepth,
          lastSeenAt: runtime.lastSeenAt,
          lastAgentActivityAt: runtime.lastAgentActivityAt,
          healthEvidence: [...runtime.healthEvidence],
          workingFiles: [...runtime.workingFiles]
        } : undefined,
        readiness
      }]
    })

    const groups = activeRun ? projectGroups(state.groups, activeRun, members, Date.now()) : []

    const bridgeConnected = bridgeSnapshot.connection.state === 'connected'
    const workspaceBound = Boolean(state.activeWorkspaceId && activeRun)
    const goalDefined = Boolean(activeRun?.goal.trim())
    const activeMembersInstalled = members.length > 0 && members.every((member) =>
      Boolean(member.binding && member.slot.channelId === member.binding.channelId)
    )
    const activeMemberChannelsRegistered = members.length > 0 && members.every((member) =>
      Boolean(member.slot.channelId && registrationByChannel.has(member.slot.channelId))
    )
    const mcpInstalled = activeMembersInstalled && activeMemberChannelsRegistered
    // 会话池里「非 solo」= 已入组席位（任务书 §5.7）：agentsWaiting 只看入组成员。
    const teamMembers = members.filter((member) => member.slot.solo !== true)
    const agentsWaiting = teamMembers.length > 0 && teamMembers.every((member) =>
      member.runtime?.online && member.runtime.waiting
    )
    // 池没有「团队目标」与「启动」这两个概念：目标在组上，组即建即用。blockers 只剩接入前提与已结束。
    const blockers: string[] = []
    if (!bridgeConnected) blockers.push('拾光本地通道尚未就绪')
    if (!workspaceBound) blockers.push('尚未绑定 Cursor 工作区')
    if (workspaceBound && !mcpInstalled) blockers.push('Agent MCP 尚未接入全部本轮通道')
    if (activeRun?.status === 'completed') blockers.push('本次运行已经结束')

    return {
      ...state,
      roles,
      slots,
      bindings,
      activeRun,
      members,
      runtimeChannels,
      standbyChannels,
      failovers,
      groups,
      preflight: {
        bridgeConnected,
        workspaceBound,
        goalDefined,
        mcpInstalled,
        agentsWaiting,
        canLaunch: blockers.length === 0,
        blockers
      }
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    this.lastRevision = snapshot.revision
    for (const listener of this.listeners) listener(snapshot)
  }

  private syncConversationScope(state: TeamControlState): void {
    const run = activeRunOf(state)
    if (run) this.bridge.beginConversationScope?.({ runId: run.id, startedAt: run.createdAt })
  }
}
