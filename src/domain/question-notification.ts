import { NOTIFICATION_SOURCE_BATCH_LIMIT, validateNotificationDraft, type NotificationDraft, type NotificationScope } from './notification'
import { QUESTION_TERMINAL_BATCH_LIMIT, type QuestionTerminalReceipt } from './question-terminal-receipt'

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
export interface QuestionNotificationInput { scopeKey: string; runCompleted: boolean; now: number; facts: NotificationQuestionFact[]; sessions?: QuestionSessionEvidence[]; signature: string }
export interface QuestionNotificationState {
  version: 2; scopeKey: string; rows: Record<string, NotificationQuestionFact>; indexed: boolean; indexOffset?: number
  terminalScan?: { signature: string; offset: number }
}
export function readQuestionNotificationState(value: unknown, key: string): QuestionNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as QuestionNotificationState
  const version = (value as { version?: number })?.version
  if (!state || ![1, 2].includes(version!) || state.scopeKey !== key || !state.rows || Array.isArray(state.rows) || Object.keys(state.rows).length > 512) throw Error('问卷通知检查点格式异常')
  for (const [id, row] of Object.entries(state.rows)) {
    if (!row || Object.keys(row).some(key => !['identity', 'toolCallId', 'blockId', 'entryId', 'name', 'scope', 'status', 'count', 'actionable', 'terminated'].includes(key))
      || row.identity !== id || !/^[a-f0-9]{64}$/.test(id) || !['pending', 'submitted', 'cancelled'].includes(row.status)
      || typeof row.toolCallId !== 'string' || !row.toolCallId || row.toolCallId.length > 200 || typeof row.blockId !== 'string' || !row.blockId || row.blockId.length > 300
      || row.entryId !== undefined && (typeof row.entryId !== 'string' || !row.entryId || row.entryId.length > 300) || typeof row.name !== 'string' || row.name.length > 150
      || !Number.isSafeInteger(row.count) || row.count < 0 || typeof row.actionable !== 'boolean' || typeof row.terminated !== 'boolean') throw Error('问卷通知检查点格式异常')
    validateNotificationDraft({ key: `question:${id}`, category: 'sessions', source: '问卷检查点', title: '范围校验', tone: 'info', attention: 'activity', state: 'resolved', scope: row.scope, occurredAt: 0, sourceRevision: 0 })
  }
  if (version === 1) return { version: 2, scopeKey: key, rows: state.rows, indexed: false }
  if (Object.keys(state).some(key => !['version', 'scopeKey', 'rows', 'indexed', 'indexOffset', 'terminalScan'].includes(key)) || typeof state.indexed !== 'boolean' || state.indexOffset !== undefined && (!Number.isSafeInteger(state.indexOffset) || state.indexOffset < 0 || state.indexOffset > Object.values(state.rows).filter(fact => fact.status !== 'pending').length || state.indexed)
    || state.terminalScan !== undefined && (!state.terminalScan || Object.keys(state.terminalScan).some(key => !['signature', 'offset'].includes(key)) || !/^[a-f0-9]{64}$/.test(state.terminalScan.signature) || !Number.isSafeInteger(state.terminalScan.offset) || state.terminalScan.offset < 0)) throw Error('问卷终态分批检查点异常')
  return state
}
export function questionTerminalSlice(old: QuestionNotificationState | undefined, input: QuestionNotificationInput) {
  const facts = input.facts.filter(fact => fact.status !== 'pending')
  const start = old?.terminalScan?.signature === input.signature ? old.terminalScan.offset : 0
  if (start > facts.length) throw Error('问卷终态分批位置超出原观察')
  return { facts: facts.slice(start, start + QUESTION_TERMINAL_BATCH_LIMIT), start, total: facts.length }
}
export function reduceQuestionNotifications(old: QuestionNotificationState | undefined, input: QuestionNotificationInput, baseline: boolean, revision: number, receipts: readonly QuestionTerminalReceipt[] = []) {
  if (old && !old.indexed) {
    const facts = Object.values(old.rows).filter(fact => fact.status !== 'pending'), start = old.indexOffset ?? 0
    const rows = facts.slice(start, start + QUESTION_TERMINAL_BATCH_LIMIT).map(fact => ({ identity: fact.identity, status: fact.status as QuestionTerminalReceipt['status'] }))
    const end = start + rows.length
    return { state: { ...old, indexed: end === facts.length, indexOffset: end < facts.length ? end : undefined }, drafts: [] as NotificationDraft[], complete: false,
      ...(rows.length ? { questionTerminals: { sourceKey: old.scopeKey, rows } } : {}) }
  }
  const state: QuestionNotificationState = { version: 2, scopeKey: input.scopeKey, rows: {}, indexed: true }; const drafts: NotificationDraft[] = []
  const slice = questionTerminalSlice(old, input), allowed = new Set(slice.facts.map(fact => fact.identity)), known = new Map(receipts.map(row => [row.identity, row.status])), accepted = new Set<string>()
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
      renewAttention: active && !previous?.actionable, respectCleared: !active, announce: !baseline && active && (!previous || !previous.actionable || previous.status !== 'pending') })
    return true
  }
  for (const captured of input.facts) {
    const previous = old?.rows[captured.identity], terminal = known.get(captured.identity)
    if (captured.status !== 'pending' && (terminal && terminal !== captured.status || previous && previous.status !== 'pending' && previous.status !== captured.status)) throw Error('原问卷终态冲突，不猜测覆盖')
    // Uncommitted passive facts cannot enter a prunable cache ahead of their receipt.
    if (captured.status !== 'pending' && !allowed.has(captured.identity) && !terminal && previous?.status !== captured.status) continue
    const evidence = input.sessions?.find(value => value.scope.channelId === captured.scope.channelId && value.scope.sessionId === captured.scope.sessionId && value.scope.generation === captured.scope.generation
      && value.scope.composerId === captured.scope.composerId && value.scope.bindingGeneration === captured.scope.bindingGeneration)
    const uncertainWait = Boolean(previous?.actionable && evidence && !evidence.terminated && !(evidence.awaitingUserEvidence === 'runtime' && evidence.awaitingUser === false)
      && captured.status === 'pending' && !captured.terminated && !input.runCompleted)
    const fact = terminal ? { ...captured, status: terminal, actionable: false } : previous?.status !== undefined && previous.status !== 'pending' && captured.status === 'pending'
      ? previous : { ...captured, actionable: captured.status === 'pending' && (captured.actionable || uncertainWait) && !captured.terminated && !input.runCompleted }
    // Passive sealing/refinement is neither a new attention class nor a human read.
    const changed = !previous || previous.status !== fact.status || fact.status === 'pending' && (previous.actionable !== fact.actionable || previous.terminated !== fact.terminated
      || fact.actionable && (previous.entryId !== fact.entryId || previous.blockId !== fact.blockId || previous.count !== fact.count || previous.name !== fact.name))
    if (changed && !event(fact, previous)) { if (previous) state.rows[fact.identity] = previous; continue }
    state.rows[fact.identity] = fact
    if (captured.status !== 'pending') accepted.add(captured.identity)
  }
  for (const fact of Object.values(old?.rows ?? {})) {
    if (state.rows[fact.identity]) continue
    // Missing from a clipped process frame is not proof of cancellation. Retain without announcing again.
    const sessions: QuestionSessionEvidence[] = input.sessions ?? input.facts.map(current => ({ scope: current.scope, online: current.actionable, terminated: current.terminated }))
    const changedIdentity = (scope: NotificationScope) => scope.channelId === fact.scope.channelId && (scope.sessionId !== fact.scope.sessionId
      || scope.generation !== fact.scope.generation || scope.bindingGeneration !== fact.scope.bindingGeneration || scope.composerId !== fact.scope.composerId)
    const sameSession = sessions.find(current => current.scope.channelId === fact.scope.channelId && !changedIdentity(current.scope))
    const end = input.runCompleted || sessions.some(current => changedIdentity(current.scope)) || sameSession?.terminated === true
    // A transport outage does not answer, cancel or retire a human decision.
    const unavailable = end || sameSession && sameSession.awaitingUserEvidence === 'runtime' && sameSession.awaitingUser === false
    if (unavailable && fact.actionable) {
      const inactive = { ...fact, actionable: false, terminated: end }; state.rows[fact.identity] = event(inactive, fact) ? inactive : fact
    } else state.rows[fact.identity] = fact
  }
  const active = Object.values(state.rows).filter(fact => fact.status === 'pending' && fact.actionable)
  if (active.length > 512) throw Error('活动问卷数量超出通知检查点容量')
  // Never evict an unresolved human action to make room for passive history.
  const passive = Object.values(state.rows).filter(fact => fact.status !== 'pending' || !fact.actionable).slice(-(512 - active.length))
  state.rows = Object.fromEntries([...active, ...(active.length < 512 ? passive : [])].map(fact => [fact.identity, fact]))
  let end = slice.start
  for (const fact of slice.facts) { if (!accepted.has(fact.identity)) break; ++end }
  if (end < slice.total) state.terminalScan = { signature: input.signature, offset: end }
  const terminalRows = slice.facts.filter(fact => accepted.has(fact.identity) && !known.has(fact.identity)).map(fact => ({ identity: fact.identity, status: fact.status as QuestionTerminalReceipt['status'] }))
  return { state, drafts, complete: complete && end === slice.total, ...(terminalRows.length ? { questionTerminals: { sourceKey: input.scopeKey, rows: terminalRows } } : {}) }
}
