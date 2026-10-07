import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { McpWriteNotifications } from '../src/application/notifications/mcp-write-notifications'
import { CursorStreamObserver, type CursorNativeProcessEvent } from '../src/infrastructure/cursor/cursor-stream-observer'
import { UsageBindingFixtureSocket } from './fixtures/usage-binding-socket'
import { originalMcpDesktopFixture, originalUnattributedMcpResults } from './fixtures/mcp-unattributed-results'
import { nativeMcpResultFrame } from './fixtures/notification-mcp'
import { notificationFrame, notificationSession } from './fixtures/notification-session-data'
import type { ConversationEntry, ProcessBlockTool } from '../src/domain/conversation-entry'
import type { NotificationDraft } from '../src/domain/notification'

// Real private worker + original SDK/native/desktop path only. Never production
// main, a Cursor socket, real model/account actions or an OS notification.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-mcp-unattributed-worker-')), path = join(directory, 'private.sqlite')
const workers: Worker[] = [], commands: Array<{ kind: string; key?: string; drafts?: NotificationDraft[]; data?: unknown }> = []
class AuditWorker extends Worker {
  override postMessage(message: { command: typeof commands[number] }): void { commands.push(message.command); super.postMessage(message) }
}
const createOwner = () => {
  const port = new NotificationWorkerPort(options => {
    const worker = new AuditWorker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
  }, path)
  return { port, owner: new NotificationService(port) }
}
let { owner, port } = createOwner()
let at = 1000, source = new McpWriteNotifications(owner, () => at)
const desktop = originalMcpDesktopFixture(), socket = new UsageBindingFixtureSocket()
let processes = 0
const observer = new CursorStreamObserver({ fetchPageSocketUrl: async () => 'ws://127.0.0.1:1/never-connected', openSocket: () => socket,
  locateComposerService: async () => true, disarmLegacyPatch: async () => {}, onProcessEvent: event => {
    processes++; source.observe(desktop.receive(event, at), desktop.team)
  } })
