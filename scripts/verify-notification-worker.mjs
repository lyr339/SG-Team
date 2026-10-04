import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'

// Run after build. Also runnable with ELECTRON_RUN_AS_NODE=1 <Electron> this-script.
// All writes are isolated test data; no app profile, Cursor, account or network access.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const folder = process.argv[2] ? resolve(process.argv[2]) : join(root, 'out', 'main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('未找到通知工作线程，请先 npm run build')
const temporary = mkdtempSync(join(tmpdir(), 'sg-notification-smoke-'))
const databasePath = join(temporary, 'ledger.sqlite')
let worker
let database
let sequence = 0
const waits = new Map()
function spawn() {
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  worker = new Worker(pathToFileURL(join(folder, entry)), { workerData: { databasePath } })
  worker.on('message', reply => {
    if (reply.id === 0) { reply.ok ? readyResolve() : readyReject(Error(reply.error)); return }
    const wait = waits.get(reply.id)
    if (!wait) return
    clearTimeout(wait.timer); waits.delete(reply.id)
    reply.ok ? wait.resolve(reply.result) : wait.reject(Error(reply.error))
  })
  worker.on('error', error => {
    readyReject(error)
    for (const wait of waits.values()) { clearTimeout(wait.timer); wait.reject(error) }
    waits.clear()
  })
  return ready
}
function rpc(command) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waits.delete(id); reject(Error('工作线程验收未及时返回')) }, 10_000)
    waits.set(id, { resolve, reject, timer }); worker.postMessage({ id, command })
  })
}
const draft = { key: 'smoke:operation', category: 'run', source: '批量发起', title: '会话创建完成', tone: 'success',
  attention: 'notice', state: 'resolved', scope: { workspaceId: 'test-only' }, occurredAt: 100, sourceRevision: 1 }
try {
  await spawn()
  const first = await rpc({ kind: 'put', draft, now: 200 })
  assert.equal(first.summary.unread, 1)
  assert.equal((await rpc({ kind: 'put', draft, now: 250 })).changed, false)
  await rpc({ kind: 'read', id: first.record.id, revision: first.record.revision, now: 300 })
  assert.equal((await rpc({ kind: 'page' })).summary.unread, 0)
  database = new DatabaseSync(databasePath)
  database.exec("CREATE TABLE unrelated_fixture(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO unrelated_fixture VALUES(1,'preserve');PRAGMA user_version=9;BEGIN IMMEDIATE")
  const writing = rpc({ kind: 'put', draft: { ...draft, key: 'smoke:second' }, now: 400 })
  const started = performance.now()
  await new Promise(resolve => setTimeout(resolve, 40))
  const mainTimerMs = performance.now() - started
  assert.ok(mainTimerMs < 200, `主线程被数据库等待阻塞：${mainTimerMs}ms`)
  database.exec('ROLLBACK'); database.close(); database = undefined
  await writing
  assert.equal((await rpc({ kind: 'sourceState', key: 'smoke:source' })).revision, 0)
  const checkpoint = await rpc({ kind: 'commitSource', key: 'smoke:source', expectedRevision: 0, data: { version: 1, incident: 'test-incident' },
    drafts: [{ ...draft, key: 'smoke:source-event' }], now: 500 })
  assert.equal(checkpoint.applied, true)
  assert.equal((await rpc({ kind: 'commitSource', key: 'smoke:source', expectedRevision: 0, data: { incident: 'stale' }, drafts: [], now: 600 })).applied, false)
  await rpc({ kind: 'close' }); await worker.terminate(); worker = undefined
  await spawn()
  const page = await rpc({ kind: 'page' })
  assert.equal(page.summary.total, 3); assert.equal(page.summary.unread, 2)
  assert.deepEqual(await rpc({ kind: 'sourceState', key: 'smoke:source' }), { revision: 1, data: { version: 1, incident: 'test-incident' } })
  const scope = { workspaceId: 'test-only', sessionId: 'test-session', channelId: '1', generation: '0', composerId: 'test-composer' }
  const reply = { ...draft, key: 'smoke:exact-reply', category: 'sessions', eventType: 'session.reply', subjectState: 'complete', scope,
    target: { kind: 'session', scope, entryId: 'reply:test' } }
  const replyResult = await rpc({ kind: 'put', draft: reply, now: 700 })
  await rpc({ kind: 'put', draft: { ...reply, key: 'smoke:question', eventType: 'question.state', subjectState: 'pending', attention: 'action', state: 'active',
    target: { kind: 'session', scope, entryId: 'reply:test', blockId: 'test-block', toolCallId: 'test-tool' } }, now: 710 })
  assert.equal((await rpc({ kind: 'page', query: { sessionId: 'test-session', toolCallId: 'test-tool' } })).records[0].key, 'smoke:question')
  assert.equal((await rpc({ kind: 'page', query: { sessionId: 'wrong-session', entryId: 'reply:test' } })).records.length, 0)
  await rpc({ kind: 'read', id: replyResult.record.id, revision: replyResult.record.revision, now: 720 })
  await rpc({ kind: 'clearRead', query: { key: reply.key }, now: 730 })
  assert.equal((await rpc({ kind: 'put', draft: { ...reply, sourceRevision: 2, respectCleared: true,
    target: { kind: 'session', scope, entryId: 'reply:canonical' } }, now: 740 })).changed, false)
  assert.equal((await rpc({ kind: 'marker', key: reply.key })).cleared, true)
  assert.equal((await rpc({ kind: 'page', query: { key: reply.key } })).summary.total, 0)
  const largeIdentities = { version: 1, identities: Array.from({ length: 2_000 }, (_, index) => ({ id: `test-${index}`, aliases: Array.from({ length: 5 }, () => 'f'.repeat(64)) })) }
  const large = await rpc({ kind: 'commitSource', key: 'smoke:large-identities', expectedRevision: 0, data: largeIdentities, drafts: [], now: 750 })
  assert.equal(large.applied, true)
  database = new DatabaseSync(databasePath)
  assert.equal(database.prepare('SELECT value FROM unrelated_fixture').get().value, 'preserve')
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 9)
  database.close(); database = undefined
  await rpc({ kind: 'close' }); await worker.terminate(); worker = undefined
  console.log(JSON.stringify({ workerEntry: entry, runtime: process.versions.electron ? 'Electron' : 'Node', persistedAcrossRestart: true,
    noDuplicateReplay: true, readStateRestored: true, sourceCheckpointRestored: true, staleSourceRejected: true, exactSourceQueries: true,
    clearedMetadataNotResurrected: true, boundedLargeIdentityCheckpoint: true, unrelatedSchemaPreserved: true, mainTimerMs: Math.round(mainTimerMs), isolatedProfile: true }, null, 2))
} finally {
  database?.close()
  for (const wait of waits.values()) { clearTimeout(wait.timer); wait.reject(Error('验收结束')) }
  waits.clear()
  if (worker) await worker.terminate()
  rmSync(temporary, { recursive: true, force: true })
}
