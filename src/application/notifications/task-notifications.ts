import { createHash } from 'node:crypto'
import type { TaskPoolSnapshot } from '../../domain/task-pool'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import { readTaskNotificationState, reduceTaskNotifications, type TaskNotificationInput, type TaskNotificationState } from '../../domain/task-notification'
import { NotificationProjectionSource } from './projection-source'

export function connectTaskNotifications(tasks: { subscribe(listener: (snapshot: TaskPoolSnapshot) => void): () => void }, getTeam: () => TeamControlSnapshot, owner: NotificationService) {
  const source = new NotificationProjectionSource<TaskNotificationInput, TaskNotificationState>(owner, readTaskNotificationState, reduceTaskNotifications,
    input => JSON.stringify([input.key, input.completed, input.facts.map(fact => [fact.id, fact.title, fact.status, fact.attemptId, fact.reviewId, fact.scope, fact.failure])]))
  const stop = tasks.subscribe(snapshot => {
    try {
      const team = getTeam()
      if (!snapshot.runId || snapshot.runId !== team.activeRun?.id || snapshot.workspaceId !== team.activeWorkspaceId) return
      const key = `task-notifications:${createHash('sha256').update(JSON.stringify([snapshot.workspaceId, snapshot.runId])).digest('hex')}`
      const facts = snapshot.taskOrder.flatMap(id => {
        const task = snapshot.tasks[id]
        if (!task || task.runId !== snapshot.runId) return []
        return [{ id: task.id, title: task.title, status: task.status, attemptId: task.currentAttemptId, reviewId: task.currentReviewId, at: task.updatedAt,
          ...(task.status === 'failed' && task.failureReason ? { failure: task.failureReason.slice(0, 1_000) } : {}),
          scope: { workspaceId: snapshot.workspaceId, runId: snapshot.runId, ...(task.groupId ? { groupId: task.groupId } : {}) } }]
      })
      source.observe(key, { key, completed: team.activeRun.status === 'completed', now: Date.now(), facts })
    } catch { owner.reportHistoryGap() }
  })
  let detached = false
  const detach = () => { if (!detached) { detached = true; stop() } }
  return { source, close: () => { detach(); return source.close() }, dispose: () => { detach(); source.stop() } }
}
