import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readQuestionNotificationState } from '../src/domain/question-notification'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { validateQuestionTerminalBatch, type QuestionTerminalBatch } from '../src/domain/question-terminal-receipt'
import { NOTIFICATION_SOURCE_PAYLOAD_LIMIT, type NotificationDraft } from '../src/domain/notification'
const sourceKey = `questions:${'1'.repeat(64)}`, other = `questions:${'2'.repeat(64)}`, identity = '3'.repeat(64)
const batch: QuestionTerminalBatch = { sourceKey, rows: [{ identity, status: 'submitted' }] }
const draft: NotificationDraft = { key: `question:${identity}`, category: 'sessions', eventType: 'question.state', source: 'original question', title: 'Answered', attention: 'notice', tone: 'info', state: 'resolved', scope: {}, occurredAt: 1, sourceRevision: 1 }
describe('private question terminal metadata joins the existing source transaction', () => {
  let directory: string, path: string, ledger: SqliteNotificationRepository
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'sg-question-storage-')); path = join(directory, 'private.sqlite'); ledger = new SqliteNotificationRepository(path) })
  afterEach(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }) })
  it.each(['desktop_notifications', 'desktop_notification_question_terminals', 'desktop_notification_sources'])('rolls back receipt, ledger and checkpoint together if %s rejects', table => {
    const db = new DatabaseSync(path); db.exec(`CREATE TRIGGER reject_part BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'part rejected'); END`); db.close()
    expect(() => ledger.commitSource(sourceKey, 0, {}, [draft], 1, undefined, batch)).toThrow('part rejected')
    expect(ledger.sourceState(sourceKey).revision).toBe(0); expect(ledger.page().summary).toMatchObject({ total: 0, revision: 0 }); expect(ledger.questionTerminals(sourceKey, [identity])).toEqual([])
  })
  it('restores exact immutable terminals across restart without crossing source namespaces', () => {
    ledger.commitSource(sourceKey, 0, {}, [draft], 1, undefined, batch); ledger.close(); ledger = new SqliteNotificationRepository(path)
    expect(ledger.questionTerminals(sourceKey, [identity])).toEqual(batch.rows); expect(ledger.questionTerminals(other, [identity])).toEqual([])
    expect(() => ledger.commitSource(sourceKey, 1, { changed: true }, [{ ...draft, title: 'Incorrect overwrite', sourceRevision: 2 }], 2, undefined, { sourceKey, rows: [{ identity, status: 'cancelled' }] })).toThrow('终态凭据冲突')
    expect(ledger.sourceState(sourceKey).revision).toBe(1); expect(ledger.page().records[0]?.title).toBe('Answered')
  })
  it('stale CAS, cross-source metadata and original payload limit cannot advance terminal evidence', () => {
    ledger.commitSource(sourceKey, 0, {}, [], 1)
    expect(ledger.commitSource(sourceKey, 0, {}, [draft], 1, undefined, batch).applied).toBe(false)
    expect(() => ledger.commitSource(other, 0, {}, [], 1, undefined, batch)).toThrow('跨来源')
    expect(() => ledger.commitSource(sourceKey, 1, 'a'.repeat(NOTIFICATION_SOURCE_PAYLOAD_LIMIT), [], 1, undefined, batch)).toThrow('状态过大')
    expect(ledger.questionTerminals(sourceKey, [identity])).toEqual([])
  })
  it('rejects arbitrary payloads, unknown statuses, duplicate or oversized identities and foreign namespaces', () => {
    for (const changed of [{ sourceKey, rows: [{ identity, status: 'pending' }] }, { sourceKey, rows: [{ identity, status: 'submitted', prompt: 'PRIVATE' }] }, { sourceKey, rows: [batch.rows[0], batch.rows[0]] },
      { sourceKey: `reply-source:${'1'.repeat(64)}`, rows: batch.rows }, { sourceKey, rows: Array.from({ length: 101 }, (_, i) => ({ identity: i.toString(16).padStart(64, '0'), status: 'submitted' })) }]) expect(() => validateQuestionTerminalBatch(changed as QuestionTerminalBatch)).toThrow()
    expect(() => ledger.questionTerminals(sourceKey, [identity, identity])).toThrow('查询无效')
  })
  it('migrates a real v6 three-column receipt table without inventing an original read stamp or changing a terminal', () => {
    ledger.commitSource(sourceKey, 0, {}, [draft], 1, undefined, batch); ledger.close()
    const db = new DatabaseSync(path)
    db.exec('ALTER TABLE desktop_notification_question_terminals DROP COLUMN original_stamp; UPDATE desktop_notification_meta SET schema_version=6; PRAGMA user_version=87;')
    db.close(); ledger = new SqliteNotificationRepository(path)
    expect(ledger.questionTerminals(sourceKey, [identity])).toEqual(batch.rows)
    const inspect = new DatabaseSync(path)
    try { expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(87); expect(inspect.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version).toBe(9) }
    finally { inspect.close() }
  })
  it('stores only a typed bounded original inspection hash, preserves it on legacy refinement, and rolls it back on CAS/failure', () => {
    const originalStamp = 'a'.repeat(64), changedStamp = 'b'.repeat(64)
    ledger.commitSource(sourceKey, 0, {}, [], 1, undefined, { sourceKey, rows: [{ ...batch.rows[0]!, originalStamp }] })
    ledger.commitSource(sourceKey, 1, {}, [], 2, undefined, batch)
    expect(ledger.questionTerminals(sourceKey, [identity])[0]?.originalStamp).toBe(originalStamp)
    expect(ledger.commitSource(sourceKey, 1, {}, [], 3, undefined, { sourceKey, rows: [{ ...batch.rows[0]!, originalStamp: changedStamp }] }).applied).toBe(false)
    const db = new DatabaseSync(path); db.exec("CREATE TRIGGER deny_stamp BEFORE UPDATE OF original_stamp ON desktop_notification_question_terminals BEGIN SELECT RAISE(ABORT,'stamp rejected'); END"); db.close()
    expect(() => ledger.commitSource(sourceKey, 2, { changed: true }, [draft], 3, undefined, { sourceKey, rows: [{ ...batch.rows[0]!, originalStamp: changedStamp }] })).toThrow('stamp rejected')
    expect(ledger.questionTerminals(sourceKey, [identity])[0]?.originalStamp).toBe(originalStamp); expect(ledger.sourceState(sourceKey).revision).toBe(2)
    for (const stamp of ['PRIVATE', '', 'a'.repeat(65), 1, null]) expect(() => validateQuestionTerminalBatch({ sourceKey, rows: [{ ...batch.rows[0]!, originalStamp: stamp as string }] })).toThrow()
  })
  it.each(['missing', 'malformed'])('fails closed for %s current-schema structures without reconstructing an empty history', fault => {
    ledger.commitSource(sourceKey, 0, {}, [draft], 1, undefined, batch); ledger.close()
    const db = new DatabaseSync(path); db.exec('DROP TABLE desktop_notification_question_terminals')
    if (fault === 'malformed') db.exec('CREATE TABLE desktop_notification_question_terminals(source_key TEXT,identity TEXT,status TEXT)')
    db.close(); expect(() => new SqliteNotificationRepository(path)).toThrow('终态结构异常')
    const inspect = new DatabaseSync(path)
    try { expect(inspect.prepare('SELECT COUNT(*) AS n FROM desktop_notifications').get()!.n).toBe(1); expect(inspect.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version).toBe(9) }
    finally { inspect.close() }
  })
})

describe('terminal backfill never launders malformed old checkpoint fields', () => {
  it('validates source-only metadata and real scan progress instead of retaining answers or invalid offsets', () => {
    const fact = { identity, toolCallId: 'original', blockId: 'block-original', name: 'CH-1', scope: { sessionId: 'session-original', channelId: '1' }, status: 'submitted', count: 1, actionable: false, terminated: false }
    expect(readQuestionNotificationState({ version: 1, scopeKey: sourceKey, rows: { [identity]: fact } }, sourceKey)).toMatchObject({ version: 2, indexed: false })
    expect(() => readQuestionNotificationState({ version: 1, scopeKey: sourceKey, rows: { [identity]: { ...fact, answers: ['PRIVATE'] } } }, sourceKey)).toThrow('检查点格式异常')
    expect(() => readQuestionNotificationState({ version: 2, scopeKey: sourceKey, indexed: false, indexOffset: 2, rows: { [identity]: fact } }, sourceKey)).toThrow('分批检查点异常')
    expect(() => readQuestionNotificationState({ version: 2, scopeKey: sourceKey, indexed: true, terminalScan: { signature: 'plain', offset: 0 }, rows: {} }, sourceKey)).toThrow('分批检查点异常')
  })
})
