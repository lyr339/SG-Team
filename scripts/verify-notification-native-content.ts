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
import { TeamMemoryService } from '../src/application/team-memory-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { connectGroupTopologyNotifications } from '../src/application/notifications/group-topology-notifications'
import { connectMemoryIssueNotifications } from '../src/application/notifications/memory-issue-notifications'
import { connectTaskNotifications } from '../src/application/notifications/task-notifications'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import type { NotificationPush } from '../src/domain/notification'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-native-content-worker-')), path = join(directory, 'business.sqlite'), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
const events: NotificationPush[] = []; owner.subscribe(event => events.push(event))
const frame: DesktopSnapshot = { connection: { state: 'connected', endpoint: 'fixture-only', attempt: 0, lastError: '' }, sessions: [], conversations: {}, protocolIssues: [], updatedAt: 1 }
const open = () => {
  const controlRepository = new SqliteTeamControlRepository(path), memoryRepository = new SqliteTeamMemoryRepository(path), taskRepository = new SqliteTaskPoolRepository(path)
  const control = new TeamControlService(controlRepository, { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: () => ({ commandId: 'fixture' }) })
  const memory = new TeamMemoryService(memoryRepository, control), tasks = new TaskPoolService(taskRepository, control)
  const groups = connectGroupTopologyNotifications(control, owner), memories = connectMemoryIssueNotifications(memory, () => { throw Error('must use original read context') }, owner),
    taskSource = connectTaskNotifications(tasks, () => control.getSnapshot(), owner)
  let closed = false
  return { controlRepository, memoryRepository, taskRepository, control, memory, tasks, groups, memories, taskSource,
    flush: async () => { await Promise.all([groups.source.flush(), memories.source.flush(), taskSource.source.flush()]); await owner.flush() },
    close: async () => { if (closed) return; closed = true; await Promise.all([groups.close(), memories.close(), taskSource.close()]); memory.dispose(); tasks.stopWatcher(); tasks.stopSweeper(); control.dispose();
      controlRepository.close(); memoryRepository.close(); taskRepository.close() } }
}
let current = open(), database: DatabaseSync | undefined
try {
  const team = current.control.createSessionPool({ workspaceId: 'same-native-workspace', workspaceName: 'fixture', workspacePath: '/fixture-no-cursor',
    members: ['1', '2'].map(channelId => ({ channelId, roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true })) })
  const runId = team.activeRun!.id, group = current.controlRepository.createGroup({ runId, name: 'Before source fork',
    members: team.members.map(member => ({ slotId: member.slot.id, roleTemplateKey: 'builder' })), leadSlotId: team.members[0]!.slot.id, at: 1 }).group
  const nativeTeam = current.control.getSnapshot()
  const propose = (name: string, supersedesId?: string) => current.memoryRepository.propose({ workspaceId: team.activeWorkspaceId!, runId, scope: 'run', kind: 'decision', title: name,
    content: 'PRIVATE original body never copied into the notification checkpoint', proposedBy: { type: 'operator' }, sources: [{ type: 'file', ref: 'src/fixture', label: 'fixture' }],
    clientProposalId: `native-content-${name}`, ...(supersedesId ? { supersedesId } : {}) })
  const parent = propose('parent'); current.memoryRepository.review({ memoryId: parent.id, decision: 'accept', reviewer: { type: 'operator' } })
  const first = propose('first', parent.id), second = propose('second', parent.id)
  current.memoryRepository.review({ memoryId: first.id, decision: 'accept', reviewer: { type: 'operator' } })
  const nativeMemory = current.memory.getSnapshot()
  const task = current.tasks.createTask({ title: 'Source task' }); current.tasks.cancelTask(task.id, 'fixture')
  const nativeTask = current.tasks.getSnapshot(); await current.flush()
  const memoryRecord = (await owner.page({ memoryId: second.id })).records[0]!
  assert.equal(memoryRecord.subjectState, 'conflict')
  const liveBeforeFork = events.filter(event => event.announcement).length
  database = new DatabaseSync(path)
  // Controlled business DATA in the fixture, not a new business action. Keep
  // revision counters equal, like conflicting native versions/backup branches.
  database.prepare("UPDATE team_memory_items SET status='rejected',updated_at=updated_at+1 WHERE id=?").run(second.id)
  database.prepare("UPDATE tasks SET status='failed',failure_reason='source fork',updated_at=updated_at+1 WHERE id=?").run(task.id)
  database.prepare('UPDATE team_groups SET name=? WHERE id=?').run('After source fork', group.id)
  assert.equal(current.memory.getSnapshot().revision, nativeMemory.revision)
  assert.equal(current.tasks.getSnapshot().revision, nativeTask.revision); await current.flush()
  assert.equal((await owner.page({ memoryId: second.id })).records[0]?.subjectState, 'rejected')
  assert.equal((await owner.page({ key: `task:${task.id}` })).records[0]?.subjectState, 'failed')
  assert.match((await owner.page({ eventType: 'memory.rebase' })).records[0]!.title, /相同修订号/)
  assert.match((await owner.page({ eventType: 'task.rebase' })).records[0]!.title, /相同修订号/)
  // Do not manufacture a fresh group read when the ORIGINAL business service
  // intentionally reuses its own revision cache. This remains a separate gap.
  assert.equal(current.control.getSnapshot().groups[0]?.group.name, 'Before source fork')
  await current.close(); current = open()
  const fresh = current.control.getSnapshot(); await current.flush()
  assert.equal(fresh.revision, nativeTeam.revision); assert.equal(fresh.groups[0]?.group.name, 'After source fork')
  assert.match((await owner.page({ eventType: 'group.rebase' })).records[0]!.title, /相同修订号/)
  assert.equal((await owner.page({ eventType: 'group.topology' })).records.find(record => record.scope.groupId === group.id)?.source, '协作组 · After source fork')
  const before = (await owner.page()).summary.total
  for (let index = 0; index < 20; index++) { current.control.getSnapshot(); current.memory.getSnapshot(); current.tasks.getSnapshot() }
  await current.flush(); assert.equal((await owner.page()).summary.total, before)
  assert.equal(events.filter(event => event.announcement).length, liveBeforeFork)
  assert.equal(/PRIVATE original body/.test(JSON.stringify(await owner.page())), false)
  database.prepare('DELETE FROM team_memory_items WHERE id=?').run(second.id)
  database.prepare('DELETE FROM tasks WHERE id=?').run(task.id)
  current.memory.getSnapshot(); current.tasks.getSnapshot(); await current.flush()
  assert.equal((await owner.page({ memoryId: second.id })).records[0]?.subjectState, 'prior-data')
  assert.equal((await owner.page({ key: `task:${task.id}` })).records[0]?.subjectState, 'prior-data')
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, realOriginalServicesAndSqlite: true,
    equalNativeRevisionsWithActualChangedRows: true, memoryAndTaskLiveReadsReprojected: true, freshGroupReadAcrossOriginalServiceRestart: true,
    originalHotGroupCacheNotPretendedFresh: true, missingFactsNotClaimedCompletedOrDeleted: true, currentStateNotBusinessReplay: true,
    noHistoricalAlertReplay: true, noOriginalBodiesCopied: true, normalSubsequentReadsQuiet: true, isolated: true }, null, 2))
} finally {
  database?.close(); await current.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
