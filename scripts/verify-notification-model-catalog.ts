import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'
import { NotificationService } from '../src/application/notification-service'
import { ModelCatalogNotifications } from '../src/application/notifications/model-catalog-notifications'
import { CursorComposerTelemetryReader } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import { drainNotificationsForQuit } from '../src/main/notification-quit-barrier'

// The original reader and a genuine compiled private worker, not production
// main, CDP, the user's Cursor database or any remote model request.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'out/main')
const entry = readdirSync(folder).find(name => /^notification-worker-.*\.js$/.test(name))
if (!entry) throw Error('请先构建通知 worker')
const directory = mkdtempSync(join(tmpdir(), 'sg-model-catalog-worker-')), workers: Worker[] = []
const path = join(directory, 'state.vscdb'), applicationKey = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
const createOwner = () => new NotificationService(new NotificationWorkerPort(options => {
  const worker = new Worker(pathToFileURL(join(folder, entry)), options); workers.push(worker); return worker
}, join(directory, 'notifications.sqlite')))
let owner = createOwner(), source = new ModelCatalogNotifications(owner), database: DatabaseSync | undefined
let at = Date.now() - 60000
const readerOptions = { globalStateDatabase: path, projectsRoot: join(directory, 'projects'), workspaceStorageRoot: join(directory, 'workspaces'), now: () => at }
let reader = new CursorComposerTelemetryReader({ ...readerOptions, modelObserver: source })
const write = (key: string, value: string) => database!.prepare('INSERT OR REPLACE INTO ItemTable VALUES(?,?)').run(key, value)
const compatible = JSON.stringify({ availableDefaultModels2: [{ name: 'PRIVATE-model', clientDisplayName: 'PRIVATE catalog name' }] })
try {
  assert.equal(reader.readModelCatalog(), undefined)
  await source.source.flush(); assert.equal((await owner.page()).summary.total, 0)
  database = new DatabaseSync(path); database.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)')
  write(applicationKey, JSON.stringify({ aiSettings: { modelConfig: { composer: { modelName: 'auto' } } } }))
  write('cursor.modelCatalogOwnKey.gateEnabled', 'true')
  at += 1000; assert.equal(reader.readModelCatalog()?.[0]?.modelId, 'auto')
  await source.source.flush(); assert.equal((await owner.page()).summary.total, 0)
  write(applicationKey, compatible); write('cursor.modelCatalogOwnKey.gateEnabled', 'false')
  at += 1000; const original = reader.readModelCatalog()
  assert.equal(original?.[0]?.modelId, 'PRIVATE-model')
  write(applicationKey, '{PRIVATE malformed original preference')
  at += 1000; assert.deepEqual(reader.readModelCatalog(), [])
  await source.source.flush(); assert.equal((await owner.page()).summary.total, 0)
  at += 6000; assert.deepEqual(reader.readModelCatalog(), [])
  await source.source.flush()
  const incident = (await owner.page()).records[0]!
  assert.equal(incident.state, 'active'); assert.equal(incident.eventType, 'cursor.model-catalog')
  for (let index = 0; index < 20; index++) { at += 1000; reader.readModelCatalog() }
  await source.source.flush(); assert.equal((await owner.page()).summary.total, 1)
  await owner.read(incident.id, incident.revision)
  assert.equal((await owner.page()).records[0]?.state, 'active')
  // Exact gate-only cache transition: compatible data stays usable, but does
  // not pretend the failing authoritative own source has returned.
  write(applicationKey, compatible); write('cursor.modelCatalogOwnKey.gateEnabled', 'true')
  at += 1000; assert.equal(reader.readModelCatalog(), original)
  await source.source.flush(); assert.equal((await owner.page()).records[0]?.state, 'active')
  reader.dispose(); await source.close(); await owner.close()

  owner = createOwner(); source = new ModelCatalogNotifications(owner)
  reader = new CursorComposerTelemetryReader({ ...readerOptions, modelObserver: source })
  const announcements: unknown[] = []
  owner.subscribe(event => { if (event.announcement) announcements.push(event.announcement) })
  at += 1000; reader.readModelCatalog(); await source.source.flush()
  assert.equal((await owner.page()).records[0]?.id, incident.id)
  assert.equal((await owner.page()).records[0]?.state, 'active'); assert.equal(announcements.length, 0)
  write('cursor.modelCatalog.v1', JSON.stringify([{ name: 'PRIVATE-own-model' }]))
  at += 1000; assert.equal(reader.readModelCatalog()?.[0]?.modelId, 'PRIVATE-own-model')
  await source.source.flush(); assert.equal((await owner.page()).records[0]?.state, 'resolved')
  assert.equal(announcements.length, 0)

  write(applicationKey, '{}'); write('cursor.modelCatalog.v1', '{}')
  source.suspend(); at += 1000; reader.readModelCatalog(); source.resume()
  at += 1000; reader.readModelCatalog(); at += 6000; reader.readModelCatalog()
  await source.source.flush()
  assert.equal((await owner.page()).summary.total, 2); assert.equal(announcements.length, 0)
  write('cursor.modelCatalog.v1', JSON.stringify([{ name: 'PRIVATE-own-model' }]))
  at += 1000; reader.readModelCatalog(); await source.source.flush()
  assert.equal((await owner.page()).records[0]?.state, 'resolved')
  database.exec('DROP TABLE ItemTable')
  at += 1000; reader.readModelCatalog(); at += 6000; reader.readModelCatalog()
  // Drain already accepted original facts with presentations fenced on quit.
  const confirmed = await drainNotificationsForQuit(owner, [() => source.close()], () => reader.dispose())
  assert.equal(confirmed, true); assert.equal(announcements.length, 0)
  owner = createOwner()
  const restored = await owner.page()
  assert.equal(restored.summary.total, 3)
  assert.equal(restored.records[0]?.state, 'active')
  assert.equal(/PRIVATE|sg-model-catalog-worker-|state\.vscdb/.test(JSON.stringify(restored)), false)
  console.log(JSON.stringify({ runtime: process.versions.electron ? 'Electron' : 'Node', realBuiltWorker: true, realOriginalCursorShapedSqlite: true,
    missingOrSelectedOnlyIsQuiet: true, consecutiveOriginalReadsOnly: true, originalModelReferencesPreserved: true,
    gateOnlyChangeNotFalseRecovery: true, durableRestart: true, privateReadNotSourceRecovery: true, genuineOwnCatalogRecovery: true,
    suspendResumeNotStartupReplay: true, noQuitAnnouncements: true, noRawModelsOrPaths: true, isolated: true }, null, 2))
} finally {
  reader.dispose(); database?.close(); await source.close().catch(() => {}); await owner.close().catch(() => {})
  await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()))
  rmSync(directory, { recursive: true, force: true })
}
