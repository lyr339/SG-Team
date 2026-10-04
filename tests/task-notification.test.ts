import { describe, expect, it } from 'vitest'
import { reduceTaskNotifications, type NotificationTaskFact, type TaskNotificationInput } from '../src/domain/task-notification'
const task = (patch: Partial<NotificationTaskFact> = {}): NotificationTaskFact => ({ id: 'task-1', title: '验证边界', status: 'running', attemptId: 'attempt-1', scope: { workspaceId: 'a', runId: 'run-a', groupId: 'group-a' }, at: 100, ...patch })
const input = (facts = [task()]): TaskNotificationInput => ({ key: 'tasks:a', completed: false, now: 200, facts })
describe('task results are not all human approvals', () => {
  it('team review is a quiet record, not an artificial human pending action', () => {
    const first = reduceTaskNotifications(undefined, input(), true, 1)
    const review = reduceTaskNotifications(first.state, input([task({ status: 'review', reviewId: 'review-1' })]), false, 2)
    expect(review.drafts[0]).toMatchObject({ attention: 'activity', announce: false })
    expect(review.drafts[0]?.detail).toContain('不代表要求你人工批准')
  })
  it('reports final task failure/completion once and does not equate a new attempt with completed work', () => {
    const first = reduceTaskNotifications(undefined, input(), true, 1)
    const failed = reduceTaskNotifications(first.state, input([task({ status: 'failed', failure: 'confirmed final failure' })]), false, 2)
    expect(failed.drafts[0]).toMatchObject({ attention: 'notice', announce: true, state: 'active' })
    const retried = reduceTaskNotifications(failed.state, input([task({ status: 'running', attemptId: 'attempt-2' })]), false, 3)
    expect(retried.drafts[0]).toMatchObject({ attention: 'activity', announce: false })
    const done = reduceTaskNotifications(retried.state, input([task({ status: 'done', attemptId: 'attempt-2' })]), false, 4)
    expect(done.drafts[0]).toMatchObject({ tone: 'success', state: 'resolved' })
    expect(reduceTaskNotifications(done.state, input([task({ status: 'done', attemptId: 'attempt-2', at: 500 })]), false, 5).drafts).toHaveLength(0)
  })
  it('restores old known results quietly but avoids announcing all historical stock successes on first install', () => {
    expect(reduceTaskNotifications(undefined, input([task({ status: 'done' })]), true, 1).drafts).toHaveLength(0)
    const old = reduceTaskNotifications(undefined, input(), true, 1).state
    expect(reduceTaskNotifications(old, input([task({ status: 'done' })]), true, 2).drafts[0]?.announce).toBe(false)
  })
})
