import {
  NOTIFICATION_SOURCE_BATCH_LIMIT,
  validateNotificationDraft,
  type NotificationDraft,
  type NotificationScope
} from './notification'
import type { memoryRevisionIssue } from './team-memory-inspection'
import { validateMemoryOperatorProof, type MemoryOperatorReviewProof } from './memory-operator-review'
import {
  nativeRevisionRegressed,
  validateNativeRebaseState,
  type NativeVersionEvidence,
  type NativeRebaseState
} from './native-rebase'
export interface MemoryIssueFact {
  identity: string
  id: string
  version: number
  title: string
  state: ReturnType<typeof memoryRevisionIssue> | 'operator-review' | 'operator-unconfirmed'
  operatorReview?: MemoryOperatorReviewProof
  scope: NotificationScope
  ceased: boolean
}
export interface MemoryIssueInput extends NativeVersionEvidence {
  scope?: NotificationScope
  key: string
  revision: number
  now: number
  facts: MemoryIssueFact[]
}
interface MemoryIssueRow extends MemoryIssueFact {
  priorData?: boolean
  requestEpoch?: number
  recorded: boolean
}
export interface MemoryIssueState extends NativeRebaseState {
  version: 1
  key: string
  revision: number
  rows: Record<string, MemoryIssueRow>
}
const previousMemoryLabel: Record<NonNullable<MemoryIssueFact['state']>, string> = {
  conflict: '前置冲突',
  eligible: '等待原流程审核',
  unconfirmed: '状态未确认',
  proposed: '待审查',
  accepted: '已采纳',
  rejected: '已驳回',
  superseded: '已被取代',
  'operator-review': '等待用户审核',
  'operator-unconfirmed': '原人工请求待核对'
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
    typeof state.rows !== 'object' ||
    Array.isArray(state.rows) ||
    Object.keys(state.rows).length > 4096
  )
    throw Error('记忆事项通知检查点无效')
  validateNativeRebaseState(state, 4096)
  if (state.pendingRebase?.missing.some((id) => !state.rows[id])) throw Error('记忆恢复进度指向不存在的身份')
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
      (row.priorData !== undefined && typeof row.priorData !== 'boolean') ||
      (row.requestEpoch !== undefined && (!Number.isSafeInteger(row.requestEpoch) || row.requestEpoch < 0)) ||
      (row.state !== undefined &&
        ![
          'conflict',
          'eligible',
          'unconfirmed',
          'proposed',
          'accepted',
          'rejected',
          'superseded',
          'operator-review',
          'operator-unconfirmed'
        ].includes(row.state))
    )
      throw Error('记忆通知事实无效')
    if (row.operatorReview !== undefined) validateMemoryOperatorProof(row.operatorReview)
    if (['operator-review', 'operator-unconfirmed'].includes(row.state ?? '') && !row.operatorReview)
      throw Error('人工审核事项缺少原请求证据')
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
    if (state.observedScope && (row.scope.workspaceId !== state.observedScope.workspaceId || row.scope.runId !== state.observedScope.runId)) throw Error('记忆范围与原来源身份不一致')
  }
  return state
}
export function reduceMemoryIssueNotifications(
  previous: MemoryIssueState | undefined,
  input: MemoryIssueInput,
  baseline: boolean,
  revision: number
) {
  if (previous?.scopeMissing && !input.currentRead) return { state: previous, drafts: [] }
  if (previous && input.revision < previous.revision && !input.currentRead)
    return { state: previous, drafts: [] }
  const rows = { ...previous?.rows },
    drafts: NotificationDraft[] = []
  const regression = nativeRevisionRegressed(previous, input), returned = Boolean(previous?.scopeMissing && input.currentRead),
    rebases = (previous?.rebases ?? 0) + (regression || returned ? 1 : 0)
  const present = new Set(input.facts.map((fact) => fact.identity))
  const pending = regression || returned
    ? {
        ...(returned ? { origin: 'scope-returned' as const } : {}),
        from: Math.max(previous!.revision, input.rebaseFrom ?? 0),
        to: input.rebaseTo ?? input.revision,
        missing: Object.keys(rows).filter((id) => !present.has(id))
      }
    : previous?.pendingRebase
      ? {
          ...previous.pendingRebase,
          missing: [...previous.pendingRebase.missing]
        }
      : undefined
  if (returned) for (const id of pending?.missing ?? []) rows[id] = { ...rows[id]!, priorData: false }
  if (pending) {
    while (pending.missing.length && drafts.length < NOTIFICATION_SOURCE_BATCH_LIMIT - 1) {
      const id = pending.missing.shift()!,
        old = rows[id]!
      if (old.priorData) continue
      rows[id] = { ...old, priorData: true, ceased: true }
      const key = `memory-issue:${old.identity}`
      drafts.push({
        key,
        eventType: 'memory.issue',
        eventId: `${key}:prior-data:${rebases}`,
        subjectState: 'prior-data',
        category: 'team',
        source: '共享记忆',
        title: '这项提醒属于先前数据版本',
        detail: `此前修订 ${pending.from} 保存了这项提醒。本次修订 ${pending.to} 的完整读取没有这项修订事项；不推断已采纳、驳回、删除或清理。`,
        scope: {
          ...old.scope,
          memoryId: old.id,
          memoryVersion: String(old.version)
        },
        tone: 'info',
        attention: 'notice',
        state: 'expired',
        occurredAt: input.now,
        timeBasis: 'observed',
        sourceRevision: revision,
        announce: false,
        renewAttention: false,
        respectCleared: true
      })
    }
  }
  let complete = true
  for (const original of input.facts) {
    const old = rows[original.identity]
    const mutable = !['accepted', 'rejected', 'superseded'].includes(original.state ?? '') && !original.ceased
    const operatorReview = original.operatorReview ?? old?.operatorReview
    const newOperatorRequest = Boolean(
      original.operatorReview && original.operatorReview.messageId !== old?.operatorReview?.messageId
    )
    const requestEpoch = (old?.requestEpoch ?? 0) + (newOperatorRequest ? 1 : 0)
    const effective =
      mutable && original.state !== 'conflict' && (original.operatorReview || old?.operatorReview)
        ? original.operatorReview
          ? ('operator-review' as const)
          : ('operator-unconfirmed' as const)
        : original.state
    const fact = {
      ...original,
      state: effective,
      ...(operatorReview ? { operatorReview } : {})
    }
    if (!old && fact.state !== 'conflict' && fact.state !== 'operator-review') continue
    const next = { ...fact, recorded: true, ...(operatorReview ? { requestEpoch } : {}) }
    if (JSON.stringify(old) === JSON.stringify(next)) continue
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT - (pending ? 1 : 0)) {
      complete = false
      break
    }
    rows[fact.identity] = next
    const active =
        !fact.ceased &&
        ['conflict', 'unconfirmed', 'operator-review', 'operator-unconfirmed'].includes(fact.state ?? ''),
      resolved = !fact.ceased && !active
    const state = fact.ceased ? 'expired' : (fact.state ?? 'unconfirmed'),
      key = `memory-issue:${fact.identity}`
    const title = fact.ceased
      ? '这项记忆提醒的运行范围已结束'
      : state === 'operator-review'
        ? '有一项共享记忆需要你审核'
        : state === 'operator-unconfirmed'
          ? '原人工审核请求待核对'
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
                    : '这项修订在当前读取中仍待审查'
    drafts.push({
      key,
      eventId: `${key}:${state}${state === 'operator-review' ? `:${requestEpoch}` : ''}${rebases ? `:data:${rebases}` : ''}`,
      eventType: 'memory.issue',
      subjectState: state,
      category: 'team',
      source: '共享记忆',
      title,
      detail:
        (pending
          ? `${pending.origin === 'scope-returned' ? '原范围重新出现在本次原读取中；不声明备份恢复成功。' : `源数据修订 ${pending.from} → ${pending.to}。`}先前提醒状态：${old?.state ? previousMemoryLabel[old.state] : '无'}${old?.ceased ? '（旧提醒范围已失效）' : ''}，只属于先前数据版本。本次只是重新读取对齐，未回放或重做审核。\n`
          : '') +
        `${fact.title}\n` +
        (fact.ceased
          ? '原提案状态没有被通知改写。结束提醒不等于提案已采纳、驳回或清理。'
          : state === 'operator-review'
            ? `原流程${fact.operatorReview?.reason === 'timeout' ? '在本次观察中确认审核已超过等待时限' : '在本次观察中未找到独立且有权限的审核成员'}，已留下发给用户的原请求。你可以先查看提案与引用，再明确选择采纳或驳回；通知不会代为审核。`
            : state === 'operator-unconfirmed'
              ? '先前有原流程发给用户的审核请求；当前读取没有重新确认该请求，提案本身仍未采纳。通知保持待核对，不自动重提或推测已经处理。'
              : state === 'conflict'
                ? '这项提案要取代的前置记忆已不再满足原审核条件。它本身仍待审查；不能把调度请求或冲突当作已采纳。'
                : state === 'unconfirmed'
                  ? '当前快照没有确认前置条目，不能把缺失推断为冲突已解决。'
                  : state === 'eligible'
                    ? '当前前置条件允许原流程继续审查，提案本身仍未被采纳。通知没有代为审核或重提。'
                    : '这里只陈述原条目已确认的状态；通知没有代为审核，也没有写入新的记忆。'),
      scope: {
        ...fact.scope,
        memoryId: fact.id,
        memoryVersion: String(fact.version),
        ...(state === 'operator-review' && fact.operatorReview
          ? { operatorRequestId: fact.operatorReview.messageId }
          : {})
      },
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
      announce:
        !pending &&
        !baseline &&
        ((state === 'conflict' && !old) ||
          (state === 'operator-review' && fact.operatorReview?.live && newOperatorRequest) ||
          (resolved &&
            ['conflict', 'unconfirmed', 'operator-review', 'operator-unconfirmed'].includes(
              old?.state ?? ''
            ))),
      renewAttention:
        (state === 'conflict' && (!old?.recorded || Boolean(pending && old?.state !== 'conflict'))) ||
        (state === 'operator-review' && newOperatorRequest) ||
        (!pending &&
          resolved &&
          ['conflict', 'unconfirmed', 'operator-review', 'operator-unconfirmed'].includes(old?.state ?? '')),
      respectCleared: !pending || !active
    })
  }
  if (Object.keys(rows).length > 4096) throw Error('记忆事项身份超出通知容量')
  if (pending) {
    complete &&= pending.missing.length === 0
    drafts.push({
      key: `memory-rebase:${input.key.slice(-64)}:${rebases}`,
      eventType: 'memory.rebase',
      subjectState: complete ? 'observed' : 'pending',
      category: 'team',
      source: '共享记忆核对',
      title: pending.origin === 'scope-returned' ? '原记忆范围已在当前读取中重新确认' : pending.from === pending.to ? '相同修订号下的记忆数据已变化' : '检测到较早的记忆数据版本',
      detail: `${pending.origin === 'scope-returned' ? '原范围重新出现在本次原读取中；不声明备份恢复成功。' : `源修订 ${pending.from} → ${pending.to}。`}${complete ? '已按本次原读取重新投影提醒。' : '旧事项正在分批核对。'}先前已发生的确认结果只属于先前数据版本；没有重放提案、审核、队列或 Agent 回执，也不声明业务恢复完成。`,
      scope:
        input.scope ??
        input.facts[0]?.scope ??
        (previous ? Object.values(previous.rows)[0]?.scope : undefined) ??
        {},
      target: input.scope?.runId ? { kind: 'run', runId: input.scope.runId } : undefined,
      tone: 'warning',
      attention: 'notice',
      state: complete ? 'resolved' : 'active',
      occurredAt: input.now,
      timeBasis: 'observed',
      sourceRevision: revision,
      announce: false,
      renewAttention: regression
    })
  }
  drafts.forEach(validateNotificationDraft)
  return {
    state: {
      version: 1 as const,
      key: input.key,
      ...(input.scope?.workspaceId && input.scope.runId ? { observedScope: { workspaceId: input.scope.workspaceId, runId: input.scope.runId } }
        : previous?.observedScope ? { observedScope: previous.observedScope } : {}),
      ...(!input.currentRead && previous?.scopeMissing ? { scopeMissing: previous.scopeMissing } : {}),
      revision: input.revision,
      rows,
      rebases,
      readOwner: input.readOwner ?? previous?.readOwner,
      readEpoch: input.readEpoch ?? previous?.readEpoch ?? 0,
      ...(input.readSignature !== undefined ? { readSignature: input.readSignature } : previous?.readSignature ? { readSignature: previous.readSignature } : {}),
      ...(!complete && pending ? { pendingRebase: pending } : {})
    },
    drafts,
    complete
  }
}
