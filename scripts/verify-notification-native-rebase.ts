import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { connectGroupTopologyNotifications } from '../src/application/notifications/group-topology-notifications'
import { connectMemoryIssueNotifications } from '../src/application/notifications/memory-issue-notifications'
import { connectTaskNotifications } from '../src/application/notifications/task-notifications'
import { vacuumDatabaseInto } from '../src/infrastructure/app-update/update-backup'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import type { NotificationPush } from '../src/domain/notification'

// Actual SQLite backup/restore, original services and built private worker.
// No production main, updater helper/GUI, Cursor/app profile or model/account action.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  folder = join(root, 'out', 'main')
const entry = readdirSync(folder).find((name) => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-native-rebase-runtime-')),
  path = join(directory, 'business.sqlite'),
  ledgerPath = join(directory, 'notifications.sqlite')
const workers: Worker[] = [],
  frame: DesktopSnapshot = {
    connection: { state: 'connected', endpoint: 'fixture', attempt: 0, lastError: '' },
    sessions: [],
    conversations: {},
    protocolIssues: [],
    updatedAt: 1
  }
let sends = 0
function open() {
  const controlRepository = new SqliteTeamControlRepository(path),
    memoryRepository = new SqliteTeamMemoryRepository(path),
    tasksRepository = new SqliteTaskPoolRepository(path)
  const control = new TeamControlService(controlRepository, {
    getSnapshot: () => frame,
    subscribe: () => () => {},
    sendMessage: () => {
      sends++
      return { commandId: 'fixture' }
    }
  })
  const memory = new TeamMemoryService(memoryRepository, control),
    tasks = new TaskPoolService(tasksRepository, control)
  const owner = new NotificationService(
    new NotificationWorkerPort((options) => {
      const worker = new Worker(pathToFileURL(join(folder, entry!)), options)
      workers.push(worker)
      return worker
    }, ledgerPath)
  )
  const events: NotificationPush[] = []
  owner.subscribe((event) => events.push(event))
  const groups = connectGroupTopologyNotifications(control, owner),
    memorySource = connectMemoryIssueNotifications(
      memory,
      () => {
        throw Error('must use the original read context')
      },
      owner
    ),
    taskSource = connectTaskNotifications(tasks, () => control.getSnapshot(), owner)
  const flush = async () => {
    await groups.source.flush()
    await memorySource.source.flush()
    await taskSource.source.flush()
    await owner.flush()
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await Promise.all([groups.close(), memorySource.close(), taskSource.close()])
    await owner.close()
    tasks.stopWatcher()
    tasks.stopSweeper()
    memory.dispose()
    control.dispose()
    tasksRepository.close()
    memoryRepository.close()
    controlRepository.close()
  }
  return {
    controlRepository,
    memoryRepository,
    tasksRepository,
    control,
    memory,
    tasks,
    owner,
    events,
    groups,
    memorySource,
    taskSource,
    flush,
    close
  }
}
let active = open()
try {
  const team = active.control.createSessionPool({
    workspaceId: 'restore-test',
    workspaceName: 'test',
    workspacePath: '/fixture-no-cursor',
    members: ['1', '2'].map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true }))
  })
  const runId = team.activeRun!.id,
    slots = team.members.map((member) => member.slot.id)
  const group = active.controlRepository.createGroup({
    runId,
    name: '备份前的组',
    members: slots.map((slotId) => ({ slotId, roleTemplateKey: 'builder' })),
    leadSlotId: slots[0],
    at: 1
  }).group
  active.control.getSnapshot()
  const propose = (title: string, supersedesId?: string) =>
    active.memoryRepository.propose({
      workspaceId: 'restore-test',
      runId,
      scope: 'run',
      kind: 'decision',
      title,
      content: 'fixture full body is not ledger data',
      proposedBy: { type: 'operator' },
      sources: [{ type: 'file', ref: 'src/fixture.ts', label: 'fixture' }],
      clientProposalId: `restore-${title}`,
      ...(supersedesId ? { supersedesId } : {})
    })
  const parent = propose('parent')
  active.memoryRepository.review({ memoryId: parent.id, decision: 'accept', reviewer: { type: 'operator' } })
  const first = propose('first', parent.id),
    second = propose('second', parent.id)
  active.memoryRepository.review({ memoryId: first.id, decision: 'accept', reviewer: { type: 'operator' } })
  active.memory.getSnapshot()
  const originalTask = active.tasks.createTask({ title: '备份前任务' })
  await active.flush()
  const backup = join(directory, 'before.sqlite')
  vacuumDatabaseInto(path, backup)
  active.memory.review(second.id, 'reject')
  active.tasks.cancelTask(originalTask.id, 'fixture later cancellation')
  active.controlRepository.setGroupLead({ groupId: group.id, slotId: slots[1]!, at: 2 })
  active.control.getSnapshot()
  await active.flush()
  const old = (await active.owner.page({ memoryId: second.id })).records[0]!
  await active.owner.read(old.id, old.revision)
  await active.owner.clearRead({ key: old.key })
  active.controlRepository.dissolveGroup({ groupId: group.id, at: 3 })
  const newGroup = active.controlRepository.createGroup({
    runId,
    name: '备份后新组',
    members: [{ slotId: slots[0]!, roleTemplateKey: 'builder' }],
    at: 4
  }).group
  active.control.getSnapshot()
  const newTask = active.tasks.createTask({ title: '备份后任务' })
  active.tasks.cancelTask(newTask.id, 'fixture only')
  await active.flush()
  const before = {
    groups: active.control.getSnapshot().revision,
    memory: active.memoryRepository.revision(),
    tasks: active.tasksRepository.load().revision
  }
  await active.close()
  copyFileSync(backup, path)
  active = open()
  const current = active.control.getSnapshot()
  active.memory.getSnapshot()
  const currentTasks = active.tasks.getSnapshot()
  await active.flush()
  assert.ok(current.revision < before.groups)
  assert.ok(active.memoryRepository.revision() < before.memory)
  assert.ok(currentTasks.revision < before.tasks)
  assert.equal((await active.owner.page({ memoryId: second.id })).records[0]!.subjectState, 'conflict')
  assert.equal((await active.owner.page({ eventType: 'memory.issue' })).summary.pending, 1)
  assert.equal((await active.owner.page({ key: `task:${originalTask.id}` })).records[0]!.subjectState, 'queued')
  assert.equal((await active.owner.page({ key: `task:${newTask.id}` })).records[0]!.subjectState, 'prior-data')
  assert.equal(
    (await active.owner.page({ eventType: 'group.topology' })).records.find((record) => record.scope.groupId === newGroup.id)!.subjectState,
    'prior-data'
  )
  assert.equal(
    (await active.owner.page({ eventType: 'group.topology' })).records.find((record) => record.scope.groupId === group.id)!.subjectState,
    'active'
  )
  for (const type of ['group.rebase', 'memory.rebase', 'task.rebase']) assert.equal((await active.owner.page({ eventType: type })).summary.total, 1)
  assert.equal(
    active.events.some((event) => event.announcement),
    false
  )
  assert.equal(sends, 0)
  assert.equal(active.memory.getSnapshot().items[second.id]!.status, 'proposed')
  assert.equal(currentTasks.tasks[originalTask.id]!.status, 'queued')
  assert.equal(active.tasksRepository.load().attempts && Object.keys(active.tasksRepository.load().attempts).length, 0)
  await active.close()
  active = open()
  active.control.getSnapshot()
  active.memory.getSnapshot()
  active.tasks.getSnapshot()
  await active.flush()
  for (const type of ['group.rebase', 'memory.rebase', 'task.rebase']) assert.equal((await active.owner.page({ eventType: type })).summary.total, 1)
  assert.equal(
    active.events.some((event) => event.announcement),
    false
  )
  console.log(
    JSON.stringify(
      {
        runtime: process.versions.electron ? 'Electron' : 'Node',
        realBuiltWorker: true,
        realSqliteVacuumBackupAndRestore: true,
        privateLedgerNotRestored: true,
        currentReadAllowsLowerNativeRevision: true,
        restoredMemoryConflictNotHiddenByPriorRejectOrClear: true,
        restoredTaskNotStuckCancelled: true,
        absentGroupAndTaskLabelledPriorData: true,
        restartRebaseSummaryNotDuplicated: true,
        noPresentationReplay: true,
        noBusinessSendsOrLeaseReplay: true,
        isolatedFixture: true
      },
      null,
      2
    )
  )
} finally {
  await active.close().catch(() => {})
  await Promise.allSettled(workers.filter((worker) => worker.threadId !== -1).map((worker) => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
