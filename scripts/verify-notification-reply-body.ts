import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { NotificationService } from '../src/application/notification-service'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { ReplyNotifications } from '../src/application/notifications/reply-notifications'
import { originalReplyStore } from './fixtures/reply-original-store'
import { notificationFrame } from './fixtures/notification-session-data'

// Real original channel row/backup + current compiled private worker. No model,
// production main, account, message send/retry or physical system notification.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const f = originalReplyStore(), workers: Worker[] = [], path = join(f.directory, 'private.sqlite'), commands: string[] = []
class AuditWorker extends Worker { override postMessage(message: { command: { kind: string } }): void { commands.push(message.command.kind); super.postMessage(message) } }
const open = () => new NotificationService(new NotificationWorkerPort(options => {
  const worker = new AuditWorker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, path), () => 10000)
let owner = open(), source = new ReplyNotifications(owner, () => 1000)
const observe = async () => { source.observe(f.frame(), f.team); await source.flush() }
try {
  f.replaceBody('PRIVATE newer reply already observed')
  source.observe(notificationFrame(), f.team); await source.flush(); await observe()
  const first = (await owner.page()).records[0]!
  assert.ok(first.target?.kind === 'session' && first.target.replyBody)
  const originalDigest = first.target.replyBody.digest
  await owner.read(first.id, first.revision); await source.close(); await owner.close()
  f.restore()
  owner = open(); source = new ReplyNotifications(owner, () => 10000)
  let originalReads = 0
  const repository = f.current().repository, read = repository.listRepliesSince.bind(repository), raw = JSON.stringify(read(0))
  repository.listRepliesSince = (...args) => { originalReads++; return read(...args) }
  const notices: unknown[] = []; owner.subscribe(event => { if (event.announcement) notices.push(event.announcement) })
  await observe()
  const updated = (await owner.page()).records[0]!
  assert.equal(updated.id, first.id); assert.equal(updated.subjectState, 'body-changed'); assert.equal(updated.timeBasis, 'observed')
  assert.equal((await owner.page()).summary.unread, 1); assert.equal(updated.occurredAt, 10000)
  assert.ok(updated.target?.kind === 'session' && updated.target.replyBody)
  assert.notEqual(updated.target.replyBody.digest, originalDigest); assert.equal(updated.target.entryId, f.entryId)
  assert.equal(originalReads, 0); assert.equal(JSON.stringify(read(0)), raw); assert.equal(notices.length, 0)
  assert.equal(/PRIVATE|sg-reply-original-|original older reply/.test(JSON.stringify(await owner.page())), false)
  await owner.read(updated.id, updated.revision)
  const idle = commands.length
  for (let i = 0; i < 200; i++) source.observe(f.frame(), f.team)
  await source.flush(); assert.equal(commands.length, idle); assert.equal(originalReads, 0)
  await source.close(); await owner.close()
  owner = open(); source = new ReplyNotifications(owner, () => 10000); await observe()
  assert.equal((await owner.page()).summary.unread, 0); assert.equal((await owner.page()).records[0]?.attentionRevision, updated.attentionRevision)
  await owner.clearRead({ key: updated.key }); await observe(); assert.equal((await owner.page()).summary.total, 0)
  await source.close(); await owner.close()
  const inspect = new DatabaseSync(path)
  try {
    const rows = inspect.prepare('SELECT payload FROM desktop_notification_reply_keys').all()
    assert.equal(rows.length, 1); const row = JSON.parse(rows[0]!.payload as string)
    assert.equal(row.bodyDigest, updated.target.replyBody.digest); assert.equal(row.recorded, true)
    assert.equal(/PRIVATE|body already observed/.test(JSON.stringify(rows)), false)
    const state = JSON.parse(inspect.prepare('SELECT payload FROM desktop_notification_sources LIMIT 1').get()!.payload as string)
    assert.equal(state.version, 4); assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 2 * 1024 * 1024)
    assert.equal(inspect.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version, 8)
  } finally { inspect.close() }
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltPrivateWorker: true, actualOriginalSqliteReplyBackupRestore: true,
    sameIdDifferentBodyIsOneNewObservedVersion: true, historicalReadNotUsedForReplacementBody: true, digestAndReadSurviveWorkerRestart: true,
    clearedIdenticalContentNotReplayed: true, opaqueActorScopedDigestOnly: true, noExtraOriginalReadOrMessageReplay: true, idleNoWorkerCommands: true, isolated: true }, null, 2))
} finally {
  await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  f.close()
}
