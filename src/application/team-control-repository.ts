import type { AgentRegistrationBatch } from './agent-authorization'
import type { AgentCheckInReceipt, AgentPresenceStore } from './agent-presence'
import type {
  TeamControlState,
  TeamGroup,
  TeamGroupEvent,
  TeamGroupMemberConfiguration,
  TeamGroupPlanPolicy,
  WorkspaceTeamBundle
} from '../domain/team-control'
import type { ComposerBindingMethod } from '../domain/cursor-telemetry'
import type { CursorModelSelection } from '../domain/cursor-model'
import type { AgentAuthorizationIdentity, AgentRegistration } from './agent-authorization'
import type { TeamFailoverRebindResult, TeamFailoverRecord, TeamFailoverStatus } from '../domain/team-failover'

/** 一次成员关系变化里进入 / 离开组的席位（服务层据此投递成员关系通知，不必再查库）。 */
export interface GroupMembershipChange {
  slotId: string
  channelId?: string
  roleName: string
  roleTemplateKey: string
}

/** 组变更结果：变更后的组行 + 本次进出组的席位 + lead 变化。 */
export interface TeamGroupMutation {
  group: TeamGroup
  joined: GroupMembershipChange[]
  left: GroupMembershipChange[]
  leadChange?: { previousSlotId?: string; nextSlotId?: string }
}

export interface TeamControlRepository extends AgentPresenceStore {
  /** 轻量读取当前修订号；用于避免每个轮询消费者都全量装配团队状态。 */
  revision?(): number
  loadTeamControl(): TeamControlState
  upsertWorkspaceTeam(bundle: WorkspaceTeamBundle): void
  /** 单槽模型选定持久化（lobby 逐会话配置保存出口）。 */
  setSlotModelSelection(slotId: string, selection: CursorModelSelection, updatedAt?: number): void
  setActiveWorkspace(workspaceId: string): void
  recordInstallation(batch: AgentRegistrationBatch): void
  recordComposerBinding(input: {
    runId: string
    slotId: string
    generation: string
    bindingKey: string
    composerId: string
    method: ComposerBindingMethod
    at: number
  }): boolean
  prepareComposerRelaunch(input: {
    runId: string
    slotId: string
    bindingKey: string
  }): boolean
  resolveAgentRuntimeIdentity(identityKey: string, runId?: string): AgentAuthorizationIdentity
  listAgentRegistrations(runId: string): AgentRegistration[]
  rebindSlotToStandby(input: {
    failoverId: string
    runId: string
    slotId: string
    expectedAgentSessionId: string
    replacementAgentSessionId: string
    reason: string
    detectedAt: number
    bindingKey: string
    checkpointId?: string
  }): TeamFailoverRebindResult
  rebindSlotFromMember(input: {
    failoverId: string
    runId: string
    slotId: string
    donorSlotId: string
    expectedAgentSessionId: string
    replacementAgentSessionId: string
    reason: string
    detectedAt: number
    bindingKey: string
    checkpointId?: string
  }): TeamFailoverRebindResult
  attachFailoverContext(input: {
    failoverId: string
    checkpointId?: string
    messageId: string
    taskIds: string[]
    at: number
  }): void
  updateFailoverStatus(input: {
    failoverId: string
    status: Extract<TeamFailoverStatus, 'completed' | 'failed'>
    reason?: string
    at: number
  }): void
  listFailovers(runId: string): TeamFailoverRecord[]
  /**
   * 把 running 的 run 收尾为 completed（撤销注册、绑定标 failed）。`detail` 写入各绑定的
   * launch_detail，说明收尾原因（用户显式结束 / 被新运行替换）；已结束的 run 返回 false。
   */
  completeRun(runId: string, at: number, detail?: string): boolean
  recordAgentCheckIn(
    identity: Parameters<AgentPresenceStore['recordAgentCheckIn']>[0],
    note: string
  ): AgentCheckInReceipt
  /** 设置或清除临时主控：主控离线时指定新的 acting lead。 */
  setActingLead(input: { runId: string; slotId: string | null; at: number }): boolean

  // ---- 协作组（会话池）：每个方法 = 一次事务 + team_group_events 审计行；不触碰令牌 / Composer / 作用域 ----

  /**
   * 在会话池 run 内建组：成员必须是未入组席位；lead 可空（无 lead 组）。
   * `planPolicy` 省略时按 `defaultGroupPlanPolicy(leadSlotId)`：有 lead → lead_only，无 lead → any_member。
   */
  createGroup(input: {
    runId: string
    name: string
    goal?: string
    members: TeamGroupMemberConfiguration[]
    leadSlotId?: string
    planPolicy?: TeamGroupPlanPolicy
    at?: number
  }): TeamGroupMutation
  addGroupMembers(input: { groupId: string; members: TeamGroupMemberConfiguration[]; at?: number }): TeamGroupMutation
  /**
   * 移出成员并恢复其 solo 身份。有效 lead 在组内仍有其他成员时被拒绝
   *（`lead_must_transfer_first`），除非 `force`（解散 / 用户明确要求）。
   */
  removeGroupMember(input: { groupId: string; slotId: string; at?: number; force?: boolean }): TeamGroupMutation
  /** 换 lead（null = 改为无 lead 组）；同时清除临时主控。 */
  setGroupLead(input: { groupId: string; slotId: string | null; at?: number }): TeamGroupMutation
  /** 组内临时主控（lead 离线接管 / team_run transfer_lead）；null = 复位。 */
  setGroupActingLead(input: { groupId: string; slotId: string | null; at?: number }): TeamGroupMutation
  updateGroupGoal(input: { groupId: string; goal: string; at?: number }): TeamGroupMutation
  /** 改规划策略（谁能 team_task plan）；只对无 lead 的组产生实际效果，有 lead 时规划权始终归有效 lead。 */
  setGroupPlanPolicy(input: { groupId: string; planPolicy: TeamGroupPlanPolicy; at?: number }): TeamGroupMutation
  /** 解散：全部成员恢复 solo、组角色删除、组置 dissolved；任务 / 消息 / 记忆由调用方按组收尾。 */
  dissolveGroup(input: { groupId: string; at?: number }): TeamGroupMutation
  listGroupEvents(groupId: string, limit?: number): TeamGroupEvent[]
  close(): void
}
