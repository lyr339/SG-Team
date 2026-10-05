import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { GroupEffectsNotifications } from '../src/application/notifications/group-effects-notifications'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamGroupService } from '../src/application/team-group-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { membershipTransferNotification } from '../src/domain/membership-transfer-notification'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
// Original isolated business services plus the current built private worker. No
// production main, Cursor, MCP config, model/account/OS operation or business retry.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  folder = join(root, 'out/main'),
  entry = readdirSync(folder).find((name) => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('build the private worker first')
const directory = mkdtempSync(join(tmpdir(), 'sg-group-effects-runtime-')),
  path = join(directory, 'business.sqlite'),
  workers: Worker[] = []
const repository = new SqliteTeamControlRepository(path),
  messages = new SqliteTeamCollaborationRepository(path),
  taskRepository = new SqliteTaskPoolRepository(path)
const frame: DesktopSnapshot = {
  connection: { state: 'connected', endpoint: 'fixture-only', attempt: 0, lastError: '' },
  sessions: [],
  conversations: {},
  protocolIssues: [],
  updatedAt: 1
}
let calls = 0,
  fail = false
const bridge = {
  getSnapshot: () => frame,
  subscribe: () => () => {},
  sendMessage: () => {
    calls++
    if (fail) throw Error('private fixture error not copied')
    return { commandId: `fixture-${calls}` }
  }
}
const control = new TeamControlService(repository, bridge),
  tasks = new TaskPoolService(taskRepository, control)
const owner = new NotificationService(
  new NotificationWorkerPort(
    (options) => {
      const w = new Worker(pathToFileURL(join(folder, entry)), options)
      workers.push(w)
      return w
    },
    join(directory, 'notifications.sqlite')
  )
)
let source: GroupEffectsNotifications | undefined
const errors: unknown[] = []
const groups = new TeamGroupService(repository, control, tasks, messages, bridge, {
  onerror: (error) => errors.push(error),
  effects: { observe: (value) => source?.observe(value), unavailable: () => owner.reportHistoryGap() }
})
source = new GroupEffectsNotifications(owner, groups.getEffectsOwnerId())
try {
  const initial = control.createSessionPool({
    workspaceId: 'fixture-group-workspace',
    workspaceName: 'fixture',
    workspacePath: '/fixture-no-cursor',
    members: ['1', '2', '3'].map((channelId) => ({
      channelId,
      roleTemplateKey: 'solo',
      avatarId: 'lead',
      skills: [],
      solo: true
    }))
  })
  const runId = initial.activeRun!.id,
    slots = initial.members.map((member) => member.slot.id)
  control.recordInstallation({
    workspaceId: initial.activeWorkspaceId!,
    runId,
    generation: 'fixture',
    agents: slots.map((_, i) => ({
      workspaceId: initial.activeWorkspaceId!,
      runId,
      channelId: String(i + 1),
      agentSessionId: `${initial.activeWorkspaceId}:ch-${i + 1}:fixture`,
      generation: 'fixture',
      capabilities: []
    }))
  })
  const created = groups.createGroup({
    name: '原组 fixture',
    goal: 'private original goal',
    members: [
      { slotId: slots[0]!, roleTemplateKey: 'lead' },
      { slotId: slots[1]!, roleTemplateKey: 'builder' }
    ],
    leadSlotId: slots[0]
  })
  await source.flush()
  assert.equal((await owner.page()).summary.total, 0)
  assert.equal(calls, 2)
  fail = true
  const result = groups.transferMembership({
    groupId: created.groups[0]!.group.id,
    fromSlotId: slots[1]!,
    toSlotId: slots[2]!
  })
  await source.flush()
  assert.equal(
    result.groupEffects?.effects.filter(
      (effect) => effect.kind === 'membership' && effect.status === 'unconfirmed'
    ).length,
    2
  )
  assert.equal(calls, 4)
  assert.equal(errors.length, 2)
  assert.equal(
    control.getSnapshot().members.find((member) => member.slot.id === slots[2])?.slot.groupId,
    result.groupId
  )
  const before = (await owner.page()).records[0]!
  await owner.read(before.id, before.revision)
  assert.equal(result.groupEffects?.phase, 'completed')
  const parent = membershipTransferNotification({ transfer: result }, control.getSnapshot())
  assert.equal(parent.tone, 'warning')
  owner.offerCurrent(parent)
  source.linkTransfer(result.groupEffects!.id, { key: parent.key, eventId: parent.eventId })
  await source.flush()
  await owner.flush()
  const page = await owner.page()
  assert.equal(page.summary.total, 2)
  assert.equal(page.summary.unread, 1)
  assert.equal(page.records.find((record) => record.id === before.id)?.attention, 'activity')
  assert.equal(/private original goal|private fixture error/.test(JSON.stringify(page)), false)
  assert.equal(calls, 4)
  console.log(
    JSON.stringify(
      {
        runtime: process.versions.electron ? 'Electron' : 'Node',
        realBuiltWorker: true,
        realGroupMutation: true,
        originalSendCountsPreserved: true,
        knownRoleChangeNotRolledBack: true,
        actualUnknownReceipts: true,
        noNormalSuccessHistory: true,
        oneUnreadAfterStoredParentProof: true,
        noRawGoalOrError: true,
        noBusinessReplay: true,
        isolated: true
      },
      null,
      2
    )
  )
} finally {
  await source.close()
  await owner.close().catch(() => {})
  tasks.stopWatcher()
  tasks.stopSweeper()
  control.dispose()
  messages.close()
  taskRepository.close()
  repository.close()
  await Promise.allSettled(workers.filter((w) => w.threadId !== -1).map((w) => w.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
