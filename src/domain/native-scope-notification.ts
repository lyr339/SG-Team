import { readGroupTopologyState, type GroupTopologyState } from './group-topology-notification'
import { readMemoryIssueState, type MemoryIssueState } from './memory-issue-notification'
import { readTaskNotificationState, type TaskNotificationState } from './task-notification'
import { operatorMessageIds, readOperatorMessageState, type OperatorMessageState } from './team-message-notification'
import { NOTIFICATION_SOURCE_BATCH_LIMIT, type NotificationDraft, type NotificationScope } from './notification'
import { missingNativeScopeDraft, validNativeScope, type NativeScopeRef, type NativeScopeMissing, type NativeScopeSourcePrefix } from './native-scope-availability'

export type NativeScopeCheckpoint =
  | { kind: 'group'; state: GroupTopologyState }
  | { kind: 'memory'; state: MemoryIssueState }
  | { kind: 'task'; state: TaskNotificationState }
  | { kind: 'operator'; state: OperatorMessageState }

/** Existing decoders remain the authority; malformed/unknown checkpoints are never silently overwritten. */
export function readNativeScopeCheckpoint(data: unknown, key: string, prefix: NativeScopeSourcePrefix): NativeScopeCheckpoint | undefined {
  if (data === undefined) return undefined
  if (prefix === 'group-topology:') return { kind: 'group', state: readGroupTopologyState(data, key)! }
  if (prefix === 'memory-issues:') return { kind: 'memory', state: readMemoryIssueState(data, key)! }
  if (prefix === 'operator-messages:') return { kind: 'operator', state: readOperatorMessageState(data, key)! }
  return { kind: 'task', state: readTaskNotificationState(data, key)! }
}

/** Old row-bearing checkpoints can identify their scope, but never by guessing from the active page. */
export function nativeCheckpointScope(checkpoint: NativeScopeCheckpoint): NativeScopeRef | undefined {
  if (checkpoint.state.observedScope) return checkpoint.state.observedScope
  if (checkpoint.kind === 'group' || checkpoint.kind === 'operator') return undefined
  const scopes = Object.values(checkpoint.state.rows).map(row => row.scope)
  const first = scopes[0]
  if (!first?.workspaceId || !first.runId || scopes.some(scope => scope?.workspaceId !== first.workspaceId || scope.runId !== first.runId)) return undefined
  const value = { workspaceId: first.workspaceId, runId: first.runId }
  return validNativeScope(value) ? value : undefined
}

/** Private-only metadata repair. Keep original statuses, no workflow action, no inferred completion/cancellation. */
export function reduceMissingNativeScope(checkpoint: NativeScopeCheckpoint, scope: NativeScopeRef, initial: { episode: string; at: number }, revision: number) {
  const previous = checkpoint.state
  const ids = (checkpoint.kind === 'group' ? Object.keys(checkpoint.state.groups) : checkpoint.kind === 'operator' ? [...operatorMessageIds(checkpoint.state)] : Object.keys(checkpoint.state.rows)).sort()
  const missing: NativeScopeMissing = previous.scopeMissing
    ? { ...previous.scopeMissing }
    : { ...initial, rowsClosed: false, summaryClosed: false }
  if (missing.after !== undefined && !ids.includes(missing.after)) throw Error('原范围核对进度指向未知身份')
  const remaining = missing.rowsClosed ? [] : ids.filter(id => missing.after === undefined || id > missing.after)
  const drafts: NotificationDraft[] = []
  const state = { ...previous, observedScope: { ...scope }, scopeMissing: missing }
  const make = (key: string, eventType: string, title: string, activity: boolean, recordScope: NotificationScope = scope) =>
    missingNativeScopeDraft({ key, eventType, title, activity, scope: recordScope, episode: missing.episode, at: missing.at, revision })
  if (checkpoint.kind === 'group') {
    const prior = new Set(checkpoint.state.priorData)
    while (remaining.length && drafts.length < NOTIFICATION_SOURCE_BATCH_LIMIT) {
      const id = remaining.shift()!, row = checkpoint.state.groups[id]!
      missing.after = id
      prior.add(id)
      drafts.push(make(`group-topology:${row.identity}`, 'group.topology', '此组关系的原运行范围未确认', true, { ...scope, groupId: id }))
    }
    Object.assign(state, { priorData: [...prior] })
  } else if (checkpoint.kind === 'memory') {
    const rows = { ...checkpoint.state.rows }
    while (remaining.length && drafts.length < NOTIFICATION_SOURCE_BATCH_LIMIT) {
      const id = remaining.shift()!, row = rows[id]!, { operatorReview: _obsolete, ...rest } = row
      missing.after = id
      rows[id] = { ...rest, priorData: true, ceased: true,
        ...(['operator-review', 'operator-unconfirmed'].includes(row.state ?? '') ? { state: 'unconfirmed' as const } : {}) }
      if (row.recorded) drafts.push(make(`memory-issue:${row.identity}`, 'memory.issue', '这项记忆提醒的原运行范围未确认', false,
        { ...row.scope, memoryId: row.id, memoryVersion: String(row.version) }))
    }
    Object.assign(state, { rows })
  } else if (checkpoint.kind === 'operator') {
    while (remaining.length && drafts.length < NOTIFICATION_SOURCE_BATCH_LIMIT) {
      const id = remaining.shift()!; missing.after = id
      drafts.push(make(`operator-message:${id}`, 'team.operator-message', '此协作消息的原运行范围未确认', false))
    }
    delete (state as OperatorMessageState).pendingMessages
  } else {
    const rows = { ...checkpoint.state.rows }
    while (remaining.length && drafts.length < NOTIFICATION_SOURCE_BATCH_LIMIT) {
      const id = remaining.shift()!, row = rows[id]!
      missing.after = id
      rows[id] = { ...row, priorData: true }
      if (row.recorded !== false) drafts.push(make(`task:${id}`, 'task.state', '此任务提醒的原运行范围未确认', false, row.scope ?? scope))
    }
    Object.assign(state, { rows })
  }
  missing.rowsClosed = !remaining.length
  if (missing.rowsClosed && !missing.summaryClosed && drafts.length < NOTIFICATION_SOURCE_BATCH_LIMIT) {
    if (previous.rebases && checkpoint.kind !== 'operator') drafts.push(make(`${checkpoint.kind}-rebase:${previous.key.slice(-64)}:${previous.rebases}`, `${checkpoint.kind}.rebase`, '先前数据核对的原运行范围未确认', false))
    missing.summaryClosed = true
    delete state.pendingRebase
  }
  // Verify the newly assembled state before any write; source-specific capacities/receipts stay intact.
  readNativeScopeCheckpoint(state, previous.key, checkpoint.kind === 'group' ? 'group-topology:' : checkpoint.kind === 'memory' ? 'memory-issues:' : checkpoint.kind === 'operator' ? 'operator-messages:' : 'task-notifications:')
  return { state, drafts, complete: missing.rowsClosed && missing.summaryClosed }
}
