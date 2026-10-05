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
import { MemoryReviewCoordinator } from '../src/application/memory-review-coordinator'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
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
    tasksRepository = new SqliteTaskPoolRepository(path),
    messages = new SqliteTeamCollaborationRepository(path)
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
    messages.close()
    memoryRepository.close()
    controlRepository.close()
  }
  return {
    controlRepository,
    memoryRepository,
    tasksRepository,
    messages,
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
    members: ['1', '2'].map((channelId) => ({
      channelId,
      roleTemplateKey: 'solo',
      avatarId: 'lead',
      skills: [],
      solo: true
    }))
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
  assert.equal(
    (await active.owner.page({ key: `task:${originalTask.id}` })).records[0]!.subjectState,
    'queued'
  )
  assert.equal(
    (await active.owner.page({ key: `task:${newTask.id}` })).records[0]!.subjectState,
    'prior-data'
  )
  assert.equal(
    (await active.owner.page({ eventType: 'group.topology' })).records.find(
      (record) => record.scope.groupId === newGroup.id
    )!.subjectState,
    'prior-data'
  )
  assert.equal(
    (await active.owner.page({ eventType: 'group.topology' })).records.find(
      (record) => record.scope.groupId === group.id
    )!.subjectState,
    'active'
  )
  for (const type of ['group.rebase', 'memory.rebase', 'task.rebase'])
    assert.equal((await active.owner.page({ eventType: type })).summary.total, 1)
  assert.equal(
    active.events.some((event) => event.announcement),
    false
  )
  assert.equal(sends, 0)
  assert.equal(active.memory.getSnapshot().items[second.id]!.status, 'proposed')
  assert.equal(currentTasks.tasks[originalTask.id]!.status, 'queued')
  assert.equal(
    active.tasksRepository.load().attempts && Object.keys(active.tasksRepository.load().attempts).length,
    0
  )
  await active.close()
  active = open()
  active.control.getSnapshot()
  active.memory.getSnapshot()
  active.tasks.getSnapshot()
  await active.flush()
  for (const type of ['group.rebase', 'memory.rebase', 'task.rebase'])
    assert.equal((await active.owner.page({ eventType: type })).summary.total, 1)
  assert.equal(
    active.events.some((event) => event.announcement),
    false
  )
  // The older backup contains the proposal, but not the later human request or
  // adoption. Restoring native data must not certify that newer receipt merely
  // because the item ID/version is identical, and must not run the coordinator.
  const manual = active.memoryRepository.propose({
    workspaceId: team.activeWorkspaceId!,
    runId,
    scope: 'run',
    kind: 'fact',
    title: '人工处理恢复 fixture',
    content: 'private manual restoration body',
    proposedBy: { type: 'agent', slotId: slots[0]! },
    sources: [{ type: 'file', ref: 'src/private-restore.ts', label: 'original' }],
    clientProposalId: 'manual-restoration-fixture'
  })
  active.memory.getSnapshot()
  await active.flush()
  const manualBackup = join(directory, 'before-manual-request.sqlite')
  vacuumDatabaseInto(path, manualBackup)
  new MemoryReviewCoordinator(
    active.memory,
    active.control,
    active.messages,
    (error) => {
      throw error
    },
    Date.now,
    active.memorySource
  ).reconcile()
  await active.flush()
  const ref = {
    workspaceId: manual.workspaceId,
    runId: manual.runId,
    memoryId: manual.id,
    version: manual.version,
    ...(manual.groupId ? { groupId: manual.groupId } : {})
  }
  const newerProof = active.memorySource.operatorReviewProof(ref)!
  assert.ok(newerProof.messageId)
  active.memory.review(manual.id, 'accept', 'private restored human note', manual.version, {
    workspaceId: manual.workspaceId,
    runId: manual.runId,
    ...(manual.groupId ? { groupId: manual.groupId } : {})
  })
  await active.flush()
  const settled = (await active.owner.page({ memoryId: manual.id })).records[0]!
  assert.equal(settled.subjectState, 'accepted')
  await active.owner.read(settled.id, settled.revision)
  await active.close()
  copyFileSync(manualBackup, path)
  active = open()
  active.memory.getSnapshot()
  await active.flush()
  assert.equal(active.memorySource.operatorReviewProof(ref), undefined)
  assert.equal(
    (await active.owner.page({ memoryId: manual.id })).records[0]!.subjectState,
    'operator-unconfirmed'
  )
  assert.equal(active.memory.getSnapshot().items[manual.id]?.status, 'proposed')
  assert.equal(active.messages.loadRun(runId).messageOrder.length, 0)
  assert.equal(
    active.events.some((event) => event.announcement),
    false
  )
  const beforeRequest = (await active.owner.page({ memoryId: manual.id })).records[0]!
  await active.owner.read(beforeRequest.id, beforeRequest.revision)
  // Explicitly exercising the existing coordinator is separate from notification
  // restore. This actual fresh request is allowed to renew one actionable item.
  const coordinator = new MemoryReviewCoordinator(
    active.memory,
    active.control,
    active.messages,
    (error) => {
      throw error
    },
    Date.now,
    active.memorySource
  )
  coordinator.reconcile()
  await active.flush()
  const currentProof = active.memorySource.operatorReviewProof(ref)!
  assert.notEqual(currentProof.messageId, newerProof.messageId)
  const requested = (await active.owner.page({ memoryId: manual.id })).records[0]!
  assert.equal(requested.id, settled.id)
  assert.equal(requested.subjectState, 'operator-review')
  assert.equal((await active.owner.page({ memoryId: manual.id })).summary.unread, 1)
  const receipts = JSON.stringify(active.messages.loadRun(runId).messages)
  coordinator.reconcile()
  await active.flush()
  assert.equal((await active.owner.page({ memoryId: manual.id })).records[0]!.revision, requested.revision)
  assert.equal(JSON.stringify(active.messages.loadRun(runId).messages), receipts)
  await active.owner.read(requested.id, requested.revision)
  assert.equal(active.memory.getSnapshot().items[manual.id]?.status, 'proposed')
  active.memory.review(manual.id, 'reject', 'private human restored decision', manual.version, {
    workspaceId: manual.workspaceId,
    runId: manual.runId,
    ...(manual.groupId ? { groupId: manual.groupId } : {})
  })
  await active.flush()
  assert.equal((await active.owner.page({ memoryId: manual.id })).summary.pending, 0)
  assert.equal(JSON.stringify(active.messages.loadRun(runId).messages), receipts)
  assert.equal(
    /private manual restoration body|private human restored decision|src\/private-restore.ts/.test(
      JSON.stringify(await active.owner.page())
    ),
    false
  )
  assert.equal(sends, 0)
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
        restoredProposalDoesNotReuseNewerManualRequestProof: true,
        manualRestorationDoesNotRunCoordinator: true,
        actualDifferentOriginalRequestRenewsSameItemOnce: true,
        restoredOriginalHumanDecisionDoesNotWriteAgentReceipts: true,
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
  await Promise.allSettled(
    workers.filter((worker) => worker.threadId !== -1).map((worker) => worker.terminate())
  )
  rmSync(directory, { recursive: true, force: true })
}
