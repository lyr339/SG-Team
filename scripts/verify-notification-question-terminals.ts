import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { NotificationService } from '../src/application/notification-service'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { QuestionNotifications } from '../src/application/notifications/question-notifications'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { notificationFrame, notificationSession, notificationTeam } from './fixtures/notification-session-data'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const workerEntry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!workerEntry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-question-terminal-worker-')), path = join(directory, 'private.sqlite'), workers: Worker[] = []
function createOwner() { return new NotificationService(new NotificationWorkerPort(options => { const worker = new Worker(pathToFileURL(join(folder, workerEntry!)), options); workers.push(worker); return worker }, path), () => 1000) }
const entry = (id: string, status: 'pending' | 'submitted' | 'cancelled'): ConversationEntry => ({ id: `native:${id}`, channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', timestamp: 1000, text: 'PRIVATE original body',
  processBlocks: [{ kind: 'tool', id: `block:${id}`, toolName: 'ask_question', status: status === 'pending' ? 'running' : 'done', question: { toolCallId: id, status,
    questions: [{ id: 'q', prompt: 'PRIVATE prompt', allowMultiple: false, options: [{ id: 'a', label: 'PRIVATE option' }] }] } }] })
let owner = createOwner(), source = new QuestionNotifications(owner, () => 1000)
const observe = async (entries: ConversationEntry[], waiting = true) => { source.observe(notificationFrame({ sessions: [notificationSession({ awaitingUser: waiting, awaitingUserEvidence: 'runtime' })], conversations: { '1': entries } }), notificationTeam()); await source.flush() }
try {
  await observe([entry('read', 'pending'), entry('clear', 'pending')])
  await observe([entry('read', 'submitted'), entry('clear', 'cancelled')], false)
  const original = await owner.page(), read = original.records.find(record => record.target?.kind === 'session' && record.target.toolCallId === 'read')!, clear = original.records.find(record => record.target?.kind === 'session' && record.target.toolCallId === 'clear')!
  for (const record of original.records) await owner.read(record.id, record.revision)
  await owner.clearRead({ key: clear.key })
  await observe([entry('read', 'submitted'), entry('clear', 'cancelled'), ...Array.from({ length: 1600 }, (_, index) => entry(`stock:${index}`, 'submitted'))], false)
  await source.close(); await owner.close()
  const inspect = new DatabaseSync(path)
  inspect.exec("CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES('original'); PRAGMA user_version=87;")
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM desktop_notification_question_terminals').get()!.n, 1602)
  const stored = inspect.prepare('SELECT source_key FROM desktop_notification_question_terminals LIMIT 1').get()!.source_key as string
  const cached = JSON.parse(inspect.prepare('SELECT payload FROM desktop_notification_sources WHERE source_key=?').get(stored)!.payload as string)
  assert.equal(Object.keys(cached.rows).length, 512); assert.equal(cached.rows[clear.key.slice(9)], undefined)
  assert.equal(inspect.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version, 7)
  inspect.close()
  owner = createOwner(); source = new QuestionNotifications(owner, () => 1000)
  let announcements = 0; owner.subscribe(event => { if (event.announcement) ++announcements })
  await observe([entry('read', 'pending'), entry('clear', 'pending'), entry('genuine:new', 'pending')])
  assert.equal((await owner.page()).summary.pending, 1); assert.equal((await owner.page()).summary.total, 2); assert.equal(announcements, 0)
  assert.equal((await owner.page({ key: read.key })).records[0]!.readRevision, read.attentionRevision)
  const fault = new DatabaseSync(path)
  fault.exec("CREATE TRIGGER reject_question_terminal BEFORE INSERT ON desktop_notification_question_terminals BEGIN SELECT RAISE(ABORT,'fixture rejected'); END"); fault.close()
  const before = await owner.sourceState(stored)
  await observe([entry('genuine:new', 'submitted')], false)
  assert.equal((await owner.sourceState(stored)).revision, before.revision); assert.equal((await owner.page()).summary.pending, 1)
  const repair = new DatabaseSync(path); repair.exec('DROP TRIGGER reject_question_terminal'); repair.close()
  await observe([entry('genuine:new', 'submitted')], false); assert.equal((await owner.page()).summary.pending, 0)
  const unread = (await owner.page()).summary.unread
  await observe([{ ...entry('genuine:new', 'submitted'), id: 'native:late-sealed' }], false)
  assert.equal((await owner.page()).summary.unread, unread)
  await source.close(); await owner.close()
  const final = new DatabaseSync(path)
  try {
    assert.equal(final.prepare('PRAGMA user_version').get()!.user_version, 87); assert.equal(final.prepare('SELECT value FROM preserve').get()!.value, 'original')
    assert.equal(final.prepare('SELECT COUNT(*) AS n FROM desktop_notification_question_terminals').get()!.n, 1603)
    assert.equal(final.prepare('SELECT COUNT(*) AS n FROM desktop_notification_tombstones WHERE semantic_key=?').get(clear.key)!.n, 1)
    const columns = final.prepare('PRAGMA table_info(desktop_notification_question_terminals)').all().map(row => row.name)
    assert.deepEqual(columns, ['source_key', 'identity', 'status', 'original_stamp'])
    const receiptRows = final.prepare('SELECT * FROM desktop_notification_question_terminals').all()
    assert.equal(JSON.stringify(receiptRows).includes('PRIVATE'), false)
  } finally { final.close() }
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltNotificationWorker: true,
    terminalEvidenceSurvives512WindowAndWorkerRestart: true, clearedQuestionNotReopenedByStalePending: true,
    genuinePendingStillRestores: true, passiveRefinementDoesNotConsumeUnread: true, receiptLedgerCheckpointRollbackTogether: true, noQuestionBodyOrBusinessRequest: true,
    originalUserVersionAndUnrelatedDataPreserved: true, isolated: true }, null, 2))
} finally {
  await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
