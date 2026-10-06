import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { runInNewContext } from 'node:vm'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { RuntimeUsageNotifications } from '../src/application/notifications/runtime-usage-notifications'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import { CursorCdpSessionCreator } from '../src/infrastructure/cursor/cursor-cdp-session-creator'
import { CursorUsageTracker } from '../src/application/cursor-usage-tracker'
import { CursorUsageStore } from '../src/infrastructure/cursor/cursor-usage-store'
import { drainNotificationsForQuit } from '../src/main/notification-quit-barrier'

// Real compiled private worker + original runtime expression/reader/aggregator.
// The fake CDP adapter executes only in a VM, not against Cursor or an account.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-runtime-usage-worker-')), workers: Worker[] = []
const createOwner = () => new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
let owner = createOwner(), at = Date.now() - 60000, source = new RuntimeUsageNotifications(owner, () => at)
const team = emptyTeamControlSnapshot(), workspace = { id: 'workspace-fixture', name: 'PRIVATE workspace', path: directory, createdAt: 1, updatedAt: 1 }
team.workspaces = [workspace]; team.activeWorkspaceId = workspace.id
team.activeRun = { id: 'run-fixture', workspaceId: workspace.id, name: 'fixture', goal: '', templateId: 'independent-session-v1', status: 'running', createdAt: 1, updatedAt: 1 }
team.runs = [team.activeRun]
team.bindings = [{ id: 'binding-fixture', workspaceId: workspace.id, runId: team.activeRun.id, slotId: 'slot-fixture', channelId: '1', agentSessionId: 'sg-channel:1', generation: 'binding-first',
  installedAt: 1, launchDetail: '', lastCheckInNote: '', composerBindingKey: 'fixture-key', composerId: 'composer-fixture', composerBoundAt: 1 }]
source.setTeam(team)
const data: any = { chatGenerationUUID: 'generation-fixture', status: 'generating', fullConversationHeadersOnly: [], conversationMap: {}, turnTokenUsage: { inputTokens: 0, outputTokens: 0 } }
const window = { __sgComposerService: { createComposer: () => ({}), composerDataService: { getComposerDataIfLoaded: () => data, allComposersData: { allComposers: [{ composerId: 'composer-fixture' }] } } } }
let calls = 0, badRecord = false
const creator = new CursorCdpSessionCreator({
  fetchTargets: async () => { calls++; return [{ id: 'fixture', type: 'page', title: 'fixture', url: 'file:///fixture/workbench.html', webSocketDebuggerUrl: 'ws://127.0.0.1:1/never-connected' }] },
  evaluate: async (_url, expression) => {
    calls++
    if (expression.includes('document.title')) return { bridge: true }
    return badRecord ? { ok: true, rows: 'PRIVATE invalid records' } : await runInNewContext(expression, { window, Map, Date: { now: () => at } })
  }, usageReadObserver: { begin: input => source.begin(input), unavailable: () => source.unavailable() }
})
const store = new CursorUsageStore(join(directory, 'usage.json'))
const tracker = new CursorUsageTracker({ now: () => at, boundComposers: [{ composerId: 'composer-fixture', slotId: 'slot-fixture' }], persistSnapshot: snapshot => store.save(snapshot) })
const read = async () => {
  const before = calls
  const result = await creator.inspectComposerRuntime(directory, ['composer-fixture'])
  assert.equal(calls - before, 3) // One original target fetch, one window probe, one runtime evaluation.
  assert.equal(Object.hasOwn(result['composer-fixture'] ?? {}, 'usageRead'), false)
  const usage = result['composer-fixture']?.usage
  if (usage?.generationId) {
    if (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheWriteTokens)
      tracker.recordTurnSnapshot({ composerId: 'composer-fixture', ...usage, occurredAt: at })
    else if (usage.contextTokensUsed) tracker.recordRequestSample({ composerId: 'composer-fixture', generationId: usage.generationId, used: usage.contextTokensUsed, occurredAt: at })
  }
  return result
}
try {
  await read(); await source.source.flush(); assert.equal((await owner.page()).summary.total, 0)
  data.contextTokensUsed = 10000; at += 1000; await read(); await source.source.flush()
  assert.equal(tracker.getSnapshot()['composer-fixture']?.quality, 'estimated')
  const estimate = tracker.getSnapshot()
  Object.defineProperty(data, 'turnTokenUsage', { configurable: true, get: () => { throw Error('PRIVATE native getter') } })
  at += 1000; assert.equal((await read())['composer-fixture']?.state, 'active')
  at += 6000; await read(); await source.source.flush()
  const incident = (await owner.page()).records[0]!
  assert.equal(incident.state, 'active'); assert.deepEqual(tracker.getSnapshot(), estimate)
  await owner.read(incident.id, incident.revision); assert.equal((await owner.page()).records[0]?.state, 'active')
  delete data.turnTokenUsage; data.turnTokenUsage = { inputTokens: 15000, outputTokens: 10, cacheReadTokens: 5000, cacheWriteTokens: 0 }
  at += 1000; await read(); await source.source.flush()
  assert.equal((await owner.page()).records[0]?.state, 'resolved')
  assert.equal(tracker.getSnapshot()['composer-fixture']?.quality, 'exact')
  assert.equal(store.load()['composer-fixture']?.inputTokens, 15000)
  Object.defineProperty(data, 'turnTokenUsage', { configurable: true, get: () => { throw Error('PRIVATE native getter') } })
  at += 1000; await read(); at += 6000; await read(); await source.source.flush()
  const active = (await owner.page()).records[0]!
  await source.close(); await owner.close()
  owner = createOwner(); source = new RuntimeUsageNotifications(owner, () => at); source.setTeam(team)
  const announcements: unknown[] = []; owner.subscribe(event => { if (event.announcement) announcements.push(event.announcement) })
  at += 1000; await read(); at += 6000; await read(); await source.source.flush()
  assert.equal((await owner.page()).records[0]?.id, active.id); assert.equal(announcements.length, 0)
  badRecord = true; at += 1000; await read(); at += 6000; await read()
  const confirmed = await drainNotificationsForQuit(owner, [() => source.close()], () => tracker.dispose())
  assert.equal(confirmed, true); assert.equal(announcements.length, 0)
  owner = createOwner()
  const restored = await owner.page()
  assert.equal(restored.summary.total, 2); assert.equal(restored.records[0]?.state, 'active')
  assert.equal(/PRIVATE|sg-runtime-usage-worker-|composer-fixture|generation-fixture|usage\.json/.test(JSON.stringify(restored)), false)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, originalRuntimeExpressionInVm: true,
    originalReaderAndUsageAggregator: true, noAdditionalCdpCalls: true, noHealthyZeroOrEstimateAlarm: true,
    originalLivenessStillActive: true, failureDoesNotAlterExistingCounts: true, originalExactSettlementStillWorks: true,
    privateReadNotSourceRecovery: true, durableRestartNoReplay: true, noQuitAnnouncements: true, noRawDetails: true, isolated: true }, null, 2))
} finally {
  tracker.dispose(); await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
