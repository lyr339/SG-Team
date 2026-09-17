import type { TeamControlRepository, TeamGroupMutation, GroupMembershipChange } from './team-control-repository'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { TaskPoolService } from './task-pool-service'
import type { TeamControlBridge } from './team-control-service'
import { TaskPoolError, type PlanTaskInput, type TeamTask } from '../domain/task-pool'
import {
  buildMembershipNotice,
  groupLeadLabel,
  groupMembersMayPlan,
  isSessionPoolRun,
  type MembershipNoticeKind,
  type TeamControlSnapshot,
  type TeamGroup,
  type TeamGroupMemberConfiguration,
  type TeamGroupPlanPolicy,
  type TeamGroupView,
  type TeamMemberView
} from '../domain/team-control'
import type {
  MembershipTransferCandidate,
  MembershipTransferOptions,
  MembershipTransferResult
} from '../domain/team-handoff'

interface TeamSource {
  getSnapshot(): TeamControlSnapshot
}

export interface TeamGroupServiceOptions {
  now?: () => number
  onerror?: (error: unknown) => void
}

export interface CreateTeamGroupInput {
  name: string
  goal?: string
  members: TeamGroupMemberConfiguration[]
  leadSlotId?: string
  /** 省略 = `defaultGroupPlanPolicy(leadSlotId)`。 */
  planPolicy?: TeamGroupPlanPolicy
}

/** 成员出组原因：写进任务 attempt 的 error / 任务 failureReason，与任务书 §7 规则 1 的口径一致。 */
const MEMBER_LEFT_REASON = 'member_left'
const GROUP_DISSOLVED_REASON = 'group_dissolved'

/**
 * 会话池 · 协作组的操作员服务（任务书 §5.2「事务外」一列）。
 *
 * 成员关系的真相源只有 team-control 仓储：每个公开方法先跑仓储事务（校验 + 改表 + 审计 + revision），
 * 事务被拒即整体失败、零副作用。成功后再做跨聚合副作用，副作用之间互不依赖、各自 fail-soft
 *（只记 onerror，不回滚成员关系——出站队列本身持久，通知投不出去也不该撤销一次已生效的入组 / 出组）：
 *
 * - 成员关系通知：`bridge.sendMessage({ kind: 'membership' })`，正文由 domain `buildMembershipNotice` 生成，
 *   投递时 check_messages 用独立后缀（没有 messageId、不要求 record_reply）。
 * - 任务池：出组释放其租约与验收、清空定向给它的任务（`releaseAgentWork`）；解散取消本组未完成任务（`closeGroup`）。
 * - 协作库：出组 / 解散把该席位名下待回应的 directive / question 标记为孤儿（`orphanPendingReceipts`）。
 * - lead 的知情：成员被移出后向本组有效 lead 发一条 `notice`；改目标向全体成员发 `notice`
 *  （这两类走 team_message，不是成员关系通知）。
 *
 * 不触碰令牌 / Composer / generation / run 状态；`addSeats / removeSeat / registerSeat` 推后（任务书 §14.2）。
 */
export class TeamGroupService {
  private readonly now: () => number
  private readonly onerror: (error: unknown) => void

  constructor(
    private readonly repository: TeamControlRepository,
    private readonly team: TeamSource,
    private readonly tasks: Pick<TaskPoolService, 'closeGroup' | 'releaseAgentWork' | 'planTasks'>,
    private readonly collaboration: Pick<TeamCollaborationRepository, 'createMessage' | 'orphanPendingReceipts'>,
    private readonly bridge: Pick<TeamControlBridge, 'sendMessage'>,
    options: TeamGroupServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.onerror = options.onerror ?? (() => undefined)
  }

  createGroup(input: CreateTeamGroupInput): TeamControlSnapshot {
    const { runId } = this.requirePool()
    const at = this.now()
    const mutation = this.repository.createGroup({
      runId,
      name: input.name,
      goal: input.goal,
      members: input.members,
      leadSlotId: input.leadSlotId,
      planPolicy: input.planPolicy,
      at
    })
    const after = this.team.getSnapshot()
    this.notifyJoined(mutation, this.viewOf(after, mutation.group.id))
    return after
  }

  addGroupMembers(input: { groupId: string; members: TeamGroupMemberConfiguration[] }): TeamControlSnapshot {
    this.requirePool()
    const mutation = this.repository.addGroupMembers({ groupId: input.groupId, members: input.members, at: this.now() })
    const after = this.team.getSnapshot()
    this.notifyJoined(mutation, this.viewOf(after, mutation.group.id))
    return after
  }

