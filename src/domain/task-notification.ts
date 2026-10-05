import type { TaskStatus } from './task-pool'
import {
  NOTIFICATION_SOURCE_BATCH_LIMIT,
  notificationSafeText,
  validateNotificationDraft,
  type NotificationDraft,
  type NotificationScope
} from './notification'
import { nativeRevisionRegressed, validateNativeRebaseState, type NativeVersionEvidence, type NativeRebaseState } from './native-rebase'

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
export interface TaskNotificationInput extends NativeVersionEvidence {
  key: string
  completed: boolean
  now: number
  facts: NotificationTaskFact[]
  nativeRevision?: number
  scope?: NotificationScope
}
interface TaskNotificationRow extends Pick<NotificationTaskFact, 'status' | 'attemptId' | 'reviewId'> {
  recorded?: boolean
  priorData?: boolean
  scope?: NotificationScope
  title?: string
}
export interface TaskNotificationState extends NativeRebaseState {
  version: 1
  key: string
  rows: Record<string, TaskNotificationRow>
  nativeRevision?: number
}
const previousTaskLabel: Record<TaskStatus, string> = {
  queued: '排队',
  leased: '已领取',
  running: '执行中',
  review: '团队验收',
  done: '已完成',
  failed: '最终未完成',
  cancelled: '已取消'
}
export function readTaskNotificationState(value: unknown, key: string): TaskNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as TaskNotificationState
  if (
    !state ||
    state.version !== 1 ||
    state.key !== key ||
    !state.rows ||
    typeof state.rows !== 'object' ||
    Array.isArray(state.rows) ||
    Object.keys(state.rows).length > 5_000
  )
    throw Error('任务通知检查点格式异常')
  validateNativeRebaseState(state, 5000)
  if (state.nativeRevision !== undefined && (!Number.isSafeInteger(state.nativeRevision) || state.nativeRevision < 0))
    throw Error('任务通知原修订号无效')
  if (state.pendingRebase?.missing.some((id) => !state.rows[id])) throw Error('任务恢复进度无效')
  for (const [id, row] of Object.entries(state.rows)) {
    if (
      !id ||
      id.length > 300 ||
      !row ||
      !['queued', 'leased', 'running', 'review', 'done', 'failed', 'cancelled'].includes(row.status) ||
      (row.recorded !== undefined && typeof row.recorded !== 'boolean') ||
      (row.priorData !== undefined && typeof row.priorData !== 'boolean')
    )
      throw Error('任务通知检查点格式异常')
    validateNotificationDraft({
      key: 'decode-task',
      category: 'team',
      source: '任务',
      title: row.title ?? '原任务',
      tone: 'info',
      attention: 'notice',
      state: 'resolved',
      scope: row.scope ?? {},
      sourceRevision: 0,
      occurredAt: 0
    })
  }
  return state
}
export function reduceTaskNotifications(old: TaskNotificationState | undefined, input: TaskNotificationInput, baseline: boolean, revision: number) {
  if (old?.nativeRevision !== undefined && input.nativeRevision !== undefined && input.nativeRevision < old.nativeRevision && !input.currentRead)
    return { state: old, drafts: [] }
  const regression =
    old?.nativeRevision !== undefined &&
    input.nativeRevision !== undefined &&
    nativeRevisionRegressed({ ...old, revision: old.nativeRevision }, { ...input, revision: input.nativeRevision })
  const rebases = (old?.rebases ?? 0) + (regression ? 1 : 0),
    present = new Set(input.facts.map((fact) => fact.id))
  const pending = regression
    ? {
        from: Math.max(old!.nativeRevision!, input.rebaseFrom ?? 0),
        to: input.rebaseTo ?? input.nativeRevision!,
        missing: Object.keys(old!.rows).filter((id) => !present.has(id))
      }
    : old?.pendingRebase
      ? { ...old.pendingRebase, missing: [...old.pendingRebase.missing] }
      : undefined
  const state: TaskNotificationState = {
    version: 1,
    key: input.key,
    rows: { ...old?.rows },
    ...(input.nativeRevision !== undefined ? { nativeRevision: input.nativeRevision } : {}),
    ...(input.currentRead || old?.readOwner
      ? { readOwner: input.readOwner ?? old?.readOwner, readEpoch: input.readEpoch ?? old?.readEpoch ?? 0, rebases }
      : {})
  }
  const drafts: NotificationDraft[] = []
  if (pending)
    while (pending.missing.length && drafts.length < NOTIFICATION_SOURCE_BATCH_LIMIT - 1) {
      const id = pending.missing.shift()!,
        previous = state.rows[id]!
      if (previous.priorData) continue
      state.rows[id] = { ...previous, priorData: true }
      if (previous.recorded === false) continue
      drafts.push({
        key: `task:${id}`,
        eventId: `task:${id}:prior-data:${rebases}`,
        eventType: 'task.state',
        subjectState: 'prior-data',
        category: 'team',
        source: '组任务',
        title: '此任务提醒属于先前数据版本',
        detail: `源修订 ${pending.from} → ${pending.to}，本次当前范围的读取未包含这个任务。不能推断它已完成、取消、删除或重新投递。先前任务结果仍属于先前数据版本。`,
        scope: previous.scope ?? input.scope ?? {},
        tone: 'info',
        attention: 'notice',
        state: 'expired',
        timeBasis: 'observed',
        occurredAt: input.now,
        sourceRevision: revision,
        announce: false,
        renewAttention: false,
        respectCleared: true
      })
    }
  let complete = true
  for (const fact of input.facts) {
    const previous = state.rows[fact.id]
    const same =
      previous &&
      JSON.stringify([previous.status, previous.attemptId, previous.reviewId]) === JSON.stringify([fact.status, fact.attemptId, fact.reviewId]) &&
      !previous.priorData
    if (same) continue
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT - (pending ? 1 : 0)) {
      complete = false
      break
    }
    state.rows[fact.id] = {
      status: fact.status,
      ...(fact.attemptId ? { attemptId: fact.attemptId } : {}),
      ...(fact.reviewId ? { reviewId: fact.reviewId } : {}),
      scope: fact.scope,
      title: notificationSafeText(fact.title).slice(0, 120),
      recorded: previous?.recorded ?? false
    }
    const significant = ['done', 'failed', 'review', 'cancelled'].includes(fact.status)
    if (!significant && !previous) continue
    // Fresh installation is not a complete historical task audit. Reconstruct current review/failure silently; replay no stock success.
    if (!old && baseline && (fact.status === 'done' || fact.status === 'cancelled')) continue
    if (!significant && previous?.status !== 'failed' && previous?.status !== 'review' && !pending) continue
    state.rows[fact.id]!.recorded = true
    const terminal = fact.status === 'done' || fact.status === 'failed'
    drafts.push({
      key: `task:${fact.id}`,
      eventId: `task:${fact.id}:${fact.attemptId ?? 'none'}:${fact.reviewId ?? 'none'}:${fact.status}`,
      subjectState: fact.status,
      eventType: 'task.state',
      category: 'team',
      source: '组任务',
      title: pending
        ? `当前任务记录：${previousTaskLabel[fact.status]}`
        : fact.status === 'done'
          ? `任务已完成：${notificationSafeText(fact.title).slice(0, 100)}`
          : fact.status === 'failed'
            ? `任务最终未完成：${notificationSafeText(fact.title).slice(0, 90)}`
            : fact.status === 'review'
              ? `任务进入团队验收：${notificationSafeText(fact.title).slice(0, 90)}`
              : fact.status === 'cancelled'
                ? '该任务已取消'
                : '原任务已进入新的执行状态',
      detail:
        (pending
          ? `原数据修订 ${pending.from} → ${pending.to}。先前提醒阶段：${previous?.status ? previousTaskLabel[previous.status] : '无'}，属于先前数据版本；本次只是重新对齐通知，没有重做任务、领取或验收。\n`
          : '') +
        (fact.status === 'failed'
          ? `来源已给出任务最终未完成状态${fact.failure ? `：${notificationSafeText(fact.failure).slice(0, 800)}` : '。'}\n中间尝试失败不据此通知，不会自动重试。`
          : fact.status === 'review'
            ? '这是原团队的验收流程，不代表要求你人工批准。可查看验收标准和来源记录。'
            : fact.status === 'done'
              ? '原任务已给出完成结果，具体产物和证据请在来源查看。'
              : '原状态已变化，旧结果及其来源保留；不将取消或重试当成任务完成。'),
      scope: fact.scope,
      ...(fact.scope.runId
        ? { target: { kind: 'run' as const, runId: fact.scope.runId, ...(fact.scope.groupId ? { groupId: fact.scope.groupId } : {}) } }
        : {}),
      origin: { module: 'run' },
      tone: fact.status === 'failed' ? 'warning' : fact.status === 'done' ? 'success' : 'info',
      attention: terminal ? 'notice' : 'activity',
      state: fact.status === 'failed' ? 'active' : fact.status === 'review' ? 'active' : 'resolved',
      occurredAt: pending ? input.now : fact.at,
      ...(pending ? { timeBasis: 'observed' as const } : {}),
      sourceRevision: revision,
      announce: !pending && !previous?.priorData && !baseline && terminal && !input.completed,
      renewAttention: terminal && (!pending || fact.status === 'failed'),
      respectCleared: Boolean(pending && fact.status !== 'failed')
    })
  }
  // Old absent IDs are not cancelled merely because a query is scoped or data isn't hydrated yet.
  for (const [id, row] of Object.entries(old?.rows ?? {})) if (!state.rows[id]) state.rows[id] = row
  if (pending) {
    complete &&= pending.missing.length === 0
    drafts.push({
      key: `task-rebase:${input.key.slice(-64)}:${rebases}`,
      eventType: 'task.rebase',
      subjectState: complete ? 'observed' : 'pending',
      category: 'team',
      source: '组任务核对',
      title: '检测到较早的任务数据版本',
      detail: `原修订 ${pending.from} → ${pending.to}。${complete ? '已按原读取核对当前通知。' : '旧提醒仍在分批核对。'}先前任务结果不作为当前阶段证明；没有重放任务、租约或验收，也不声明业务恢复完成。`,
      scope: input.scope ?? {},
      target: input.scope?.runId ? { kind: 'run', runId: input.scope.runId } : undefined,
      origin: { module: 'run' },
      tone: 'warning',
      attention: 'notice',
      state: complete ? 'resolved' : 'active',
      occurredAt: input.now,
      timeBasis: 'observed',
      sourceRevision: revision,
      announce: false,
      renewAttention: Boolean(regression)
    })
    if (!complete) state.pendingRebase = pending
  }
  if (Object.keys(state.rows).length > 5000) throw Error('任务通知身份超出容量，不能截断重要历史')
  drafts.forEach(validateNotificationDraft)
  return { state, drafts, complete }
}
