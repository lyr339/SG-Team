import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { UsageStorageNotifications } from '../src/application/notifications/usage-storage-notifications'
import { CursorUsageStore } from '../src/infrastructure/cursor/cursor-usage-store'
import { CursorUsageTracker } from '../src/application/cursor-usage-tracker'
import { drainNotificationsForQuit } from '../src/main/notification-quit-barrier'
// Actual built worker + original stores/aggregator, isolated from the user profile and production main.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-usage-storage-worker-')), workers: Worker[] = []
const createOwner = () => new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
let owner = createOwner(), source = new UsageStorageNotifications(owner)
const path = join(directory, 'usage.json'), store = new CursorUsageStore(path, source)
let tracker: CursorUsageTracker | undefined
try {
  store.load(); await source.source.flush()
  assert.equal((await owner.page()).summary.total, 0)
  writeFileSync(path, '{PRIVATE original broken file')
  store.load(); await source.source.flush()
  const history = (await owner.page()).records[0]!
  assert.equal(history.subjectState, 'history-unconfirmed')
  assert.ok(readdirSync(directory).some(name => name.startsWith('usage.json.corrupt-')))
  mkdirSync(path) // Original rename cannot replace a directory: genuine file write exception.
  let saves = 0
  tracker = new CursorUsageTracker({ notifyDelayMs: 0, persistSnapshot: snapshot => { saves++; store.save(snapshot) } })
  const event = { composerId: 'fixture-composer', generationId: 'fixture-generation', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, occurredAt: Date.now() }
  tracker.record(event)
  await source.source.flush()
  assert.equal(tracker.getSnapshot()['fixture-composer']?.inputTokens, 100)
  assert.equal((await owner.page()).summary.total, 2)
  const incident = (await owner.page({ eventType: 'usage.storage-write' })).records[0]!
  assert.equal(incident.state, 'active')
  rmSync(path, { recursive: true }) // Only this fixture-created directory.
  tracker.record({ ...event, generationId: 'next-generation', occurredAt: event.occurredAt + 1 })
  await source.source.flush()
  assert.equal((await owner.page({ eventType: 'usage.storage-write' })).records[0]?.state, 'resolved')
  assert.equal((await owner.page({ eventType: 'usage.storage-history' })).records[0]?.state, 'active')
  tracker.dispose(); tracker = undefined
  await source.close(); await owner.close()
  owner = createOwner(); source = new UsageStorageNotifications(owner)
  const restart = new CursorUsageStore(path, source)
  assert.equal(restart.load()['fixture-composer']?.inputTokens, 200)
  await source.source.flush()
  assert.equal((await owner.page({ eventType: 'usage.storage-history' })).records[0]?.id, history.id)
  const originalSaves = saves
  for (let i = 0; i < 200; i++) source.observe({ kind: 'save', result: 'confirmed' })
  await source.source.flush(); assert.equal(saves, originalSaves)
  assert.equal((await owner.page()).summary.total, 2)
  const beforeQuit = (await owner.page()).summary.total
  // Same logical store as the original run, not a diagnostic from another file.
  rmSync(path); mkdirSync(path)
  const finalStore = new CursorUsageStore(path, source)
  let finalSaves = 0
  tracker = new CursorUsageTracker({ persistSnapshot: snapshot => { finalSaves++; finalStore.save(snapshot) } })
  const records: unknown[] = [], announcements: unknown[] = []
  owner.subscribe(e => { if (e.change?.record) records.push(e.change.record); if (e.announcement) announcements.push(e.announcement) })
  const confirmed = await drainNotificationsForQuit(owner, [() => Promise.resolve().then(() => source.close())], () => { tracker!.dispose(); tracker = undefined })
  assert.equal(confirmed, true); assert.equal(finalSaves, 1); assert.equal(announcements.length, 0); assert.ok(records.length)
  owner = createOwner()
  const restored = await owner.page()
  assert.equal(restored.summary.total, beforeQuit + 1)
  assert.equal(/PRIVATE|fixture-composer|sg-usage-storage-worker-|usage\.json/.test(JSON.stringify(restored)), false)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, realOriginalUsageStore: true,
    genuineFileWriteFailure: true, currentInMemoryCountsStillUsable: true, newSaveNotHistoricalRestore: true, durableRestart: true,
    finalOriginalPersistObserved: true, originalSaveCountsPreserved: true, noQuitAnnouncements: true, noRawDataOrPaths: true, isolated: true }, null, 2))
} finally {
  tracker?.dispose(); await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
