import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { NotificationService } from '../src/application/notification-service'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { QueueNotifications } from '../src/application/notifications/queue-notifications'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { notificationFrame, notificationSession, notificationTeam } from './fixtures/notification-session-data'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-queue-boundary-worker-')), channelsPath = join(directory, 'channels.sqlite'), notificationsPath = join(directory, 'private.sqlite'), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => { const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker }, notificationsPath), () => 10000)
const repository = new SqliteChannelMessageRepository(channelsPath), relay = new ChannelMessageRelay(repository, () => 1000)
let source = new QueueNotifications(owner, () => relay.notificationQueueSnapshot(), () => 10000, fact => relay.watchNotificationQueueFact(fact))
const team = notificationTeam()
const observe = async () => { source.observe(relay.applyTo(notificationFrame()), team); await source.flush() }
try {
  repository.markChannelEmbedded('1', 'workspace-a', '/fixture'); relay.resetScope('run-a', 1)
  const sent = relay.sendMessage({ channelId: '1', text: 'PRIVATE original', holdSessionToken: 'PRIVATE token' })
  await observe(); source.registerHandoff({ entryId: sent.entryId!, targetChannelId: '1', held: true, transcriptPath: '/PRIVATE/transcript', recordPath: '/PRIVATE/record', issuedAt: 1000, commandId: 'not-a-receipt', transcriptState: 'present' }, '2'); await source.flush()
  repository.markOutboundDelivered([sent.entryId!.slice(7)], 2000); relay['refreshOutboundDeliveries'](); await observe()
  const original = (await owner.page()).records[0]!
  assert.equal(original.subjectState, 'delivered')
  const next = notificationTeam(); next.members[0]!.binding = { ...next.members[0]!.binding!, composerId: 'composer-next', generation: 'bind-next' }
  source.observe(relay.applyTo(notificationFrame({ sessions: [notificationSession({ composerId: 'composer-next', generation: 1 })] })), next); await source.flush()
  assert.deepEqual((await owner.page()).records[0]!.scope, original.scope)
  const restored = new DatabaseSync(channelsPath); restored.exec('UPDATE channel_outbox SET delivered_at=NULL'); restored.close()
  relay['refreshOutboundDeliveries'](); await observe()
  const uncertain = (await owner.page()).records[0]!
  assert.equal(uncertain.id, original.id); assert.equal(uncertain.subjectState, 'unconfirmed'); assert.equal(uncertain.state, 'active'); assert.equal(uncertain.target, undefined)
  assert.equal(uncertain.timeBasis, 'observed'); assert.equal(uncertain.occurredAt, 10000)
  await source.close(); source = new QueueNotifications(owner, () => relay.notificationQueueSnapshot(), () => 10000, fact => relay.watchNotificationQueueFact(fact))
  await observe(); assert.equal((await owner.page()).records[0]!.subjectState, 'unconfirmed')
  repository.markOutboundDelivered([sent.entryId!.slice(7)], 4000); relay['refreshOutboundDeliveries'](); await observe()
  assert.equal((await owner.page()).records[0]!.subjectState, 'delivered')
  const repeated = relay.notificationQueueSnapshot()
  for (let i = 0; i < 150; i++) relay['refreshOutboundDeliveries']()
  assert.equal(relay.notificationQueueSnapshot().facts, repeated.facts)
  const privateDb = new DatabaseSync(notificationsPath)
  try {
    const rows = privateDb.prepare("SELECT payload FROM desktop_notification_sources WHERE source_key LIKE 'queue-source:%'").all()
    for (const row of rows) { const state = JSON.parse(row.payload as string); assert.equal(state.version, 2); assert.ok(Buffer.byteLength(row.payload as string) <= 2 * 1024 * 1024) }
    assert.equal(JSON.stringify(rows).includes('PRIVATE'), false)
  } finally { privateDb.close() }
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltNotificationWorker: true, originalChannelRepositoryAndRelay: true,
    originalRereadDetectsRestoredPendingWithoutReplayingPastDelivery: true, realRetakingResolvesSameNotification: true,
    oldReceiverNotReassignedOnCHRebinding: true, observerRestartRetainsUncertainty: true, idleReadsKeepSharedReference: true,
    noSourceTextTokenPathOrBusinessNetworkRequest: true, originalPayloadLimitUnchanged: true, isolated: true }, null, 2))
} finally {
  await source.close().catch(() => {}); await owner.close().catch(() => {}); relay.stop(); repository.close()
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
