import { describe, expect, it } from 'vitest'
import type { ConversationEntry, ProcessBlock } from '../src/domain/conversation-entry'
import { nativeAssistantEntry } from '../src/domain/native-assistant-entry'
import { QuestionNotifications } from '../src/application/notifications/question-notifications'
import { ReplyNotifications } from '../src/application/notifications/reply-notifications'
import { QueueNotifications } from '../src/application/notifications/queue-notifications'
import { notificationFrame, notificationSession, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'

const question = (status: 'pending' | 'submitted'): ProcessBlock => ({ kind: 'tool', id: 'native-question-block', status: status === 'pending' ? 'running' : 'done', toolName: 'ask_question',
  question: { toolCallId: 'native-question', status, questions: [{ id: 'q', prompt: 'Original body not copied', allowMultiple: false, options: [{ id: 'a', label: 'Private option not copied' }] }] } })
const entry = (patch: Partial<ConversationEntry> = {}): ConversationEntry => ({ id: 'native-entry', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', timestamp: 12000,
  text: 'Original text not copied', streamId: 'original-stream', turn: 'original-turn', ...patch })
const mutations: Partial<ConversationEntry>[] = [{ source: 'desktop' }, { source: 'recovery' }, { channelId: '2' }, { role: 'user' }]

describe('history notifications do not grant native authority to imported or misrouted entries', () => {
  it('shares the original assistant/source/channel rule without guessing from text or ids', () => {
    expect(nativeAssistantEntry(entry(), '1')).toBe(true)
    for (const patch of mutations) expect(nativeAssistantEntry(entry(patch), '1')).toBe(false)
  })
  it.each(mutations)('does not create a pending questionnaire or complete reply from $source/$role/$channelId', async patch => {
    const h = notificationSourceHarness(), questions = new QuestionNotifications(h.owner, () => 10000), replies = new ReplyNotifications(h.owner, () => 10000), team = notificationTeam()
    const initial = notificationFrame({ sessions: [notificationSession({ awaitingUser: true, awaitingUserEvidence: 'runtime' })] })
    try {
      questions.observe(initial, team); replies.observe(initial, team); await questions.flush(); await replies.flush()
      const frame = { ...initial, conversations: { '1': [entry({ ...patch, processBlocks: [question('pending')] })] } }
      questions.observe(frame, team); replies.observe(frame, team); await questions.flush(); await replies.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 0, unread: 0, pending: 0 })
    } finally { await questions.close(); await replies.close(); await h.owner.close() }
  })
  it.each(mutations)('does not resolve a real pending question with an imported or foreign answer', async patch => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner, () => 10000), team = notificationTeam()
    const initial = notificationFrame({ sessions: [notificationSession({ awaitingUser: true, awaitingUserEvidence: 'runtime' })], conversations: { '1': [entry({ processBlocks: [question('pending')] })] } })
    try {
      source.observe(initial, team); await source.flush()
      const before = h.ledger.page().records[0]!
      source.observe({ ...initial, conversations: { '1': [entry({ ...patch, processBlocks: [question('submitted')] })] } }, team); await source.flush()
      expect(h.ledger.page().records[0]).toEqual(before); expect(h.ledger.page().summary.pending).toBe(1)
      source.observe({ ...initial, conversations: { '1': [entry({ processBlocks: [question('submitted')] })] } }, team); await source.flush()
      expect(h.ledger.page().summary.pending).toBe(0); expect(h.ledger.page().records[0]!.subjectState).toBe('submitted')
    } finally { await source.close(); await h.owner.close() }
  })
  it.each(mutations)('does not claim a queued handoff was replied to by $source/$role/$channelId', async patch => {
    const h = notificationSourceHarness(), raw = { entryId: 'outbox:original', channelId: '1', runId: 'run-a', createdAt: 5000, held: true }
    const source = new QueueNotifications(h.owner, () => ({ facts: [raw], historyIncomplete: false }), () => 10000), team = notificationTeam()
    try {
      source.observe(notificationFrame(), team)
      source.registerHandoff({ entryId: raw.entryId, targetChannelId: '1', held: true, transcriptPath: '/fixture-original', recordPath: '/fixture-record', commandId: 'not-a-receipt', issuedAt: 5000, transcriptState: 'present' }, '2')
      await source.flush(); const before = h.ledger.page().records[0]!
      source.observe(notificationFrame({ conversations: { '1': [entry({ ...patch, replyToEntryId: raw.entryId })] } }), team); await source.flush()
      expect(h.ledger.page().records[0]).toEqual(before)
      source.observe(notificationFrame({ conversations: { '1': [entry({ replyToEntryId: raw.entryId })] } }), team); await source.flush()
      expect(h.ledger.page().records[0]!.subjectState).toBe('replied')
    } finally { await source.close(); await h.owner.close() }
  })
  it('keys explicit queue replies by their actual channel and invalidates cache when only the timeline bucket changes', async () => {
    const h = notificationSourceHarness(), raw = { entryId: 'outbox:original', channelId: '1', runId: 'run-a', createdAt: 5000, held: true }
    const facts = [raw], source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false }), () => 10000), team = notificationTeam()
    const sameEntries = [entry({ replyToEntryId: raw.entryId })]
    try {
      source.observe(notificationFrame(), team); source.registerHandoff({ entryId: raw.entryId, targetChannelId: '1', held: true, transcriptPath: '/fixture', commandId: 'not-a-receipt', issuedAt: 5000 }, '2'); await source.flush()
      source.observe(notificationFrame({ conversations: { '2': sameEntries } }), team); await source.flush()
      expect(h.ledger.page().records[0]!.subjectState).toBe('held')
      source.observe(notificationFrame({ conversations: { '2': [entry({ channelId: '2', replyToEntryId: raw.entryId })] } }), team); await source.flush()
      expect(h.ledger.page().records[0]!.subjectState).toBe('held') // Correctly bucketed other-channel data is not a CH-1 receipt either.
      source.observe(notificationFrame({ conversations: { '1': sameEntries } }), team); await source.flush()
      expect(h.ledger.page().records[0]!.subjectState).toBe('replied')
    } finally { await source.close(); await h.owner.close() }
  })
})
