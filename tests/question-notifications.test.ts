import { describe, expect, it } from 'vitest'
import { QuestionNotifications } from '../src/application/notifications/question-notifications'
import type { ConversationEntry, ProcessBlock } from '../src/domain/conversation-entry'
import { notificationFrame, notificationSession, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'

const block = (status: 'pending' | 'submitted' = 'pending'): ProcessBlock => ({ kind: 'tool', id: 'question-block', toolName: 'ask_question', toolKind: 'question', status: status === 'pending' ? 'running' : 'done',
  question: { toolCallId: 'question-tool', status, questions: [{ id: 'q1', prompt: '不要落库的正文', allowMultiple: false, options: [{ id: 'a', label: '不要落库的选项' }] }] } })
const entry = (status: 'pending' | 'submitted' = 'pending'): ConversationEntry => ({ id: 'reply:source', channelId: '1', role: 'assistant', text: '不复制全文', timestamp: 1_000, status: 'complete', source: 'cursor', processBlocks: [block(status)] })
const waitingFrame = (status: 'pending' | 'submitted' = 'pending') => notificationFrame({ sessions: [notificationSession({ awaitingUser: status === 'pending' })],
  conversations: { '1': [entry(status)] }, liveProcess: { '1': { startedAt: 1_000, blocks: [block(status)], generating: false, turn: 'turn-1', updatedAt: 1_000 } } })

describe('question source into the real private ledger', () => {
  it('keeps an unanswered decision across suspected outage, clipped history and restart; only real stop ends availability', async () => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner, () => 10000), team = notificationTeam()
    const suspect = notificationSession({ online: false, connected: false, runtimeEvidence: 'suspected', connectionPhase: 'suspected', awaitingUser: false, awaitingUserEvidence: 'unknown' })
    let restored: QuestionNotifications | undefined
    try {
      source.observe(waitingFrame(), team); await source.flush()
      const before = h.ledger.page().records[0]!
      source.observe({ ...waitingFrame(), sessions: [suspect] }, team); await source.flush()
      expect(h.ledger.page().records[0]).toEqual(before); expect(h.ledger.page().summary.pending).toBe(1)
      await source.close(); restored = new QuestionNotifications(h.owner, () => 20000)
      restored.observe(notificationFrame({ sessions: [suspect] }), team); await restored.flush()
      expect(h.ledger.page().records[0]).toEqual(before); expect(h.ledger.page().summary.pending).toBe(1)
      restored.observe(notificationFrame({ sessions: [notificationSession({ ...suspect, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })] }), team); await restored.flush()
      expect(h.ledger.page().summary.pending).toBe(0); expect(h.ledger.page().records[0]!.subjectState).toBe('pending')
    } finally { await source.close(); await restored?.close(); await h.owner.close() }
  })
  it('hydrates a native pending question quietly while the transport is suspect instead of losing the action', async () => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner, () => 10000)
    try {
      source.observe({ ...waitingFrame(), sessions: [notificationSession({ online: false, connected: false, runtimeEvidence: 'suspected', connectionPhase: 'suspected', awaitingUser: true, awaitingUserEvidence: 'runtime' })] }, notificationTeam())
      await source.flush(); expect(h.ledger.page().summary.pending).toBe(1)
    } finally { await source.close(); await h.owner.close() }
  })
  it('restores pending quietly, resolves an explicit answer, and does not let stale live pending replace it', async () => {
    const h = notificationSourceHarness(); const source = new QuestionNotifications(h.owner, () => 10_000)
    const pushes: unknown[] = []; h.owner.subscribe(push => { if (push.announcement) pushes.push(push) })
    try {
      source.observe(waitingFrame(), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary).toMatchObject({ pending: 1, unread: 1 }); expect(pushes).toHaveLength(0)
      const answered = waitingFrame('submitted'); answered.liveProcess!['1']!.blocks = [block()]
      source.observe(answered, notificationTeam()); await source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 1, pending: 0 })
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'submitted', target: { entryId: 'reply:source', blockId: 'question-block' } })
      source.observe(waitingFrame(), notificationTeam()); await source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe('submitted')
      expect(JSON.stringify(h.ledger.page())).not.toContain('不要落库')
    } finally { source.stop(); await h.owner.close() }
  })
  it('clipping alone is not cancellation; explicit runtime no-longer-waiting expires even an absent question', async () => {
    const h = notificationSourceHarness(); const source = new QuestionNotifications(h.owner)
    try {
      source.observe(waitingFrame(), notificationTeam()); await source.flush()
      const clipped = notificationFrame({ sessions: [notificationSession({ awaitingUser: true })] })
      source.observe(clipped, notificationTeam()); await source.flush(); expect(h.ledger.page().summary.pending).toBe(1)
      source.observe(notificationFrame({ sessions: [notificationSession({ awaitingUser: false, awaitingUserEvidence: 'unknown' })] }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.pending).toBe(1)
      source.observe(notificationFrame({ sessions: [notificationSession({ awaitingUser: false, awaitingUserEvidence: 'runtime' })] }), notificationTeam()); await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ state: 'expired', subjectState: 'pending' })
      expect(h.ledger.page().summary.pending).toBe(0)
    } finally { source.stop(); await h.owner.close() }
  })
  it('cached pending blocks plus an unknown/fallback false cannot expire an already confirmed human action', async () => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner)
    try {
      source.observe(waitingFrame(), notificationTeam()); await source.flush()
      const fallback = waitingFrame(); fallback.sessions = [notificationSession({ awaitingUser: false, awaitingUserEvidence: 'unknown' })]
      source.observe(fallback, notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.pending).toBe(1)
      fallback.sessions = [notificationSession({ awaitingUser: false, awaitingUserEvidence: 'runtime' })]
      source.observe(fallback, notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.pending).toBe(0)
      expect(h.ledger.page().records[0]?.subjectState).toBe('pending')
    } finally { source.stop(); await h.owner.close() }
  })
  it('a positive stop, or reusing CH with another generation, closes the old action without fabricating an answer', async () => {
    const h = notificationSourceHarness(); const source = new QuestionNotifications(h.owner)
    try {
      source.observe(waitingFrame(), notificationTeam()); await source.flush()
      source.observe(notificationFrame({ sessions: [notificationSession({ online: false, connected: false, runtimeEvidence: 'stopped' })] }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.pending).toBe(0)
      source.observe(waitingFrame(), notificationTeam()); await source.flush(); expect(h.ledger.page().summary.pending).toBe(1)
      source.observe(notificationFrame({ sessions: [notificationSession({ generation: 1, awaitingUser: true })] }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.pending).toBe(0)
    } finally { source.stop(); await h.owner.close() }
  })
  it('fences mismatched topology frames and reconciles a completed previous run when scope moves', async () => {
    const h = notificationSourceHarness(); const source = new QuestionNotifications(h.owner)
    try {
      const team = notificationTeam(); source.observe(waitingFrame(), team); await source.flush()
      const wrong = notificationFrame({ runtimeScope: { workspaceId: 'wrong', runId: team.activeRun!.id, teamRevision: team.revision } })
      source.observe(wrong, team); await source.flush(); expect(h.ledger.page().summary.pending).toBe(1)
      const switched = { ...team, activeRun: undefined, activeWorkspaceId: 'workspace-b', runs: [{ ...team.activeRun!, status: 'completed' as const }] }
      source.observe(notificationFrame({ sessions: [] }), switched); await source.flush()
      expect(h.ledger.page().summary.pending).toBe(0)
    } finally { source.stop(); await h.owner.close() }
  })
})
