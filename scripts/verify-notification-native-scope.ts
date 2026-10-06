import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationService } from '../src/application/notification-service'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { vacuumDatabaseInto } from '../src/infrastructure/app-update/update-backup'
import { connectGroupTopologyNotifications } from '../src/application/notifications/group-topology-notifications'
import { connectMemoryIssueNotifications } from '../src/application/notifications/memory-issue-notifications'
import { connectTaskNotifications } from '../src/application/notifications/task-notifications'
import { connectNativeScopeAvailabilityNotifications } from '../src/application/notifications/native-scope-availability'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import type { NotificationPush } from '../src/domain/notification'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-native-scope-worker-')), path = join(directory, 'business.sqlite'), workers: Worker[] = []
const owner = new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
const events: NotificationPush[] = []; owner.subscribe(event => events.push(event))
const frame: DesktopSnapshot = { connection: { state: 'connected', endpoint: 'fixture', attempt: 0, lastError: '' }, sessions: [], conversations: {}, protocolIssues: [], updatedAt: 1 }
const bridge = { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: () => { throw Error('must never replay a business command') } }
function open() {
  const repository = new SqliteTeamControlRepository(path), memoryRepository = new SqliteTeamMemoryRepository(path), taskRepository = new SqliteTaskPoolRepository(path)
  const control = new TeamControlService(repository, bridge), memory = new TeamMemoryService(memoryRepository, control), tasks = new TaskPoolService(taskRepository, control)
  const groups = connectGroupTopologyNotifications(control, owner), memories = connectMemoryIssueNotifications(memory, () => { throw Error('must reuse original context') }, owner),
    taskSource = connectTaskNotifications(tasks, () => { throw Error('must reuse original task context') }, owner)
  const scopeSource = connectNativeScopeAvailabilityNotifications(control, owner, {
    'group-topology:': groups.source, 'memory-issues:': memories.source, 'task-notifications:': taskSource.source
  }, { catalogueObserved: catalogue => memories.observeScopeCatalogue(catalogue) })
  let closed = false, revisionReads = 0, fullLoads = 0
  const revision = repository.revision.bind(repository), load = repository.loadTeamControl.bind(repository)
  repository.revision = () => { ++revisionReads; return revision() }; repository.loadTeamControl = () => { ++fullLoads; return load() }
  return { repository, memoryRepository, taskRepository, control, memory, tasks, groups, memories, taskSource, scopeSource,
    counts: () => ({ revisionReads, fullLoads }),
    flush: async () => { await Promise.all([groups.source.flush(), memories.source.flush(), taskSource.source.flush(), scopeSource.flush()]); await owner.flush() },
    close: async () => { if (closed) return; closed = true; await Promise.all([groups.close(), memories.close(), taskSource.close(), scopeSource.close()]);
      memory.dispose(); tasks.stopWatcher(); tasks.stopSweeper(); control.dispose(); repository.close(); memoryRepository.close(); taskRepository.close() } }
}
let current = open()
try {
  current.control.getSnapshot(); await current.flush()
  const emptyBackup = join(directory, 'without-scope.sqlite'), populatedBackup = join(directory, 'with-scope.sqlite')
  vacuumDatabaseInto(path, emptyBackup)
  const team = current.control.createSessionPool({ workspaceId: 'scope-workspace', workspaceName: 'fixture', workspacePath: '/fixture-no-cursor',
    members: ['1', '2'].map(channelId => ({ channelId, roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true })) })
  const runId = team.activeRun!.id, group = current.repository.createGroup({ runId, name: 'original group',
    members: team.members.map(member => ({ slotId: member.slot.id, roleTemplateKey: 'builder' })), at: 1 }).group
  current.control.getSnapshot()
  const propose = (title: string, supersedesId?: string) => current.memoryRepository.propose({ workspaceId: team.activeWorkspaceId!, runId, scope: 'run', kind: 'decision', title,
    content: 'PRIVATE original body never copied to scope catalogue or notifications', proposedBy: { type: 'operator' }, sources: [{ type: 'file', ref: 'src/fixture', label: 'fixture' }],
    clientProposalId: `scope-${title}`, ...(supersedesId ? { supersedesId } : {}) })
  const parent = propose('parent'); current.memoryRepository.review({ memoryId: parent.id, decision: 'accept', reviewer: { type: 'operator' } })
  const first = propose('first', parent.id), second = propose('second', parent.id)
  current.memoryRepository.review({ memoryId: first.id, decision: 'accept', reviewer: { type: 'operator' } }); current.memory.getSnapshot()
  const task = current.tasks.createTask({ title: 'original task' }); current.tasks.cancelTask(task.id, 'fixture'); await current.flush()
  const oldTask = (await owner.page({ key: `task:${task.id}` })).records[0]!, oldMemory = (await owner.page({ memoryId: second.id })).records[0]!
  assert.equal(oldMemory.subjectState, 'conflict'); assert.equal(oldTask.subjectState, 'cancelled')
  vacuumDatabaseInto(path, populatedBackup)
  const announcements = events.filter(event => event.announcement).length
  await current.close(); copyFileSync(emptyBackup, path); current = open()
  const beforeMissing = current.counts(), empty = current.control.getSnapshot(); await current.flush()
  assert.equal(empty.runs.length, 0)
  assert.equal(current.counts().revisionReads - beforeMissing.revisionReads, 1, 'catalogue projection must not query the original team again')
  for (const query of [{ key: `task:${task.id}` }, { memoryId: second.id }, { eventType: 'group.topology' }]) {
    const record = (await owner.page(query)).records.find(value => query.eventType ? value.scope.groupId === group.id : true)!
    assert.equal(record.subjectState, 'scope-unconfirmed'); assert.equal(record.state, 'expired'); assert.equal(record.target, undefined)
  }
  const counts = current.counts()
  for (let index = 0; index < 100; index++) current.control.getSnapshot()
  await current.flush(); assert.equal(current.counts().revisionReads - counts.revisionReads, 100); assert.equal(current.counts().fullLoads, counts.fullLoads)
  assert.equal(events.filter(event => event.announcement).length, announcements)
  await current.close(); copyFileSync(populatedBackup, path); current = open()
  current.control.getSnapshot(); await current.flush()
  assert.equal((await owner.page({ memoryId: second.id })).records[0]?.subjectState, 'scope-unconfirmed', 'directory presence is not a specific memory read')
  assert.equal((await owner.page({ key: `task:${task.id}` })).records[0]?.subjectState, 'scope-unconfirmed', 'directory presence is not a specific task read')
  current.memory.getSnapshot(); current.tasks.getSnapshot(); await current.flush()
  const restoredMemory = (await owner.page({ memoryId: second.id })).records[0]!, restoredTask = (await owner.page({ key: `task:${task.id}` })).records[0]!
  assert.equal(restoredMemory.subjectState, 'conflict'); assert.equal(restoredTask.subjectState, 'cancelled')
  assert.notEqual(restoredMemory.eventId, oldMemory.eventId); assert.notEqual(restoredTask.eventId, oldTask.eventId)
  assert.match((await owner.page({ eventType: 'task.rebase' })).records[0]!.title, /重新确认/)
  assert.equal(events.filter(event => event.announcement).length, announcements)
  assert.equal(current.memory.getSnapshot().items[second.id]?.status, 'proposed'); assert.equal(current.tasks.getSnapshot().tasks[task.id]?.status, 'cancelled')
  assert.equal(/PRIVATE original body/.test(JSON.stringify(await owner.page())), false)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, originalServicesAndSqlite: true,
    coldOriginalScopeDisappearanceWithPreservedPrivateHistory: true, directoryPresenceNotSpecificSourceRecovery: true,
    genuineSpecificReadsReconfirmWithoutBusinessReplay: true, noExtraOriginalTeamQueries: true, stable100ReadsKeepOriginalCache: true,
    noHistoricalAlertReplay: true, noOriginalBodiesCopied: true, isolated: true }, null, 2))
} finally {
  await current.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
