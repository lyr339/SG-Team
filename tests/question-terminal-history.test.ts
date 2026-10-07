import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { QuestionNotifications } from '../src/application/notifications/question-notifications'
import type { ProcessBlock, ConversationEntry } from '../src/domain/conversation-entry'
import { notificationFrame, notificationSession, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
const block = (id: string, status: 'pending' | 'submitted' | 'cancelled'): ProcessBlock => ({ kind: 'tool', id: `block:${id}`, toolName: 'ask_question', status: status === 'pending' ? 'running' : 'done',
  question: { toolCallId: id, status, questions: [{ id: 'q', prompt: 'PRIVATE prompt', allowMultiple: false, options: [{ id: 'a', label: 'PRIVATE option' }] }] } })
const entry = (id: string, status: 'pending' | 'submitted' | 'cancelled'): ConversationEntry => ({ id: `native:${id}`, channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', text: 'PRIVATE body', timestamp: 1000, processBlocks: [block(id, status)] })
const observe = async (source: QuestionNotifications, entries: ConversationEntry[], waiting = true) => { source.observe(notificationFrame({ sessions: [notificationSession({ awaitingUser: waiting, awaitingUserEvidence: 'runtime' })], conversations: { '1': entries } }), notificationTeam()); await source.flush() }
describe('question terminal facts outlive the passive working cache', () => {
  it.each(['submitted', 'cancelled'] as const)('does not reopen a cleared %s question after 600 unrelated terminal questions evict its checkpoint row', async status => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner)
    try {
      await observe(source, [entry('original', 'pending')]); await observe(source, [entry('original', status)], false)
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision); await h.owner.clearRead({})
      await observe(source, [entry('original', status), ...Array.from({ length: 600 }, (_, i) => entry(`later:${i}`, 'submitted'))], false)
      await source.close(); const restored = new QuestionNotifications(h.owner)
      await observe(restored, [entry('original', 'pending'), entry('genuine:new', 'pending')]); await restored.close()
      expect(h.ledger.page().summary).toMatchObject({ total: 1, pending: 1 })
      expect(h.ledger.marker(first.key).cleared).toBe(true)
      expect(h.ledger.page().records[0]?.target).toMatchObject({ toolCallId: 'genuine:new' })
      expect(JSON.stringify(h.ledger.page())).not.toContain('PRIVATE')
    } finally { await source.close(); await h.owner.close() }
  })
})

