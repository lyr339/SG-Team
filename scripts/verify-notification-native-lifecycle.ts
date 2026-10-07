import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { NotificationDeliveryService, type NotificationNativePort } from '../src/application/notification-delivery-service'
import { NotificationStore } from '../src/renderer/src/notifications/notification-store'
import { vacuumDatabaseInto } from '../src/infrastructure/app-update/update-backup'

// Actual compiled private worker/restore + synthetic native callback contract.
// NEVER send an OS notification, query permissions or boot production main.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-native-lifecycle-')), path = join(directory, 'private.sqlite'), backup = join(directory, 'earlier.sqlite')
const workers: Worker[] = [], port = new NotificationWorkerPort(options => { const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker }, path)
const owner = new NotificationService(port), callbacks: Array<Parameters<NotificationNativePort['show']>[1]> = []
let opens = 0, closes = 0
const delivery = new NotificationDeliveryService(owner, { native: { supported: () => true, show: (_content, callback) => { callbacks.push(callback); return { close: () => { closes++ } } } },
  foreground: () => false, openWindow: () => { opens++ } })
const store = new NotificationStore({ getNotificationPage: query => owner.page(query), getNotificationPreferences: () => owner.preferences(), saveNotificationPreferences: value => owner.savePreferences(value),
  onNotificationChanged: listener => delivery.subscribe(listener), readNotification: input => owner.read(input.id, input.revision, input.storageEpoch),
  readAllNotifications: input => owner.readAll(input.query ?? {}, input.revision, input.storageEpoch), archiveNotification: input => owner.archive(input), clearReadNotifications: input => owner.clearRead(input.query ?? {}, input.storageEpoch) })
const release = store.acquire()
const offer = async (key: string) => { owner.offer({ key, eventId: `${key}:complete`, category: 'automation', source: '隔离流程', title: '隔离原结果', detail: '不是执行指令', scope: {},
  attention: 'notice', state: 'resolved', tone: 'success', occurredAt: Date.now(), sourceRevision: 1, announce: true }); await owner.flush(); await delivery.flush() }
const bounded = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(Error('隔离 native lifecycle 验收超时')), 10000)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) }) })
try {
  await owner.savePreferences({ nativeEnabled: true }); await delivery.flush(); vacuumDatabaseInto(path, backup)
  await offer('before:retained-native')
  assert.equal(delivery.status().nativeFeedback, 'unconfirmed')
  callbacks[0]!.shown(); assert.equal(delivery.status().nativeFeedback, 'reported')
  callbacks[0]!.closed('timed-out'); callbacks[0]!.clicked()
  assert.equal(opens, 1); assert.equal((await owner.page()).summary.unread, 1)
  assert.equal(delivery.openRequested()?.storageEpoch, 0); assert.ok(store.snapshot().openRequested)
  const restored = new Promise<void>(resolve => workers.at(-1)!.once('exit', () => {
    copyFileSync(backup, path); for (const suffix of ['-wal','-shm']) if (existsSync(path + suffix)) rmSync(path + suffix); resolve()
  }))
  const recovered = bounded(new Promise<void>(resolve => { const stop = port.subscribeLifecycle(event => { if (event.state === 'recovered' && event.generation === 2) { stop(); resolve() } }) }))
  await workers.at(-1)!.terminate(); await restored; await recovered; await owner.flush(); await delivery.flush()
  callbacks[0]!.clicked(); callbacks[0]!.failed(); callbacks[0]!.shown()
  assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(owner.sourceStorageEpoch(), 1)
  assert.equal(delivery.openRequested(), undefined); assert.equal(store.snapshot().openRequested, undefined)
  assert.equal((await owner.page()).summary.total, 0)
  await offer('after:real-recovery')
  assert.equal(callbacks.length, 2); assert.equal((await owner.page()).summary.unread, 1)
  callbacks[1]!.shown(); callbacks[1]!.closed('timed-out'); callbacks[1]!.clicked()
  assert.equal(opens, 2); assert.equal(delivery.openRequested()?.storageEpoch, 1)
  await owner.savePreferences({ quiet: true }); callbacks[1]!.clicked(); callbacks[1]!.failed()
  assert.equal(opens, 2); assert.equal(closes, 2); assert.equal(delivery.status().state, 'ready')
  assert.equal((await owner.page()).summary.unread, 1)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltPrivateWorker: true, syntheticNativeCallbacksOnly: true,
    showReturnNotDisplayPermissionOrHumanRead: true, timedOutBannerRetainsActionCenterClick: true,
    actualWorkerExitBackupRestoreInvalidatesRetainedCallbacksAndDeferredRequests: true,
    originalRecoveryPreferencesResumeOnlyFreshDelivery: true, freshClicksCarryExactStorageEpoch: true,
    quietClosesRetainedNativeWithoutReadingOrWorkflowAction: true, noActualOsNotificationOrPermissionProbe: true, isolated: true }, null, 2))
} finally {
  release(); delivery.dispose(); await owner.close().catch(() => {}); await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
