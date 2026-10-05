import type { AgentSession } from '../../../domain/agent-session'
import type { TeamControlSnapshot } from '../../../domain/team-control'
import type { NotificationTarget } from '../../../domain/notification'

export function notificationTargetAvailable(target: NotificationTarget, sessions: readonly AgentSession[], team: TeamControlSnapshot): boolean {
  if (target.kind === 'settings') return true
  if(target.kind==='memory')return team.activeWorkspaceId===target.workspaceId&&team.activeRun?.id===target.runId
    &&(!target.groupId||team.groups.some(view=>view.group.id===target.groupId&&view.group.runId===target.runId))
  if (target.kind === 'run' || target.kind === 'collaboration') return (!target.runId || team.activeRun?.id === target.runId)
    && (!target.groupId || team.groups.some(view => view.group.id === target.groupId && view.group.runId === team.activeRun?.id))
  const scope = target.scope
  if (!scope.channelId || !scope.sessionId && !scope.composerId) return false
  if (scope.workspaceId && team.activeWorkspaceId !== scope.workspaceId || scope.runId && team.activeRun?.id !== scope.runId) return false
  const session = sessions.find(value => value.channelId === scope.channelId)
  if (!session || scope.sessionId && session.id !== scope.sessionId || scope.composerId && session.composerId !== scope.composerId
    || scope.generation && String(session.generation) !== scope.generation) return false
  if (scope.contextDomain && (session.contextUsageSource !== 'bound' || session.contextUsageComposerId !== session.composerId
    || scope.contextDomain !== JSON.stringify([session.contextUsageModelId ?? null, session.contextUsage?.limit]))) return false
  const member = team.members.find(value => (value.binding?.channelId ?? value.slot.channelId) === scope.channelId)
  if (scope.slotId && member?.slot.id !== scope.slotId || scope.groupId && member?.slot.groupId !== scope.groupId
    || scope.bindingGeneration && member?.binding?.generation !== scope.bindingGeneration) return false
  return true
}
