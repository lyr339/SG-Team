import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { ContextThresholdNotifications } from '../src/application/notifications/context-threshold-notifications'
import { WorkspaceNotifications } from '../src/application/notifications/workspace-notifications'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import type { NotificationPush } from '../src/domain/notification'

// Existing observer logic + real built private worker. Facts below are isolated
// fixtures, NOT real Cursor readings or proof of physical OS delivery.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out', 'main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const temporary = mkdtempSync(join(tmpdir(), 'sg-notification-context-')), databasePath = join(temporary, 'ledger.sqlite')
let owner: NotificationService | undefined
const workers: Worker[] = []
const open = () => new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, databasePath), () => 10_000)
const team = emptyTeamControlSnapshot(); team.activeWorkspaceId = 'fixture-workspace'
team.activeRun = { id: 'fixture-run', workspaceId: team.activeWorkspaceId, name: 'test', goal: '', templateId: 'independent-session-v1', status: 'running', createdAt: 1, updatedAt: 1 }
team.runs = [team.activeRun]
const binding = { id: 'fixture-binding', workspaceId: team.activeWorkspaceId, runId: team.activeRun.id, slotId: 'fixture-slot', channelId: '1', agentSessionId: 'fixture-agent', generation: 'bind-a',
  installedAt: 1, launchDetail: '', lastCheckInNote: '', composerBindingKey: 'fixture-key', composerId: 'fixture-composer', composerBoundAt: 2 }
team.bindings = [binding]
team.members = [{ slot: { id: binding.slotId, runId: binding.runId, roleId: 'fixture-role', name: '验收', avatarId: 'lead', solo: true, channelId: '1', order: 0, createdAt: 1, updatedAt: 1 },
  role: { id: 'fixture-role', runId: binding.runId, key: 'fixture', templateKey: 'solo', name: '验收', mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: 0 }, binding, readiness: 'active' }]
const frame = (ratio: number, sampledAt = 10_000): DesktopSnapshot => ({ connection: { state: 'connected', endpoint: 'fixture', attempt: 0, lastError: '' }, conversations: {}, protocolIssues: [], updatedAt: 10_000,
  contextUsageSampledAt: sampledAt, runtimeScope: { workspaceId: team.activeWorkspaceId, runId: team.activeRun!.id, teamRevision: team.revision }, sessions: [{
    id: 'fixture-session', channelId: '1', generation: 1, composerId: binding.composerId, displayName: '验收', roleName: '验收', status: 'waiting', currentTask: '', queueDepth: 0, connectionPhase: 'waiting',
    online: true, connected: true, waiting: true, workingFiles: [], healthEvidence: [], telemetry: { state: 'bound', detail: 'fixture' }, contextUsageSource: 'bound', contextUsageComposerId: binding.composerId,
    contextUsageModelId: 'fixture-native-model', contextUsage: { ratio, used: Math.round(ratio * 100_000), limit: 100_000 }
  }] })
let context: ContextThresholdNotifications | undefined, workspace: WorkspaceNotifications | undefined
try {
  owner = open(); const events: NotificationPush[] = []; owner.subscribe(event => events.push(event))
  context = new ContextThresholdNotifications(owner, () => 10_000); workspace = new WorkspaceNotifications(owner)
  for (const ratio of [.2, .81, .86, .96, .94]) { context.observe(frame(ratio), team); await context.flush(); await owner.flush() }
  assert.equal(events.filter(event => event.announcement).length, 2)
  const page = await owner.page({ eventType: 'context.threshold', generation: '1', contextDomain: JSON.stringify(['fixture-native-model', 100_000]) })
  assert.equal(page.summary.total, 1); assert.equal(page.records[0]!.subjectState, '95')
  assert.equal((await owner.page({ contextDomain: 'wrong', generation: '1' })).summary.total, 0)
  assert.equal((await owner.page({ contextDomain: JSON.stringify(['fixture-native-model', 100_000]), generation: '2' })).summary.total, 0)
  context.observe(frame(.1, 1_000), team); await context.flush(); assert.equal((await owner.page()).records[0]!.subjectState, 'unconfirmed')
  context.observe(frame(.1), team); await context.flush(); assert.equal((await owner.page()).records[0]!.state, 'resolved')
  context.observe(frame(.96), team); await context.flush(); const record = (await owner.page()).records[0]!
  await owner.read(record.id, record.revision); await owner.clearRead({ key: record.key })
  assert.equal((await owner.page()).summary.total, 0)
  workspace.begin().complete({ state: 'detected', workspace: { id: 'fixture-project', name: '验收项目', path: '/fixture-not-persisted' }, candidates: [], detail: 'native fixture', observedAt: 10_000 })
  await workspace.flush()
  workspace.begin().complete({ state: 'unavailable', cause: 'no-folder', candidates: [], detail: 'not parsed', observedAt: 11_000 })
  workspace.begin().complete({ state: 'unavailable', cause: 'no-folder', candidates: [], detail: 'not parsed', observedAt: 15_000 }); await workspace.flush()
  assert.equal((await owner.page({ eventType: 'workspace.confirmation' })).records[0]!.subjectState, 'unconfirmed')
  await context.close(); await workspace.close(); await owner.close()
  owner = open(); const restored: NotificationPush[] = []; owner.subscribe(event => restored.push(event))
  context = new ContextThresholdNotifications(owner, () => 10_000); context.observe(frame(.96), team); await context.flush()
  assert.equal((await owner.page({ eventType: 'context.threshold' })).summary.total, 0)
  assert.equal(restored.some(event => event.announcement), false)
  assert.equal((await owner.page({ eventType: 'workspace.confirmation' })).summary.total, 1)
  assert.equal(JSON.stringify(await owner.page()).includes('/fixture-not-persisted'), false)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, fixtureFactsOnly: true, contextTwoThresholdsOnce: true,
    exactDomainAndGenerationQueries: true, staleReadingNotLowRecovery: true, clearedContextNotResurrected: true, restartNotReplayed: true,
    workspaceIssueDurable: true, noPathsInHistory: true, noCursorProbeOrBusinessCalls: true, isolatedFixture: true }, null, 2))
} finally {
  await context?.close(); await workspace?.close(); await owner?.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(temporary, { recursive: true, force: true })
}
