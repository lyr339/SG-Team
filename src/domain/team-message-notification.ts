import type { NotificationDraft, NotificationScope } from './notification'
import { NOTIFICATION_SOURCE_BATCH_LIMIT, notificationSafeText } from './notification'
export interface NotificationOperatorMessageFact {
  id: string
  kind: 'directive' | 'question' | 'response' | 'status' | 'notice'
  at: number
  subject?: string
  sender: string
  scope: NotificationScope
}
export interface OperatorMessageInput { key: string; facts: NotificationOperatorMessageFact[]; now: number }
export interface OperatorMessageState { version: 1; key: string; seen: string[] }
export function readOperatorMessageState(value: unknown, key: string): OperatorMessageState | undefined {
  if (value === undefined) return undefined
  const state = value as OperatorMessageState
  if (!state || state.version !== 1 || state.key !== key || !Array.isArray(state.seen) || state.seen.length > 50_000 || state.seen.some(value => typeof value !== 'string')) throw Error('操作员消息通知检查点异常')
  return state
}
export function reduceOperatorMessages(old: OperatorMessageState | undefined, input: OperatorMessageInput, baseline: boolean, revision: number) {
  const seen = new Set(old?.seen); const drafts: NotificationDraft[] = []
  let complete = true
  for (const fact of input.facts) {
    if (seen.has(fact.id)) continue
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) { complete = false; break }
    seen.add(fact.id)
    drafts.push({ key: `operator-message:${fact.id}`, eventId: `operator-message:${fact.id}`, eventType: 'team.operator-message', category: 'team', source: `协作 · ${notificationSafeText(fact.sender).slice(0, 50)}`,
      title: fact.kind === 'question' || fact.kind === 'directive' ? '有一条发给你的协作消息' : '收到协作回复或记录',
      detail: `${fact.subject ? `${notificationSafeText(fact.subject).slice(0, 160)}\n` : ''}请打开原组记录阅读完整内容。通知不会代你回复，也不会改写 Agent 的已读或响应回执。`,
      scope: fact.scope, ...(fact.scope.runId ? { target: fact.scope.groupId ? { kind: 'collaboration' as const, runId: fact.scope.runId, groupId: fact.scope.groupId, messageId: fact.id }
        : { kind: 'run' as const, runId: fact.scope.runId } } : {}),
      origin: { module: 'run' }, tone: 'info', attention: ['question', 'directive', 'response'].includes(fact.kind) ? 'notice' : 'activity', state: 'resolved', occurredAt: fact.at, sourceRevision: revision,
      announce: !baseline && ['question', 'directive', 'response'].includes(fact.kind), renewAttention: true })
  }
  // The collaboration source retains the whole run, unlike the clipped reply
  // timeline. Evicting IDs while rescanning that whole run would loop forever.
  if (seen.size > 50_000) throw Error('本批协作消息身份超过通知检查点容量')
  return { state: { version: 1 as const, key: input.key, seen: [...seen] }, drafts, complete }
}