const keyOf = (h: ReturnType<typeof notificationSourceHarness>) => vi.mocked(h.port.commitSource).mock.calls[0]![0]
describe('question terminal transport preserves facts, not a larger cache', () => {
  it('restores the terminal receipt across a private database restart without reopening a human-read result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sg-question-restart-')), path = join(directory, 'private.sqlite')
    let h = notificationSourceHarness(path), source = new QuestionNotifications(h.owner)
    try {
      await observe(source, [entry('original', 'pending')]); await observe(source, [entry('original', 'submitted')], false)
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision)
      await observe(source, [entry('original', 'submitted'), ...Array.from({ length: 600 }, (_, i) => entry(`later:${i}`, 'submitted'))], false)
      expect((h.ledger.sourceState(keyOf(h)).data as any).rows[first.key.slice(9)]).toBeUndefined()
      await source.close(); await h.owner.close(); h = notificationSourceHarness(path); source = new QuestionNotifications(h.owner)
      await observe(source, [entry('original', 'pending')])
      expect(h.ledger.page().summary).toMatchObject({ total: 1, pending: 0, unread: 0 })
      expect(h.ledger.page().records[0]).toMatchObject({ id: first.id, subjectState: 'submitted', readRevision: first.attentionRevision })
    } finally { await source.close(); await h.owner.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('indexes all initial stock terminals in bounded batches while retaining a genuinely pending action', async () => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner)
    try {
      const history = Array.from({ length: 1600 }, (_, i) => entry(`stock:${i}`, 'submitted'))
      await observe(source, [entry('still:pending', 'pending'), ...history])
      expect(h.ledger.page().summary).toMatchObject({ total: 1, pending: 1 })
      const writes = vi.mocked(h.port.commitSource).mock.calls
      expect(writes.filter(call => call[6]?.rows.length).map(call => call[6]!.rows.length)).toEqual(Array(16).fill(100))
      expect((h.ledger.sourceState(keyOf(h)).data as any).rows).toHaveProperty(h.ledger.page().records[0]!.key.slice(9))
      const previous = writes.length
      await observe(source, [entry('still:pending', 'pending'), ...history, entry('new:terminal', 'cancelled')])
      expect(vi.mocked(h.port.commitSource).mock.calls.length - previous).toBe(1)
      await observe(source, [entry('stock:0', 'pending'), entry('still:pending', 'pending')])
      expect(h.ledger.page().summary.pending).toBe(1)
      expect(h.owner.status().health).toBe('ready')
    } finally { await source.close(); await h.owner.close() }
  })
  it('a failed receipt transaction advances neither terminal scan nor notification state, and the next original frame resumes it', async () => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner)
    let writes = 0
    vi.mocked(h.port.commitSource).mockImplementation(async (...args) => { if (++writes === 2) throw Error('second batch refused'); return h.ledger.commitSource(...args) })
    const history = Array.from({ length: 230 }, (_, i) => entry(`stock:${i}`, 'submitted'))
    try {
      await observe(source, history, false)
      expect(h.ledger.sourceState(keyOf(h))).toMatchObject({ revision: 1, data: { terminalScan: { offset: 100 } } })
      await observe(source, history, false); expect((h.ledger.sourceState(keyOf(h)).data as any).terminalScan).toBeUndefined()
      await observe(source, [entry('stock:0', 'pending'), entry('stock:220', 'pending'), entry('genuine:new', 'pending')])
      expect(h.ledger.page().summary).toMatchObject({ total: 1, pending: 1 })
    } finally { await source.close(); await h.owner.close() }
  })
  it('reloads a lost ACK and rebases a CAS conflict without reviving a cleared answer', async () => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner)
    try {
      await observe(source, [entry('original', 'pending')])
      vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { h.ledger.commitSource(...args); throw Error('ACK lost after commit') })
      await observe(source, [entry('original', 'submitted')], false); await observe(source, [entry('original', 'submitted')], false)
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision); await h.owner.clearRead({})
      vi.mocked(h.port.commitSource).mockImplementationOnce(async (key, expected, data, drafts, now, replies, questions) => {
        h.ledger.commitSource(key, expected, h.ledger.sourceState(key).data, [], now)
        return h.ledger.commitSource(key, expected, data, drafts, now, replies, questions)
      })
      await observe(source, [entry('original', 'pending'), entry('genuine:new', 'pending')])
      expect(h.ledger.marker(first.key).cleared).toBe(true); expect(h.ledger.page().summary.pending).toBe(1)
    } finally { await source.close(); await h.owner.close() }
  })
  it('old delayed terminal metadata cannot confirm a projection after a private storage generation changes', async () => {
    let lifecycle!: (event: { state: 'unavailable' | 'recovered'; generation: number }) => void
    const h = notificationSourceHarness(':memory:', listener => { lifecycle = listener; return () => {} }), source = new QuestionNotifications(h.owner)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
    try {
      await observe(source, [entry('original', 'pending')]); await observe(source, [entry('original', 'submitted')], false)
      vi.mocked(h.port.questionTerminals!).mockImplementationOnce(async (key, ids) => { const result = h.ledger.questionTerminals(key, ids); entered(); await held; return result })
      const waiting = observe(source, [entry('genuine:new', 'pending')]); await started
      lifecycle({ state: 'unavailable', generation: 1 }); lifecycle({ state: 'recovered', generation: 2 }); release(); await waiting
      expect(h.ledger.page().summary.pending).toBe(0)
      await observe(source, [entry('genuine:new', 'pending')]); expect(h.ledger.page().summary.pending).toBe(1)
    } finally { release?.(); await source.close(); await h.owner.close() }
  })
  it('backfills only legacy terminal rows actually retained, and preserves unrelated SQLite schema/data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sg-question-legacy-')), path = join(directory, 'private.sqlite')
    let h = notificationSourceHarness(path), source = new QuestionNotifications(h.owner)
    try {
      await observe(source, Array.from({ length: 220 }, (_, i) => entry(`stock:${i}`, 'submitted')), false)
      const key = keyOf(h), data = h.ledger.sourceState(key).data as any
      await source.close(); await h.owner.close()
      const db = new DatabaseSync(path)
      db.prepare('UPDATE desktop_notification_sources SET payload=? WHERE source_key=?').run(JSON.stringify({ version: 1, scopeKey: key, rows: data.rows }), key)
      db.exec("UPDATE desktop_notification_meta SET schema_version=5; DROP TABLE desktop_notification_question_terminals; CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES('original'); PRAGMA user_version=87;"); db.close()
      h = notificationSourceHarness(path); source = new QuestionNotifications(h.owner)
      await observe(source, [entry('stock:0', 'pending'), entry('genuine:new', 'pending')])
      expect(h.ledger.page().summary.pending).toBe(1)
      expect(vi.mocked(h.port.commitSource).mock.calls.slice(0, 3).map(call => call[6]?.rows.length)).toEqual([100, 100, 20])
      const inspect = new DatabaseSync(path)
      try { expect(inspect.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version).toBe(8); expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(87); expect(inspect.prepare('SELECT value FROM preserve').get()!.value).toBe('original') }
      finally { inspect.close() }
    } finally { await source.close(); await h.owner.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('late entry references update the same action without renewing human read attention', async () => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner)
    try {
      source.observe(notificationFrame({ sessions: [notificationSession({ awaitingUser: true })], liveProcess: { '1': { blocks: [block('original', 'pending')], startedAt: 1000, updatedAt: 1000, generating: false, turn: 'turn-original' } } }), notificationTeam()); await source.flush()
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision)
      await observe(source, [entry('original', 'pending')])
      expect(h.ledger.page().records[0]).toMatchObject({ id: first.id, attentionRevision: first.attentionRevision, readRevision: first.attentionRevision, target: { entryId: 'native:original' } })
      expect(h.ledger.page().summary.total).toBe(1)
    } finally { await source.close(); await h.owner.close() }
  })
})

describe('passive metadata is not human reading', () => {
  it('late sealed references or stopped state cannot silently downgrade an unread answer to activity', async () => {
    const h = notificationSourceHarness(), source = new QuestionNotifications(h.owner)
    try {
      await observe(source, [entry('original', 'pending')]); await observe(source, [entry('original', 'submitted')], false)
      const first = h.ledger.page().records[0]!
      expect(h.ledger.page().summary.unread).toBe(1)
      const sealed = { ...entry('original', 'submitted'), id: 'native:late-sealed' }
      await observe(source, [sealed], false)
      source.observe(notificationFrame({ sessions: [notificationSession({ online: false, connected: false, runtimeEvidence: 'stopped', awaitingUser: false })], conversations: { '1': [sealed] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ id: first.id, attention: 'notice', attentionRevision: first.attentionRevision })
      expect(h.ledger.page().summary.unread).toBe(1)
    } finally { await source.close(); await h.owner.close() }
  })
})
