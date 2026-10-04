import { NOTIFICATION_SOURCE_BATCH_LIMIT, type NotificationDraft, type NotificationScope } from './notification'
export interface NotificationReplyFact { key: string; entryId: string; at: number; scope: NotificationScope; name: string; failed: boolean; aliases?: string[] }
export interface ReplyNotificationInput { key: string; facts: NotificationReplyFact[]; now: number; monitorStartedAt?: number; signature?: string }
interface ReplyIdentity { aliases: string[]; entryId: string; failed: boolean; recorded: boolean }
export interface ReplyNotificationState { version: 2; key: string; seen: string[]; rows: Record<string, ReplyIdentity> }
export function readReplyNotificationState(value: unknown, key: string): ReplyNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as ReplyNotificationState
  const version = (value as { version?: unknown })?.version
  if (!state || version !== 1 && version !== 2 || state.key !== key || !Array.isArray(state.seen) || state.seen.length > 2_000 || state.seen.some(value => typeof value !== 'string')) throw Error('回复通知检查点异常')
  if (version === 1) return { ...state, version: 2, rows: {} }
  if (!state.rows || Array.isArray(state.rows) || Object.keys(state.rows).length > 2_000) throw Error('回复通知检查点异常')
  for (const row of Object.values(state.rows)) if (!row || typeof row.entryId !== 'string' || typeof row.failed !== 'boolean' || typeof row.recorded !== 'boolean'
    || !Array.isArray(row.aliases) || row.aliases.length > 8 || row.aliases.some(alias => typeof alias !== 'string')) throw Error('回复通知检查点异常')
  return state
}
export function reduceReplyNotifications(old: ReplyNotificationState | undefined, input: ReplyNotificationInput, baseline: boolean, revision: number) {
  const seen = new Set(old?.seen); const drafts: NotificationDraft[] = []
  const rows = { ...old?.rows }; const aliasKeys = new Map<string, string>()
  for (const [key, row] of Object.entries(rows)) for (const alias of row.aliases) aliasKeys.set(alias, key)
  const parents = new Map<string, string>()
  const root = (key: string): string => {
    let result = key
    while (parents.has(result) && parents.get(result) !== result) result = parents.get(result)!
    while (parents.has(key) && parents.get(key) !== result) { const next = parents.get(key)!; parents.set(key, result); key = next }
    return result
  }
  for (const fact of input.facts) {
    const keys = [fact.key, ...fact.aliases ?? []].map(alias => root(aliasKeys.get(alias) ?? fact.key))
    const winner = keys.find(key => rows[key]?.recorded) ?? keys.find(key => seen.has(key)) ?? keys[0]!
    for (const key of keys) if (key !== winner) parents.set(key, winner)
    for (const alias of [fact.key, ...fact.aliases ?? []]) aliasKeys.set(alias, winner)
  }
  for (const [key, row] of Object.entries(rows)) {
    const winner = root(key)
    if (winner === key) continue
    const previous = rows[winner] ?? row
    rows[winner] = { ...previous, aliases: [...new Set([winner, ...previous.aliases, ...row.aliases])].slice(0, 8), recorded: previous.recorded || row.recorded }
    delete rows[key]; seen.delete(key)
  }
  // Resolve all facts first, so a relay record and native fallback in the same
  // frame cannot briefly publish conflicting results for one logical reply.
  const selected = new Map<string, NotificationReplyFact>()
  for (const fact of input.facts) {
    const aliases = [...new Set([fact.key, ...fact.aliases ?? []])]
    const key = root(aliasKeys.get(fact.key) ?? fact.key)
    const known = selected.get(key)
    selected.set(key, known?.entryId.startsWith('reply:') && !fact.entryId.startsWith('reply:')
      ? { ...known, aliases: [...new Set([...known.aliases ?? [], ...aliases])] }
      : { ...fact, aliases: [...new Set([...known?.aliases ?? [], ...aliases])] })
    for (const alias of aliases) aliasKeys.set(alias, key)
  }
  let complete = true
  for (const [key, fact] of selected) {
    const previous = rows[key]; const existed = seen.has(key)
    const aliases = [...new Set([key, ...previous?.aliases ?? [], ...fact.aliases ?? []])].slice(0, 8)
    const newFailure = fact.failed && (!existed || previous?.failed === false)
    const stock = !old && baseline && (input.monitorStartedAt === undefined || fact.at < input.monitorStartedAt)
    const publish = !stock && (!existed || newFailure || previous?.recorded === true && (previous.entryId !== fact.entryId || previous.failed !== fact.failed))
    if (publish && drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) { complete = false; break }
    rows[key] = { aliases, entryId: fact.entryId, failed: fact.failed, recorded: previous?.recorded === true || publish }; seen.add(key)
    if (!publish) continue
    drafts.push({ key: `reply:${key}`, eventId: `reply:${key}:${fact.failed ? 'failed' : 'complete'}`, eventType: 'session.reply', subjectState: fact.failed ? 'failed' : 'complete',
      category: 'sessions', source: `会话 · ${fact.name}`, title: fact.failed ? `${fact.name} 有一条未完成的回复记录` : `${fact.name} 有新回复`,
      detail: fact.failed ? '原消息链提供了失败记录。请打开对应会话核对，不会自动重发。' : '已收到完整的回复记录。新回复不等于所有后续工作都已结束，请查看原内容。',
      scope: fact.scope, target: { kind: 'session', scope: fact.scope, entryId: fact.entryId }, origin: { module: 'sessions', sessionId: fact.scope.sessionId },
      tone: fact.failed ? 'warning' : 'info', attention: 'notice', state: 'resolved', occurredAt: fact.at, sourceRevision: revision,
      announce: !baseline && newFailure, renewAttention: !existed || newFailure, respectCleared: existed && !newFailure })
  }
  const kept = [...seen].slice(-2_000)
  return { state: { version: 2 as const, key: input.key, seen: kept, rows: Object.fromEntries(kept.flatMap(key => rows[key] ? [[key, rows[key]]] : [])) }, drafts, complete }
}
