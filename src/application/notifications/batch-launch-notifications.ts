import type { AgentSessionLauncher } from '../agent-session-launcher'
import type { NotificationService } from '../notification-service'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationScope } from '../../domain/notification'
import { batchLaunchNotification } from '../../domain/batch-launch-notification'

export function connectBatchLaunchNotifications(launcher: Pick<AgentSessionLauncher, 'subscribe'>, getTeam: () => TeamControlSnapshot,
  notifications: Pick<NotificationService, 'offerCurrent'>, now: () => number = Date.now): () => void {
  const scopes = new Map<string, NotificationScope>()
  let subscribing = true
  const stop = launcher.subscribe(plan => {
    if (plan.state === 'running' && !scopes.has(plan.id)) {
      const team = getTeam(); const run = team.activeRun
      scopes.set(plan.id, { ...(team.activeWorkspaceId ? { workspaceId: team.activeWorkspaceId } : {}), ...(run ? { runId: run.id } : {}) })
    }
    notifications.offerCurrent(batchLaunchNotification(plan, scopes.get(plan.id) ?? {}, !subscribing, now()))
    if (scopes.size > 32) scopes.delete(scopes.keys().next().value!)
  })
  subscribing = false
  return stop
}
