import { NOTIFICATION_SOURCE_BATCH_LIMIT, validateNotificationDraft, type NotificationDraft, type NotificationScope } from './notification'
import type { memoryRevisionIssue } from './team-memory-inspection'
import { nativeRevisionRegressed, validateNativeRebaseState, type NativeVersionEvidence, type NativeRebaseState } from './native-rebase'
export interface MemoryIssueFact {
  identity: string
  id: string
  version: number
  title: string
  state: ReturnType<typeof memoryRevisionIssue>
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
  superseded: '已被取代'
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
  if (previous && input.revision < previous.revision && !input.currentRead) return { state: previous, drafts: [] }
  const rows = { ...previous?.rows },
    drafts: NotificationDraft[] = []
  const regression = nativeRevisionRegressed(previous, input),
    rebases = (previous?.rebases ?? 0) + (regression ? 1 : 0)
  const present = new Set(input.facts.map((fact) => fact.identity))
  const pending = regression
    ? {
        from: Math.max(previous!.revision, input.rebaseFrom ?? 0),
        to: input.rebaseTo ?? input.revision,
        missing: Object.keys(rows).filter((id) => !present.has(id))
      }
    : previous?.pendingRebase
      ? { ...previous.pendingRebase, missing: [...previous.pendingRebase.missing] }
      : undefined
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
        detail: `此前修订 ${pending.from} 保存了这项提醒。本次较早修订 ${pending.to} 的完整读取没有这项修订事项；不推断已采纳、驳回、删除或清理。`,
        scope: { ...old.scope, memoryId: old.id, memoryVersion: String(old.version) },
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
  for (const fact of input.facts) {
    const old = rows[fact.identity]
    if (!old && fact.state !== 'conflict') continue
    const next = { ...fact, recorded: true }
    if (JSON.stringify(old) === JSON.stringify(next)) continue
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT - (pending ? 1 : 0)) {
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
                : '这项修订在当前读取中仍待审查'
    drafts.push({
      key,
      eventId: `${key}:${state}`,
      eventType: 'memory.issue',
      subjectState: state,
      category: 'team',
      source: '共享记忆',
      title,
      detail:
        (pending
          ? `源数据修订 ${pending.from} → ${pending.to}。先前提醒状态：${old?.state ? previousMemoryLabel[old.state] : '无'}${old?.ceased ? '（原范围已结束）' : ''}，只属于先前数据版本。本次只是重新读取对齐，未回放或重做审核。\n`
          : '') +
        `${fact.title}\n` +
        (fact.ceased
          ? '原提案状态没有被通知改写。结束提醒不等于提案已采纳、驳回或清理。'
          : state === 'conflict'
            ? '这项提案要取代的前置记忆已不再满足原审核条件。它本身仍待审查；不能把调度请求或冲突当作已采纳。'
            : state === 'unconfirmed'
              ? '当前快照没有确认前置条目，不能把缺失推断为冲突已解决。'
              : state === 'eligible'
                ? '当前前置条件允许原流程继续审查，提案本身仍未被采纳。通知没有代为审核或重提。'
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
      announce: !pending && !baseline && ((state === 'conflict' && !old) || (resolved && ['conflict', 'unconfirmed'].includes(old?.state ?? ''))),
      renewAttention:
        (state === 'conflict' && (!old?.recorded || Boolean(pending && old?.state !== 'conflict'))) ||
        (!pending && resolved && ['conflict', 'unconfirmed'].includes(old?.state ?? '')),
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
      title: '检测到较早的记忆数据版本',
      detail: `源修订 ${pending.from} → ${pending.to}。${complete ? '已按本次原读取重新投影提醒。' : '旧事项正在分批核对。'}先前已发生的确认结果只属于先前数据版本；没有重放提案、审核、队列或 Agent 回执，也不声明业务恢复完成。`,
      scope: input.scope ?? input.facts[0]?.scope ?? (previous ? Object.values(previous.rows)[0]?.scope : undefined) ?? {},
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
      revision: input.revision,
      rows,
      rebases,
      readOwner: input.readOwner ?? previous?.readOwner,
      readEpoch: input.readEpoch ?? previous?.readEpoch ?? 0,
      ...(!complete && pending ? { pendingRebase: pending } : {})
    },
    drafts,
    complete
  }
}
