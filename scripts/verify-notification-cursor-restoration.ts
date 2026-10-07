import assert from 'node:assert/strict'
import { readdirSync, readFileSync, utimesSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { ContextThresholdNotifications } from '../src/application/notifications/context-threshold-notifications'
import { DesktopSessionService } from '../src/application/desktop-session-service'
import { notificationFrame } from './fixtures/notification-session-data'
import { cursorRestoredFiles } from './fixtures/cursor-restored-files'

// Original read-only SQLite/JSONL reader + desktop + real built private worker.
// Every source file is an isolated fixture, never an installed user's database.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const workers: Worker[] = [], evidence: unknown[] = []
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
for (const shape of ['legacy', 'table'] as const) {
  const f = cursorRestoredFiles(shape), ledgerPath = join(f.directory, 'notifications.sqlite'), commands: string[] = []
  class AuditWorker extends Worker {
    override postMessage(message: { command: { kind: string } }): void { commands.push(message.command.kind); super.postMessage(message) }
  }
  const open = () => new NotificationService(new NotificationWorkerPort(options => {
    const worker = new AuditWorker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
  }, ledgerPath))
  let owner = open(), source = new ContextThresholdNotifications(owner), emitted = 0
  let sourceReads = 0, sends = 0
  const desktop = new DesktopSessionService({ getSnapshot: () => notificationFrame(), subscribe: () => () => {}, sendMessage: () => { sends++; throw Error('fixture must never send') } },
    { getSnapshot: () => f.team, subscribe: () => () => {}, recordComposerBinding: () => { throw Error('fixture must not change binding') } },
    { readWorkspace: (workspace, bindings) => { sourceReads++; return f.reader.readWorkspace(workspace, bindings) } })
  desktop.setNativeProcessStreamStatus({ state: 'connected', detail: 'isolated, no real observer', updatedAt: Date.now() })
  const read = async () => {
    const dbBefore = digest(f.path), transcriptBefore = digest(f.transcript)
    desktop.refreshTelemetry()
    const snapshot = desktop.getSnapshot()
    source.observe(snapshot, f.team); await source.flush()
    assert.equal(digest(f.path), dbBefore); assert.equal(digest(f.transcript), transcriptBefore)
    return snapshot
  }
  try {
    owner.subscribe(event => { if (event.announcement) emitted++ })
    assert.equal(f.databaseHeader(f.old), f.databaseHeader(f.next))
    f.updateBranch(f.path, 33, 3000); await read()
    assert.equal((await owner.page()).summary.total, 0)
    f.updateBranch(f.path, 33, 9600)
    const high = await read()
    assert.equal(high.sessions[0]?.contextUsage?.used, 9600)
    assert.equal((await owner.page()).records[0]?.subjectState, '95'); assert.equal(emitted, 1)
    const before = f.stamp()
    f.restore(f.old)
    // Also exercise a forward timestamp replacement: never rely on time going backwards.
    utimesSync(f.path, new Date(Date.now() + 1000), new Date(Date.now() + 1000))
    assert.equal(f.stamp().ino, before.ino)
    const restored = await read()
    assert.equal(restored.sessions[0]?.contextUsage?.used, 7000)
    assert.equal(restored.sessions[0]?.changes?.additions, 22)
    assert.equal((await owner.page()).records[0]?.state, 'resolved'); assert.equal(emitted, 1)
    const record = (await owner.page()).records[0]!
    await owner.read(record.id, record.revision)
    const commandCount = commands.length
    const sealed = f.read().composers
    for (let i = 0; i < 200; i++) {
      assert.equal(f.read().composers, sealed)
      source.observe(desktop.getSnapshot(), f.team)
    }
    await source.flush(); assert.equal(commands.length, commandCount)
    const oldTranscript = f.read().composers[0]?.lastAssistantResponse?.text
    f.rewriteTranscript('2', 'PRIVATE reply new'); f.nextFrame()
    const replacement = f.read()
    assert.notEqual(replacement.composers[0]?.lastAssistantResponse?.text, oldTranscript)
    assert.equal(replacement.channelActivities?.['1'], undefined)
    await source.close(); await owner.close()
    owner = open(); source = new ContextThresholdNotifications(owner)
    const restartEvents: unknown[] = []; owner.subscribe(event => { if (event.announcement) restartEvents.push(event.announcement) })
    await read()
    assert.equal((await owner.page()).summary.total, 1); assert.equal((await owner.page()).summary.unread, 0)
    assert.equal(restartEvents.length, 0); assert.equal(sends, 0)
    assert.equal(/PRIVATE|state\.vscdb|reply new|sg-cursor-restored-files-/.test(JSON.stringify(await owner.page())), false)
    const verify = new DatabaseSync(f.path, { readOnly: true })
    try { assert.equal(verify.prepare('SELECT value FROM cursorDiskKV WHERE key=?').get(`composerData:${f.composerId}`)!.value, JSON.stringify({ contextTokensUsed: 7000, contextTokenLimit: 10000 })) }
    finally { verify.close() }
    evidence.push({ shape, originalSqliteAndEqualLengthJsonlRead: true, originalDesktopBindingsAndSampleUsed: true,
      inPlaceBackupAndForwardTimestampCorrect: true, resolvedContextUsesRestoredNativeReading: true, noReplayOnWorkerRestart: true,
      untouchedOriginalSourceHashes: true, idleSourceHasNoWorkerCommands: true, sourceReads, noBusinessSends: true })
  } finally {
    desktop.dispose(); await source.close().catch(() => {}); await owner.close().catch(() => {})
    await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
    f.close()
  }
}
console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltPrivateWorker: true, isolated: true,
  noProductionMainCursorModelAccountOrOsDelivery: true, evidence }, null, 2))
