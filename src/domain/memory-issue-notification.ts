import { NOTIFICATION_SOURCE_BATCH_LIMIT, validateNotificationDraft, type NotificationDraft, type NotificationScope } from './notification'
import type { memoryRevisionIssue } from './team-memory-inspection'
export interface MemoryIssueFact {
  identity: string
  id: string
  version: number
  title: string
  state: ReturnType<typeof memoryRevisionIssue>
  scope: NotificationScope
  ceased: boolean
}
export interface MemoryIssueInput {
  key: string
  revision: number
  now: number
  facts: MemoryIssueFact[]
}
interface MemoryIssueRow extends MemoryIssueFact {
  recorded: boolean
}
export interface MemoryIssueState {
  version: 1
  key: string
  revision: number
  rows: Record<string, MemoryIssueRow>
}
export function readMemoryIssueState(value: unknown, key: string): MemoryIssueState | undefined {
  if (value === undefined) return undefined
  const state = value as MemoryIssueState
  if (
    !state ||
    state.version !== 1 ||
    state.key !== key ||
    !Number.isSafeInteger(state.revision) ||
    !state.rows ||
    typeof state.rows!=='object' ||
    Array.isArray(state.rows) ||
    Object.keys(state.rows).length > 4096
  )
    throw Error('记忆事项通知检查点无效')
  for (const [id, row] of Object.entries(state.rows)) {
    if (
      !row ||
      row.identity !== id ||
      !/^[a-f0-9]{64}$/.test(id) ||
      typeof row.id !== 'string' ||
      !row.id ||
      row.id.length > 300 ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      typeof row.recorded !== 'boolean' ||
      typeof row.ceased !== 'boolean' ||
      (row.state !== undefined && !['conflict', 'eligible', 'unconfirmed', 'proposed', 'accepted', 'rejected', 'superseded'].includes(row.state))
    )
      throw Error('记忆通知事实无效')
    validateNotificationDraft({
      key: 'memory-decode',
      category: 'team',
      source: '共享记忆',
      title: row.title || '原事项',
      tone: 'info',
      attention: 'notice',
      state: 'resolved',
      scope: row.scope,
      occurredAt: 0,
      sourceRevision: 0
    })
  }
  return state
}
export function reduceMemoryIssueNotifications(previous: MemoryIssueState | undefined, input: MemoryIssueInput, baseline: boolean, revision: number) {
  if (previous && input.revision < previous.revision) return { state: previous, drafts: [] }
  const rows = { ...previous?.rows },
    drafts: NotificationDraft[] = []
  let complete = true
  for (const fact of input.facts) {
    const old = rows[fact.identity]
    if (!old && fact.state !== 'conflict') continue
    const next = { ...fact, recorded: true }
    if (JSON.stringify(old) === JSON.stringify(next)) continue
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) {
      complete = false
      break
    }
    rows[fact.identity] = next
    const active = !fact.ceased && ['conflict', 'unconfirmed'].includes(fact.state ?? ''),
      resolved = !fact.ceased && !active
    const state = fact.ceased ? 'expired' : (fact.state ?? 'unconfirmed'),
      key = `memory-issue:${fact.identity}`
    const title = fact.ceased
      ? '这项记忆提醒的运行范围已结束'
      : state === 'conflict'
        ? '共享记忆修订需要重新核对'
        : state === 'unconfirmed'
          ? '原记忆前置状态待核对'
          : state === 'accepted'
            ? '原记录确认这项记忆已采纳'
            : state === 'rejected'
              ? '原记录确认这项记忆已驳回'
              : state === 'superseded'
                ? '这项记忆已被后续条目取代'
                : '原记忆修订前置条件已更新'
    drafts.push({
      key,
      eventId: `${key}:${state}`,
      eventType: 'memory.issue',
      subjectState: state,
      category: 'team',
      source: '共享记忆',
      title,
      detail:
        `${fact.title}\n` +
        (fact.ceased
          ? '原提案状态没有被通知改写。结束提醒不等于提案已采纳、驳回或清理。'
          : state === 'conflict'
            ? '这项提案要取代的前置记忆已不再满足原审核条件。它本身仍待审查；不能把调度请求或冲突当作已采纳。'
            : state === 'unconfirmed'
              ? '当前快照没有确认前置条目，不能把缺失推断为冲突已解决。'
              : '这里只陈述原条目已确认的状态；通知没有代为审核，也没有写入新的记忆。'),
      scope: { ...fact.scope, memoryId: fact.id, memoryVersion: String(fact.version) },
      target:
        fact.scope.workspaceId && fact.scope.runId
          ? {
              kind: 'memory',
              workspaceId: fact.scope.workspaceId,
              runId: fact.scope.runId,
              memoryId: fact.id,
              version: fact.version,
              ...(fact.scope.groupId ? { groupId: fact.scope.groupId } : {})
            }
          : undefined,
      origin: { module: 'run' },
      tone: active ? 'warning' : 'info',
      attention: active ? 'action' : 'notice',
      state: fact.ceased ? 'expired' : resolved ? 'resolved' : 'active',
      occurredAt: input.now,
      timeBasis: 'observed',
      sourceRevision: revision,
      announce: !baseline && ((state === 'conflict' && !old) || (resolved && ['conflict', 'unconfirmed'].includes(old?.state ?? ''))),
      renewAttention: (state === 'conflict' && !old?.recorded) || (resolved && ['conflict', 'unconfirmed'].includes(old?.state ?? '')),
      respectCleared: true
    })
  }
  if (Object.keys(rows).length > 4096) throw Error('记忆事项身份超出通知容量')
  drafts.forEach(validateNotificationDraft)
  return { state: { version: 1 as const, key: input.key, revision: input.revision, rows }, drafts, complete }
}