  removeGroupMember(input: { groupId: string; slotId: string }): TeamControlSnapshot {
    const { runId, snapshot: before } = this.requirePool()
    const at = this.now()
    const mutation = this.repository.removeGroupMember({ groupId: input.groupId, slotId: input.slotId, at })
    const [left] = mutation.left
    const after = this.team.getSnapshot()
    if (!left) return after

    const settled = this.settleDeparture({ runId, before, left, groupId: mutation.group.id, at })
    this.sendMembershipNotice('left', left, mutation.group, undefined)

    // 组内仍有有效 lead：告知它成员已移出、任务已回队（团队消息，会按接收方自动落进本组）。
    const view = this.viewOf(after, mutation.group.id)
    const lead = view ? effectiveLeadOf(view) : undefined
    if (lead && lead.slot.id !== left.slotId) {
      this.safely('通知 lead 成员已移出', () => this.collaboration.createMessage({
        runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: lead.slot.id },
        kind: 'notice',
        subject: '成员已移出协作组',
        content: `【系统通知】成员「${left.roleName} · CH-${left.channelId ?? '?'}」已被移出协作组「${mutation.group.name}」，恢复为独立席位。`
          + departureFollowUp(settled),
        clientMessageId: `group-member-left:${shortId(mutation.group.id)}:${shortId(left.slotId)}:${at}`
      }))
    }
    return after
  }

  setGroupLead(input: { groupId: string; slotId: string | null }): TeamControlSnapshot {
    this.requirePool()
    const mutation = this.repository.setGroupLead({ groupId: input.groupId, slotId: input.slotId, at: this.now() })
    const after = this.team.getSnapshot()
    const change = mutation.leadChange
    if (!change || change.previousSlotId === change.nextSlotId) return after
    const view = this.viewOf(after, mutation.group.id)
    const leadLabel = view ? groupLeadLabel(view) : undefined
    for (const slotId of [change.previousSlotId, change.nextSlotId]) {
      if (!slotId) continue
      const member = view?.members.find((candidate) => candidate.slot.id === slotId) ?? memberOf(after, slotId)
      const channelId = member?.binding?.channelId ?? member?.slot.channelId
      if (!channelId) continue
      this.send(channelId, buildMembershipNotice({
        kind: 'lead_changed',
        channelId,
        group: mutation.group,
        leadLabel,
        becameLead: slotId === change.nextSlotId
      }))
    }
    return after
  }

  updateGroupGoal(input: { groupId: string; goal: string }): TeamControlSnapshot {
    const { runId } = this.requirePool()
    const at = this.now()
    const mutation = this.repository.updateGroupGoal({ groupId: input.groupId, goal: input.goal, at })
    const after = this.team.getSnapshot()
    const view = this.viewOf(after, mutation.group.id)
    for (const member of view?.members ?? []) {
      this.safely('通知成员组目标已更新', () => this.collaboration.createMessage({
        runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: member.slot.id },
        kind: 'notice',
        subject: '协作组目标已更新',
        content: `【系统通知】协作组「${mutation.group.name}」的目标已更新：\n${mutation.group.goal || '（已清空，以用户随后指令为准）'}\n后续工作以新目标为准；如与进行中的任务冲突，向 lead 或用户确认。`,
        clientMessageId: `group-goal:${shortId(mutation.group.id)}:${shortId(member.slot.id)}:${at}`
      }))
    }
    return after
  }

  /**
   * 改规划策略。只在策略确实改变了「组内谁能 plan」时通知成员（有 lead 的组：规划权始终归 lead，
   * 策略只是预设，成员对此无感，不打扰）。
   */
  setGroupPlanPolicy(input: { groupId: string; planPolicy: TeamGroupPlanPolicy }): TeamControlSnapshot {
    const { runId, snapshot: before } = this.requirePool()
    const at = this.now()
    const previous = this.viewOf(before, input.groupId)?.group
    const mutation = this.repository.setGroupPlanPolicy({ groupId: input.groupId, planPolicy: input.planPolicy, at })
    const after = this.team.getSnapshot()
    const view = this.viewOf(after, mutation.group.id)
    if (!view || !previous || groupMembersMayPlan(previous) === groupMembersMayPlan(mutation.group)) return after
    const opened = groupMembersMayPlan(mutation.group)
    for (const member of view.members) {
      this.safely('通知成员规划策略已更新', () => this.collaboration.createMessage({
        runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: member.slot.id },
        kind: 'notice',
        subject: '协作组规划策略已更新',
        content: opened
          ? `【系统通知】协作组「${mutation.group.name}」现在允许全体成员规划任务：收到用户明确要求后可用 team_task({action:'plan', tasks:[...]}) 创建任务，系统会自动分派。先调用 team_check_in 刷新简报。`
          : `【系统通知】协作组「${mutation.group.name}」不再允许成员规划任务：任务改由用户在拾光里创建并自动分派；已创建的任务不受影响。先调用 team_check_in 刷新简报。`,
        clientMessageId: `group-plan-policy:${shortId(mutation.group.id)}:${shortId(member.slot.id)}:${at}`
      }))
    }
    return after
  }

  /**
   * 用户在拾光里为某个组规划任务（阶段 2 · 2A，决策 D2：无 lead 组的规划权首先归用户；有 lead 的组用户同样可以直接建任务）。
   * 校验口径与 Agent 侧 `TeamCollaborationAgentService.planTasks` 一致：targetSlotId 必须是本组成员、requiredCapabilities
   * 至少有一名成员全部具备——否则任务会静默地永远派不出去。创建后 TaskDispatcher 按组自动派单。
   */
  planGroupTasks(input: { groupId: string; tasks: PlanTaskInput[] }): TeamTask[] {
    const { snapshot } = this.requirePool()
    const view = this.viewOf(snapshot, input.groupId)
    if (!view) throw new TaskPoolError('group_not_found', '协作组不存在或不属于当前会话池')
    if (view.group.status !== 'active') throw new TaskPoolError('group_not_active', '协作组已解散，不能再规划任务')
    const memberBySlot = new Map(view.members.map((member) => [member.slot.id, member]))
    for (const task of input.tasks) {
      const required = [...new Set((task.requiredCapabilities ?? []).map((item) => item.trim()).filter(Boolean))]
      if (task.targetSlotId) {
        const target = memberBySlot.get(task.targetSlotId.trim())
        if (!target) throw new TaskPoolError('target_slot_not_found', `指定席位不属于协作组「${view.group.name}」：${task.targetSlotId}`)
        const missing = required.filter((capability) => !target.role.capabilities.includes(capability))
        if (missing.length) {
          throw new TaskPoolError('target_capability_mismatch', `${target.role.name} 不具备能力 ${missing.join('、')}`)
        }
      } else if (required.length && !view.members.some((member) => required.every((capability) => member.role.capabilities.includes(capability)))) {
        throw new TaskPoolError('team_capability_unavailable', `协作组「${view.group.name}」没有成员同时具备能力：${required.join('、')}`)
      }
    }
    return this.tasks.planTasks(view.group.id, input.tasks)
  }

  /**
   * 成员身份迁移的选项（阶段 2 · 2C）：源席位必须是某个 active 组的成员；候选 = 池内全部未入组的
   * 独立席位。离线目标同样可选——joined 通知与上下文交接都走通道队列，等它的新会话上线后生效。
   */
  membershipTransferOptions(sourceSlotId: string): MembershipTransferOptions {
    const { runId, snapshot } = this.requirePool()
    if (snapshot.activeRun?.status !== 'running') {
      throw new TaskPoolError('group_run_inactive', '会话池已结束，不能再迁移成员身份')
    }
    const slotId = sourceSlotId.trim()
    const view = snapshot.groups.find((candidate) => (
      candidate.group.status === 'active' && candidate.members.some((member) => member.slot.id === slotId)
    ))
    const source = view?.members.find((member) => member.slot.id === slotId)
    if (!view || !source) {
      throw new TaskPoolError('transfer_source_not_grouped', '该席位不在任何协作组内；独立席位直接用会话上下文交接')
    }
    const candidates: MembershipTransferCandidate[] = snapshot.members
      .filter((member) => member.slot.solo === true)
      .map((member) => {
        const online = member.runtime?.online === true
        return {
          slotId: member.slot.id,
          channelId: member.binding?.channelId ?? member.slot.channelId,
          roleName: member.role.name,
          avatarId: member.slot.avatarId,
          online,
          impact: online
            ? '在线独立席位：入组通知随它的下一次轮询到达'
            : '当前离线：通知与上下文会在其通道排队，等新会话上线后生效'
        }
      })
    return {
      runId,
      groupId: view.group.id,
      groupName: view.group.name,
      sourceSlotId: slotId,
      sourceRoleName: source.role.name,
      sourceChannelId: source.binding?.channelId ?? source.slot.channelId,
      transfersLead: view.effectiveLeadSlotId === slotId,
      candidates
    }
  }

  /**
   * 成员身份迁移（阶段 2 · 2C）：A 出组、B 以 A 的组角色入组，lead 身份随迁；绑定 / 令牌 /
   * Composer 全部不动。成员关系一次事务生效（transferGroupMembership），之后的跨聚合收尾与
   * 移出成员同一套（释放 A 的租约与验收、待回应消息标孤儿）。通知：A left、B joined；有效 lead
   * 随迁时 B 另收一条 lead_changed（A 已出组，left 通知已经说明它不再持有任何组内权限，不再
   * 追加 lead_changed——那条模板会让它去 team_check_in）。审计行在 team_failovers
   *（reason='manual_membership_transfer'）。
   */
  transferMembership(input: { groupId: string; fromSlotId: string; toSlotId: string }): MembershipTransferResult {
    const { runId, snapshot: before } = this.requirePool()
    const at = this.now()
    const mutation = this.repository.transferGroupMembership({
      groupId: input.groupId,
      fromSlotId: input.fromSlotId,
      toSlotId: input.toSlotId,
      at
    })
    const after = this.team.getSnapshot()
    const view = this.viewOf(after, mutation.group.id)
    const leadLabel = view ? groupLeadLabel(view) : undefined

    const settled = this.settleDeparture({ runId, before, left: mutation.from, groupId: mutation.group.id, at })
    this.sendMembershipNotice('left', mutation.from, mutation.group, undefined)
    this.sendMembershipNotice('joined', mutation.to, mutation.group, leadLabel)
    if (mutation.transferredLead && mutation.to.channelId) {
      this.send(mutation.to.channelId, buildMembershipNotice({
        kind: 'lead_changed', channelId: mutation.to.channelId, group: mutation.group, leadLabel, becameLead: true
      }))
    }

    // 有效 lead 是 B 之外的成员：告知它成员换人与任务回队（团队消息，非成员关系通知）。
    const lead = view ? effectiveLeadOf(view) : undefined
    if (lead && lead.slot.id !== mutation.to.slotId) {
      this.safely('通知 lead 成员身份已迁移', () => this.collaboration.createMessage({
        runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: lead.slot.id },
        kind: 'notice',
        subject: '成员身份已迁移',
        content: `【系统通知】协作组「${mutation.group.name}」的成员身份已迁移：「${mutation.from.roleName} · CH-${mutation.from.channelId ?? '?'}」→「CH-${mutation.to.channelId ?? '?'}」（角色不变）。`
          + departureFollowUp(settled),
        clientMessageId: `group-membership-transfer:${shortId(mutation.group.id)}:${shortId(mutation.to.slotId)}:${at}`
      }))
    }

    return {
      groupId: mutation.group.id,
      fromSlotId: mutation.from.slotId,
      toSlotId: mutation.to.slotId,
      toChannelId: mutation.to.channelId,
      roleName: mutation.to.roleName,
      transferredLead: mutation.transferredLead,
      failover: mutation.failover,
      releasedTaskIds: settled.released
    }
  }

  dissolveGroup(input: { groupId: string }): TeamControlSnapshot {
    const { runId } = this.requirePool()
    const at = this.now()
    const mutation = this.repository.dissolveGroup({ groupId: input.groupId, at })
    const after = this.team.getSnapshot()
    // 任务书 §7 规则 5：未完成任务取消（attempt / review 一并收口）；消息与记忆由各自仓储保留只读。
    this.safely('取消已解散协作组的任务', () => this.tasks.closeGroup(runId, mutation.group.id, GROUP_DISSOLVED_REASON))
    for (const left of mutation.left) {
      this.safely('标记已解散协作组成员的待回应消息', () => this.collaboration.orphanPendingReceipts({
        runId, slotId: left.slotId, groupId: mutation.group.id, at
      }))
      this.sendMembershipNotice('dissolved', left, mutation.group, undefined)
    }
    return after
  }

  /** 组操作只在会话池（独立批次 run）里有意义；仓储还会再校验一次池状态。 */
  private requirePool(): { runId: string; snapshot: TeamControlSnapshot } {
    const snapshot = this.team.getSnapshot()
    const run = snapshot.activeRun
    if (!run) throw new TaskPoolError('run_not_found', '当前没有活动的运行')
    if (!isSessionPoolRun(run)) {
      throw new TaskPoolError('group_requires_pool_run', '协作组只能在会话池（独立批次）内创建；一次性团队 run 不支持分组')
    }
    return { runId: run.id, snapshot }
  }

  private viewOf(snapshot: TeamControlSnapshot, groupId: string): TeamGroupView | undefined {
    return snapshot.groups.find((view) => view.group.id === groupId)
  }

  private notifyJoined(mutation: TeamGroupMutation, view: TeamGroupView | undefined): void {
    const leadLabel = view ? groupLeadLabel(view) : undefined
    for (const joined of mutation.joined) this.sendMembershipNotice('joined', joined, mutation.group, leadLabel)
  }

  /**
   * 成员出组（移出 / 身份迁移）后的跨聚合收尾，任务书 §7 规则 1：释放它持有的租约与验收、清空定向给它的
   * 任务（需要迁移前快照里的会话 id——出组后 memberOf 仍能找到席位，但释放按 agentSessionId 归属），
   * 并把它名下待回应的 directive / question 标为孤儿。两步各自 fail-soft。
   */
  private settleDeparture(input: {
    runId: string
    before: TeamControlSnapshot
    left: GroupMembershipChange
    groupId: string
    at: number
  }): DepartureSettlement {
    const agentSessionId = memberOf(input.before, input.left.slotId)?.binding?.agentSessionId
    const released = agentSessionId
      ? this.safely('释放出组成员的任务租约', () => this.tasks.releaseAgentWork({
        agentSessionId, slotId: input.left.slotId, reason: MEMBER_LEFT_REASON
      })) ?? []
      : []
    const orphaned = this.safely('标记出组成员的待回应消息', () => this.collaboration.orphanPendingReceipts({
      runId: input.runId, slotId: input.left.slotId, groupId: input.groupId, at: input.at
    })) ?? []
    return { released, orphaned: orphaned.length }
  }

  private sendMembershipNotice(
    kind: Exclude<MembershipNoticeKind, 'lead_changed'>,
    change: GroupMembershipChange,
    group: Pick<TeamGroup, 'name' | 'goal'>,
    leadLabel: string | undefined
  ): void {
    if (!change.channelId) return
    this.send(change.channelId, buildMembershipNotice({
      kind, channelId: change.channelId, group, roleName: change.roleName, leadLabel
    }))
  }

  private send(channelId: string, text: string): void {
    this.safely(`向 CH-${channelId} 投递成员关系通知`, () => this.bridge.sendMessage({ channelId, text, kind: 'membership' }))
  }

  private safely<T>(step: string, operation: () => T): T | undefined {
    try {
      return operation()
    } catch (error) {
      this.onerror(new Error(`[team-group] ${step}失败：${error instanceof Error ? error.message : String(error)}`))
      return undefined
    }
  }
}

