import { describe, expect, it, vi } from 'vitest'
import { QuestionNotifications } from '../src/application/notifications/question-notifications'
import { notificationSourceHarness } from './notification-source-fixtures'
import { originalQuestionStore } from '../scripts/fixtures/question-original-store'
import { readQuestionNotificationState } from '../src/domain/question-notification'
const connect = (f: ReturnType<typeof originalQuestionStore>, h: ReturnType<typeof notificationSourceHarness>) => new QuestionNotifications(h.owner, () => 10000,
  (channel, entries, run) => f.current().relay.notificationQuestionHistory(channel, entries, run))
const observe = async (source: QuestionNotifications, f: ReturnType<typeof originalQuestionStore>, waiting = true) => { source.observe(f.frame(waiting), f.team); await source.flush() }

describe('real original question store versus a retained private terminal', () => {
  it('does not silently call a restored original pending row answered, while keeping its previous terminal evidence unchanged', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = new QuestionNotifications(h.owner, () => 10000,
      (channel, entries, run) => f.current().relay.notificationQuestionHistory(channel, entries, run))
    try {
      source.observe(f.frame(), f.team); await source.flush()
      f.setStatus('submitted'); source.observe(f.frame(false), f.team); await source.flush()
      const settled = h.ledger.page({ eventType: 'question.state' }).records[0]!
      await h.owner.read(settled.id, settled.revision)
      f.restorePending(); source.observe(f.frame(), f.team); await source.flush()
      expect(h.ledger.page({ eventType: 'question.state' }).records[0]?.subjectState).toBe('submitted')
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).summary).toMatchObject({ total: 1, pending: 1, unread: 1 })
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).records[0]?.detail).toContain('历史回执不会被覆盖')
      expect(JSON.stringify(h.ledger.page())).not.toContain('PRIVATE')
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
  it('a stored pending view read BEFORE the native terminal is not a newly restored contradiction', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = connect(f, h)
    try {
      await observe(source, f)
      const native = f.frame(false)
      native.liveProcess = { '1': { blocks: [f.block('submitted')], turn: 'native:original-turn', startedAt: 1500, updatedAt: 4000, generating: false } }
      source.observe(native, f.team); await source.flush()
      const original = h.ledger.page().records[0]!
      await observe(source, f)
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).summary.total).toBe(0)
      expect(h.ledger.page({ eventType: 'question.state' }).records[0]?.subjectState).toBe('submitted')
      const key = vi.mocked(h.port.sourceState).mock.calls[0]![0]
      expect(h.ledger.questionTerminals(key, [original.key.slice(9)])[0]?.originalStamp).toMatch(/^[a-f0-9]{64}$/)
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
  it('keeps the mismatch through clipped or unproved frames, but an actual original matching write resolves it without answering', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = connect(f, h)
    try {
      await observe(source, f); f.setStatus('submitted'); await observe(source, f, false)
      f.restorePending(); await observe(source, f)
      const mismatch = h.ledger.page({ eventType: 'question.original-recheck' }).records[0]!
      await h.owner.read(mismatch.id, mismatch.revision)
      const writes = vi.mocked(h.port.commitSource).mock.calls.length
      for (let i = 0; i < 100; i++) source.observe(f.frame(), f.team)
      await source.flush(); expect(h.port.commitSource).toHaveBeenCalledTimes(writes)
      const unproved = f.frame(); unproved.conversations = {}; unproved.liveProcess = { '1': { blocks: [f.block('submitted')], turn: 'legacy:late', startedAt: 1000, updatedAt: 6000, generating: false } }
      source.observe(unproved, f.team); await source.flush()
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).records[0]?.state).toBe('active')
      f.setStatus('submitted'); await observe(source, f, false)
      const confirmed = h.ledger.page({ eventType: 'question.original-recheck' }).records[0]!
      expect(confirmed).toMatchObject({ id: mismatch.id, state: 'resolved', subjectState: 'original-confirmed', readRevision: mismatch.attentionRevision })
      expect(h.ledger.page().summary.pending).toBe(0)
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
  it('warns on a different newly read native terminal without replacing the immutable historical terminal', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = connect(f, h)
    try {
      await observe(source, f); f.setStatus('submitted'); await observe(source, f, false)
      const settled = h.ledger.page({ eventType: 'question.state' }).records[0]!
      f.setStatus('cancelled'); await observe(source, f, false)
      expect(h.owner.status().historyIncomplete).toBe(false)
      const note = h.ledger.page({ eventType: 'question.original-recheck' }).records[0]!
      expect(note).toMatchObject({ subjectState: 'original-cancelled', attention: 'notice', state: 'active' })
      expect(h.ledger.page({ eventType: 'question.state' }).records[0]?.id).toBe(settled.id)
      expect(h.ledger.page({ eventType: 'question.state' }).records[0]?.subjectState).toBe('submitted')
      const key = vi.mocked(h.port.sourceState).mock.calls[0]![0]
      expect(h.ledger.questionTerminals(key, [settled.key.slice(9)])[0]?.status).toBe('submitted')
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
  it('rejects cloned/foreign original arrays and a proof that became obsolete during the private metadata lookup', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = connect(f, h)
    try {
      await observe(source, f); f.setStatus('submitted'); await observe(source, f, false)
      f.restorePending()
      const current = f.frame(), rows = current.conversations['1']!
      expect(f.current().relay.notificationQuestionHistory('1', [...rows], 'run-a')).toBeUndefined()
      expect(f.current().relay.notificationQuestionHistory('1', rows, 'foreign-run')).toBeUndefined()
      let entered!: () => void, release!: () => void
      const started = new Promise<void>(done => { entered = done }), paused = new Promise<void>(done => { release = done })
      vi.mocked(h.port.questionTerminals!).mockImplementationOnce(async (...args) => { entered(); await paused; return h.ledger.questionTerminals(...args) })
      source.observe(current, f.team); await started
      f.setStatus('submitted'); release(); await source.flush()
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).summary.total).toBe(0)
      await observe(source, f, false); expect(h.ledger.page().summary.pending).toBe(0)
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
  it('uses the same checkpoint and 100-draft budget for a burst of original contradictions, preserving all terminal stamps beyond the cache', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = connect(f, h)
    const blocks = (status: 'submitted' | 'pending', count: number) => Array.from({ length: count }, (_, i) => ({ ...f.block(status), id: `block:${i}`, question: { ...f.block(status).question!, toolCallId: `question:${i}` } }))
    const set = (status: 'submitted' | 'pending', count: number) => f.current().relay.attachProcessToReply(f.entryId, { turn: 'large-original', blocks: blocks(status, count), startedAt: 1500, updatedAt: 6000, generating: status === 'pending' })
    try {
      set('submitted', 650); await observe(source, f, false)
      const key = vi.mocked(h.port.sourceState).mock.calls[0]![0], state = readQuestionNotificationState(h.ledger.sourceState(key).data, key)!
      expect(Object.keys(state.rows)).toHaveLength(512)
      const before = vi.mocked(h.port.commitSource).mock.calls.length
      set('pending', 220); await observe(source, f)
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).summary).toMatchObject({ total: 220, unread: 220, pending: 220 })
      expect(vi.mocked(h.port.commitSource).mock.calls.slice(before).filter(([, , , drafts]) => drafts.length).map(([, , , drafts]) => drafts.length)).toEqual([100, 100, 20])
      expect(h.port.sourceState).toHaveBeenCalledTimes(1)
      expect(h.owner.status().historyIncomplete).toBe(false)
      expect(JSON.stringify(h.ledger.sourceState(key).data)).not.toMatch(/originalRead|historyStamp|PRIVATE/)
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
  it('does not advance a terminal metadata slice past conflicts that lost the shared draft budget to genuinely new pending questions', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = connect(f, h)
    const make = (prefix: string, status: 'submitted' | 'pending' | 'cancelled', count: number) => Array.from({ length: count }, (_, i) => ({ ...f.block(status), id: `${prefix}-block:${i}`,
      question: { ...f.block(status).question!, toolCallId: `${prefix}-question:${i}` } }))
    const set = (blocks: ReturnType<typeof make>) => f.current().relay.attachProcessToReply(f.entryId, { turn: 'mixed-native', blocks, startedAt: 1500, updatedAt: 8000, generating: false })
    try {
      set(make('known', 'submitted', 120)); await observe(source, f, false)
      set([...make('new', 'pending', 110), ...make('known', 'cancelled', 120)])
      await observe(source, f)
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).summary.total).toBe(120)
      expect(h.ledger.page({ eventType: 'question.state' }).summary.pending).toBe(110)
      expect(h.owner.status().historyIncomplete).toBe(false)
      expect(vi.mocked(h.port.commitSource).mock.calls.every(([, , , drafts]) => drafts.length <= 100)).toBe(true)
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
  it('preserves a mismatch while suspected or clipped, removes the pending action on a positive no-wait fact, and expires it only on real stop', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = connect(f, h)
    try {
      await observe(source, f); f.setStatus('submitted'); await observe(source, f, false); f.restorePending(); await observe(source, f)
      const clipped = f.frame(); clipped.conversations = {}
      clipped.sessions[0]!.awaitingUserEvidence = 'unknown'; clipped.sessions[0]!.awaitingUser = false
      clipped.sessions[0]!.online = false; clipped.sessions[0]!.runtimeEvidence = 'suspected'
      source.observe(clipped, f.team); await source.flush(); expect(h.ledger.page().summary.pending).toBe(1)
      clipped.sessions[0]!.awaitingUserEvidence = 'runtime'
      source.observe(clipped, f.team); await source.flush(); expect(h.ledger.page().summary.pending).toBe(0)
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).records[0]?.state).toBe('active')
      clipped.sessions[0]!.runtimeEvidence = 'stopped'; clipped.sessions[0]!.connectionPhase = 'cursor_stopped'
      source.observe(clipped, f.team); await source.flush()
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).records[0]?.subjectState).toBe('original-unavailable')
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
  it('refines an unresolved comparison to the actual newly stored block without renewing unread or overwriting the old terminal', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = connect(f, h)
    try {
      await observe(source, f); f.setStatus('submitted'); await observe(source, f, false); f.restorePending(); await observe(source, f)
      const before = h.ledger.page({ eventType: 'question.original-recheck' }).records[0]!
      await h.owner.read(before.id, before.revision)
      f.current().relay.attachProcessToReply(f.entryId, { turn: 'canonical-refinement', blocks: [{ ...f.block('pending'), id: 'actual-new-block' }], startedAt: 1500, updatedAt: 9000, generating: false })
      await observe(source, f)
      const after = h.ledger.page({ eventType: 'question.original-recheck' }).records[0]!
      expect(after).toMatchObject({ id: before.id, target: { blockId: 'actual-new-block' }, attentionRevision: before.attentionRevision, readRevision: before.attentionRevision })
      expect(h.ledger.page({ eventType: 'question.original-recheck' }).summary.unread).toBe(0)
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
  it('keeps the new checkpoint metadata strict and never accepts a persisted read grant or impossible comparison phase', async () => {
    const f = originalQuestionStore(), h = notificationSourceHarness(), source = connect(f, h)
    try {
      await observe(source, f); f.setStatus('submitted'); await observe(source, f, false); f.restorePending(); await observe(source, f)
      const key = vi.mocked(h.port.sourceState).mock.calls[0]![0], state = readQuestionNotificationState(h.ledger.sourceState(key).data, key)!
      const [identity, fact] = Object.entries(state.rows)[0]!
      for (const patch of [{ originalRead: true }, { historyStamp: 'a'.repeat(64) }, { recheck: { ...fact.recheck, answers: ['PRIVATE'] } },
        { recheck: { originalStatus: 'submitted', phase: 'unconfirmed', actionable: false } }, { recheck: { originalStatus: 'pending', phase: 'confirmed', actionable: false } }])
        expect(() => readQuestionNotificationState({ ...state, rows: { [identity]: { ...fact, ...patch } } }, key)).toThrow('检查点格式异常')
      expect(() => readQuestionNotificationState({ ...state, version: 4 }, key)).toThrow()
    } finally { await source.close(); await h.owner.close(); f.close() }
  })
})
