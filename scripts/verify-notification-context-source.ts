import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { ComposerContextNotifications } from '../src/application/notifications/runtime-usage-notifications'
import { CursorComposerTelemetryReader } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import { drainNotificationsForQuit } from '../src/main/notification-quit-barrier'

// Original SQLite reader + compiled private worker. No production main, CDP,
// account operation, model request or change to the original accounting sink.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-context-source-worker-')), workspacePath = join(directory, 'workspace'), path = join(directory, 'state.vscdb')
mkdirSync(workspacePath)
const workers: Worker[] = [], database = new DatabaseSync(path)
database.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT)')
const write = (key: string, value: string) => database.prepare('INSERT OR REPLACE INTO ItemTable VALUES(?,?)').run(key, value)
write('composer.composerHeaders', JSON.stringify({ allComposers: [{ composerId: 'composer-fixture', name: 'PRIVATE fixture', createdAt: 1000, lastUpdatedAt: 2000,
  workspaceIdentifier: { uri: { fsPath: workspacePath } } }] }))
write('src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser', '{}')
const detail = (value: unknown) => database.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES(?,?)').run('composerData:composer-fixture', typeof value === 'string' ? value : JSON.stringify(value))
let at = Date.now() - 60000, stamp = 0
const touch = () => { const time = new Date(1_000_000 + ++stamp * 1000); utimesSync(path, time, time) }
const createOwner = () => new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
let owner = createOwner(), source = new ComposerContextNotifications(owner, () => at)
const team = emptyTeamControlSnapshot(), workspace = { id: 'workspace-fixture', name: 'PRIVATE workspace', path: workspacePath, createdAt: 1, updatedAt: 1 }
team.workspaces = [workspace]; team.activeWorkspaceId = workspace.id
team.activeRun = { id: 'run-fixture', workspaceId: workspace.id, name: 'fixture', goal: '', templateId: 'independent-session-v1', status: 'running', createdAt: 1, updatedAt: 1 }
team.runs = [team.activeRun]
team.bindings = [{ id: 'binding-fixture', workspaceId: workspace.id, runId: team.activeRun.id, slotId: 'slot-fixture', channelId: '1', agentSessionId: 'sg-channel:1', generation: 'binding-first',
  installedAt: 1, launchDetail: '', lastCheckInNote: '', composerBindingKey: 'fixture-key', composerId: 'composer-fixture', composerBoundAt: 1 }]
source.setTeam(team)
const options = { globalStateDatabase: path, projectsRoot: join(directory, 'projects'), workspaceStorageRoot: join(directory, 'workspaces'), now: () => at }
let reader = new CursorComposerTelemetryReader({ ...options, contextObserver: { begin: input => source.begin(input), unavailable: () => source.unavailable() } })
const read = () => reader.readWorkspace(workspacePath, team.bindings)
try {
  detail({ contextTokensUsed: 0, contextTokenLimit: 10000 }); touch(); read(); await source.source.flush()
  assert.equal((await owner.page()).summary.total, 0)
  detail({ contextTokensUsed: 3000, contextTokenLimit: 10000 }); touch(); at += 1000
  const normal = read(); assert.equal(normal.composers[0]?.contextUsage?.used, 3000)
  at += 10000; assert.equal(read(), normal)
  detail('{PRIVATE broken'); touch(); at += 1000; const fallback = read()
  assert.equal(fallback.availability, 'available'); assert.equal(fallback.composers[0]?.contextUsage, undefined)
  at += 6000; read(); await source.source.flush(); assert.equal((await owner.page()).summary.total, 0)
  touch(); read(); await source.source.flush()
  const incident = (await owner.page()).records[0]!
  assert.equal(incident.eventType, 'cursor.context-source'); assert.equal(incident.state, 'active')
  await owner.read(incident.id, incident.revision); assert.equal((await owner.page()).records[0]?.state, 'active')
  database.exec('DROP TABLE cursorDiskKV'); touch(); at += 1000; read(); await source.source.flush()
  assert.equal((await owner.page()).records[0]?.state, 'active')
  database.exec('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT)')
  detail({}); touch(); at += 1000; read(); await source.source.flush(); assert.equal((await owner.page()).records[0]?.state, 'active')
  detail({ contextTokensUsed: 3100, contextTokenLimit: 10000 }); touch(); at += 1000; read(); await source.source.flush()
  assert.equal((await owner.page()).records[0]?.state, 'resolved')
  // A real exclusive SQLite lock is a read fault, not an inferred missing count.
  database.exec('BEGIN EXCLUSIVE'); touch(); at += 1000; assert.equal(read().availability, 'error')
  touch(); at += 6000; read(); await source.source.flush()
  assert.equal((await owner.page()).summary.total, 2); assert.equal((await owner.page()).records[0]?.state, 'active')
  database.exec('ROLLBACK')
  reader.dispose(); await source.close(); await owner.close()
  owner = createOwner(); source = new ComposerContextNotifications(owner, () => at); source.setTeam(team)
  reader = new CursorComposerTelemetryReader({ ...options, contextObserver: { begin: input => source.begin(input), unavailable: () => source.unavailable() } })
  const announcements: unknown[] = []; owner.subscribe(event => { if (event.announcement) announcements.push(event.announcement) })
  detail('{PRIVATE broken on restart'); touch(); at += 1000; read(); touch(); at += 6000; read(); await source.source.flush()
  assert.equal((await owner.page()).summary.total, 2); assert.equal(announcements.length, 0)
  const count = (await owner.page()).summary.total
  // A new cause remains the original episode; quit draining doesn't broadcast it.
  database.exec('BEGIN EXCLUSIVE'); touch(); at += 1000; read(); touch(); at += 6000; read()
  const confirmed = await drainNotificationsForQuit(owner, [() => source.close()], () => reader.dispose())
  assert.equal(confirmed, true); assert.equal(announcements.length, 0); database.exec('ROLLBACK')
  owner = createOwner()
  const restored = await owner.page()
  assert.equal(restored.summary.total, count); assert.equal(restored.records[0]?.state, 'active')
  assert.equal(/PRIVATE|sg-context-source-worker-|composer-fixture|state\.vscdb/.test(JSON.stringify(restored)), false)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, realOriginalSqliteReader: true,
    genuineMalformedJsonAndReadLock: true, originalAvailableFallbackPreserved: true, cachedFramesNotFailureProof: true,
    optionalAbsenceOrZeroNotRecovery: true, originalValidContextStillReturned: true, privateReadNotSourceRecovery: true,
    durableRestart: true, noQuitAnnouncements: true, noRawDataOrPaths: true, noAccountingChange: true, isolated: true }, null, 2))
} finally {
  try { database.exec('ROLLBACK') } catch { /* Only if this fixture still owns a transaction. */ }
  reader.dispose(); database.close(); await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
