import type { NotificationDraft } from './notification'
import type { NotificationQuestionFact } from './question-notification'

export interface QuestionOriginalRecheck {
  originalStatus: NotificationQuestionFact['status']
  phase: 'unconfirmed' | 'confirmed' | 'unavailable'
  actionable: boolean
}
export function validQuestionOriginalRecheck(value: QuestionOriginalRecheck): boolean {
  return Boolean(value && Object.keys(value).every(key => ['originalStatus', 'phase', 'actionable'].includes(key))
    && ['pending', 'submitted', 'cancelled'].includes(value.originalStatus) && ['unconfirmed', 'confirmed', 'unavailable'].includes(value.phase)
    && typeof value.actionable === 'boolean' && (!value.actionable || value.phase === 'unconfirmed' && value.originalStatus === 'pending'))
}
export function questionOriginalRecheck(previous: QuestionOriginalRecheck | undefined, original: NotificationQuestionFact,
  historical: NotificationQuestionFact['status'], unavailable: boolean, uncertainWait: boolean): QuestionOriginalRecheck | undefined {
  if (original.originalRead && original.status !== historical)
    return { originalStatus: original.status, phase: unavailable ? 'unavailable' : 'unconfirmed',
      actionable: !unavailable && original.status === 'pending' && (original.actionable || Boolean(previous?.actionable && uncertainWait)) }
  if (!previous) return
  if (original.originalRead && original.status === historical) return { originalStatus: original.status, phase: 'confirmed', actionable: false }
  if (unavailable && previous.phase === 'unconfirmed') return { ...previous, phase: 'unavailable', actionable: false }
  if (previous.phase === 'unconfirmed' && previous.actionable && !uncertainWait) return { ...previous, actionable: false }
  return previous // A clipped/legacy/live frame cannot confirm, answer or reopen this comparison.
}
const labels = { pending: '待回答', submitted: '已回答', cancelled: '已取消' }
export function questionOriginalRecheckDraft(fact: NotificationQuestionFact, previous: QuestionOriginalRecheck | undefined,
  baseline: boolean, now: number, revision: number): NotificationDraft {
  const check = fact.recheck!, fresh = check.phase === 'unconfirmed' && (previous?.phase !== 'unconfirmed' || check.actionable && !previous.actionable)
  return { key: `question-recheck:${fact.identity}`, eventId: `question-recheck:${fact.identity}:${check.phase}:${check.originalStatus}:${check.actionable ? 'actionable' : 'inactive'}`,
    eventType: 'question.original-recheck', subjectState: `original-${check.phase === 'unconfirmed' ? check.originalStatus : check.phase}`,
    category: 'sessions', source: `问卷 · ${fact.name}`, title: check.phase === 'unconfirmed' ? '原问卷状态需要核对' : check.phase === 'confirmed' ? '原问卷状态已重新核对' : '原问卷当前无法继续核对',
    detail: check.phase === 'unconfirmed'
      ? `原记录为「${labels[check.originalStatus]}」，通知历史保留「${labels[fact.status]}」。两者不一致，历史回执不会被覆盖。\n请查看原问卷核对；这不是再次执行或已回滚的证明。通知不会代答、补答或重放。`
      : check.phase === 'confirmed' ? `本次原记录重新确认「${labels[fact.status]}」，与保留的历史回执一致。未提交答案，也未改写原会话。`
        : '会话或运行已明确结束，当前无法继续核对。保留原差异，不把它推测为已回答、已取消或已回滚。',
    tone: check.phase === 'unconfirmed' ? 'warning' : 'info', attention: check.actionable ? 'action' : 'notice',
    state: check.phase === 'confirmed' ? 'resolved' : check.phase === 'unavailable' ? 'expired' : 'active',
    scope: fact.scope, target: { kind: 'session', scope: fact.scope, toolCallId: fact.toolCallId, blockId: fact.blockId, ...(fact.entryId ? { entryId: fact.entryId } : {}) },
    origin: { module: 'sessions', sessionId: fact.scope.sessionId }, occurredAt: now, timeBasis: 'observed', sourceRevision: revision,
    renewAttention: fresh, announce: !baseline && fresh, respectCleared: !fresh }
}