const push = async (frame: CursorNativeProcessEvent, executionContextId: number | null = 1) => {
  socket.emit('message', JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: 'sgTeamProcess', executionContextId,
    payload: JSON.stringify({ ...frame, observedAt: at }) } }))
  await source.source.flush()
}
try {
  const results = await originalUnattributedMcpResults()
  assert.equal(results.callsBeforeRuntime, 0); assert.equal(results.runtimeCalls, 1)
  await observer.attach()
  const cdpCommands = socket.sent.length, readers = { ...desktop.counts }
  source.observe(desktop.service.getSnapshot(), desktop.team); await source.source.flush()
  for (const shape of ['modern', 'legacy'] as const)
    for (const [result, args] of [[results.invalid, results.invalidArguments], [results.failedRuntime, results.runtimeArguments]] as const) {
      at += 1000; await push(await nativeMcpResultFrame('team_task', args, result, `sdk-${at}`, at, shape))
    }
  let page = await owner.page()
  assert.equal(page.summary.total, 4); assert.equal(page.summary.unread, 1)
  for (const row of page.records) {
    assert.equal(row.eventType, 'mcp.call-unattributed')
    assert.deepEqual(row.scope, { workspaceId: 'workspace-a', runId: 'run-a' })
    assert.ok(row.target?.kind === 'session'); assert.equal(row.target.mcpWrite, undefined)
    assert.equal(row.target.scope.composerId, 'fixture-composer')
  }
  const first = page.records.find(row => row.attention === 'notice')!
  const idleCommands = commands.length
  const snapshot = desktop.service.getSnapshot()
  for (let i = 0; i < 200; i++) source.observe(snapshot, desktop.team)
  await source.source.flush(); assert.equal(commands.length, idleCommands)
  assert.deepEqual(desktop.counts, readers); assert.equal(socket.sent.length, cdpCommands)
  // Original callbacks still run, but foreign/unknown contexts cannot carry the
  // newly added diagnostic grant into the same observed Composer.
  at += 1000
  const foreign = await nativeMcpResultFrame('team_task', results.invalidArguments, results.invalid, 'foreign-context', at, 'modern')
  await push(foreign, 99); await push(foreign, null)
  assert.equal(processes, 6); assert.equal((await owner.page()).summary.total, 4)
  await owner.read(first.id, first.revision); await owner.clearRead({ key: first.key })
  at += 1000
  const archivedFrame = await nativeMcpResultFrame('team_task', results.runtimeArguments, results.failedRuntime, 'archive-attempt', at, 'modern', 'new-original-user-turn')
  await push(archivedFrame)
  const archive = (await owner.page()).records.find(row => row.target?.kind === 'session' && row.target.blockId === 'cursor:archive-attempt')!
  await owner.archive(archive.id)
  at += 1000
  // Original desktop already confirmed this frame before the notification
  // observer received it; keep that original completion stamp across restart.
  const missed = await nativeMcpResultFrame('team_task', results.runtimeArguments, results.failedRuntime, 'missed-invocation', at, 'legacy', 'missed-original-user-turn')
  const missedSnapshot = desktop.receive(missed, at)
  await source.close(); await owner.close()
  const inspection = new DatabaseSync(path)
  inspection.exec("CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES('original'); PRAGMA user_version=87;")
  const storedKey = inspection.prepare('SELECT source_key FROM desktop_notification_sources LIMIT 1').get()!.source_key as string
  const checkpoint = JSON.parse(inspection.prepare('SELECT payload FROM desktop_notification_sources WHERE source_key=?').get(storedKey)!.payload as string)
  assert.equal(checkpoint.unattributedBaselineAt, 1000); assert.equal(checkpoint.seen.length, 5)
  inspection.close()
  ;({ owner, port } = createOwner()); at += 2000; source = new McpWriteNotifications(owner, () => at)
  await push(archivedFrame)
  assert.equal((await owner.page()).summary.unread, 0); assert.equal((await port.marker(first.key)).cleared, true)
  // Earlier than this restart, but later than first activation: do not lose a
  // genuine invocation merely because it arrived after the application exited.
  const restartAnnouncements: unknown[] = [], release = owner.subscribe(event => { if (event.announcement) restartAnnouncements.push(event.announcement) })
  source.observe(missedSnapshot, desktop.team); await source.source.flush()
  assert.equal((await owner.page()).summary.unread, 1); assert.equal(restartAnnouncements.length, 0); release()
  const original = missedSnapshot.liveProcess!['1']!.blocks.find(block => block.kind === 'tool') as ProcessBlockTool
  const nativeEntry = (id: string, timestamp: number, processBlocks: ProcessBlockTool[]): ConversationEntry => ({ id, turn: id, channelId: '1', role: 'assistant', source: 'cursor',
    status: 'complete', text: 'PRIVATE original body', timestamp, processBlocks })
  const fresh = nativeEntry('burst-new-turn', at + 1000, Array.from({ length: 240 }, (_, i) => ({ ...original, id: `burst-${i}`, completedAt: at + 1000 })))
  const stock = Array.from({ length: 50 }, (_, i) => nativeEntry(`stock-turn-${i}`, 900, [{ ...original, id: `stock-${i}`, startedAt: 900, completedAt: 900 }]))
  const before = commands.length
  source.observe(notificationFrame({ sessions: [notificationSession({ composerId: 'fixture-composer' })], conversations: { '1': [fresh, ...stock] } }), desktop.team)
  await source.source.flush()
  const batches = commands.slice(before).filter(command => command.kind === 'commitSource' && command.drafts?.length).map(command => command.drafts!.length)
  assert.deepEqual(batches, [100, 100, 40])
  page = await owner.page(); assert.equal(page.summary.total, 244); assert.equal(page.summary.unread, 2)
  assert.equal((await owner.page({ eventType: 'mcp.write-result' })).summary.total, 0)
  assert.deepEqual(desktop.counts, readers); assert.equal(socket.sent.length, cdpCommands)
  assert.equal(/PRIVATE|channel_id|agentSessionId|taskId|unread-native-workspace/.test(JSON.stringify(page)), false)
  for (const command of commands.filter(command => command.kind === 'commitSource'))
    assert.ok(Buffer.byteLength(JSON.stringify(command.data)) <= 2 * 1024 * 1024)
  await source.close(); await owner.close()
  const final = new DatabaseSync(path)
  try {
    assert.equal(final.prepare('PRAGMA user_version').get()!.user_version, 87)
    assert.equal(final.prepare('SELECT value FROM preserve').get()!.value, 'original')
    assert.ok(final.prepare('SELECT archived_at FROM desktop_notifications WHERE id=?').get(archive.id)!.archived_at)
    const states = final.prepare('SELECT payload FROM desktop_notification_sources').all()
    assert.equal(states.length, 1); assert.equal(JSON.parse(states[0]!.payload as string).unattributedBaselineAt, 1000)
    assert.equal(/PRIVATE|channel_id|agentSessionId/.test(JSON.stringify(states)), false)
  } finally { final.close() }
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltPrivateWorker: true,
    actualSdkValidationAndRuntimeResults: true, actualNativeHookModernAndLegacyThenParserDesktopAndLedger: true,
    originalCallbacksAndReaderCommandCountsPreserved: true, untrustedContextsCannotGrantNewErrorEvidence: true,
    oneSharedCheckpointAnd100DraftBudget: true, durableColdBoundaryAcrossBatchesAndWorkerRestart: true,
    clearedAndArchivedNotRevived: true, missedNewInvocationNotSwallowedByRestart: true, noBusinessActorArgumentsOrErrorCopied: true,
    originalUserVersionAndUnrelatedDataPreserved: true, isolated: true }, null, 2))
} finally {
  observer.dispose(); desktop.service.dispose(); await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
