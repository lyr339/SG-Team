import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import type { NotificationWorkerCommand, NotificationWorkerReply } from '../src/main/notification-worker'
import { NotificationService } from '../src/application/notification-service'
import { NotificationDeliveryService } from '../src/application/notification-delivery-service'
import type { NotificationDraft, NotificationPush } from '../src/domain/notification'

// Deliberately lose acknowledgements from a REAL built worker, then terminate it.
// No production main, user profile, Cursor, network or actual OS notification runs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const folder = process.argv[2] ? resolve(process.argv[2]) : join(root, 'out', 'main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('未找到通知工作线程，请先 npm run build')
const temporary = mkdtempSync(join(tmpdir(), 'sg-notification-recovery-'))
const databasePath = join(temporary, 'ledger.sqlite')
const workers: AuditWorker[] = []
const sent: NotificationWorkerCommand[] = []
class AuditWorker extends Worker {
  private filter?: (command: NotificationWorkerCommand) => boolean
  private hiddenId?: number
  private committed?: () => void
  hideNext(filter: (command: NotificationWorkerCommand) => boolean): Promise<void> {
    this.filter = filter
    return new Promise<void>(resolve => { this.committed = resolve })
  }
  override postMessage(message: { id: number; command: NotificationWorkerCommand }): void {
    sent.push(message.command)
    if (this.filter?.(message.command)) { this.hiddenId = message.id; this.filter = undefined }
    super.postMessage(message)
  }
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const reply = args[0] as NotificationWorkerReply | undefined
    if (event === 'message' && reply && reply.id === this.hiddenId) {
      assert.equal(reply.ok, true, 'fixture expected a truly committed result')
      this.committed?.(); this.committed = undefined
      return true
    }
    return super.emit(event, ...args)
  }
}
const port = new NotificationWorkerPort(options => {
  const worker = new AuditWorker(pathToFileURL(join(folder, entry!)), options); workers.push(worker); return worker
}, databasePath)
const owner = new NotificationService(port)
const events: NotificationPush[] = [], delivered: NotificationPush[] = []
owner.subscribe(event => events.push(event))
let nativeCount = 0
const delivery = new NotificationDeliveryService(owner, {
  native: { supported: () => true, show: () => { ++nativeCount; return { close: () => {} } } }, foreground: () => false, openWindow: () => {}, now: () => Date.now()
})
delivery.subscribe(event => delivered.push(event))
const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('真实线程恢复验收未及时完成')), 10_000)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
function nextRecovery(generation: number): Promise<void> {
  return bounded(new Promise<void>(resolve => {
    const stop = port.subscribeLifecycle(event => { if (event.state === 'recovered' && event.generation === generation) { stop(); resolve() } })
  }))
}
const draft = (key: string): NotificationDraft => ({ key, category: 'run', source: '隔离验收', title: '原入口已确认结束', attention: 'notice', state: 'resolved', tone: 'success',
  scope: { workspaceId: 'test-only' }, sourceRevision: 1, occurredAt: Date.now(), announce: true })