/** 出组收尾的结果：释放回队列的任务 id、标为孤儿的待回应消息数。 */
interface DepartureSettlement {
  released: string[]
  orphaned: number
}

/** 给 lead 的系统通知里、紧接在事由之后的收尾说明（任务回队 / 消息孤儿）。 */
function departureFollowUp(settled: DepartureSettlement): string {
  return [
    settled.released.length
      ? `与其相关的 ${settled.released.length} 项任务已回到队列（持有的租约与验收已释放，定向给该席位的已清空定向），等待组内其他成员领取。`
      : '其名下没有进行中或定向给它的任务。',
    settled.orphaned ? `发给该成员、尚未回应的 ${settled.orphaned} 条消息已标记为无人应答，不会再催办。` : ''
  ].join('')
}

function memberOf(snapshot: TeamControlSnapshot, slotId: string): TeamMemberView | undefined {
  return snapshot.members.find((member) => member.slot.id === slotId)
}

function effectiveLeadOf(view: TeamGroupView): TeamMemberView | undefined {
  return view.effectiveLeadSlotId
    ? view.members.find((member) => member.slot.id === view.effectiveLeadSlotId)
    : undefined
}

/** clientMessageId 只允许 `[a-zA-Z0-9:_-]{8,200}`：取 id 的尾段，避免 `team-group:ws:uuid` 拼接后超长。 */
function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-24)
}
