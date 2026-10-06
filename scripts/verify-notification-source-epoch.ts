import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { NotificationProjectionSource } from '../src/application/notifications/projection-source'
import { NotificationDeliveryService } from '../src/application/notification-delivery-service'
import { vacuumDatabaseInto } from '../src/infrastructure/app-update/update-backup'
import { drainNotificationsForQuit } from '../src/main/notification-quit-barrier'
import type { NotificationPush } from '../src/domain/notification'

// Real built private worker and real earlier ledger restoration. No production
// main, user data, business snapshot/transaction, Cursor or OS notification.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-source-epoch-worker-')), path = join(directory, 'notifications.sqlite'), backup = join(directory, 'earlier.sqlite')
const workers: Worker[] = [], commands: Array<{ kind: string; key?: string }> = []
class AuditWorker extends Worker {
  override postMessage(message: { command: { kind: string; key?: string } }): void { commands.push(message.command); super.postMessage(message) }
}
const port = new NotificationWorkerPort(options => {
  const worker = new AuditWorker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, path)
const owner = new NotificationService(port), events: NotificationPush[] = []
owner.subscribe(event => events.push(event))
let nativeCount = 0
const delivery = new NotificationDeliveryService(owner, { native: { supported: () => true, show: () => { nativeCount++; return { close: () => {} } } }, foreground: () => false, openWindow: () => {} })
const baselines: boolean[] = []
const source = new NotificationProjectionSource<number, number>(owner, value => value as number | undefined,
  (old, value, baseline, revision) => {
    baselines.push(baseline)
    return { state: value, drafts: old === value ? [] : [{ key: 'fixture:source-result', eventId: `fixture:source-result:${value}`, eventType: 'fixture.source',
      category: 'run', source: '隔离原来源', title: `原来源确认阶段 ${value}`, detail: '隔离事实；不执行业务或操作真实账号。', scope: { workspaceId: 'fixture-workspace' },
      state: 'resolved', tone: 'info', attention: 'notice', occurredAt: Date.now(), sourceRevision: revision, renewAttention: true, announce: !baseline }] }
  }, String)
const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('隔离线程代次验收超时')), 10000)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
let inspection: DatabaseSync | undefined
try {
  await owner.savePreferences({ nativeEnabled: true }); await delivery.flush()
  source.observe('fixture:source-state', 0); await source.flush(); await delivery.flush()
  assert.equal(nativeCount, 0); assert.equal(owner.sourceStorageEpoch(), 0)
  vacuumDatabaseInto(path, backup)
  source.observe('fixture:source-state', 1); await source.flush(); await delivery.flush()
  assert.equal(nativeCount, 1); assert.equal((await owner.page()).records[0]?.eventId, 'fixture:source-result:1')
  const before = commands.length
  source.observe('fixture:source-state', 1); await source.flush(); assert.equal(commands.length, before)

  const worker = workers.at(-1)!, restored = new Promise<void>(resolve => worker.once('exit', () => {
    // Exact files belonging to this fixture only, after the original SQLite
    // owner really exited. Replace before the bounded recovery timer fires.
    copyFileSync(backup, path)
    for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) rmSync(path + suffix)
    resolve()
  }))
  const recovered = bounded(new Promise<void>(resolve => {
    const stop = port.subscribeLifecycle(event => { if (event.state === 'recovered' && event.generation === 2) { stop(); resolve() } })
  }))
  await worker.terminate(); await restored; await recovered; await owner.flush(); await delivery.flush()
  const old = await owner.sourceState('fixture:source-state')
  assert.equal(old.data, 0); assert.equal(owner.sourceStorageEpoch(), 1)
  assert.equal((await owner.page()).records[0]?.eventId, 'fixture:source-result:0')
  const sourceWrites = commands.filter(command => command.kind === 'commitSource').length
  const sourceReads = commands.filter(command => command.kind === 'sourceState').length
  nativeCount = 0
  // Another genuine source frame with IDENTICAL content must not be swallowed
  // by an old committed-signature cache. It reads only the private checkpoint.
  source.observe('fixture:source-state', 1); await source.flush(); await owner.flush(); await delivery.flush()
  assert.equal((await owner.sourceState('fixture:source-state')).data, 1)
  assert.equal((await owner.page()).records[0]?.eventId, 'fixture:source-result:1')
  assert.equal(commands.filter(command => command.kind === 'commitSource').length, sourceWrites + 1)
  assert.equal(commands.filter(command => command.kind === 'sourceState').length, sourceReads + 2) // Adapter plus explicit verification.
  assert.equal(nativeCount, 0); assert.equal(baselines.at(-1), true)
  const after = commands.length
  for (let i = 0; i < 300; i++) source.observe('fixture:source-state', 1)
  await source.flush(); assert.equal(commands.length, after)
  assert.ok(events.some(event => event.historyReload)); assert.equal(owner.status().historyIncomplete, true)
  const confirmed = await drainNotificationsForQuit(owner, [() => source.close()], () => {})
  assert.equal(confirmed, true); delivery.dispose()
  inspection = new DatabaseSync(path)
  assert.equal(JSON.parse(String(inspection.prepare("SELECT payload FROM desktop_notification_sources WHERE source_key='fixture:source-state'").get()!.payload)), 1)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, actualWorkerExitAndEarlierPrivateRestore: true,
    identicalGenuineFrameReprojected: true, actualPrivateCheckpointReloaded: true, noHistoricalAlertReplay: true,
    unchangedTrafficQuietAfterRecovery: true, initialReadyNotFalseFailure: true, noBusinessQueryOrWrite: true, isolated: true }, null, 2))
} finally {
  inspection?.close(); delivery.dispose(); await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