let inspection: DatabaseSync | undefined
try {
  await port.page(); await owner.savePreferences({ nativeEnabled: true }); await delivery.flush()
  const old = await owner.commitSource('fixture:checkpoint', 0, { version: 1, verified: true }, [{ ...draft('fixture:old'), announce: false }])
  const oldRecord = old.changes[0]!.record!
  await owner.read(oldRecord.id, oldRecord.revision); await owner.clearRead({ key: oldRecord.key })
  inspection = new DatabaseSync(databasePath)
  inspection.exec("CREATE TABLE unrelated_fixture(value TEXT); INSERT INTO unrelated_fixture VALUES('preserve'); PRAGMA user_version=9;")
  inspection.close(); inspection = undefined

  // Hold a real lock until the built worker emits a confirmed-negative BUSY
  // reply. Its retry may write once only after release; main stays responsive.
  inspection = new DatabaseSync(databasePath); inspection.exec('BEGIN IMMEDIATE')
  const lockWorker = workers.at(-1)!
  const negative = new Promise<void>(resolve => {
    const observed = (reply: NotificationWorkerReply) => {
      if (reply.id === 0 || reply.ok) return
      assert.equal(reply.retryable, true)
      lockWorker.off('message', observed)
      inspection!.exec('ROLLBACK'); inspection!.close(); inspection = undefined; resolve()
    }
    lockWorker.on('message', observed)
  })
  const blocked = port.put({ ...draft('fixture:locked'), attention: 'activity', announce: false }, Date.now())
  await Promise.all([bounded(negative), blocked])
  assert.equal(sent.filter(command => command.kind === 'put' && command.draft.key === 'fixture:locked').length, 2)

  // A put committed but its acknowledgement never reached the port/service.
  const final = draft('fixture:unknown-final'), { sourceRevision: _revision, ...current } = final
  let worker = workers.at(-1)!, hidden = worker.hideNext(command => command.kind === 'put' && command.draft.key === final.key)
  owner.offerCurrent(current); await bounded(hidden)
  const recovered = nextRecovery(2); await worker.terminate(); await recovered; await owner.flush(); await delivery.flush()
  assert.equal((await owner.page({ key: final.key })).records[0]!.title, final.title)
  assert.equal(owner.status().historyIncomplete, true); assert.equal(nativeCount, 0)
  owner.offerCurrent(current); await owner.flush(); await delivery.flush()
  assert.equal(sent.filter(command => command.kind === 'put' && command.draft.key === final.key).length, 1)
  assert.equal(delivered.filter(event => event.announcement).length, 0)
  owner.offer(draft('fixture:fresh-one')); await owner.flush(); await delivery.flush(); assert.equal(nativeCount, 1)

  // The source checkpoint and its record really committed atomically before death.
  worker = workers.at(-1)!; hidden = worker.hideNext(command => command.kind === 'commitSource' && command.key === 'fixture:unknown-source')
  const unknownSource = owner.commitSource('fixture:unknown-source', 0, { version: 1, fact: 'confirmed-before-exit' }, [draft('fixture:source-final')]).catch(error => error)
  await bounded(hidden); const recoveredSource = nextRecovery(3); await worker.terminate(); await recoveredSource
  assert.ok(await unknownSource instanceof Error); await owner.flush(); await delivery.flush()
  assert.equal((await owner.sourceState('fixture:unknown-source')).revision, 1)
  assert.equal((await owner.page({ key: 'fixture:source-final' })).summary.total, 1)
  assert.equal(sent.filter(command => command.kind === 'commitSource' && command.key === 'fixture:unknown-source').length, 1)
  assert.equal(nativeCount, 1)

  // A durable delivery claim is not proof the OS alert was shown. Lose its ack,
  // kill the worker, then allow only a later genuinely new event to be delivered.
  worker = workers.at(-1)!; hidden = worker.hideNext(command => command.kind === 'commitSource' && command.key === 'notification-delivery:v1')
  owner.offer(draft('fixture:unknown-claim')); await owner.flush(); await bounded(hidden)
  const recoveredDelivery = nextRecovery(4); await worker.terminate(); await recoveredDelivery; await owner.flush(); await delivery.flush()
  assert.equal(nativeCount, 1)
  owner.offer(draft('fixture:fresh-two')); await owner.flush(); await delivery.flush(); assert.equal(nativeCount, 2)
  assert.equal((await owner.page()).summary.unread, 5)
  assert.equal((await port.marker(oldRecord.key)).cleared, true)
  assert.equal((await owner.sourceState('fixture:checkpoint')).revision, 1)
  inspection = new DatabaseSync(databasePath)
  assert.equal(inspection.prepare('SELECT value FROM unrelated_fixture').get()!.value, 'preserve')
  assert.equal(inspection.prepare('PRAGMA user_version').get()!.user_version, 9)
  inspection.close(); inspection = undefined
  assert.equal(workers.length, 4)
  assert.equal(events.filter(event => event.historyReload).length, 3)
  delivery.dispose(); await owner.close()
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', builtWorker: entry, actualWorkerTerminations: 3,
    recoveredGenerations: 3, unknownPutNotReplayed: true, unknownSourceCommitNotReplayed: true, unknownDeliveryClaimNotResent: true,
    freshDeliveryRecovered: true, confirmedNegativeLockRetry: true, persistedReadAndTombstone: true, unrelatedSchemaPreserved: true, noBusinessCalls: true, isolatedFixture: true }, null, 2))
} finally {
  inspection?.close(); delivery.dispose(); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(temporary, { recursive: true, force: true })
}
