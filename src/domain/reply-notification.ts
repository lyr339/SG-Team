import { type NotificationDraft, type NotificationScope } from './notification'
import { REPLY_IDENTITY_BATCH_LIMIT, REPLY_IDENTITY_LOOKUP_LIMIT, validReplyIdentityRow, type ReplyIdentityRow, type ReplyIdentityMatch, type ReplyIdentityBatch } from './reply-identity-index'
export interface NotificationReplyFact { key: string; entryId: string; at: number; scope: NotificationScope; name: string; failed: boolean; aliases?: string[]; bodyDigest?: string }
export interface ReplyNotificationInput { key: string; facts: NotificationReplyFact[]; now: number; monitorStartedAt?: number; signature: string }
type ReplyIdentity = Omit<ReplyIdentityRow, 'key'>
interface ReplyScan { signature: string; offset: number; stock?: number | 'all' }
/** Small working cache only. Historical authority lives in the worker-owned normalized identity index. */
export interface ReplyNotificationState { version: 4; key: string; seen: string[]; rows: Record<string, ReplyIdentity>; indexed: boolean; indexOffset?: number; scan?: ReplyScan }
export function readReplyNotificationState(value: unknown, key: string): ReplyNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as ReplyNotificationState, version = (value as { version?: unknown })?.version
  if (!state || ![1, 2, 3, 4].includes(version as number) || state.key !== key || !Array.isArray(state.seen) || state.seen.length > 2_000 || state.seen.some(value => typeof value !== 'string')) throw Error('回复通知检查点异常')
  if (version === 1) return { version: 4, key, seen: state.seen, rows: {}, indexed: false }
  if (!state.rows || Array.isArray(state.rows) || Object.keys(state.rows).length > 2_000) throw Error('回复通知检查点异常')
  for (const [key, row] of Object.entries(state.rows)) if (!row || Object.keys(row).includes('key') || !validReplyIdentityRow({ key, ...row })
    || version !== 4 && (row.bodyDigest !== undefined || row.legacyComparison !== undefined || row.bodyUpdatedAt !== undefined)) throw Error('回复通知检查点异常')
  if (version === 2) return { version: 4, key, seen: state.seen, rows: state.rows, indexed: false }
  if (Object.keys(state).some(key => !['version', 'key', 'seen', 'rows', 'indexed', 'indexOffset', 'scan'].includes(key)) || typeof state.indexed !== 'boolean'
    || state.indexOffset !== undefined && (!Number.isSafeInteger(state.indexOffset) || state.indexOffset < 0 || state.indexOffset > Object.keys(state.rows).length || state.indexed)
    || state.scan !== undefined && (!state.scan || typeof state.scan !== 'object' || Object.keys(state.scan).some(key => !['signature', 'offset', 'stock'].includes(key))
      || !/^[a-f0-9]{64}$/.test(state.scan.signature) || !Number.isSafeInteger(state.scan.offset) || state.scan.offset < 0
      || state.scan.stock !== undefined && state.scan.stock !== 'all' && (!Number.isSafeInteger(state.scan.stock) || state.scan.stock < 0))) throw Error('回复通知分批检查点异常')
  return { ...state, version: 4 }
}
const aliasesOf = (fact: NotificationReplyFact): string[] => [...new Set([fact.key, ...fact.aliases ?? []])]
/** Resolve exact in-frame bridges before slicing, so a late bridge cannot create two notifications at a batch boundary. */
export function groupReplyNotificationFacts(facts: NotificationReplyFact[], matches: readonly ReplyIdentityMatch[] = []): NotificationReplyFact[] {
  const parents = facts.map((_, index) => index), owners = new Map<string, number>()
  const root = (index: number): number => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]!]!; index = parents[index]! }
    return index
  }
  const matchingOwners = new Map<string, string[]>()
  for (const match of matches) for (const alias of match.aliases) matchingOwners.set(alias, [...matchingOwners.get(alias) ?? [], match.row.key])
  for (const [index, fact] of facts.entries()) {
    const references = aliasesOf(fact)
    for (const alias of references.flatMap(alias => [alias, ...matchingOwners.get(alias) ?? []])) {
      const previous = owners.get(alias)
      if (previous !== undefined) parents[root(index)] = root(previous)
      owners.set(alias, index)
    }
  }
  const grouped = new Map<number, NotificationReplyFact>()
  for (const [index, fact] of facts.entries()) {
    const key = root(index), previous = grouped.get(key)
    const selected = previous?.entryId.startsWith('reply:') && !fact.entryId.startsWith('reply:') ? previous : fact
    grouped.set(key, { ...selected, aliases: [...new Set([...previous?.aliases ?? [], ...aliasesOf(fact)])] })
  }
  return [...grouped.values()]
}
export function replyNotificationSlice(old: ReplyNotificationState | undefined, input: ReplyNotificationInput) {
  const start = old?.scan?.signature === input.signature ? old.scan.offset : 0
  if (start > input.facts.length) throw Error('回复通知分批位置不能超出原观察')
  const facts: NotificationReplyFact[] = [], aliases = new Set<string>()
  for (let index = start; index < input.facts.length; index++) {
    const fact = input.facts[index]!
    const added = aliasesOf(fact).filter(alias => !aliases.has(alias))
    if (aliases.size + added.length > REPLY_IDENTITY_LOOKUP_LIMIT || facts.length === REPLY_IDENTITY_BATCH_LIMIT) break
    facts.push(fact); for (const alias of added) aliases.add(alias)
  }
  if (!facts.length && start < input.facts.length) throw Error('单条回复身份关联超过本次有界核对容量，历史保留')
  return { facts, aliases: [...aliases], start, end: start + facts.length }
}
/** Legacy rows are imported with their source cursor; missing old aliases are never invented. */
function backfillReplyIdentityIndex(old: ReplyNotificationState) {
  const offset = old.indexOffset ?? 0, entries = Object.entries(old.rows)
  const rows = entries.slice(offset, offset + REPLY_IDENTITY_BATCH_LIMIT).map(([key, row]) => ({ key, ...row }))
  const end = offset + rows.length
  return { state: { ...old, indexed: end === entries.length, ...(end < entries.length ? { indexOffset: end } : { indexOffset: undefined }) }, drafts: [], complete: false,
    ...(rows.length ? { replyIdentities: { sourceKey: old.key, rows } } : {}) }
}
export function reduceReplyNotifications(old: ReplyNotificationState | undefined, input: ReplyNotificationInput, baseline: boolean, revision: number, matches?: readonly ReplyIdentityMatch[]) {
  if (old && !old.indexed) return backfillReplyIdentityIndex(old)
  const seen = new Set(old?.seen), rows = { ...old?.rows }, drafts: NotificationDraft[] = []
  const slice = replyNotificationSlice(old, input)
  const candidates = matches ?? Object.entries(old?.rows ?? {}).map(([key, row]) => ({ row: { key, ...row }, aliases: [key, ...row.aliases] }))
  const selected = groupReplyNotificationFacts(slice.facts, candidates)
  const stock = old?.scan?.stock ?? (!old && baseline ? input.monitorStartedAt ?? 'all' : undefined)
  const changed: ReplyIdentityRow[] = [], links: NonNullable<ReplyIdentityBatch['links']> = [], merges: NonNullable<ReplyIdentityBatch['merges']> = []
  for (const original of selected) {
    const aliases = aliasesOf(original), related = candidates.filter(match => match.aliases.some(alias => aliases.includes(alias)))
    if (related.filter(match => match.row.recorded).length > 1) throw Error('回复身份关联有多条已发布记录，不猜测归并')
    const prior = related.find(match => match.row.recorded) ?? related.find(match => match.row.key === original.key) ?? related[0]
    const key = prior?.row.key ?? original.key, previous = prior?.row
    // A trimmed native history frame cannot downgrade an already proven canonical reference.
    const fact = previous?.entryId.startsWith('reply:') && !original.entryId.startsWith('reply:') ? { ...original, entryId: previous.entryId, failed: previous.failed, bodyDigest: previous.bodyDigest } : original
    const existed = Boolean(previous) || seen.has(key)
    const newFailure = fact.failed && (!existed || previous?.failed === false)
    const historical = stock === 'all' || typeof stock === 'number' && fact.at < stock
    const sameStatus = previous?.failed === fact.failed
    const bodyChanged = Boolean(sameStatus && previous?.recorded && previous.bodyDigest && fact.bodyDigest && previous.bodyDigest !== fact.bodyDigest)
    const legacyComparison = Boolean(sameStatus && !bodyChanged && !newFailure && (previous?.legacyComparison || previous?.recorded && !previous.bodyDigest && fact.bodyDigest))
    const bodyUpdatedAt = bodyChanged ? input.now : sameStatus ? previous?.bodyUpdatedAt : undefined
    const updatedBody = bodyUpdatedAt !== undefined
    const publish = Boolean(!historical && (!existed || newFailure || bodyChanged || previous?.recorded === true && (previous.entryId !== fact.entryId || previous.failed !== fact.failed || !previous.bodyDigest && fact.bodyDigest)))
    const row: ReplyIdentityRow = { key, aliases: [...new Set([key, ...previous?.aliases ?? [], ...aliases])].slice(0, 8), entryId: fact.entryId, failed: fact.failed, recorded: previous?.recorded === true || publish,
      ...(fact.bodyDigest ?? previous?.bodyDigest ? { bodyDigest: fact.bodyDigest ?? previous?.bodyDigest } : {}), ...(legacyComparison ? { legacyComparison: true } : {}),
      ...(updatedBody ? { bodyUpdatedAt } : {}) }
    const missing = aliases.filter(alias => !prior?.aliases.includes(alias))
    const losers = related.filter(match => match.row.key !== key)
    if (!previous || JSON.stringify(previous) !== JSON.stringify(row) || missing.length || losers.length) {
      changed.push(row); for (const alias of missing) links.push({ key, alias })
      for (const loser of losers) {
        merges.push({ from: loser.row.key, to: key }); seen.delete(loser.row.key); delete rows[loser.row.key]
      }
    }
    const { key: _key, ...cached } = row
    rows[key] = cached; seen.add(key)
    if (!publish) continue
    const observedChange = updatedBody || legacyComparison
    drafts.push({ key: `reply:${key}`, eventId: `reply:${key}:${legacyComparison ? 'legacy-comparison' : updatedBody ? 'body-changed' : fact.failed ? 'failed' : 'complete'}${row.bodyDigest ? `:body:${row.bodyDigest}` : ''}`,
      eventType: 'session.reply', subjectState: legacyComparison ? 'legacy-comparison' : updatedBody ? 'body-changed' : fact.failed ? 'failed' : 'complete',
      category: 'sessions', source: `会话 · ${fact.name}`, title: legacyComparison ? '旧回复记录只能对照当前内容' : updatedBody ? '原回复正文已更新' : fact.failed ? `${fact.name} 有一条未完成的回复记录` : `${fact.name} 有新回复`,
      detail: legacyComparison ? '旧通知没有保存正文校验信息，不能用当前文本补造当时的内容。可对照当前回复；未自动确认旧内容已被阅读。'
        : updatedBody ? '同一回复位置现已提供不同正文。可能来自内容修订或来源恢复；这不证明新任务完成或数据已回滚。请查看当前内容，不会重发消息。'
          : fact.failed ? '原消息链提供了失败记录。请打开对应会话核对，不会自动重发。' : '已收到完整的回复记录。新回复不等于所有后续工作都已结束，请查看原内容。',
      scope: fact.scope, target: { kind: 'session', scope: fact.scope, entryId: fact.entryId, ...(row.bodyDigest ? { replyBody: { version: 1, digest: row.bodyDigest, status: fact.failed ? 'failed' : 'complete' } as const } : {}) },
      origin: { module: 'sessions', sessionId: fact.scope.sessionId }, tone: fact.failed ? 'warning' : 'info', attention: 'notice', state: 'resolved',
      occurredAt: bodyUpdatedAt ?? (legacyComparison ? input.now : fact.at), ...(observedChange ? { timeBasis: 'observed' as const } : {}), sourceRevision: revision,
      announce: !baseline && newFailure, renewAttention: !existed || newFailure || bodyChanged, respectCleared: existed && !newFailure && !bodyChanged,
      ...(!baseline && (!existed || bodyChanged) && !fact.failed ? { liveSignal: 'reply' as const } : {}) })
  }
  const kept = [...seen].slice(-2_000), complete = slice.end === input.facts.length
  return { state: { version: 4 as const, key: input.key, seen: kept, rows: Object.fromEntries(kept.flatMap(key => rows[key] ? [[key, rows[key]]] : [])), indexed: true,
    ...(!complete ? { scan: { signature: input.signature, offset: slice.end, ...(stock !== undefined ? { stock } : {}) } } : {}) }, drafts, complete,
    ...(changed.length ? { replyIdentities: { sourceKey: input.key, rows: changed, ...(links.length ? { links } : {}), ...(merges.length ? { merges } : {}) } } : {}) }
}
