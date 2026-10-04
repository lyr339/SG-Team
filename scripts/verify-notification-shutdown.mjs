import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'vite'

// Real Electron before-quit/will-quit acceptance. NOT the production main entry:
// no BrowserWindow, global MCP config, Cursor, credentials, browser host or network.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const main = join(root, 'out/main')
const worker = readdirSync(main).find(name => /^notification-worker-.*\.js$/.test(name))
if (!worker) throw Error('请先 npm run build')
const electron = process.platform === 'darwin'
  ? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : process.platform === 'win32' ? join(root, 'node_modules/electron/dist/electron.exe')
    : join(root, 'node_modules/electron/dist/electron')
const temporary = mkdtempSync(join(tmpdir(), 'sg-notification-quit-smoke-'))
const imported = file => JSON.stringify(join(root, file).replaceAll('\\', '/'))
try {
  const fixture = join(temporary, 'fixture.ts'), compiled = join(temporary, 'compiled')
  const text = `
import { app } from 'electron'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { NotificationService } from ${imported('src/application/notification-service.ts')}
import { NotificationProjectionSource } from ${imported('src/application/notifications/projection-source.ts')}
import { NotificationWorkerPort } from ${imported('src/main/notification-worker-port.ts')}
import { NotificationQuitBarrier, drainNotificationsForQuit } from ${imported('src/main/notification-quit-barrier.ts')}
import { NotificationRuntimeJournal } from ${imported('src/infrastructure/notifications/runtime-journal.ts')}
const directory = process.argv[2], mode = process.argv[3]
app.setName('SG isolated notification quit acceptance')
app.setPath('userData', directory)
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
let beforeQuit = 0, cleanups = 0, resumed = 0, alerts = 0, installs = 0, restoredGap = false, outcome
const journal = new NotificationRuntimeJournal(join(directory, 'runtime.json'))
const port = new NotificationWorkerPort(options => new Worker(new URL(${JSON.stringify(pathToFileURL(join(main, worker)).href)}), options), join(directory, 'notifications.sqlite3'))
const sourceRead = port.sourceState.bind(port)
port.sourceState = async key => {
  if (key === 'quit-fixture') {
    if (mode === 'timeout') await new Promise(() => {})
    else await new Promise(done => setTimeout(done, 100))
  }
  return sourceRead(key)
}
const owner = new NotificationService(port)
owner.subscribe(event => { if (event.announcement) alerts++ })
const source = new NotificationProjectionSource(owner, value => value, (_old, value, _baseline, revision) => ({ state: value,
  drafts: value ? [{ key: 'native-accepted:' + value, sourceRevision: revision, category: 'sessions', source: '隔离验收', title: '原始已接收事实 ' + value,
    attention: 'notice', state: 'resolved', tone: 'info', scope: {}, occurredAt: Date.now(), announce: true }] : [] }), String)
const barrier = new NotificationQuitBarrier({ timeoutMs: mode === 'timeout' ? 50 : 2_000,
  drain: () => drainNotificationsForQuit(owner, [() => source.close()], () => { cleanups++; source.observe('quit-fixture', 99) }),
  settled: result => { outcome = result; journal.finish(result.confirmed, owner.status().historyIncomplete) },
  resumeQuit: () => { resumed++; app.quit() }
})
app.on('before-quit', event => { beforeQuit++; barrier.handle(event) })
app.on('will-quit', () => writeFileSync(join(directory, 'result.json'), JSON.stringify({ beforeQuit, cleanups, resumed, alerts, installs, restoredGap, outcome })))
process.on('unhandledRejection', error => { writeFileSync(join(directory, 'fixture-error.txt'), String(error)); app.exit(1) })
// Electron waits for main-module evaluation before emitting ready; top-level
// await app.whenReady() would deadlock the fixture rather than test quitting.
app.whenReady().then(async () => {
  restoredGap = journal.open().historyIncomplete
  if (restoredGap) owner.reportHistoryGap()
  await owner.sourceState('init')
  source.observe('quit-fixture', 0); source.observe('quit-fixture', 1); source.observe('quit-fixture', 2)
  if (mode === 'crash') app.exit(0)
  else if (mode === 'updater') { installs++; setImmediate(() => app.quit()) }
  else app.quit()
}).catch(error => { writeFileSync(join(directory, 'fixture-error.txt'), String(error)); app.exit(1) })
`
  writeFileSync(fixture, text)
  await build({ configFile: false, publicDir: false, logLevel: 'error', build: { ssr: fixture, outDir: compiled, emptyOutDir: true,
    rollupOptions: { external: ['electron'], output: { format: 'es', entryFileNames: 'fixture.mjs' } } } })
  const results = []
  for (const mode of ['clean', 'updater', 'timeout', 'crash', 'restore-crash']) {
    const directory = join(temporary, mode === 'restore-crash' ? 'crash' : mode); mkdirSync(directory, { recursive: true })
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawnSync(electron, [join(compiled, 'fixture.mjs'), directory, mode], { cwd: root, env, encoding: 'utf8', timeout: 15_000 })
    if (child.error || child.status !== 0) throw Error(`原生退出验收 ${mode} 未完成：${child.error ?? child.status}\n${child.stderr ?? ''}`)
    const marker = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'))
    if (mode === 'crash') { assert.equal(marker.closedAt, undefined); results.push({ mode, uncleanEvidence: true }); continue }
    const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'))
    assert.equal(result.beforeQuit, 2); assert.equal(result.cleanups, 1); assert.equal(result.resumed, 1); assert.equal(result.alerts, 0)
    if (mode === 'timeout') { assert.equal(result.outcome.reason, 'timeout'); assert.equal(marker.closedAt, undefined); assert.equal(marker.historyIncomplete, true) }
    else {
      assert.equal(result.outcome.confirmed, true); assert.equal(marker.historyIncomplete, mode === 'restore-crash'); assert.ok(marker.closedAt)
      if (mode === 'restore-crash') assert.equal(result.restoredGap, true)
      if (mode === 'updater') assert.equal(result.installs, 1)
      const db = new DatabaseSync(join(directory, 'notifications.sqlite3'))
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM desktop_notifications').get().count, 2)
        assert.equal(JSON.parse(db.prepare("SELECT payload FROM desktop_notification_sources WHERE source_key='quit-fixture'").get().payload), 2)
      } finally { db.close() }
    }
    results.push({ mode, ...result.outcome, cleanupOnce: true, quitResumedOnce: true, noQuitAlert: true })
  }
  console.log(JSON.stringify({ nativeElectronLifecycle: true, platform: process.platform, isolatedProfile: true, productionMainNotLoaded: true, results }, null, 2))
} finally { rmSync(temporary, { recursive: true, force: true }) }
