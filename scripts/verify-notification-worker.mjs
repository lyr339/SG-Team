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
  await rpc({ kind: 'close' }); await worker.terminate(); worker = undefined
  await spawn()
  const page = await rpc({ kind: 'page' })
  assert.equal(page.summary.total, 2); assert.equal(page.summary.unread, 1)
  database = new DatabaseSync(databasePath)
  assert.equal(database.prepare('SELECT value FROM unrelated_fixture').get().value, 'preserve')
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 9)
  database.close(); database = undefined
  await rpc({ kind: 'close' }); await worker.terminate(); worker = undefined
  console.log(JSON.stringify({ workerEntry: entry, runtime: process.versions.electron ? 'Electron' : 'Node', persistedAcrossRestart: true,
    noDuplicateReplay: true, readStateRestored: true, unrelatedSchemaPreserved: true, mainTimerMs: Math.round(mainTimerMs), isolatedProfile: true }, null, 2))
} finally {
  database?.close()
  for (const wait of waits.values()) { clearTimeout(wait.timer); wait.reject(Error('验收结束')) }
  waits.clear()
  if (worker) await worker.terminate()
  rmSync(temporary, { recursive: true, force: true })
}
