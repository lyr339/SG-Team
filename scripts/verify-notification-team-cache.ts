import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { NotificationService } from '../src/application/notification-service'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { TeamControlService } from '../src/application/team-control-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { connectGroupTopologyNotifications } from '../src/application/notifications/group-topology-notifications'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

// Real live original SQLite connection and service cache, not a fake reload.
// All writes/reads are fixture-only; no production main, Cursor or accounts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-team-cache-worker-')), path = join(directory, 'business.sqlite'), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
class Repository extends SqliteTeamControlRepository {
  revisions = 0
  loads = 0
  override revision() { this.revisions++; return super.revision() }
  override loadTeamControl() { this.loads++; return super.loadTeamControl() }
}
const repository = new Repository(path)
const frame: DesktopSnapshot = { connection: { state: 'connected', endpoint: 'fixture-only', attempt: 0, lastError: '' }, sessions: [], conversations: {}, protocolIssues: [], updatedAt: 1 }
const service = new TeamControlService(repository, { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: () => ({ commandId: 'fixture' }) })
const source = connectGroupTopologyNotifications(service, owner), database = new DatabaseSync(path)
try {
  const pool = service.createSessionPool({ workspaceId: 'team-cache-workspace', workspaceName: 'fixture', workspacePath: directory,
    members: ['1', '2'].map(channelId => ({ channelId, roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true })) })
  const group = repository.createGroup({ runId: pool.activeRun!.id, name: 'Old relation', members: pool.members.map(member => ({ slotId: member.slot.id, roleTemplateKey: 'builder' })), at: 1 }).group
  const before = service.getSnapshot(); await source.source.flush()
  let loads = repository.loads, revisions = repository.revisions
  for (let index = 0; index < 100; index++) service.getSnapshot()
  await source.source.flush()
  assert.equal(repository.loads, loads); assert.equal(repository.revisions, revisions + 100)
  const known = repository.lastReadVersion()
  for (let index = 0; index < 100; index++) assert.equal(repository.lastReadVersion(), known)
  assert.equal(repository.revisions, revisions + 100) // Zero-query witness getter.

  database.prepare('UPDATE team_groups SET name=? WHERE id=?').run('New relation same revision', group.id)
  const current = service.getSnapshot(); await source.source.flush()
  assert.equal(current.revision, before.revision); assert.equal(current.groups[0]?.group.name, 'New relation same revision')
  assert.equal(repository.loads, loads + 1)
  assert.match((await owner.page({ eventType: 'group.rebase' })).records[0]!.title, /相同修订号/)
  const total = (await owner.page()).summary.total
  database.exec("CREATE TABLE unrelated_fixture(value TEXT); INSERT INTO unrelated_fixture VALUES('preserve')")
  service.getSnapshot(); await source.source.flush()
  assert.equal((await owner.page()).summary.total, total) // A storage commit is NOT a topology-change notification.
  assert.equal(repository.loads, loads + 2)
  loads = repository.loads; revisions = repository.revisions
  for (let index = 0; index < 100; index++) service.getSnapshot()
  await source.source.flush(); assert.equal(repository.loads, loads); assert.equal(repository.revisions, revisions + 100)

  // The original watcher must still observe changes after getActiveTaskScope
  // refreshed its cache first. No new timer/poll is introduced by notifications.
  let changed!: () => void, watcherObserved = false
  const observed = new Promise<void>(done => { changed = done })
  const stop = service.subscribe(snapshot => { if (snapshot.groups[0]?.group.name === 'Scope saw it before watcher') { watcherObserved = true; changed() } })
  database.prepare('UPDATE team_groups SET name=? WHERE id=?').run('Scope saw it before watcher', group.id)
  service.getActiveTaskScope(); service.startWatcher(250)
  const timer = setTimeout(() => changed(), 3000)
  await observed; clearTimeout(timer); service.stopWatcher(); stop()
  assert.equal(watcherObserved, true, 'fixture timeout is not proof that the original watcher emitted the new source data')
  assert.equal(service.getSnapshot().groups[0]?.group.name, 'Scope saw it before watcher')
  await source.source.flush()
  assert.equal(Number(database.prepare('SELECT schema_version FROM team_control_meta WHERE id=1').get()!.schema_version), 9)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, realHotServiceCache: true,
    externalEqualRevisionChangeActuallyReread: true, stableTrafficStillOneOriginalRevisionRead: true, pureMemoryWitnessGetter: true,
    unrelatedStorageChangeNotTopologyAlarm: true, actualOriginalWatcherStillEmitsAfterScopeRead: true,
    noSchemaTriggerOrBusinessReplay: true, isolated: true }, null, 2))
} finally {
  service.stopWatcher(); await source.close().catch(() => {}); await owner.close().catch(() => {})
  service.dispose(); database.close(); repository.close()
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
