import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { UsageBindingNotifications } from '../src/application/notifications/usage-binding-notifications'
import { CursorStreamObserver } from '../src/infrastructure/cursor/cursor-stream-observer'
import { UsageBindingFixtureSocket } from './fixtures/usage-binding-socket'
import { usageEmissionHook } from './fixtures/usage-emission-hook'
import { notificationTeam } from './fixtures/notification-session-data'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main'), entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-usage-emission-worker-')), workers: Worker[] = [], socket = new UsageBindingFixtureSocket()
const owner = new NotificationService(new NotificationWorkerPort(options => { const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker }, join(directory, 'private.sqlite')))
let at = 10000
const source = new UsageBindingNotifications(owner, () => at), team = notificationTeam()
team.workspaces = [{ id: 'workspace-a', name: 'PRIVATE workspace', path: '/isolated/workspace', createdAt: 1, updatedAt: 1 }]; source.setTeam(team)
let processes = 0, counts = 0
const observer = new CursorStreamObserver({ fetchPageSocketUrl: async () => 'ws://127.0.0.1:1/never-connected', openSocket: () => socket,
  locateComposerService: async () => true, disarmLegacyPatch: async () => undefined, usageObserver: source,
  onProcessEvent: () => { processes++ }, onUsageEvent: () => { counts++ } })
const processFrame = (frame: Record<string, unknown>, executionContextId = 1) => socket.emit('message', JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: 'sgTeamProcess', executionContextId, payload: JSON.stringify(frame) } }))
const data: any = { chatGenerationUUID: 'generation-a', status: 'generating', fullConversationHeadersOnly: [], conversationMap: {} }
Object.defineProperty(data, 'turnTokenUsage', { get: () => { throw Error('PRIVATE original getter') } })
try {
  assert.equal(await observer.attach(), true); const commands = socket.sent.length
  let emissions = 0
  const hook = usageEmissionHook(() => data, () => { emissions++ }); await hook.flush()
  assert.equal(emissions, 0); assert.equal(hook.frames.length, 1); assert.deepEqual(hook.frames[0]!.usageEmission, { version: 1, reason: 'extract' })
  processFrame(hook.frames[0]!); at += 6000; hook.schedule(); await hook.flush(); processFrame(hook.frames.at(-1)!); await source.source.flush()
  const failed = (await owner.page()).records[0]!
  assert.match(failed.detail ?? '', /页面未能提取原用量载荷/); assert.equal(counts, 0); assert.equal(processes, 2)
  await owner.read(failed.id, failed.revision)
  at += 1000; processFrame({ composerId: 'composer-a', isGenerating: false }); socket.usage({ c: 'composer-a', i: 0, o: 0 }); await source.source.flush()
  assert.equal((await owner.page()).records[0]!.state, 'active')
  const good = { chatGenerationUUID: 'generation-a', status: 'generating', fullConversationHeadersOnly: [], conversationMap: {}, turnTokenUsage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  const healthy = usageEmissionHook(() => good, payload => socket.usage(payload)); at += 1000; await healthy.flush(); await source.source.flush()
  assert.equal((await owner.page()).records[0]!.state, 'resolved'); assert.equal(counts, 2) // unchanged zero legacy event + original healthy payload
  const missing = usageEmissionHook(() => good); await missing.flush(); at += 1000; processFrame(missing.frames[0]!); at += 6000; processFrame(missing.frames[0]!); await source.source.flush()
  assert.match((await owner.page()).records[0]!.detail ?? '', /页面未确认原 binding 发出载荷/)
  const total = (await owner.page()).summary.total
  at += 1000; processFrame(missing.frames[0]!, 99); processFrame({ ...missing.frames[0], composerId: 'foreign-composer' }); await source.source.flush()
  assert.equal((await owner.page()).summary.total, total); assert.equal(socket.sent.length, commands)
  assert.equal(/PRIVATE|generation-a|composer-a/.test(JSON.stringify(await owner.page())), false)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', actualEmbeddedHookInIsolatedVm: true, realBuiltPrivateWorker: true,
    unEmittedUsageDiagnosedViaOriginalProcessFrame: true, originalProcessCallbacksAndCountersPreserved: true, noRetryOrAdditionalCdpCommand: true,
    staleContextAndForeignBindingIgnored: true, waitingCannotClaimRecovery: true, verifiedOriginalPayloadResolvesEpisode: true,
    noSourceCountsErrorOrGenerationCopied: true, isolated: true }, null, 2))
} finally {
  observer.dispose(); await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
