import type { TeamControlRepository, TeamGroupMutation, GroupMembershipChange } from './team-control-repository'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { TaskPoolService } from './task-pool-service'
import type { TeamControlBridge } from './team-control-service'
import { TaskPoolError } from '../domain/task-pool'
import {
  buildMembershipNotice,
  isSessionPoolRun,
  type MembershipNoticeKind,
  type TeamControlSnapshot,
  type TeamGroup,
  type TeamGroupMemberConfiguration,
  type TeamGroupView,
  type TeamMemberView
} from '../domain/team-control'

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
 * - 任务池：出组释放其租约与验收（`releaseAgentWork`）；解散取消本组未完成任务（`closeGroup`）。
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
    private readonly tasks: Pick<TaskPoolService, 'closeGroup' | 'releaseAgentWork'>,
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

    const agentSessionId = memberOf(before, left.slotId)?.binding?.agentSessionId
    const released = agentSessionId
      ? this.safely('释放出组成员的任务租约', () => this.tasks.releaseAgentWork({
        agentSessionId, slotId: left.slotId, reason: MEMBER_LEFT_REASON
      })) ?? []
      : []
    const orphaned = this.safely('标记出组成员的待回应消息', () => this.collaboration.orphanPendingReceipts({
      runId, slotId: left.slotId, groupId: mutation.group.id, at
    })) ?? []
    this.sendMembershipNotice('left', left, mutation.group, undefined)

    // 组内仍有有效 lead：告知它成员已移出、任务已回队（团队消息，会按接收方自动落进本组）。
    const view = this.viewOf(after, mutation.group.id)
    const lead = view ? effectiveLeadOf(view) : undefined
    if (lead && lead.slot.id !== left.slotId) {
      const summary = [
        `【系统通知】成员「${left.roleName} · CH-${left.channelId ?? '?'}」已被移出协作组「${mutation.group.name}」，恢复为独立席位。`,
        released.length
          ? `其持有的 ${released.length} 项任务已回到队列，等待组内其他成员领取（定向给该席位的任务已清空定向）。`
          : '其名下没有进行中的任务。',
        orphaned.length ? `发给该成员、尚未回应的 ${orphaned.length} 条消息已标记为无人应答，不会再催办。` : ''
      ].filter(Boolean).join('')
      this.safely('通知 lead 成员已移出', () => this.collaboration.createMessage({
        runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: lead.slot.id },
        kind: 'notice',
        subject: '成员已移出协作组',
        content: summary,
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
    const leadLabel = view ? leadLabelOf(view) : undefined
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
    const leadLabel = view ? leadLabelOf(view) : undefined
    for (const joined of mutation.joined) this.sendMembershipNotice('joined', joined, mutation.group, leadLabel)
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

function memberOf(snapshot: TeamControlSnapshot, slotId: string): TeamMemberView | undefined {
  return snapshot.members.find((member) => member.slot.id === slotId)
}

function effectiveLeadOf(view: TeamGroupView): TeamMemberView | undefined {
  return view.effectiveLeadSlotId
    ? view.members.find((member) => member.slot.id === view.effectiveLeadSlotId)
    : undefined
}

/** 简报与通知里的 lead 标签：`主控协调 · CH-1`；无 lead 组为空（模板写「无」）。 */
function leadLabelOf(view: TeamGroupView): string | undefined {
  const lead = effectiveLeadOf(view)
  if (!lead) return undefined
  return `${lead.role.name} · CH-${lead.binding?.channelId ?? lead.slot.channelId ?? '?'}`
}

/** clientMessageId 只允许 `[a-zA-Z0-9:_-]{8,200}`：取 id 的尾段，避免 `team-group:ws:uuid` 拼接后超长。 */
function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-24)
}
