import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { CompatibilityNotifications } from '../src/application/notifications/compatibility-notifications'
import { connectMemoryIssueNotifications } from '../src/application/notifications/memory-issue-notifications'
import { connectGroupTopologyNotifications } from '../src/application/notifications/group-topology-notifications'
import { CursorSwitchPumpInstaller } from '../src/infrastructure/cursor/cursor-switch-pump-installer'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { MemoryReviewCoordinator } from '../src/application/memory-review-coordinator'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

// Real isolated business repositories and a real built notification worker.
// The fake workbench and bridge belong to this fixture, not the installed Cursor/app.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  folder = join(root, 'out', 'main')
const entry = readdirSync(folder).find((name) => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-notification-team-')),
  workers: Worker[] = []
const port = new NotificationWorkerPort(
  (options) => {
    const worker = new Worker(pathToFileURL(join(folder, entry)), options)
    workers.push(worker)
    return worker
  },
  join(directory, 'notifications.sqlite')
)
const owner = new NotificationService(port),
  compatibility = new CompatibilityNotifications(owner)
const controlRepository = new SqliteTeamControlRepository(join(directory, 'business.sqlite')),
  memoryRepository = new SqliteTeamMemoryRepository(join(directory, 'business.sqlite')),
  messages = new SqliteTeamCollaborationRepository(join(directory, 'business.sqlite'))
const frame: DesktopSnapshot = {
  connection: { state: 'connected', endpoint: 'fixture', attempt: 0, lastError: '' },
  sessions: [],
  conversations: {},
  protocolIssues: [],
  updatedAt: 1
}
const control = new TeamControlService(controlRepository, {
  getSnapshot: () => frame,
  subscribe: () => () => {},
  sendMessage: () => ({ commandId: 'fixture' })
})
let team = control.createSessionPool({
  workspaceId: 'fixture-workspace',
  workspaceName: 'fixture-workspace',
  workspacePath: '/fixture-no-cursor',
  members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true }]
})
const stop = control.subscribe((next) => {
    team = next
  }),
  memory = new TeamMemoryService(memoryRepository, { getSnapshot: () => team, subscribe: () => () => {} })
let memorySource = connectMemoryIssueNotifications(memory, () => team, owner)
const groups = connectGroupTopologyNotifications(control, owner)
const propose = (title: string, supersedesId?: string) =>
  memoryRepository.propose({
    workspaceId: team.activeWorkspaceId!,
    runId: team.activeRun!.id,
    scope: 'run',
    kind: 'decision',
    title,
    content: 'this complete original memory body must not be copied into the notification ledger',
    sources: [{ type: 'file', ref: 'src/fixture.ts', label: 'fixture' }],
    proposedBy: { type: 'operator' },
    clientProposalId: `fixture-${title}`,
    ...(supersedesId ? { supersedesId } : {})
  })
