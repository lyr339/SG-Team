import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { UsageBindingFixtureSocket } from './fixtures/usage-binding-socket'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { UsageBindingNotifications } from '../src/application/notifications/usage-binding-notifications'
import { CursorStreamObserver } from '../src/infrastructure/cursor/cursor-stream-observer'
import { CursorUsageTracker } from '../src/application/cursor-usage-tracker'
import { CursorUsageStore } from '../src/infrastructure/cursor/cursor-usage-store'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import { drainNotificationsForQuit } from '../src/main/notification-quit-barrier'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-usage-binding-worker-')), workers: Worker[] = []
const createOwner = () => new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
let at = Date.now() - 60000, owner = createOwner(), source = new UsageBindingNotifications(owner, () => at)
const team = emptyTeamControlSnapshot(), workspace = { id: 'workspace-fixture', name: 'PRIVATE workspace', path: directory, createdAt: 1, updatedAt: 1 }
team.workspaces = [workspace]; team.activeWorkspaceId = workspace.id
team.activeRun = { id: 'run-fixture', workspaceId: workspace.id, name: 'fixture', goal: '', templateId: 'independent-session-v1', status: 'running', createdAt: 1, updatedAt: 1 }
team.runs = [team.activeRun]
for (let n = 1; n <= 2; n++) {
  const binding = { id: `binding-${n}`, workspaceId: workspace.id, runId: team.activeRun.id, slotId: `slot-${n}`, channelId: String(n), agentSessionId: `sg-channel:${n}`,
    generation: `bind-${n}`, installedAt: 1, launchDetail: '', lastCheckInNote: '', composerBindingKey: 'fixture-key', composerId: `composer-${n}`, composerBoundAt: 1 }
  team.bindings.push(binding)
  team.members.push({ slot: { id: binding.slotId, runId: team.activeRun.id, roleId: `role-${n}`, order: n, name: `PRIVATE member ${n}`, avatarId: 'lead', channelId: binding.channelId, solo: true, createdAt: 1, updatedAt: 1 },
    role: { id: `role-${n}`, runId: team.activeRun.id, key: `solo-${n}`, templateKey: 'solo', name: `fixture ${n}`, mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: n }, binding, readiness: 'active' })
}
source.setTeam(team)
const store = new CursorUsageStore(join(directory, 'usage.json')), tracker = new CursorUsageTracker({ now: () => at,
  boundComposers: team.bindings.map(binding => ({ composerId: binding.composerId!, slotId: binding.slotId })), persistSnapshot: snapshot => store.save(snapshot) })
const socket = new UsageBindingFixtureSocket(); let callbacks = 0, failedCallback = false
const observer = new CursorStreamObserver({ fetchPageSocketUrl: async () => 'ws://127.0.0.1:1/never-connected', openSocket: () => socket,
  locateComposerService: async () => true, disarmLegacyPatch: async () => undefined,
  usageObserver: { begin: composer => source.begin(composer), reset: () => source.reset(), unattributed: () => source.unattributed(), unavailable: () => source.unavailable() },
  onUsageEvent: event => { callbacks++; if (failedCallback) throw Error('PRIVATE original callback'); tracker.record(event) }, onUsageSample: sample => tracker.recordRequestSample(sample) })
const good = (n = 1) => ({ c: `composer-${n}`, g: 'generation-fixture', i: 100, o: 10, r: 50, w: 0, t: at })
const bad = (n = 1) => ({ ...good(n), i: 'PRIVATE bad number' })
try {
  assert.equal(await observer.attach(), true)
  const commands = socket.sent.length
  socket.usage(good()); await source.source.flush()
  assert.equal(tracker.getSnapshot()['composer-1']?.inputTokens, 100); assert.equal(store.load()['composer-1']?.quality, 'exact')
  const initial = tracker.getSnapshot(), callbackCount = callbacks
  at += 1000; socket.usage(bad()); socket.usage(bad(2)); at += 6000; socket.usage(bad()); socket.usage(bad(2)); await source.source.flush()
  assert.equal(callbacks, callbackCount); assert.deepEqual(tracker.getSnapshot(), initial)
  const incident = (await owner.page()).records[0]!
  assert.equal((await owner.page()).summary.total, 1); assert.equal((await owner.page()).summary.unread, 1)
  assert.match(incident.detail ?? '', /2 个绑定来源/)
  await owner.read(incident.id, incident.revision); assert.equal((await owner.page()).records[0]?.state, 'active')
  at += 1000; socket.usage(good()); await source.source.flush(); assert.equal((await owner.page()).records[0]?.state, 'active')
  assert.match((await owner.page()).records[0]?.detail ?? '', /1 个绑定来源/)
  at += 1000; socket.usage(good(2)); await source.source.flush(); assert.equal((await owner.page()).records[0]?.state, 'resolved')
  failedCallback = true; at += 1000; socket.usage(good()); at += 6000; socket.usage(good()); await source.source.flush()
  const failed = (await owner.page()).records[0]!
  assert.match(failed.detail ?? '', /原计数回调没有正常返回/)
  const before = callbacks; at += 1000; socket.usage(good()); assert.equal(callbacks, before + 1)
  assert.equal(socket.sent.length, commands)
  await source.close(); await owner.close()
  owner = createOwner(); source = new UsageBindingNotifications(owner, () => at); source.setTeam(team); await source.source.flush()
  assert.equal((await owner.page()).records[0]?.id, failed.id); assert.equal((await owner.page()).records[0]?.state, 'expired')
  const announcements: unknown[] = []; owner.subscribe(event => { if (event.announcement) announcements.push(event.announcement) })
  at += 1000; socket.usage(good()); at += 6000; socket.usage(good()); await source.source.flush()
  assert.equal(announcements.length, 0); assert.equal((await owner.page()).summary.total, 3)
  failedCallback = false; at += 1000; socket.usage(good())
  const confirmed = await drainNotificationsForQuit(owner, [() => source.close()], () => { observer.dispose(); tracker.dispose() })
  assert.equal(confirmed, true); assert.equal(announcements.length, 0)
  owner = createOwner(); const restored = await owner.page()
  assert.equal(restored.records[0]?.state, 'resolved')
  assert.equal(/PRIVATE|composer-1|generation-fixture|sg-usage-binding-worker-|usage\.json/.test(JSON.stringify(restored)), false)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, originalBindingReceiverAndTracker: true,
    fixtureSocketOnly: true, noAdditionalCdpCommands: true, originalCountsAndCallbackArgumentsPreserved: true, groupedOneEpisode: true,
    otherMemberCannotResolveAll: true, originalCallbackInvokedOnceNoRetry: true, privateReadNotBusinessRecovery: true,
    restartOldDocumentNotFalseRecovery: true, noQuitAnnouncements: true, noRawCountsOrErrors: true, isolated: true }, null, 2))
} finally {
  observer.dispose(); tracker.dispose(); await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
