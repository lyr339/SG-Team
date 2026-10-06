import { createHash } from 'node:crypto'
import type { TaskPoolSnapshot, TaskPoolReadObservation } from '../../domain/task-pool'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import {
  readTaskNotificationState,
  reduceTaskNotifications,
  type TaskNotificationInput,
  type TaskNotificationState
} from '../../domain/task-notification'
import { NotificationProjectionSource } from './projection-source'
import { NativeReadOrder } from './native-read-order'

export function connectTaskNotifications(
  tasks: {
    subscribe(listener: (snapshot: TaskPoolSnapshot) => void): () => void
    subscribeReadObservation?(listener: (value: TaskPoolReadObservation) => void): () => void
    getReadOwnerId?(): string
  },
  getTeam: () => TeamControlSnapshot,
  owner: NotificationService
) {
  const order = new NativeReadOrder(tasks.getReadOwnerId?.())
  const source = new NotificationProjectionSource<TaskNotificationInput, TaskNotificationState>(
    owner,
    readTaskNotificationState,
    reduceTaskNotifications,
    (input) =>
      JSON.stringify([
        input.key,
        input.completed,
        input.currentRead ? input.readOwner : null,
        input.currentRead ? input.readEpoch : null,
        input.facts.map((fact) => [fact.id, fact.title, fact.status, fact.attemptId, fact.reviewId, fact.scope, fact.failure])
      ])
  )
  const observe = (snapshot: TaskPoolSnapshot, currentRead: boolean) => {
    try {
      const team = getTeam()
      if (!snapshot.runId || snapshot.runId !== team.activeRun?.id || snapshot.workspaceId !== team.activeWorkspaceId) return
      const key = `task-notifications:${createHash('sha256')
        .update(JSON.stringify([snapshot.workspaceId, snapshot.runId]))
        .digest('hex')}`
      const facts = snapshot.taskOrder.flatMap((id) => {
        const task = snapshot.tasks[id]
        if (!task || task.runId !== snapshot.runId) return []
        return [
          {
            id: task.id,
            title: task.title,
            status: task.status,
            attemptId: task.currentAttemptId,
            reviewId: task.currentReviewId,
            at: task.updatedAt,
            ...(task.status === 'failed' && task.failureReason ? { failure: task.failureReason.slice(0, 1000) } : {}),
            scope: { workspaceId: snapshot.workspaceId, runId: snapshot.runId, ...(task.groupId ? { groupId: task.groupId } : {}) }
          }
        ]
      })
      const nativeSignature = createHash('sha256').update(JSON.stringify(facts.map(fact => [fact.id, fact.title, fact.status, fact.attemptId, fact.reviewId, fact.scope, fact.failure])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex')
      const version = order.version(key, snapshot.revision, currentRead, nativeSignature)
      source.observe(key, {
        key,
        currentRead,
        readOwner: version.owner,
        readEpoch: version.epoch,
        readSignature: version.readSignature,
        rebaseFrom: version.rebaseFrom,
        rebaseTo: version.rebaseTo,
        nativeRevision: snapshot.revision,
        scope: { workspaceId: snapshot.workspaceId, runId: snapshot.runId },
        completed: team.activeRun.status === 'completed',
        now: Date.now(),
        facts
      })
    } catch {
      owner.reportHistoryGap()
    }
  }
  const stop = tasks.subscribeReadObservation
    ? tasks.subscribeReadObservation((value) => {
        const origin = order.accept(value.stamp)
        if (origin !== 'stale') observe(value.snapshot, origin === 'current')
      })
    : tasks.subscribe((snapshot) => observe(snapshot, false))
  let detached = false
  const detach = () => {
    if (!detached) {
      detached = true
      stop()
    }
  }
  return {
    source,
    close: () => {
      detach()
      return source.close()
    },
    dispose: () => {
      detach()
      source.stop()
    }
  }
}
