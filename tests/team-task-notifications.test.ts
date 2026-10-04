import { describe, expect, it, vi } from 'vitest'
import { connectTaskNotifications } from '../src/application/notifications/task-notifications'
import { connectOperatorMessageNotifications } from '../src/application/notifications/team-message-notifications'
import { emptyTaskPoolSnapshot, type TaskPoolSnapshot, type TeamTask } from '../src/domain/task-pool'
import { emptyTeamCollaborationSnapshot, type TeamCollaborationSnapshot, type TeamMessage } from '../src/domain/team-collaboration'
import { notificationSourceHarness, notificationTeam } from './notification-source-fixtures'

function feed<T>(initial: T) {
  let listener: (value: T) => void = () => {}
  return { subscribe: (next: typeof listener) => { listener = next; listener(initial); return () => { listener = () => {} } }, emit: (value: T) => listener(value) }
}
const task = (patch: Partial<TeamTask> = {}): TeamTask => ({ id: 'task-1', runId: 'run-a', key: 't1', title: '最终验证', description: '', acceptance: '', priority: 0, status: 'running',
  dependsOn: [], requiredCapabilities: [], maxAttempts: 3, attemptCount: 1, progress: 10, currentAttemptId: 'attempt-1', createdAt: 100, updatedAt: 1_000, ...patch })
function tasks(...rows: TeamTask[]): TaskPoolSnapshot {
  return { ...emptyTaskPoolSnapshot(), workspaceId: 'workspace-a', runId: 'run-a', taskOrder: rows.map(row => row.id), tasks: Object.fromEntries(rows.map(row => [row.id, row])) }
}
const message = (id: string, patch: Partial<TeamMessage> = {}): TeamMessage => ({ id, runId: 'run-a', groupId: 'group-a', threadId: 'thread-a', clientMessageId: id, kind: 'question',
  content: '不能写入通知数据库的正文', sender: { type: 'agent', slotId: 'slot-a' }, recipient: { type: 'operator' }, createdAt: 2_000,
  receipt: { notificationState: 'not_required', notificationDetail: '真实回执保持不变', updatedAt: 2_000 }, ...patch })
