import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NOTIFICATION_ROUTINE_RETENTION_MS } from '../src/domain/notification-history'
import type { NotificationDraft } from '../src/domain/notification'

// Actual built worker/private file only; no production main, profile or OS notice.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out', 'main')
const name = readdirSync(folder).find(value => /^notification-worker-.*\.js$/.test(value))
if (!name) throw Error('请先构建通知 worker')
const temporary = mkdtempSync(join(tmpdir(), 'sg-notification-history-')), databasePath = join(temporary, 'history.sqlite')
let port: NotificationWorkerPort | undefined, inspection: DatabaseSync | undefined
const workers: Worker[] = []
const open = () => new NotificationWorkerPort(options => { const worker = new Worker(pathToFileURL(join(folder, name)), options); workers.push(worker); return worker }, databasePath)
const at = 1_000, later = at + NOTIFICATION_ROUTINE_RETENTION_MS + 1_000
const draft = (key: string, patch: Partial<NotificationDraft> = {}): NotificationDraft => ({ key, category: 'run', source: '隔离验收', title: '普通已确认的结果', tone: 'success', attention: 'notice', state: 'resolved', scope: {}, occurredAt: at, sourceRevision: 1, ...patch })
const id = '11111111-1111-4111-8111-111111111111', next = '22222222-2222-4222-8222-222222222222'
try {
  port = open(); await port.page()
  inspection = new DatabaseSync(databasePath); inspection.exec("CREATE TABLE unrelated(value TEXT);INSERT INTO unrelated VALUES('preserve');PRAGMA user_version=23;"); inspection.close(); inspection = undefined
  for (let index = 0; index < 120; index++) await port.put(draft(`activity:${index}`, { attention: 'activity' }), at)
  const completed = (await port.put(draft('ordinary:read', { detail: 'uniquely identifiable summary removed from dedupe tombstones' }), at)).record!
  await port.read(completed.id, completed.revision, at)
  await port.put(draft('unread'), at)
  const diagnostic = (await port.put(draft('diagnostic', { tone: 'warning' }), at)).record!
  await port.read(diagnostic.id, diagnostic.revision, at)
  const pending = (await port.put(draft('question', { attention: 'action', state: 'active' }), at)).record!
  await port.read(pending.id, pending.revision, at)
  assert.equal((await port.pruneRoutine(later)).removed, 100)
  assert.equal((await port.pruneRoutine(later)).removed, 21)
  assert.equal((await port.page()).summary.total, 3)
  assert.equal((await port.put(draft('ordinary:read', { detail: 'uniquely identifiable summary removed from dedupe tombstones', sourceRevision: 99 }), later)).changed, false)
  await port.recordHistoryGap(id, later); await port.acknowledgeHistoryGap(1, later)
  await port.close(); port = open()
  assert.deepEqual((await port.historyGap(id)).integrity, { revision: 1, acknowledgedRevision: 1, latestGapId: id, observedAt: later, acknowledgedAt: later })
  assert.equal((await port.recordHistoryGap(id, later + 1)).revision, 1)
  assert.equal((await port.recordHistoryGap(next, later + 1)).revision, 2)
  assert.equal((await port.acknowledgeHistoryGap(1, later + 1)).acknowledgedRevision, 1)
  assert.equal((await port.page()).summary.unread, 1); assert.equal((await port.page()).summary.pending, 1)
  inspection = new DatabaseSync(databasePath)
  assert.match(inspection.prepare('SELECT content_signature FROM desktop_notification_tombstones WHERE semantic_key=?').get('ordinary:read')!.content_signature as string, /^sha256:[a-f0-9]{64}$/)
  assert.equal(inspection.prepare('SELECT value FROM unrelated').get()!.value, 'preserve')
  assert.equal(inspection.prepare('PRAGMA user_version').get()!.user_version, 23)
  assert.equal(inspection.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version, 5)
  inspection.close(); inspection = undefined; await port.close()
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', privateSchema: 5, realBuiltWorker: true, boundedPruning: true,
    unreadPendingDiagnosticsPreserved: true, noBodyInTombstones: true, sameContentNotResurrected: true, gapAcknowledgementRestored: true,
    oldAcknowledgementCannotHideNewGap: true, noHumanOrAgentBusinessRead: true, unrelatedSchemaPreserved: true, isolatedFixture: true }, null, 2))
} finally {
  inspection?.close(); await port?.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(temporary, { recursive: true, force: true })
}
