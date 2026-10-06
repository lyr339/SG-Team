import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { NotificationStore, type NotificationApi } from '../src/renderer/src/notifications/notification-store'
import { vacuumDatabaseInto } from '../src/infrastructure/app-update/update-backup'
import type { NotificationDraft, NotificationPush } from '../src/domain/notification'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-center-epoch-worker-')), path = join(directory, 'notifications.sqlite'), backup = join(directory, 'earlier.sqlite'), workers: Worker[] = []
const commands: string[] = []
class AuditWorker extends Worker { override postMessage(value: { command: { kind: string } }): void { commands.push(value.command.kind); super.postMessage(value) } }
const port = new NotificationWorkerPort(options => { const worker = new AuditWorker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker }, path)
const owner = new NotificationService(port), events: NotificationPush[] = []; owner.subscribe(event => events.push(event))
const api: NotificationApi = { getNotificationPage: query => owner.page(query), onNotificationChanged: listener => owner.subscribe(listener), getNotificationPreferences: () => owner.preferences(),
  saveNotificationPreferences: value => owner.savePreferences(value), readNotification: input => owner.read(input.id, input.revision, input.storageEpoch ?? 0),
  readAllNotifications: input => owner.readAll(input.query ?? {}, input.revision, input.storageEpoch ?? 0), archiveNotification: (id, epoch) => owner.archive(id, epoch ?? 0),
  clearReadNotifications: input => owner.clearRead(input.query ?? {}, input.storageEpoch ?? 0), acknowledgeNotificationHistory: (revision, epoch) => owner.acknowledgeHistoryGap(revision, epoch ?? 0) }
const store = new NotificationStore(api), release = store.acquire()
const base: NotificationDraft = { key: 'center-fixture', eventId: 'center-fixture:1', category: 'run', source: 'fixture', title: 'original result', detail: 'Private fixture summary, no original business operation.',
  tone: 'warning', attention: 'notice', state: 'resolved', scope: {}, sourceRevision: 1, occurredAt: 1_000, announce: false }
const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('private center fixture timeout')), 10_000)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
try {
  await owner.commitSource('center-fixture-source', 0, { stage: 1 }, [base]); await owner.flush(); await store.refresh()
  const first = (await owner.page()).records[0]!; assert.equal(first.storageEpoch, 0)
  vacuumDatabaseInto(path, backup)
  for (let index = 2; index <= 8; index++) await owner.commitSource('center-fixture-source', index - 1, { stage: index }, [{ ...base, eventId: `center-fixture:${index}`, title: `original result ${index}`, sourceRevision: index, renewAttention: true }])
  const old = (await owner.page()).records[0]!; assert.equal(old.id, first.id); assert.ok(old.revision > first.revision)
  assert.equal(store.snapshot().summary.revision, old.revision)
  const worker = workers.at(-1)!, restored = new Promise<void>(resolve => worker.once('exit', () => {
    copyFileSync(backup, path)
    for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) rmSync(path + suffix)
    resolve()
  }))
  const recovered = bounded(new Promise<void>(resolve => { const stop = port.subscribeLifecycle(event => { if (event.state === 'recovered' && event.generation === 2) { stop(); resolve() } }) }))
  await worker.terminate(); await restored; await recovered; await owner.flush(); await store.refresh()
  const actual = await owner.page(), current = actual.records[0]!
  assert.equal(current.id, old.id); assert.equal(current.revision, first.revision); assert.equal(current.storageEpoch, 1)
  assert.equal(store.snapshot().storageEpoch, 1); assert.equal(store.snapshot().summary.revision, actual.summary.revision)
  assert.ok(store.snapshot().summary.revision < old.revision)
  const before = commands.filter(kind => ['read', 'readAll', 'archive', 'clearRead', 'acknowledgeHistoryGap'].includes(kind)).length
  await assert.rejects(() => store.read(old), /换代/)
  await assert.rejects(() => api.readAllNotifications({ revision: old.revision, storageEpoch: 0 }), /换代/)
  await assert.rejects(() => api.archiveNotification(old.id, 0), /换代/)
  await assert.rejects(() => api.clearReadNotifications({ confirmed: true, storageEpoch: 0 }), /换代/)
  await assert.rejects(() => api.acknowledgeNotificationHistory!(1, 0), /换代/)
  assert.equal(commands.filter(kind => ['read', 'readAll', 'archive', 'clearRead', 'acknowledgeHistoryGap'].includes(kind)).length, before)
  assert.equal((await owner.page()).summary.unread, 1)
  await store.read(current); assert.equal((await owner.page()).summary.unread, 0); assert.equal(store.snapshot().summary.unread, 0)
  const final = (await owner.page()).records[0]!; assert.equal(final.readRevision, final.attentionRevision)
  assert.equal(events.some(event => event.announcement), false); assert.equal(store.snapshot().toasts.length, 0)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, actualPrivateWorkerExitAndEarlierLedgerRestore: true,
    sameRecordIdLowerRevisionKeptUnreadUntilCurrentGenerationRead: true, lowerSummaryAcceptedOnlyInNewStorageGeneration: true,
    oldReadBulkArchiveClearAndHistoryAckNeverSentToReplacement: true, currentGenerationReceiptAccepted: true,
    rendererStoreNotDomClaim: true, noOriginalBusinessQueryOrWorkflowReplay: true, noHistoricalAlerts: true, isolated: true }, null, 2))
} finally {
  release(); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