try {
  await owner.flush()
  await groups.source.flush()
  const appRoot = join(directory, 'Cursor.app', 'Contents', 'Resources', 'app'),
    bundlePath = join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
  mkdirSync(dirname(bundlePath), { recursive: true })
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ version: '3.21.12' }))
  writeFileSync(join(appRoot, 'product.json'), JSON.stringify({ version: '3.21.12' }))
  writeFileSync(
    bundlePath,
    'class FixtureAuth{constructor(){this.overrideAccessToken=undefined;this.storageService={};this.notifyLoginChangedListeners=()=>{};this.storeEmailAndSignUpType=()=>{};this.storeAccessRefreshToken=()=>{};}}'
  )
  const installer = new CursorSwitchPumpInstaller({
    bundlePath,
    statusObserver: compatibility,
    execFn: async () => {
      throw Error('fixture never runs install commands')
    }
  })
  assert.equal((await installer.status()).kind, 'not-installed')
  await compatibility.flush()
  writeFileSync(bundlePath, 'const noAuthCapabilityInFixture=true;')
  const observed = await installer.status()
  await compatibility.flush()
  assert.equal(observed.compatibility?.state, 'supported')
  assert.equal(observed.kind, 'unsupported')
  assert.equal(
    (await owner.page({ installationId: observed.installationId, eventType: 'cursor.compatibility' }))
      .records[0]!.subjectState,
    'capability'
  )
  assert.equal((await owner.page({ installationId: 'wrong' })).summary.total, 0)

  memory.getSnapshot()
  await memorySource.source.flush()
  const prior = propose('prior')
  memoryRepository.review({ memoryId: prior.id, decision: 'accept', reviewer: { type: 'operator' } })
  const first = propose('first', prior.id),
    second = propose('second', prior.id)
  memory.getSnapshot()
  await memorySource.source.flush()
  assert.equal((await owner.page({ eventType: 'memory.issue' })).summary.total, 0)
  memoryRepository.review({ memoryId: first.id, decision: 'accept', reviewer: { type: 'operator' } })
  memory.getSnapshot()
  await memorySource.source.flush()
  const conflict = (await owner.page({ memoryId: second.id })).records[0]!
  assert.equal(conflict.subjectState, 'conflict')
  assert.equal(conflict.attention, 'action')
  assert.throws(
    () =>
      memoryRepository.review({ memoryId: second.id, decision: 'accept', reviewer: { type: 'operator' } }),
    /状态已经变化/
  )
  memory.review(second.id, 'reject')
  await memorySource.source.flush()
  assert.equal((await owner.page({ memoryId: second.id })).records[0]!.subjectState, 'rejected')
  assert.equal((await owner.page()).summary.pending, 0)
  assert.equal(JSON.stringify(await owner.page()).includes('complete original memory body'), false)
  assert.equal(Object.keys(memory.getSnapshot().items).length, 3)
  const ordinary = memoryRepository.propose({
    workspaceId: team.activeWorkspaceId!,
    runId: team.activeRun!.id,
    scope: 'run',
    kind: 'fact',
    title: '独立人工审核 fixture',
    content: 'private manual proposal body',
    sources: [{ type: 'file', ref: 'src/private-fixture.ts', label: 'original private reference' }],
    proposedBy: { type: 'agent', slotId: team.members[0]!.slot.id },
    clientProposalId: 'fixture-operator-review'
  })
  memory.getSnapshot()
  await memorySource.source.flush()
  assert.equal((await owner.page({ memoryId: ordinary.id })).summary.total, 0)
  const errors: unknown[] = []
  new MemoryReviewCoordinator(
    memory,
    control,
    messages,
    (error) => errors.push(error),
    Date.now,
    memorySource
  ).reconcile()
  await memorySource.source.flush()
  const operator = (await owner.page({ memoryId: ordinary.id })).records[0]!
  assert.equal(operator.subjectState, 'operator-review')
  assert.equal(operator.attention, 'action')
  const inspection = {
    workspaceId: ordinary.workspaceId,
    runId: ordinary.runId,
    memoryId: ordinary.id,
    version: ordinary.version
  }
  assert.equal(memorySource.operatorReviewProof(inspection)?.reason, 'no-reviewer')
  const originalMessages = JSON.stringify(messages.loadRun(ordinary.runId).messages)
  await owner.read(operator.id, operator.revision)
  assert.equal(memory.getSnapshot().items[ordinary.id]?.status, 'proposed')
  assert.equal((await owner.page({ memoryId: ordinary.id })).summary.pending, 1)
  await memorySource.close()
  memorySource = connectMemoryIssueNotifications(memory, () => team, owner)
  memory.getSnapshot()
  await memorySource.source.flush()
  assert.equal(memorySource.operatorReviewProof(inspection), undefined)
  assert.equal((await owner.page({ memoryId: ordinary.id })).records[0]?.subjectState, 'operator-unconfirmed')
  new MemoryReviewCoordinator(
    memory,
    control,
    messages,
    (error) => errors.push(error),
    Date.now,
    memorySource
  ).reconcile()
  await memorySource.source.flush()
  assert.equal((await owner.page({ memoryId: ordinary.id })).summary.unread, 0)
  assert.equal(JSON.stringify(messages.loadRun(ordinary.runId).messages), originalMessages)
  const conclusion = memory.review(ordinary.id, 'accept', 'private actual operator note', ordinary.version, {
    workspaceId: ordinary.workspaceId,
    runId: ordinary.runId
  })
  await memorySource.source.flush()
  assert.equal(conclusion.status, 'accepted')
  assert.equal((await owner.page({ memoryId: ordinary.id })).records[0]?.subjectState, 'accepted')
  assert.equal((await owner.page({ memoryId: ordinary.id })).summary.pending, 0)
  assert.equal(JSON.stringify(messages.loadRun(ordinary.runId).messages), originalMessages)
  assert.equal(
    memoryRepository
      .load(ordinary.workspaceId, ordinary.runId)
      .events.filter((event) => event.memoryId === ordinary.id && event.type === 'memory.accepted').length,
    1
  )
  assert.equal(errors.length, 0)
  assert.equal(
    /private manual proposal body|private actual operator note|src\/private-fixture.ts/.test(
      JSON.stringify(await owner.page())
    ),
    false
  )
  // Sources close before the private owner, just as real quit draining does.
  await groups.close()
  await memorySource.close()
  await compatibility.close()
  await owner.close()
  console.log(
    JSON.stringify(
      {
        runtime: process.versions.electron ? 'Electron' : 'Node',
        realBuiltWorker: true,
        isolatedBusinessRepositories: true,
        readOnlyFakeInstallation: true,
        metadataSupportNotCapabilitySuccess: true,
        exactInstallationQueries: true,
        realCompetingRevisionConflict: true,
        originalRejectedAcceptPreserved: true,
        actualRejectClosesNotification: true,
        notificationsNeverReviewAutomatically: true,
        actualCoordinatorEscalationOnly: true,
        sameOriginalRequestAcrossReattachment: true,
        humanReadDoesNotReviewOrAcknowledge: true,
        explicitOriginalReviewClosesPending: true,
        noMemoryBodyInLedger: true,
        noCursorOrAccountCalls: true
      },
      null,
      2
    )
  )
} finally {
  await groups.close()
  await memorySource.close()
  await compatibility.close()
  await owner.close().catch(() => {})
  memory.dispose()
  stop()
  control.dispose()
  memoryRepository.close()
  messages.close()
  controlRepository.close()
  await Promise.allSettled(
    workers.filter((worker) => worker.threadId !== -1).map((worker) => worker.terminate())
  )
  rmSync(directory, { recursive: true, force: true })
}
