import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { ReplyNotifications } from '../src/application/notifications/reply-notifications'
import { sessionNotificationObservation } from '../src/application/notifications/session-lifecycle-notifications'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { NOTIFICATION_SOURCE_PAYLOAD_LIMIT } from '../src/domain/notification'
import { notificationFrame, notificationTeam, notificationSession } from './fixtures/notification-session-data'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const workerEntry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!workerEntry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-reply-identity-worker-')), path = join(directory, 'notifications.sqlite'), workers: Worker[] = []
const team = notificationTeam(), now = () => 1000
function createOwner() {
  return new NotificationService(new NotificationWorkerPort(options => {
    const worker = new Worker(pathToFileURL(join(folder, workerEntry!)), options); workers.push(worker); return worker
  }, path), now)
}
const original = (id: string): ConversationEntry => ({ id: `native:${id}`, channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', timestamp: 2000,
  text: 'PRIVATE reply body not a notification', streamId: `stream:${id}`, turn: `turn:${id}` })
const canonical = (id: string): ConversationEntry => ({ ...original(id), id: `reply:canonical-${id}`, replyToEntryId: `outbox:${id}` })
const sourceKey = `reply-source:${sessionNotificationObservation(notificationFrame(), team, 1000, 1000).facts[0]!.identity}`
let owner = createOwner(), source = new ReplyNotifications(owner, now)
async function observe(entries: ConversationEntry[]) { source.observe(notificationFrame({ conversations: { '1': entries } }), team); await source.flush() }
try {
  await observe([]); await observe(['read', 'archive', 'clear'].map(original))
  const page = await owner.page()
  assert.equal(page.summary.total, 3)
  const records = new Map(page.records.map(record => [record.target!.kind === 'session' ? record.target!.entryId : '', record]))
  const first = records.get('native:read')!, archived = records.get('native:archive')!, cleared = records.get('native:clear')!
  for (const record of records.values()) await owner.read(record.id, record.revision)
  await owner.archive(archived.id); await owner.clearRead({ key: cleared.key })
  await observe(Array.from({ length: 2100 }, (_, index) => original(`later-${index}`)))
  const checkpoint = await owner.sourceState(sourceKey)
  assert.equal((checkpoint.data as { seen: string[] }).seen.length, 2000)
  assert.equal((checkpoint.data as { seen: string[] }).seen.includes(first.key.slice(6)), false)
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint.data)) <= NOTIFICATION_SOURCE_PAYLOAD_LIMIT)
  await source.close(); await owner.close()
  const inspection = new DatabaseSync(path)
  inspection.exec("CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES('original'); PRAGMA user_version=77;")
  assert.equal(inspection.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version, 9)
  assert.equal(inspection.prepare('SELECT COUNT(*) AS n FROM desktop_notification_reply_keys').get()!.n, 2103)
  assert.equal(inspection.prepare("SELECT COUNT(*) AS n FROM desktop_notification_reply_keys WHERE payload LIKE '%PRIVATE%'").get()!.n, 0)
  inspection.close()
  owner = createOwner(); source = new ReplyNotifications(owner, () => 10000)
  let liveSignals = 0; owner.subscribe(event => { if (event.announcement) ++liveSignals })
  await observe(['read', 'archive', 'clear'].map(canonical))
  const restored = await owner.page()
  assert.equal(restored.summary.total, 2101); assert.equal(restored.summary.unread, 2100); assert.equal(liveSignals, 0)
  const same = (await owner.page({ key: first.key })).records[0]!
  assert.equal(same.id, first.id); assert.equal(same.readRevision, first.attentionRevision)
  assert.equal(same.target?.kind === 'session' ? same.target.entryId : '', 'reply:canonical-read')
  const matches = await owner.replyIdentities(sourceKey, [first.key.slice(6), archived.key.slice(6), cleared.key.slice(6)])
  assert.equal(matches.length, 3); assert.equal(matches.every(match => match.row.entryId.startsWith('reply:canonical-')), true)
  // A real SQLite failure must roll back notification, metadata and checkpoint together.
  const fault = new DatabaseSync(path)
  fault.exec("CREATE TRIGGER reject_reply_identity BEFORE INSERT ON desktop_notification_reply_keys BEGIN SELECT RAISE(ABORT,'fixture index rejected'); END"); fault.close()
  const before = await owner.sourceState(sourceKey)
  await observe([original('atomic-new')]); assert.equal((await owner.page()).summary.total, 2101)
  assert.equal((await owner.sourceState(sourceKey)).revision, before.revision)
  const repair = new DatabaseSync(path); repair.exec('DROP TRIGGER reject_reply_identity'); repair.close()
  await observe([original('atomic-new')]); assert.equal((await owner.page()).summary.total, 2102)
  // Stock identities beyond the working cache are all indexed, with no new unread results.
  const stock = new ReplyNotifications(owner, () => 100000), stockFrame = notificationFrame({ sessions: [notificationSession({ generation: 1 })],
    conversations: { '1': Array.from({ length: 2300 }, (_, index) => original(`stock-${index}`)) } })
  try { stock.observe(stockFrame, team); await stock.flush(); assert.equal((await owner.page()).summary.total, 2102) } finally { await stock.close() }
  const oldStock = new ReplyNotifications(owner, () => 100000)
  try { oldStock.observe(notificationFrame({ sessions: [notificationSession({ generation: 1 })], conversations: { '1': [canonical('stock-0')] } }), team); await oldStock.flush(); assert.equal((await owner.page()).summary.total, 2102) } finally { await oldStock.close() }
  await source.close(); await owner.close()
  const final = new DatabaseSync(path)
  try {
    assert.equal(final.prepare('PRAGMA user_version').get()!.user_version, 77)
    assert.equal(final.prepare('SELECT value FROM preserve').get()!.value, 'original')
    const archivedPayload = JSON.parse(final.prepare('SELECT payload FROM desktop_notifications WHERE id=?').get(archived.id)!.payload as string)
    assert.equal(archivedPayload.archivedAt, 1000)
    assert.equal(final.prepare('SELECT COUNT(*) AS n FROM desktop_notification_tombstones WHERE semantic_key=?').get(cleared.key)!.n, 1)
    assert.equal(final.prepare('SELECT COUNT(*) AS n FROM desktop_notification_reply_keys').get()!.n, 4404)
  } finally { final.close() }
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltNotificationWorker: true,
    oldAliasesSurviveCacheEvictionAndWorkerRestart: true, readArchiveClearNotRevived: true, stockHistoryFullyIndexedInBoundedBatches: true,
    originalPayloadLimitUnchanged: true, indexLedgerCursorRollbackTogether: true, noSourceBodyOrBusinessRequest: true, unrelatedSqliteDataPreserved: true, isolated: true }, null, 2))
} finally {
  await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
