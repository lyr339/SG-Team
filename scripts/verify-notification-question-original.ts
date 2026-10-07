import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { originalQuestionStore } from './fixtures/question-original-store'
import { QuestionNotifications } from '../src/application/notifications/question-notifications'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'

// Real original channel repository/relay + actual compiled private worker.
// No production main, Cursor, model request, answer submission or OS delivery.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const workerEntry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!workerEntry) throw Error('请先构建通知 worker')
const f = originalQuestionStore(), path = join(f.directory, 'private.sqlite'), workers: Worker[] = []
const commands: Array<{ kind: string; key?: string; drafts?: unknown[] }> = []
class AuditWorker extends Worker {
  override postMessage(message: { command: typeof commands[number] }): void { commands.push(message.command); super.postMessage(message) }
}
const open = () => new NotificationService(new NotificationWorkerPort(options => {
  const worker = new AuditWorker(pathToFileURL(join(folder, workerEntry)), options); workers.push(worker); return worker
}, path))
let owner = open(), source = new QuestionNotifications(owner, () => 10000, (channel, rows, run) => f.current().relay.notificationQuestionHistory(channel, rows, run))
const observe = async (waiting = true) => { source.observe(f.frame(waiting), f.team); await source.flush() }
try {
  await observe(); f.setStatus('submitted'); await observe(false)
  const settled = (await owner.page({ eventType: 'question.state' })).records[0]!
  const sourceKey = commands.find(command => command.kind === 'sourceState')!.key!, identity = settled.key.slice(9)
  await owner.read(settled.id, settled.revision); await owner.clearRead({ key: settled.key })
  await source.close(); await owner.close()
  f.restorePending()
  owner = open(); source = new QuestionNotifications(owner, () => 10000, (channel, rows, run) => f.current().relay.notificationQuestionHistory(channel, rows, run))
  const notices: unknown[] = []; owner.subscribe(event => { if (event.announcement) notices.push(event.announcement) })
  const repository = f.current().repository, reader = repository.listRepliesSince.bind(repository), rawReplies = JSON.stringify(repository.listRepliesSince(0))
  let originalReads = 0
  repository.listRepliesSince = (...args) => { originalReads++; return reader(...args) }
  await observe()
  const mismatch = (await owner.page({ eventType: 'question.original-recheck' })).records[0]!
  assert.equal(mismatch.subjectState, 'original-pending'); assert.equal(mismatch.state, 'active'); assert.equal(mismatch.attention, 'action')
  assert.equal((await owner.page()).summary.pending, 1); assert.equal((await owner.page({ key: settled.key })).summary.total, 0)
  assert.equal(notices.length, 0); assert.equal(originalReads, 0); assert.equal(JSON.stringify(reader(0)), rawReplies)
  assert.ok(mismatch.target?.kind === 'session'); assert.equal(mismatch.target.entryId, f.entryId); assert.equal(mismatch.target.toolCallId, f.toolCallId)
  await owner.read(mismatch.id, mismatch.revision)
  const idle = commands.length
  for (let i = 0; i < 200; i++) source.observe(f.frame(), f.team)
  await source.flush(); assert.equal(commands.length, idle); assert.equal(originalReads, 0)
  await source.close(); await owner.close()
  owner = open(); source = new QuestionNotifications(owner, () => 10000, (channel, rows, run) => f.current().relay.notificationQuestionHistory(channel, rows, run))
  await observe()
  assert.equal((await owner.page()).summary.pending, 1); assert.equal((await owner.page()).summary.unread, 0)
  f.setStatus('submitted'); await observe(false)
  const confirmed = (await owner.page({ eventType: 'question.original-recheck' })).records[0]!
  assert.equal(confirmed.id, mismatch.id); assert.equal(confirmed.subjectState, 'original-confirmed'); assert.equal(confirmed.state, 'resolved')
  assert.equal((await owner.page()).summary.pending, 0); assert.equal((await owner.page()).summary.unread, 0)
  assert.equal((await owner.page({ key: settled.key })).summary.total, 0)
  await owner.clearRead({ key: mismatch.key }); await observe(false)
  assert.equal((await owner.page()).summary.total, 0)
  f.restorePending(); await observe()
  assert.equal((await owner.page()).summary.pending, 1) // Truly renewed original mismatch, not a clear replay.
  await source.close(); await owner.close()
  const inspect = new DatabaseSync(path)
  try {
    assert.equal(inspect.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version, 9)
    const row = inspect.prepare('SELECT * FROM desktop_notification_question_terminals WHERE source_key=? AND identity=?').get(sourceKey, identity)!
    assert.equal(row.status, 'submitted'); assert.match(row.original_stamp as string, /^[a-f0-9]{64}$/)
    const state = JSON.parse(inspect.prepare('SELECT payload FROM desktop_notification_sources WHERE source_key=?').get(sourceKey)!.payload as string)
    assert.equal(state.version, 3); assert.equal(state.rows[identity].recheck.phase, 'unconfirmed')
    assert.equal(state.rows[identity].status, 'submitted'); assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 2 * 1024 * 1024)
    assert.equal(/PRIVATE|originalRead|historyStamp|answers|prompt/.test(JSON.stringify(state)), false)
  } finally { inspect.close() }
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltPrivateWorker: true,
    actualOriginalSqliteVacuumBackupRestore: true, historicalTerminalAndClearedRecordNotRewritten: true,
    currentOriginalPendingDifferenceRestoresOneAction: true, observerAndWorkerRestartKeepsReadAndPendingDistinct: true,
    onlyActualMatchingOriginalWriteConfirmsDifference: true, noExtraOriginalSqlReadAnswerOrWorkflowReplay: true,
    exactOriginalQuestionNavigationReference: true, originalInspectionHashOnly: true, idleNoWorkerCommands: true, isolated: true }, null, 2))
} finally {
  await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  f.close()
}
