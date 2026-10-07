import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { NotificationDeliveryService } from '../src/application/notification-delivery-service'
import { deliveryHash } from '../src/application/notification-delivery-identity'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { vacuumDatabaseInto } from '../src/infrastructure/app-update/update-backup'
import type { NotificationDraft, NotificationPush } from '../src/domain/notification'

// Compiled private workers + isolated backup rollback. Synthetic native ports
// only: no OS notices, permissions, production main, Cursor or business sources.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-delivery-claims-')), path = join(directory, 'private.sqlite'), backup = join(directory, 'earlier.sqlite')
const workers: Worker[] = [], ports: NotificationWorkerPort[] = []
const createPort = (database: string) => {
  const port = new NotificationWorkerPort(options => { const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker }, database)
  ports.push(port); return port
}
const at = Date.now(), port = createPort(path), owner = new NotificationService(port, () => at)
const sources = new Set<(event: NotificationPush) => void>(), observed: NotificationPush[] = []
const stop = owner.subscribe(event => { if (event.announcement) observed.push(event); for (const listener of sources) listener(event) })
let nativeCount = 0
const source = { subscribe: (listener: (event: NotificationPush) => void) => { sources.add(listener); return () => { sources.delete(listener) } },
  preferences: owner.preferences.bind(owner), page: owner.page.bind(owner), claimDelivery: owner.claimDelivery.bind(owner), status: owner.status.bind(owner), sourceStorageEpoch: owner.sourceStorageEpoch.bind(owner) }
let delivery = new NotificationDeliveryService(source, { native: { supported: () => true, show: () => { nativeCount++; return { close: () => {} } } }, foreground: () => false, openWindow: () => {}, now: () => at })
const draft = (patch: Partial<NotificationDraft> = {}): NotificationDraft => ({ key: 'restored:record', category: 'automation', source: '隔离流程', title: '隔离原结果', detail: '不是执行指令', scope: {},
  attention: 'notice', state: 'resolved', tone: 'success', occurredAt: at, sourceRevision: 1, announce: true, ...patch })
const offer = async (value: NotificationDraft) => { owner.offer(value); await owner.flush(); await delivery.flush() }
const replay = (event: NotificationPush) => { for (const listener of sources) listener(event) }
const bounded = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(Error('隔离 delivery claims 验收超时')), 15_000)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) }) })
try {
  await owner.savePreferences({ nativeEnabled: true }); await delivery.flush()
  await offer(draft({ announce: false })); vacuumDatabaseInto(path, backup)
  await offer(draft({ sourceRevision: 2, title: '恢复前分支 A 的结果', renewAttention: true }))
  const branchA = observed.at(-1)!, recordId = branchA.change!.record!.id
  assert.equal(nativeCount, 1)
  const worker = workers.at(-1)!
  const restored = new Promise<void>(resolve => worker.once('exit', () => {
    copyFileSync(backup, path); for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) rmSync(path + suffix); resolve()
  }))
  const recovered = bounded(new Promise<void>(resolve => { const release = port.subscribeLifecycle(event => { if (event.state === 'recovered' && event.generation === 2) { release(); resolve() } }) }))
  await worker.terminate(); await restored; await recovered; await owner.flush(); await delivery.flush()
  assert.equal(nativeCount, 1); assert.equal(owner.sourceStorageEpoch(), 1)
  await offer(draft({ sourceRevision: 2, title: '恢复后分支 B 的另一结果', renewAttention: true }))
  const branchB = observed.at(-1)!
  assert.equal(branchB.change!.record!.id, recordId)
  assert.equal(branchB.announcement!.id, branchA.announcement!.id)
  assert.equal(branchB.change!.record!.attentionRevision, branchA.change!.record!.attentionRevision)
  assert.equal(nativeCount, 2) // Raw IDs are the same; captured original bodies are not.

  const started = performance.now()
  for (let index = 0; index < 1_030; index++) await offer(draft({ key: `capacity:${index}` }))
  const count = nativeCount
  replay(branchB); await delivery.flush(); assert.equal(nativeCount, count)
  delivery.dispose()
  delivery = new NotificationDeliveryService(source, { native: { supported: () => true, show: () => { nativeCount++; return { close: () => {} } } }, foreground: () => false, openWindow: () => {}, now: () => at })
  await delivery.flush(); replay(branchB); await delivery.flush(); assert.equal(nativeCount, count)
  replay(branchA); await delivery.flush(); assert.equal(nativeCount, count) // Old epoch cannot address the restored ledger.
  const inspect = new DatabaseSync(path)
  try {
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM desktop_notification_delivery_claims').get()!.n, 1_031)
    assert.equal((await owner.page()).summary.unread, 1_031)
  } finally { inspect.close() }

  // Real v8 -> v9 migration, ID-only legacy ambiguity, unchanged unrelated data.
  const legacyPath = join(directory, 'legacy.sqlite'), old = new SqliteNotificationRepository(legacyPath)
  old.commitSource('notification-delivery:v1', 0, { version: 1, ids: ['known:legacy'] }, [], at); old.close()
  const earlier = new DatabaseSync(legacyPath)
  earlier.exec("DROP TABLE desktop_notification_delivery_claims; ALTER TABLE desktop_notification_meta DROP COLUMN legacy_delivery_imported; UPDATE desktop_notification_meta SET schema_version=8; PRAGMA user_version=71; CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('preserved');")
  earlier.close()
  const legacy = createPort(legacyPath), competitor = createPort(legacyPath)
  assert.equal(await legacy.claimDelivery({ signalHash: deliveryHash('known:legacy'), contentHash: deliveryHash('unproven historical body'), expiresAt: at + 60_000 }, at), false)
  const race = { signalHash: deliveryHash('concurrent:fresh'), contentHash: deliveryHash('same captured native event'), expiresAt: at + 60_000 }
  const elected = await Promise.all([legacy.claimDelivery(race, at), competitor.claimDelivery(race, at)])
  assert.deepEqual([...elected].sort(), [false, true])
  assert.equal(await competitor.claimDelivery({ ...race, contentHash: deliveryHash('actually different new result') }, at), true)
  assert.equal(await competitor.claimDelivery({ ...race, signalHash: deliveryHash('expired'), expiresAt: at }, at), false)
  const migration = new DatabaseSync(legacyPath)
  try {
    assert.equal(migration.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version, 9)
    assert.equal(migration.prepare('PRAGMA user_version').get()!.user_version, 71)
    assert.equal(migration.prepare('SELECT value FROM unrelated').get()!.value, 'preserved')
    assert.deepEqual((await legacy.sourceState('notification-delivery:v1')).data, { version: 1, ids: ['known:legacy'] })
  } finally { migration.close() }
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', builtPrivateWorkers: true, syntheticNativePortOnly: true,
    realBackupRollbackReusesIdAndRevisionWithoutSwallowingDifferentResult: true, oldEpochFramesNotRetargeted: true,
    validCandidatesBeyond1024NeverRepeatAfterOwnerRecreation: true, claimedEntries: 1_031, measuredPressureMs: Math.round(performance.now() - started), databaseBytes: statSync(path).size,
    legacyV8IdsRetainUnknownBodyAndOldCheckpoint: true, simultaneousWorkersElectOneWinner: true, expiredClaimRefused: true,
    unrelatedDataAndGlobalVersionPreserved: true, noBusinessCallsOrActualOsNotice: true, isolated: true }, null, 2))
} finally {
  stop(); delivery.dispose(); await owner.close().catch(() => {}); await Promise.allSettled(ports.map(port => port.close()))
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate())); rmSync(directory, { recursive: true, force: true })
}
