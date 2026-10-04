import type { TaskStatus } from './task-pool'
import { NOTIFICATION_SOURCE_BATCH_LIMIT, notificationSafeText, type NotificationDraft, type NotificationScope } from './notification'

export interface NotificationTaskFact {
  id: string
  title: string
  status: TaskStatus
  attemptId?: string
  reviewId?: string
  scope: NotificationScope
  at: number
  failure?: string
}
export interface TaskNotificationInput { key: string; completed: boolean; now: number; facts: NotificationTaskFact[] }
export interface TaskNotificationState { version: 1; key: string; rows: Record<string, Pick<NotificationTaskFact, 'status' | 'attemptId' | 'reviewId'>> }
export function readTaskNotificationState(value: unknown, key: string): TaskNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as TaskNotificationState
  if (!state || state.version !== 1 || state.key !== key || !state.rows || Array.isArray(state.rows) || Object.keys(state.rows).length > 5_000) throw Error('任务通知检查点格式异常')
  for (const row of Object.values(state.rows)) if (!row || !['queued', 'leased', 'running', 'review', 'done', 'failed', 'cancelled'].includes(row.status)) throw Error('任务通知检查点格式异常')
  return state
}
export function reduceTaskNotifications(old: TaskNotificationState | undefined, input: TaskNotificationInput, baseline: boolean, revision: number) {
  const state: TaskNotificationState = { version: 1, key: input.key, rows: {} }; const drafts: NotificationDraft[] = []
  let complete = true
  for (const fact of input.facts) {
    const previous = old?.rows[fact.id]
    state.rows[fact.id] = { status: fact.status, ...(fact.attemptId ? { attemptId: fact.attemptId } : {}), ...(fact.reviewId ? { reviewId: fact.reviewId } : {}) }
    if (previous && JSON.stringify(previous) === JSON.stringify(state.rows[fact.id])) continue
    const significant = ['done', 'failed', 'review', 'cancelled'].includes(fact.status)
    if (!significant && !previous) continue
    // Fresh installation is not a complete historical task audit. Reconstruct current review/failure silently; replay no stock success.
    if (!old && baseline && (fact.status === 'done' || fact.status === 'cancelled')) continue
    if (!significant && previous?.status !== 'failed' && previous?.status !== 'review') continue
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) { complete = false; if (previous) state.rows[fact.id] = previous; else delete state.rows[fact.id]; break }
    const terminal = fact.status === 'done' || fact.status === 'failed'
    drafts.push({ key: `task:${fact.id}`, eventId: `task:${fact.id}:${fact.attemptId ?? 'none'}:${fact.reviewId ?? 'none'}:${fact.status}`, subjectState: fact.status, eventType: 'task.state',
      category: 'team', source: '组任务', title: fact.status === 'done' ? `任务已完成：${notificationSafeText(fact.title).slice(0, 100)}`
        : fact.status === 'failed' ? `任务最终未完成：${notificationSafeText(fact.title).slice(0, 90)}`
          : fact.status === 'review' ? `任务进入团队验收：${notificationSafeText(fact.title).slice(0, 90)}`
            : fact.status === 'cancelled' ? '该任务已取消' : '原任务已进入新的执行状态',
      detail: fact.status === 'failed' ? `来源已给出任务最终未完成状态${fact.failure ? `：${notificationSafeText(fact.failure).slice(0, 800)}` : '。'}\n中间尝试失败不据此通知，不会自动重试。`
        : fact.status === 'review' ? '这是原团队的验收流程，不代表要求你人工批准。可查看验收标准和来源记录。'
          : fact.status === 'done' ? '原任务已给出完成结果，具体产物和证据请在来源查看。' : '原状态已变化，旧结果及其来源保留；不将取消或重试当成任务完成。',
      scope: fact.scope, ...(fact.scope.runId ? { target: { kind: 'run' as const, runId: fact.scope.runId, ...(fact.scope.groupId ? { groupId: fact.scope.groupId } : {}) } } : {}),
      origin: { module: 'run' }, tone: fact.status === 'failed' ? 'warning' : fact.status === 'done' ? 'success' : 'info',
      attention: terminal ? 'notice' : 'activity', state: fact.status === 'failed' ? 'active' : fact.status === 'review' ? 'active' : 'resolved',
      occurredAt: fact.at, sourceRevision: revision, announce: !baseline && terminal && !input.completed, renewAttention: terminal })
  }
  // Old absent IDs are not cancelled merely because a query is scoped or data isn't hydrated yet.
  for (const [id, row] of Object.entries(old?.rows ?? {})) if (!state.rows[id]) state.rows[id] = row
  return { state, drafts, complete }
}
