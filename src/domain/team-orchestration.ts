import type { TaskPoolSnapshot, TaskReview, TeamTask } from './task-pool'
import { effectiveGroupLeadSlotId, isSessionPoolRun, type TeamControlSnapshot, type TeamMemberView } from './team-control'
import type { TeamMemoryItem } from './team-memory'

export const MEMORY_REVIEW_ESCALATION_MS = 30 * 60 * 1_000

function runtimeRank(member: TeamMemberView): number {
  return member.runtime?.online && member.runtime.waiting ? 0 : 1
}

/**
 * 参与协作的成员：legacy 团队 run = 全部非 solo 席位；会话池 = 全部已入组席位（跨组，池级视图）。
 * solo 模板能力为空且不是 lead/reviewer，本过滤属显式防御，防未来模板扩展误纳入。
 */
export function collaboratingMembers(team: TeamControlSnapshot): TeamMemberView[] {
  return team.members.filter((member) => member.slot.solo !== true && Boolean(member.binding))
}

/**
 * 某个组作用域内可被编排的成员（任务书 §5.5）：
 * - 对象带 groupId → 该组成员；
 * - 对象不带 groupId 且活动 run 是会话池 → 没有人（池内没有 run 级对象的执行者，避免把别组成员
 *   派去领一条它领不到的任务）；
 * - legacy 团队 run → 全体非 solo 成员（原语义）。
 */
export function groupScopedMembers(team: TeamControlSnapshot, groupId: string | undefined): TeamMemberView[] {
  if (groupId) return team.members.filter((member) => member.slot.groupId === groupId && Boolean(member.binding))
  if (team.activeRun && isSessionPoolRun(team.activeRun)) return []
  return collaboratingMembers(team)
}

/**
 * 某个组作用域的有效 lead：组内以组行的 acting / lead 为准（与授权口径一致）；
 * legacy 团队 run 以 run 级 acting lead → lead 模板角色。池内无组作用域 → 无 lead。
 */
export function groupScopedLead(team: TeamControlSnapshot, groupId: string | undefined): TeamMemberView | undefined {
  if (groupId) {
    const view = team.groups.find((candidate) => candidate.group.id === groupId)
    const leadSlotId = view ? effectiveGroupLeadSlotId(view.group) : undefined
    return leadSlotId ? view!.members.find((member) => member.slot.id === leadSlotId && member.binding) : undefined
  }
  if (team.activeRun && isSessionPoolRun(team.activeRun)) return undefined
  const actingLeadSlotId = team.activeRun?.actingLeadSlotId
  if (actingLeadSlotId) {
    return team.members.find((member) => member.slot.id === actingLeadSlotId && member.binding)
  }
  return team.members.find((member) => member.role.templateKey === 'lead' && member.binding)
}

export function selectTaskReviewMember(
  review: TaskReview,
  team: TeamControlSnapshot,
  pool: TaskPoolSnapshot
): TeamMemberView | undefined {
  const implementation = pool.attempts[review.attemptId]
  const task = pool.tasks[review.taskId]
  return groupScopedMembers(team, task?.groupId)
    .filter((member) => member.role.capabilities.includes('qa'))
    .filter((member) => member.binding?.agentSessionId !== implementation?.agentSessionId)
    .sort((left, right) => runtimeRank(left) - runtimeRank(right) || left.role.order - right.role.order)[0]
}

export function selectMemoryReviewMember(
  item: TeamMemoryItem,
  team: TeamControlSnapshot
): TeamMemberView | undefined {
  // 项目级记忆跨组共享：池内任何已入组的质量角色都可审；run 级记忆只在本组内找审核者。
  const candidates = item.scope === 'project' ? collaboratingMembers(team) : groupScopedMembers(team, item.groupId)
  // run 级记忆的审核者 = 有效 lead（组内与模板解耦：任何模板都能当组 lead）或质量角色。
  const leadSlotId = item.scope === 'project' ? undefined : groupScopedLead(team, item.groupId)?.slot.id
  const isLead = (member: TeamMemberView): boolean => leadSlotId
    ? member.slot.id === leadSlotId
    : member.role.templateKey === 'lead'
  return candidates
    .filter((member) => item.scope === 'project'
      ? member.role.templateKey === 'reviewer' || member.role.capabilities.includes('qa')
      : isLead(member) || member.role.templateKey === 'reviewer')
    .filter((member) => item.proposedBy.type !== 'agent' || member.slot.id !== item.proposedBy.slotId)
    .sort((left, right) => {
      const roleRank = (member: TeamMemberView): number => {
        if (item.scope === 'project') return member.role.templateKey === 'reviewer' ? 0 : 1
        return isLead(member) ? 0 : 1
      }
      return runtimeRank(left) - runtimeRank(right)
        || roleRank(left) - roleRank(right)
        || left.role.order - right.role.order
    })[0]
}

export function memoryReviewNeedsOperator(
  item: TeamMemoryItem,
  team: TeamControlSnapshot,
  now = Date.now()
): boolean {
  return !selectMemoryReviewMember(item, team)
    || now - item.createdAt >= MEMORY_REVIEW_ESCALATION_MS
}
