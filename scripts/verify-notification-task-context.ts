import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { TeamControlService } from '../src/application/team-control-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { connectTaskNotifications } from '../src/application/notifications/task-notifications'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

// Real original reads and built private worker. No production main, Cursor,
// account workflow, model request or native OS notification.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-task-context-worker-')), path = join(directory, 'business.sqlite'), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
class TaskRepository extends SqliteTaskPoolRepository {
  reads = 0
  override load() { this.reads++; return super.load() }
}
class Control extends TeamControlService {
  snapshots = 0
  scopes = 0
  override getSnapshot() { this.snapshots++; return super.getSnapshot() }
  override getActiveTaskScope() { this.scopes++; return super.getActiveTaskScope() }
}
const repository = new SqliteTeamControlRepository(path), tasksRepository = new TaskRepository(path)
const frame: DesktopSnapshot = { connection: { state: 'connected', endpoint: 'fixture-only', attempt: 0, lastError: '' }, sessions: [], conversations: {}, protocolIssues: [], updatedAt: 1 }
const control = new Control(repository, { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: () => ({ commandId: 'fixture' }) })
control.createSessionPool({ workspaceId: 'task-context-workspace', workspaceName: 'fixture', workspacePath: directory,
  members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true }] })
const tasks = new TaskPoolService(tasksRepository, control), source = connectTaskNotifications(tasks, () => { throw Error('notification must not read a second team frame') }, owner)
try {
  const before = { pool: tasksRepository.reads, scope: control.scopes, snapshot: control.snapshots }
  const snapshot = tasks.getSnapshot(); await source.source.flush()
  assert.equal(tasksRepository.reads, before.pool + 1); assert.equal(control.scopes, before.scope + 1); assert.equal(control.snapshots, before.snapshot)
  assert.equal(Object.hasOwn(snapshot, 'context'), false); assert.equal(Object.hasOwn(snapshot, 'runStatus'), false)
  assert.equal(owner.status().historyIncomplete, false)
  const task = tasks.createTask({ title: 'Original task' }); await source.source.flush()
  tasks.cancelTask(task.id, 'fixture cancellation'); await source.source.flush()
  const cancelled = (await owner.page({ key: `task:${task.id}` })).records[0]!
  assert.equal(cancelled.subjectState, 'cancelled')
  const ended = control.endActiveRun(), read = tasks.getSnapshot(); await source.source.flush()
  assert.equal(ended.activeRun?.status, 'completed'); assert.equal(read.runId, snapshot.runId)
  assert.equal(owner.status().historyIncomplete, false)
  const reads = tasksRepository.reads, scopes = control.scopes, snapshots = control.snapshots
  for (let index = 0; index < 30; index++) tasks.getSnapshot()
  await source.source.flush()
  assert.equal(tasksRepository.reads, reads + 30); assert.equal(control.scopes, scopes + 30); assert.equal(control.snapshots, snapshots)
  assert.equal((await owner.page({ key: `task:${task.id}` })).records[0]?.id, cancelled.id)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, realOriginalTaskAndControlServices: true,
    exactlyOneOriginalPoolAndScopeRead: true, noSecondTeamOrRuntimeQuery: true, originalPublicSnapshotUnchanged: true,
    originalTaskResultsStillObserved: true, originalCompletedScopeObserved: true, routineReadsNoExtraQueries: true, isolated: true }, null, 2))
} finally {
  await source.close().catch(() => {}); await owner.close().catch(() => {})
  tasks.stopWatcher(); tasks.stopSweeper(); control.dispose(); repository.close(); tasksRepository.close()
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
