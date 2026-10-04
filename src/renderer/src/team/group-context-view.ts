import type { TeamControlSnapshot, TeamGroupView } from '../../../domain/team-control'
import type { TaskPoolSnapshot, TeamTask } from '../../../domain/task-pool'
import type { TeamCollaborationSnapshot, TeamMessage } from '../../../domain/team-collaboration'
import { isOrphanedReceipt, teamMessageRequiresResponse } from '../../../domain/team-collaboration'

export interface GroupContextView {
  scopeKey: string
  group?: TeamGroupView
  runId?: string
  mutable: boolean
  canCreateGroup?: boolean
  tasks: TeamTask[]
  messages: TeamMessage[]
  pendingReplies: number
  planningLabel: string
}

/** Snapshot-only projection: membership comes from the current slot; messages retain their written group scope. */
export function groupContextView(
  team: TeamControlSnapshot,
  channelId: string,
  tasks: TaskPoolSnapshot,
  collaboration: TeamCollaborationSnapshot
): GroupContextView {
  const run = team.activeRun
  const member = team.members.find((item) => (item.binding?.channelId ?? item.slot.channelId) === channelId)
  const view =
    run && member?.slot.runId === run.id && member.slot.groupId
      ? team.groups.find(
          (item) =>
            item.group.id === member.slot.groupId &&
            item.group.runId === run.id &&
            item.group.status === 'active' &&
            item.members.some((candidate) => candidate.slot.id === member.slot.id)
        )
      : undefined
  const empty: GroupContextView = {
    scopeKey: `${run?.id ?? 'none'}:${view?.group.id ?? `solo:${channelId}`}`,
    runId: run?.id,
    group: view,
    mutable: Boolean(view && run?.status === 'running'),
    canCreateGroup: run?.status === 'running',
    tasks: [],
    messages: [],
    pendingReplies: 0,
    planningLabel: ''
  }
  if (!view || !run) return empty
  const groupId = view.group.id
  const scopedTasks =
    tasks.runId && tasks.runId !== run.id
      ? []
      : [...new Set(tasks.taskOrder)]
          .map((id) => tasks.tasks[id])
          .filter((task): task is TeamTask =>
            Boolean(task && task.runId === run.id && task.groupId === groupId)
          )
          .sort((a, b) => b.createdAt - a.createdAt)
  const scopedMessages =
    collaboration.runId === run.id && (!collaboration.groupId || collaboration.groupId === groupId)
      ? [...new Set(collaboration.messageOrder)]
          .map((id) => collaboration.messages[id])
          .filter((message): message is TeamMessage =>
            Boolean(message && message.runId === run.id && message.groupId === groupId)
          )
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      : []
  return {
    ...empty,
    tasks: scopedTasks,
    messages: scopedMessages,
    planningLabel: view.effectiveLeadSlotId
      ? '主控规划'
      : view.group.planPolicy === 'any_member'
        ? '成员共同规划'
        : '由用户规划',
    pendingReplies: empty.mutable
      ? scopedMessages.filter(
          (message) =>
            message.recipient.type === 'agent' &&
            teamMessageRequiresResponse(message.kind) &&
            message.receipt.respondedAt === undefined &&
            !isOrphanedReceipt(message.receipt)
        ).length
      : 0
  }
}
