import { describe, expect, it } from 'vitest'
import { reduceQuestionNotifications, type NotificationQuestionFact, type QuestionNotificationInput } from '../src/domain/question-notification'
const fact = (patch: Partial<NotificationQuestionFact> = {}): NotificationQuestionFact => ({ identity: 'question-identity', toolCallId: 'real-tool', blockId: 'block-1', name: '架构实现 · CH-2',
  scope: { sessionId: 'real-session', channelId: '2', composerId: 'real-composer', generation: '1', bindingGeneration: 'bind-1' }, status: 'pending', count: 2, actionable: true, terminated: false, ...patch })
const input = (facts = [fact()], patch: Partial<QuestionNotificationInput> = {}): QuestionNotificationInput => ({ scopeKey: 'questions:a', runCompleted: false, now: 100, facts, ...patch })
describe('question notifications reflect real user-decision evidence', () => {
  it('restores an existing pending question without replaying an old toast, then responds to new questions', () => {
    const first = reduceQuestionNotifications(undefined, input(), true, 1)
    expect(first.drafts[0]).toMatchObject({ attention: 'action', state: 'active', announce: false, subjectState: 'pending' })
    const next = reduceQuestionNotifications(first.state, input([fact(), fact({ identity: 'new-question', toolCallId: 'new-tool' })]), false, 2)
    expect(next.drafts).toHaveLength(1); expect(next.drafts[0]?.announce).toBe(true)
    expect(JSON.stringify(next.state)).not.toContain('options')
  })
  it('only submitted/cancelled facts resolve; absence and runtime-not-waiting never fabricate an answer', () => {
    const first = reduceQuestionNotifications(undefined, input(), true, 1)
    expect(reduceQuestionNotifications(first.state, input([]), false, 2).drafts).toHaveLength(0)
    const inactive = reduceQuestionNotifications(first.state, input([fact({ actionable: false })]), false, 2)
    expect(inactive.drafts[0]).toMatchObject({ state: 'expired', attention: 'activity', subjectState: 'pending' })
    const answer = reduceQuestionNotifications(first.state, input([fact({ status: 'submitted', actionable: false })]), false, 3)
    expect(answer.drafts[0]).toMatchObject({ state: 'resolved', subjectState: 'submitted', announce: false })
    const stale = reduceQuestionNotifications(answer.state, input(), false, 4)
    expect(stale.drafts).toHaveLength(0); expect(stale.state.rows['question-identity']!.status).toBe('submitted')
  })
  it('closing the run expires actionable rows once and does not infer the old reply or task completed', () => {
    const first = reduceQuestionNotifications(undefined, input(), true, 1)
    const ended = reduceQuestionNotifications(first.state, input([], { runCompleted: true }), false, 2)
    expect(ended.drafts[0]).toMatchObject({ state: 'expired', attention: 'activity' })
    expect(ended.drafts[0]?.detail).toContain('未将它推测为已回答')
    expect(reduceQuestionNotifications(ended.state, input([], { runCompleted: true }), false, 3).drafts).toHaveLength(0)
  })
})
