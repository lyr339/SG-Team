import type { NotificationDraft, NotificationScope, NotificationAttention } from './notification'
import { NOTIFICATION_SOURCE_BATCH_LIMIT, notificationSafeText, validateNotificationDraft } from './notification'
import { nativeRevisionRegressed, validateNativeRebaseState, type NativeVersionEvidence, type NativeRebaseState } from './native-rebase'
export interface NotificationOperatorMessageFact {
  id: string
  kind: 'directive' | 'question' | 'response' | 'status' | 'notice'
  at: number
  subject?: string
  sender: string
  scope: NotificationScope
  digest?: string
}
export interface OperatorMessageInput extends NativeVersionEvidence {
  key: string; facts: NotificationOperatorMessageFact[]; now: number; scope?: NotificationScope; nativeRevision?: number; signature?: string
  /** Only a confirmed previous private projection can authorize a smaller changed-ID batch. */
  previousSignature?: string; changedIds?: ReadonlySet<string>; activation?: number
}
interface MessageReadProgress {
  signature: string; missingAfter?: string; presentAfter?: string; missingClosed: boolean; presentClosed: boolean; changesOnly: boolean
  previousSignature?: string; quiet: boolean; reason?: 'native-rebase' | 'scope-returned'; from?: number; to?: number
}
export interface OperatorMessageState extends NativeRebaseState {
  version: 1 | 2; key: string; seen: string[]; seenEncoding?: 'team-message-uuid'; nativeRevision?: number; factsSignature?: string; pendingMessages?: MessageReadProgress; readActivation?: number
}
/** Exact private record metadata only, including archived records, never a business body or an Agent receipt. */
export interface OperatorMessageRecordMetadata {
  key: string; scope: NotificationScope; attention: NotificationAttention; source: string; subjectState?: string; sourceRevision: number
}
const idValid = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 280
const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
/** Lossless common-prefix encoding, not ID eviction or a body compression format. Arbitrary legacy IDs stay verbatim. */
export function operatorMessageIds(state: Pick<OperatorMessageState, 'seen' | 'seenEncoding'>): string[] {
  return state.seenEncoding ? state.seen.map(id => `team-message:${id}`) : state.seen
}
function savedIdentities(seen: Set<string>): Pick<OperatorMessageState, 'seen' | 'seenEncoding'> {
  const ids = [...seen]
  return ids.length && ids.every(id => id.startsWith('team-message:') && uuid.test(id.slice(13)))
    ? { seen: ids.map(id => id.slice(13)), seenEncoding: 'team-message-uuid' } : { seen: ids }
}
export function readOperatorMessageState(value: unknown, key: string): OperatorMessageState | undefined {
  if (value === undefined) return undefined
  const state = value as OperatorMessageState
  if (!state || ![1, 2].includes(state.version) || state.key !== key || !Array.isArray(state.seen) || state.seen.length > 50_000
    || Array.from(state.seen).some(value => !idValid(value)) || new Set(state.seen).size !== state.seen.length) throw Error('操作员消息通知检查点异常')
  if (state.seenEncoding !== undefined && (state.version !== 2 || state.seenEncoding !== 'team-message-uuid' || state.seen.some(id => !uuid.test(id))))
    throw Error('操作员消息身份编码异常')
  validateNativeRebaseState(state, 0)
  if (state.nativeRevision !== undefined && (!Number.isSafeInteger(state.nativeRevision) || state.nativeRevision < 0)
    || state.readActivation !== undefined && (!Number.isSafeInteger(state.readActivation) || state.readActivation < 0)
    || state.factsSignature !== undefined && !fingerprint(state.factsSignature)) throw Error('操作员消息原读取版本无效')
  const progress = state.pendingMessages
  if (progress !== undefined && (!progress || typeof progress !== 'object' || Array.isArray(progress) || !fingerprint(progress.signature) || typeof progress.missingClosed !== 'boolean' || typeof progress.presentClosed !== 'boolean'
    || typeof progress.quiet !== 'boolean' || typeof progress.changesOnly !== 'boolean' || progress.changesOnly && !fingerprint(progress.previousSignature)
    || [progress.missingAfter, progress.presentAfter].some(value => value !== undefined && !idValid(value))
    || progress.reason !== undefined && !['native-rebase', 'scope-returned'].includes(progress.reason)
    || [progress.from, progress.to].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0)))) throw Error('操作员消息分批核对进度异常')
  if (progress && (progress.signature !== state.factsSignature || progress.presentClosed ||
    [progress.missingAfter, progress.presentAfter].some(id => id !== undefined && !operatorMessageIds(state).includes(id)))) throw Error('操作员消息核对游标无法从原身份验证')
  return state
}
const batches = new WeakMap<NotificationOperatorMessageFact[], { ordered: NotificationOperatorMessageFact[]; ids: Set<string>; scopeToken: string }>()
function factsOf(input: OperatorMessageInput) {
  const scopeToken = JSON.stringify([input.currentRead === true, input.scope?.workspaceId, input.scope?.runId])
  let cached = batches.get(input.facts)
  if (cached?.scopeToken === scopeToken) return cached
  if (input.facts.length > 50_000) throw Error('本批协作消息身份超过通知检查点容量')
  const ids = new Set<string>()
  for (const fact of input.facts) {
    if (!idValid(fact.id) || ids.has(fact.id) || !['directive', 'question', 'response', 'status', 'notice'].includes(fact.kind)
      || fact.digest !== undefined && !fingerprint(fact.digest)) throw Error('操作员消息原事实身份无效')
    if (input.currentRead && (!input.scope?.workspaceId || !input.scope.runId || fact.scope.workspaceId !== input.scope.workspaceId || fact.scope.runId !== input.scope.runId))
      throw Error('操作员消息与原完整范围不一致')
    ids.add(fact.id)
  }
  cached = { ordered: [...input.facts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), ids, scopeToken }; batches.set(input.facts, cached)
  return cached
}
function messageDraft(fact: NotificationOperatorMessageFact, revision: number, rebases: number, fresh: boolean, quiet: boolean, reason?: MessageReadProgress['reason']): NotificationDraft {
  return { key: `operator-message:${fact.id}`, eventId: `operator-message:${fact.id}${fact.digest ? `:facts:${fact.digest}` : ''}${rebases ? `:data:${rebases}` : ''}`,
    eventType: 'team.operator-message', subjectState: fact.kind, category: 'team', source: `协作 · ${notificationSafeText(fact.sender).slice(0, 50)}`,
    title: fact.kind === 'question' || fact.kind === 'directive' ? '有一条发给你的协作消息' : '收到协作回复或记录',
    detail: `${reason ? '已按本次原完整消息读取重新核对；先前结果不作为当前原记录证明，不声明业务或备份恢复成功。\n' : ''}${fact.subject ? `${notificationSafeText(fact.subject).slice(0, 160)}\n` : ''}请打开原组记录阅读完整内容。通知不会代你回复，也不会改写 Agent 的已读或响应回执。`,
    scope: fact.scope, ...(fact.scope.runId ? { target: fact.scope.groupId ? { kind: 'collaboration' as const, runId: fact.scope.runId, groupId: fact.scope.groupId, messageId: fact.id }
      : { kind: 'run' as const, runId: fact.scope.runId } } : {}), origin: { module: 'run' }, tone: 'info',
    attention: ['question', 'directive', 'response'].includes(fact.kind) ? 'notice' : 'activity', state: 'resolved', occurredAt: fact.at, sourceRevision: revision,
    announce: fresh && !quiet && ['question', 'directive', 'response'].includes(fact.kind), renewAttention: fresh, respectCleared: !fresh }
}
/** Compact ID checkpoint + short keyset cursors. No duplicated per-message metadata or conversation bodies. */
export function reduceOperatorMessages(old: OperatorMessageState | undefined, input: OperatorMessageInput, baseline: boolean, revision: number): { state: OperatorMessageState; drafts: NotificationDraft[]; complete?: boolean } {
  if (old?.scopeMissing && !input.currentRead || old?.nativeRevision !== undefined && input.nativeRevision !== undefined && input.nativeRevision < old.nativeRevision && !input.currentRead)
    return { state: old!, drafts: [] as NotificationDraft[] }
  const { ordered, ids } = factsOf(input), seen = new Set(old ? operatorMessageIds(old) : []), drafts: NotificationDraft[] = []
  const authoritative = input.currentRead === true && input.nativeRevision !== undefined && fingerprint(input.signature)
  if (!authoritative) {
    let complete = true
    for (const fact of input.facts) {
      if (seen.has(fact.id)) continue
      if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) { complete = false; break }
      seen.add(fact.id); drafts.push(messageDraft(fact, revision, old?.rebases ?? 0, true, baseline))
    }
    if (seen.size > 50_000) throw Error('本批协作消息身份超过通知检查点容量')
    drafts.forEach(validateNotificationDraft)
    const { seenEncoding: _oldEncoding, ...previous } = old ?? {}
    return { state: { ...previous, version: 2 as const, key: input.key, ...savedIdentities(seen) }, drafts, complete }
  }
  const activated = input.activation !== undefined && (old?.readActivation !== input.activation || old.readOwner !== input.readOwner)
  if (old && old.factsSignature === input.signature && !old.scopeMissing && !old.pendingMessages && !activated) {
    return { state: { ...old, nativeRevision: input.nativeRevision, readSignature: input.readSignature, readOwner: input.readOwner, readEpoch: input.readEpoch }, drafts }
  }
  const continuing = old?.pendingMessages?.signature === input.signature
  const returned = Boolean(old?.scopeMissing), regression = !continuing && old?.nativeRevision !== undefined &&
    nativeRevisionRegressed({ ...old, revision: old.nativeRevision }, { ...input, revision: input.nativeRevision! })
  const rebases = (old?.rebases ?? 0) + (returned || regression ? 1 : 0)
  const deltaValid = !activated && !returned && !regression && input.changedIds !== undefined && input.previousSignature !== undefined &&
    (continuing ? old!.pendingMessages!.previousSignature === input.previousSignature : old?.factsSignature === input.previousSignature)
  const pending: MessageReadProgress = continuing ? { ...old!.pendingMessages! } : {
    signature: input.signature!, missingClosed: false, presentClosed: false, changesOnly: deltaValid, ...(deltaValid ? { previousSignature: input.previousSignature } : {}),
    quiet: baseline || returned || Boolean(regression), ...(returned || regression ? { reason: returned ? 'scope-returned' : 'native-rebase', from: old?.nativeRevision, to: input.nativeRevision } : {})
  }
  if (pending.changesOnly && !deltaValid) { pending.changesOnly = false; pending.presentAfter = undefined; pending.presentClosed = false }
  pending.quiet ||= baseline // A wake/storage boundary also quiets an already durable unfinished batch.
  if (!pending.missingClosed) {
    const missing = [...seen].filter(id => !ids.has(id) && (pending.missingAfter === undefined || id > pending.missingAfter)).sort()
    for (const id of missing) {
      if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) break
      pending.missingAfter = id
      drafts.push({ key: `operator-message:${id}`, eventId: `operator-message:${id}:prior-data:${rebases}`, eventType: 'team.operator-message', subjectState: 'prior-data',
        category: 'team', source: '协作消息', title: '此协作消息提醒属于先前原记录',
        detail: '本次原完整运行范围的消息读取没有确认这条先前发给用户的消息。不能据此推断已回复、已撤回、Agent 已读或原消息已删除；通知没有重发或代为处理。',
        scope: input.scope ?? {}, tone: 'info', attention: 'notice', state: 'expired', occurredAt: input.now, timeBasis: 'observed', sourceRevision: revision,
        announce: false, renewAttention: false, respectCleared: true })
    }
    pending.missingClosed = missing.length <= drafts.length
  }
  if (pending.missingClosed && !pending.presentClosed) {
    const candidates = ordered.filter(fact => (pending.presentAfter === undefined || fact.id > pending.presentAfter) && (!pending.changesOnly || input.changedIds!.has(fact.id)))
    let processed = 0
    for (const fact of candidates) {
      if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) break
      pending.presentAfter = fact.id; ++processed
      const fresh = !seen.has(fact.id); seen.add(fact.id)
      drafts.push(messageDraft(fact, revision, rebases, fresh, pending.quiet, pending.reason))
    }
    pending.presentClosed = processed === candidates.length
  }
  if (seen.size > 50_000) throw Error('本批协作消息身份超过通知检查点容量')
  const complete = pending.missingClosed && pending.presentClosed
  const state: OperatorMessageState = { version: 2, key: input.key, ...savedIdentities(seen), observedScope: { workspaceId: input.scope!.workspaceId!, runId: input.scope!.runId! },
    factsSignature: input.signature, nativeRevision: input.nativeRevision, readSignature: input.readSignature, readOwner: input.readOwner, readEpoch: input.readEpoch, rebases, readActivation: input.activation,
    ...(!complete ? { pendingMessages: pending } : {}) }
  readOperatorMessageState(state, input.key); drafts.forEach(validateNotificationDraft)
  return { state, drafts, complete }
}
/** Missing records retain their exact historical scope/activity importance; absent/cleared and already-prior records are not manufactured again. */
export function preserveOperatorMessageMetadata(drafts: NotificationDraft[], metadata: readonly OperatorMessageRecordMetadata[]): NotificationDraft[] {
  const rows = new Map(metadata.map(row => [row.key, row]))
  return drafts.flatMap(draft => {
    const row = rows.get(draft.key)
    if (!['prior-data', 'scope-unconfirmed'].includes(draft.subjectState ?? ''))
      return [{ ...draft, sourceRevision: Math.max(draft.sourceRevision, (row?.sourceRevision ?? 0) + 1) }]
    if (!row || row.subjectState === draft.subjectState || row.scope.workspaceId !== draft.scope.workspaceId || row.scope.runId !== draft.scope.runId) return []
    return [{ ...draft, scope: row.scope, source: row.source, attention: row.attention === 'activity' ? 'activity' as const : 'notice' as const,
      sourceRevision: Math.max(draft.sourceRevision, row.sourceRevision + 1) }]
  })
}