function messages(...rows: TeamMessage[]): TeamCollaborationSnapshot {
  return { ...emptyTeamCollaborationSnapshot('run-a'), messageOrder: rows.map(row => row.id), messages: Object.fromEntries(rows.map(row => [row.id, row])),
    threads: [{ id: 'thread-a', runId: 'run-a', groupId: 'group-a', subject: '核对结果', createdAt: 1_000, updatedAt: 2_000 }] }
}
describe('team result source connections', () => {
  it('stock operator history larger than one transaction restores in bounded quiet batches', async () => {
    const h = notificationSourceHarness(); const stream = feed(messages(...Array.from({ length: 230 }, (_, index) => message(`human-${index}`))))
    const connection = connectOperatorMessageNotifications(stream, notificationTeam, h.owner)
    try {
      await connection.source.flush()
      expect(h.ledger.page().summary.total).toBe(230)
      expect(vi.mocked(h.port.commitSource).mock.calls.map(call => call[3].length)).toEqual([100, 100, 30])
      expect((await h.owner.page()).historyIncomplete).toBe(false)
    } finally { connection.dispose(); await h.owner.close() }
  })
  it('an untrimmed run with more than 2,000 operator messages converges and never loops over evicted IDs', async () => {
    const h = notificationSourceHarness(), frame = messages(...Array.from({ length: 2_100 }, (_, index) => message(`human-${index}`)))
    const stream = feed(frame), connection = connectOperatorMessageNotifications(stream, notificationTeam, h.owner)
    try {
      await connection.source.flush()
      expect(h.ledger.page().summary.total).toBe(2_100)
      expect((await h.owner.page()).historyIncomplete).toBe(false)
      const count = vi.mocked(h.port.commitSource).mock.calls.length
      expect(count).toBe(21)
      stream.emit(frame); await connection.source.flush(); expect(h.port.commitSource).toHaveBeenCalledTimes(count)
    } finally { connection.dispose(); await h.owner.close() }
  })
  it('records automatic review quietly and publishes only final task results, not progress or intermediate attempt failure', async () => {
    const h = notificationSourceHarness(); const stream = feed(tasks(task()))
    const connection = connectTaskNotifications(stream, notificationTeam, h.owner)
    try {
      await connection.source.flush(); const writes = vi.mocked(h.port.commitSource)
      const count = writes.mock.calls.length
      stream.emit(tasks(task({ progress: 50, updatedAt: 2_000 }))); await connection.source.flush()
      expect(writes).toHaveBeenCalledTimes(count)
      stream.emit(tasks(task({ status: 'review', currentReviewId: 'review-1' }))); await connection.source.flush()
      expect(h.ledger.page().summary).toMatchObject({ pending: 0, unread: 0 })
      stream.emit(tasks(task({ status: 'running', currentAttemptId: 'attempt-2' }))); await connection.source.flush()
      expect(h.ledger.page().summary.pending).toBe(0)
      stream.emit(tasks(task({ status: 'failed', currentAttemptId: 'attempt-2', failureReason: '终态已确认' }))); await connection.source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1, pending: 0 })
      expect(h.ledger.page().records[0]?.subjectState).toBe('failed')
    } finally { connection.dispose(); await h.owner.close() }
  })
  it('mismatched task scope is ignored and old scoped-out task IDs are never fabricated as cancelled', async () => {
    const h = notificationSourceHarness(); const stream = feed(tasks(task({ status: 'review', currentReviewId: 'r1' })))
    const connection = connectTaskNotifications(stream, notificationTeam, h.owner)
    try {
      await connection.source.flush(); const before = h.ledger.page().records[0]!
      stream.emit({ ...tasks(task({ status: 'failed' })), workspaceId: 'other-workspace' }); await connection.source.flush()
      stream.emit(tasks()); await connection.source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ id: before.id, subjectState: 'review' })
    } finally { connection.dispose(); await h.owner.close() }
  })
  it('captures only agent-to-human facts and human reading never alters any agent transport receipt', async () => {
    const h = notificationSourceHarness(); const stream = feed(messages()); const connection = connectOperatorMessageNotifications(stream, notificationTeam, h.owner)
    try {
      await connection.source.flush()
      const frame = messages(message('for-human'), message('for-agent', { recipient: { type: 'agent', slotId: 'other' } }), message('from-human', { sender: { type: 'operator' } }))
      const before = JSON.stringify(frame)
      stream.emit(frame); await connection.source.flush()
      expect(h.ledger.page().summary.total).toBe(1)
      const record = h.ledger.page().records[0]!; expect(record.target).toMatchObject({ kind: 'collaboration', messageId: 'for-human' })
      await h.owner.read(record.id, record.revision)
      expect(JSON.stringify(frame)).toBe(before)
      expect(JSON.stringify(h.ledger.page())).not.toContain('不能写入')
      stream.emit(frame); await connection.source.flush(); expect(h.ledger.page().summary.unread).toBe(0)
    } finally { connection.dispose(); await h.owner.close() }
  })
  it('restores a missed direct question quietly; status broadcasts are activity, not unread pressure', async () => {
    const h = notificationSourceHarness(); const announcements: unknown[] = []; h.owner.subscribe(value => { if (value.announcement) announcements.push(value) })
    const stream = feed(messages(message('question'), message('routine-status', { kind: 'status' })))
    const connection = connectOperatorMessageNotifications(stream, notificationTeam, h.owner)
    try {
      await connection.source.flush(); expect(announcements).toHaveLength(0)
      expect(h.ledger.page().summary).toMatchObject({ total: 2, unread: 1 })
      stream.emit({ ...messages(message('wrong-run')), runId: 'another-run' }); await connection.source.flush()
      expect(h.ledger.page().summary.total).toBe(2)
    } finally { connection.dispose(); await h.owner.close() }
  })
})
