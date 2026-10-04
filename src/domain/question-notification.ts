import { NOTIFICATION_SOURCE_BATCH_LIMIT, type NotificationDraft, type NotificationScope } from './notification'

export interface NotificationQuestionFact {
  identity: string
  toolCallId: string
  blockId: string
  entryId?: string
  name: string
  scope: NotificationScope
  status: 'pending' | 'submitted' | 'cancelled'
  count: number
  actionable: boolean
  terminated: boolean
}
export interface QuestionSessionEvidence { scope: NotificationScope; online: boolean; awaitingUser?: boolean; awaitingUserEvidence?: 'runtime' | 'process' | 'unknown'; terminated: boolean }
export interface QuestionNotificationInput { scopeKey: string; runCompleted: boolean; now: number; facts: NotificationQuestionFact[]; sessions?: QuestionSessionEvidence[] }
export interface QuestionNotificationState { version: 1; scopeKey: string; rows: Record<string, NotificationQuestionFact> }
export function readQuestionNotificationState(value: unknown, key: string): QuestionNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as QuestionNotificationState
  if (!state || state.version !== 1 || state.scopeKey !== key || !state.rows || Array.isArray(state.rows) || Object.keys(state.rows).length > 512) throw Error('问卷通知检查点格式异常')
  for (const [id, row] of Object.entries(state.rows)) if (!row || row.identity !== id || !['pending', 'submitted', 'cancelled'].includes(row.status)
    || typeof row.toolCallId !== 'string' || typeof row.blockId !== 'string' || !row.scope || typeof row.actionable !== 'boolean') throw Error('问卷通知检查点格式异常')
  return state
}
export function reduceQuestionNotifications(old: QuestionNotificationState | undefined, input: QuestionNotificationInput, baseline: boolean, revision: number) {
  const state: QuestionNotificationState = { version: 1, scopeKey: input.scopeKey, rows: {} }; const drafts: NotificationDraft[] = []
  let complete = true
  const event = (fact: NotificationQuestionFact, previous?: NotificationQuestionFact): boolean => {
    const active = fact.status === 'pending' && fact.actionable && !fact.terminated && !input.runCompleted
    const resolved = fact.status !== 'pending'
    if (!active && !previous) return true
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) { complete = false; return false }
    drafts.push({ key: `question:${fact.identity}`, eventId: `question:${fact.identity}:${fact.status}:${active ? 'actionable' : 'inactive'}`, eventType: 'question.state',
      category: 'sessions', subjectState: fact.status, source: `会话 · ${fact.name}`, title: active ? `${fact.name} 有待回答的问题` : resolved ? fact.status === 'submitted' ? '这组问题已回答' : '这组问题已取消' : '原问卷当前已不可直接作答',
      detail: active ? `共 ${fact.count} 道题。请打开原会话查看完整选项后回答；通知不会代你选择或提交。`
        : resolved ? '原问卷已出现明确状态回执；通知已读与实际回答是不同动作。' : '当前会话或运行已停止，或运行时已不再等待这一问卷。未将它推测为已回答，可回看原记录。',
      tone: active ? 'info' : resolved ? 'success' : 'info', attention: active ? 'action' : previous?.actionable && resolved ? 'notice' : 'activity',
      state: active ? 'active' : resolved ? 'resolved' : 'expired', scope: fact.scope,
      target: { kind: 'session', scope: fact.scope, ...(fact.entryId ? { entryId: fact.entryId } : {}), toolCallId: fact.toolCallId, blockId: fact.blockId },
      origin: { module: 'sessions', sessionId: fact.scope.sessionId }, occurredAt: input.now, timeBasis: 'observed', sourceRevision: revision,
      renewAttention: active && !previous?.actionable, announce: !baseline && active && (!previous || !previous.actionable || previous.status !== 'pending') })
    return true
  }
  for (const captured of input.facts) {
    const previous = old?.rows[captured.identity]
    const evidence = input.sessions?.find(value => value.scope.channelId === captured.scope.channelId && value.scope.sessionId === captured.scope.sessionId && value.scope.generation === captured.scope.generation
      && value.scope.composerId === captured.scope.composerId && value.scope.bindingGeneration === captured.scope.bindingGeneration)
    const uncertainWait = Boolean(previous?.actionable && evidence?.online && evidence.awaitingUserEvidence !== 'runtime'
      && captured.status === 'pending' && !captured.terminated && !input.runCompleted)
    const fact = previous?.status !== undefined && previous.status !== 'pending' && captured.status === 'pending'
      ? previous : { ...captured, actionable: captured.status === 'pending' && (captured.actionable || uncertainWait) && !captured.terminated && !input.runCompleted }
    const changed = !previous || previous.status !== fact.status || previous.actionable !== fact.actionable || previous.terminated !== fact.terminated
    if (changed && !event(fact, previous)) { if (previous) state.rows[fact.identity] = previous; continue }
    state.rows[fact.identity] = fact
  }
  for (const fact of Object.values(old?.rows ?? {})) {
    if (state.rows[fact.identity]) continue
    // Missing from a clipped process frame is not proof of cancellation. Retain without announcing again.
    const sessions: QuestionSessionEvidence[] = input.sessions ?? input.facts.map(current => ({ scope: current.scope, online: current.actionable, terminated: current.terminated }))
    const changedIdentity = (scope: NotificationScope) => scope.channelId === fact.scope.channelId && (scope.sessionId !== fact.scope.sessionId
      || scope.generation !== fact.scope.generation || scope.bindingGeneration !== fact.scope.bindingGeneration || scope.composerId !== fact.scope.composerId)
    const sameSession = sessions.find(current => current.scope.channelId === fact.scope.channelId && !changedIdentity(current.scope))
    const end = input.runCompleted || sessions.some(current => changedIdentity(current.scope)) || sameSession?.terminated === true
    const unavailable = end || sameSession && (!sameSession.online || sameSession.awaitingUserEvidence === 'runtime' && sameSession.awaitingUser === false)
    if (unavailable && fact.actionable) {
      const inactive = { ...fact, actionable: false, terminated: end }; state.rows[fact.identity] = event(inactive, fact) ? inactive : fact
    } else state.rows[fact.identity] = fact
  }
  const active = Object.values(state.rows).filter(fact => fact.status === 'pending' && fact.actionable)
  if (active.length > 512) throw Error('活动问卷数量超出通知检查点容量')
  // Never evict an unresolved human action to make room for passive history.
  const passive = Object.values(state.rows).filter(fact => fact.status !== 'pending' || !fact.actionable).slice(-(512 - active.length))
  state.rows = Object.fromEntries([...active, ...(active.length < 512 ? passive : [])].map(fact => [fact.identity, fact]))
  return { state, drafts, complete }
}
