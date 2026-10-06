import { it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ModelCatalogNotifications } from '../src/application/notifications/model-catalog-notifications'
import { CursorComposerTelemetryReader } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import { notificationSourceHarness } from './notification-source-fixtures'
import type { ModelCatalogObservation } from '../src/domain/model-catalog-observation'
import { readModelCatalogState, reduceModelCatalogNotifications } from '../src/domain/model-catalog-notification'

const applicationKey = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
const modelRoot = { availableDefaultModels2: [{ name: 'fixture-model', clientDisplayName: 'PRIVATE model name' }] }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-model-health-')), databasePath = join(dir, 'state.vscdb'), db = new DatabaseSync(databasePath)
  db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)')
  const write = (key: string, text: string) => db.prepare('INSERT OR REPLACE INTO ItemTable VALUES(?,?)').run(key,text)
  const h = notificationSourceHarness(), source = new ModelCatalogNotifications(h.owner)
  let at = 10000
  const options = { globalStateDatabase: databasePath, projectsRoot: join(dir,'projects'), workspaceStorageRoot: join(dir,'workspaces'), now: () => at }
  const reader = new CursorComposerTelemetryReader({ ...options, modelObserver: source })
  return { dir, db, write, h, source, reader, options, setAt: (value: number) => { at = value }, close: async () => { reader.dispose(); db.close(); await source.close(); await h.owner.close(); rmSync(dir,{recursive:true,force:true}) } }
}
it('retains original arrays/read counts and existing catalog migration behavior; only consecutive original failed reads become one scoped incident', async () => {
  const f = fixture(), events: any[] = []; f.h.owner.subscribe(e => events.push(e))
  try {
    f.write(applicationKey, JSON.stringify(modelRoot))
    const baseline = new CursorComposerTelemetryReader(f.options)
    const get = vi.spyOn(Object.getPrototypeOf(f.db.prepare('SELECT value FROM ItemTable WHERE key = ?')), 'get')
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    try {
      const reads = () => prepare.mock.calls.filter(([sql]) => sql === 'SELECT value FROM ItemTable WHERE key = ?').length
      const modelKeys = new Set([applicationKey, 'cursor.modelCatalogOwnKey.gateEnabled', 'cursor.modelCatalog.v1'])
      const queries = () => get.mock.calls.filter(([key]) => modelKeys.has(String(key))).length
      const start = reads(), queryStart = queries(); const plain = baseline.readModelCatalog()
      const plainCalls = reads()-start, plainQueries = queries()-queryStart
      const before = reads(), queryBefore = queries(); const observed = f.reader.readModelCatalog()
      expect(reads()-before).toBe(plainCalls); expect(queries()-queryBefore).toBe(plainQueries)
      expect(plainQueries).toBe(2); expect(observed).toEqual(plain); expect(f.reader.readModelCatalog()).toBe(observed)
      f.write('cursor.modelCatalogOwnKey.gateEnabled', 'true'); f.write('cursor.modelCatalog.v1', JSON.stringify(modelRoot.availableDefaultModels2))
      const ownStart = queries(); baseline.readModelCatalog(); const ownQueries = queries()-ownStart
      const observedOwnStart = queries(); f.reader.readModelCatalog()
      expect(ownQueries).toBe(3); expect(queries()-observedOwnStart).toBe(ownQueries)
    } finally { get.mockRestore(); prepare.mockRestore(); baseline.dispose() }
    await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.write(applicationKey, '{PRIVATE malformed preference')
    f.setAt(11000); expect(f.reader.readModelCatalog()).toEqual([])
    f.setAt(12000); f.reader.readModelCatalog(); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.setAt(17000); f.reader.readModelCatalog(); await f.source.source.flush()
    expect(f.h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
    const incident = f.h.ledger.page().records[0]!
    expect(incident).toMatchObject({ eventType: 'cursor.model-catalog', target: { kind: 'settings', section: 'maintenance' }, scope: {}, state: 'active' })
    expect(incident.detail).toContain('不表示已有会话已停止')
    for (let i=0; i<20; i++) { f.setAt(18000+i*1000); f.reader.readModelCatalog() }
    await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(1); expect(events.filter(e=>e.announcement)).toHaveLength(1)
    f.write(applicationKey, JSON.stringify(modelRoot)); f.setAt(40000); f.reader.readModelCatalog(); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
    expect(JSON.stringify(f.h.ledger.page())).not.toMatch(/PRIVATE|sg-model-health-|fixture-model|state\.vscdb/)
  } finally { await f.close() }
})
it('waiting, own-key migration/partial compatible catalog, empty selected-only and cached time echoes do not manufacture a fault or a recovery', async () => {
  const f = fixture()
  try {
    f.write(applicationKey, JSON.stringify({ aiSettings: { modelConfig: { composer: { modelName:'auto' } } } }))
    expect(f.reader.readModelCatalog()?.[0]?.modelId).toBe('auto'); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.write('cursor.modelCatalogOwnKey.gateEnabled','true')
    f.write('cursor.modelCatalog.v1','[]')
    f.reader.readModelCatalog(); f.setAt(20000); f.reader.readModelCatalog(); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.write(applicationKey,JSON.stringify(modelRoot)); f.write('cursor.modelCatalog.v1','{partial')
    const old = f.reader.readModelCatalog(); expect(old?.[0]?.modelId).toBe('fixture-model')
    f.setAt(30000); f.reader.readModelCatalog(); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.source.observe({state:'failed',reason:'record',at:31000}); f.source.observe({state:'failed',reason:'record',at:37000}); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.setAt(38000); f.reader.readModelCatalog(); await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.write('cursor.modelCatalog.v1',JSON.stringify([{name:'own-model'}])); f.setAt(39000); expect(f.reader.readModelCatalog()?.[0]?.modelId).toBe('own-model')
    await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
  } finally { await f.close() }
})
it('never lets a throwing notification observer turn a readable catalog into an empty/failed original result', () => {
  const dir=mkdtempSync(join(tmpdir(),'sg-model-isolation-')), path=join(dir,'state.vscdb'), db=new DatabaseSync(path)
  db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)'); db.prepare('INSERT INTO ItemTable VALUES(?,?)').run(applicationKey,JSON.stringify(modelRoot)); db.close()
  const reader=new CursorComposerTelemetryReader({globalStateDatabase:path,projectsRoot:join(dir,'projects'),workspaceStorageRoot:join(dir,'workspaces'), modelObserver:{observe:()=>{throw Error('broken observer')},unavailable:()=>{throw Error('broken gap listener')}}})
  try { expect(reader.readModelCatalog()?.[0]?.modelId).toBe('fixture-model') }
  finally { reader.dispose(); rmSync(dir,{recursive:true,force:true}) }
})
it('does not advance confirmation from cached workspace snapshots, echo clocks, pause/wake, clock rollback or a long missing sampling gap', async () => {
  const f=fixture()
  try {
    const workspace=join(f.dir,'project'); mkdirSync(workspace)
    f.write(applicationKey,'{broken'); f.write('composer.composerHeaders',JSON.stringify({allComposers:[]}))
    f.setAt(10000); f.reader.readWorkspace(workspace,[])
    f.setAt(20000); f.reader.readWorkspace(workspace,[]); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.source.observe({state:'failed',reason:'read',at:30000}); f.source.observe({state:'failed',reason:'read',at:30000}); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.source.suspend(); f.source.observe({state:'failed',reason:'read',at:36000}); f.source.resume()
    f.source.observe({state:'failed',reason:'read',at:37000}); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.source.observe({state:'failed',reason:'read',at:10000}); f.source.observe({state:'failed',reason:'read',at:100000}); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.source.observe({state:'failed',reason:'read',at:106000}); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(1)
  } finally { await f.close() }
})
it('restores the durable existing incident after a missing private ACK without retrying database reads or replaying the old live alert', async () => {
  const f=fixture(), original=f.h.port.commitSource.bind(f.h.port)
  try {
    vi.mocked(f.h.port.commitSource).mockImplementationOnce(async (...args)=>{await original(...args);throw Error('ACK lost')})
    f.source.observe({state:'failed',reason:'read',at:10000}); f.source.observe({state:'failed',reason:'read',at:16000}); await f.source.source.flush()
    f.source.observe({state:'failed',reason:'read',at:17000}); await f.source.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(1); expect(vi.mocked(f.h.port.sourceState)).toHaveBeenCalledTimes(2)
    expect(f.h.owner.status().historyIncomplete).toBe(true)
  } finally { await f.close() }
})

it('accounts for gate-only changes without reparsing the original payload or replacing model/profile references', async () => {
  const f = fixture(), facts: ModelCatalogObservation[] = []
  const reader = new CursorComposerTelemetryReader({ ...f.options, modelObserver: { observe: fact => facts.push(fact), unavailable: vi.fn() } })
  try {
    f.write(applicationKey, JSON.stringify({ ...modelRoot, aiSettings: { modelConfig: { composer: { modelName: 'fixture-model' } } } }))
    f.write('composer.composerHeaders', JSON.stringify({ allComposers: [] }))
    const workspace = join(f.dir, 'project'); mkdirSync(workspace)
    const initial = reader.readWorkspace(workspace, [])
    const original = reader.readModelCatalog()
    const parse = vi.spyOn(JSON, 'parse')
    try {
      for (const [gate, expected] of [['true', 'fallback'], ['false', 'ready'], ['1', 'fallback'], ['0', 'ready']] as const) {
        f.write('cursor.modelCatalogOwnKey.gateEnabled', gate)
        expect(reader.readModelCatalog()).toBe(original)
        expect(facts.at(-1)?.state).toBe(expected)
      }
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
    expect(reader.readWorkspace(workspace, []).composerProfile).toBe(initial.composerProfile)
    // A failed own source cannot be called recovered by a cached compatibility list.
    f.source.observe({ state: 'ready', at: 10000 })
    f.source.observe({ state: 'failed', reason: 'record', at: 11000 })
    f.source.observe({ state: 'failed', reason: 'record', at: 17000 }); await f.source.source.flush()
    f.write('cursor.modelCatalogOwnKey.gateEnabled', 'true'); f.setAt(18000); f.reader.readModelCatalog(); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.write('cursor.modelCatalogOwnKey.gateEnabled', 'false'); f.setAt(19000); f.reader.readModelCatalog(); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
  } finally { reader.dispose(); await f.close() }
})

it('distinguishes explicit invalid records from missing/empty/selected-only catalogs without changing the original returned models', async () => {
  const f = fixture(), facts: ModelCatalogObservation[] = []
  const reader = new CursorComposerTelemetryReader({ ...f.options, modelObserver: { observe: fact => facts.push(fact), unavailable: vi.fn() } })
  const selected = { aiSettings: { modelConfig: { composer: { modelName: 'auto' } } } }
  try {
    for (const [raw, expected] of [
      [{}, 'waiting'], [selected, 'waiting'], [{ ...selected, availableDefaultModels2: [] }, 'waiting'],
      [{ ...selected, availableDefaultModels2: null }, 'failed'], [{ ...selected, availableDefaultModels2: [null] }, 'failed'],
      [{ ...selected, availableDefaultModels2: [{ clientDisplayName: 'no-id' }] }, 'failed'],
      [{ ...selected, availableDefaultModels2: [{ name: 'auto', hidden: true }] }, 'waiting'],
      [{ ...selected, availableDefaultModels2: [{ name: 'auto', isEnabled: false }] }, 'waiting'],
      [modelRoot, 'ready'], [{ ...modelRoot, availableDefaultModels2: [...modelRoot.availableDefaultModels2, null] }, 'fallback']
    ] as const) {
      f.write(applicationKey, JSON.stringify(raw))
      const returned = reader.readModelCatalog()
      const plain = new CursorComposerTelemetryReader(f.options)
      try { expect(returned).toEqual(plain.readModelCatalog()) } finally { plain.dispose() }
      expect(facts.at(-1)?.state).toBe(expected)
    }
    f.write(applicationKey, JSON.stringify(selected)); f.write('cursor.modelCatalogOwnKey.gateEnabled', 'true')
    for (const [raw, expected] of [['[]', 'waiting'], ['{}', 'failed'], ['[null]', 'failed'], ['{partial', 'failed'], ['[{"name":"own-valid"}]', 'ready']] as const) {
      f.write('cursor.modelCatalog.v1', raw); reader.readModelCatalog()
      expect(facts.at(-1)?.state).toBe(expected)
    }
    // A stored selection whose catalog entry is outside the unchanged parser
    // window is still not proof of a hydrated usable catalog.
    f.write('cursor.modelCatalogOwnKey.gateEnabled', 'false')
    f.write(applicationKey, JSON.stringify({ ...selected, availableDefaultModels2: [...Array.from({ length: 160 }, () => ({ name: 'hidden', hidden: true })), { name: 'auto' }] }))
    expect(reader.readModelCatalog()?.[0]?.modelId).toBe('auto'); expect(facts.at(-1)?.state).toBe('waiting')
  } finally { reader.dispose(); await f.close() }
})

it('observes the original read exception, size guard and missing file as different facts without an extra query or probe', async () => {
  const f = fixture(), facts: ModelCatalogObservation[] = []
  const reader = new CursorComposerTelemetryReader({ ...f.options, modelObserver: { observe: fact => facts.push(fact), unavailable: vi.fn() } })
  try {
    f.db.exec('DROP TABLE ItemTable')
    expect(reader.readModelCatalog()).toEqual([]); expect(facts.at(-1)).toMatchObject({ state: 'failed', reason: 'read' })
    f.db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT)')
    f.write(applicationKey, ' '.repeat(64 * 1024 * 1024 + 1))
    expect(reader.readModelCatalog()).toEqual([]); expect(facts.at(-1)).toMatchObject({ state: 'failed', reason: 'size' })
    const missing = new CursorComposerTelemetryReader({ ...f.options, globalStateDatabase: join(f.dir, 'not-created.sqlite'), modelObserver: { observe: fact => facts.push(fact), unavailable: vi.fn() } })
    try { expect(missing.readModelCatalog()).toBeUndefined(); expect(facts.at(-1)?.state).toBe('waiting') } finally { missing.dispose() }
  } finally { reader.dispose(); await f.close() }
})

it('keeps one active episode through a new cause, quiet recovery, restart and later genuine failures; reading is not source recovery', async () => {
  const f = fixture(), events: any[] = []
  f.h.owner.subscribe(event => events.push(event))
  try {
    f.source.observe({ state: 'ready', at: 10000 })
    f.source.observe({ state: 'failed', reason: 'read', at: 11000 }); f.source.observe({ state: 'failed', reason: 'read', at: 17000 })
    await f.source.source.flush()
    const incident = f.h.ledger.page().records[0]!
    await f.h.owner.read(incident.id, incident.revision)
    expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.source.observe({ state: 'failed', reason: 'record', at: 18000 }); f.source.observe({ state: 'failed', reason: 'record', at: 24000 })
    await f.source.source.flush()
    const newCause = f.h.ledger.page().records[0]!
    expect(newCause.id).toBe(incident.id); expect(newCause.eventId).not.toBe(incident.eventId)
    expect(newCause.detail).toContain('无法验证的目录记录'); expect(f.h.ledger.page().summary.unread).toBe(1)
    await f.source.close()
    const restarted = new ModelCatalogNotifications(f.h.owner), before = events.filter(event => event.announcement).length
    try {
      restarted.observe({ state: 'failed', reason: 'record', at: 30000 }); restarted.observe({ state: 'failed', reason: 'record', at: 36000 })
      await restarted.source.flush(); expect(events.filter(event => event.announcement)).toHaveLength(before)
      restarted.observe({ state: 'fallback', at: 37000 }); restarted.observe({ state: 'waiting', at: 38000 })
      await restarted.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
      restarted.observe({ state: 'ready', at: 39000 }); await restarted.source.flush()
      expect(f.h.ledger.page().records[0]?.state).toBe('resolved'); expect(events.filter(event => event.announcement)).toHaveLength(before)
      restarted.observe({ state: 'failed', reason: 'size', at: 40000 }); restarted.observe({ state: 'failed', reason: 'size', at: 46000 })
      await restarted.source.flush(); expect(f.h.ledger.page().summary.total).toBe(2)
      expect(f.h.ledger.page().records[0]?.key).not.toBe(incident.key)
    } finally { await restarted.close() }
  } finally { await f.close() }
})

it('validates durable diagnostic state and does not persist malformed observation reasons', () => {
  const base = { version: 1, key: 'health', incident: { key: 'model-catalog:' + '1'.repeat(64), active: true, reason: 'read' } }
  expect(readModelCatalogState(base, 'health')).toEqual(base)
  expect(readModelCatalogState(undefined, 'health')).toBeUndefined()
  for (const value of [null, [], { ...base, version: 2 }, { ...base, incident: [] }, { ...base, incident: { ...base.incident, reason: 'private' } }]) {
    expect(() => readModelCatalogState(value, 'health')).toThrow()
  }
  expect(() => reduceModelCatalogNotifications(undefined, { key: 'health', id: '1'.repeat(64), fact: { state: 'failed', at: 1, reason: 'private' as any } }, true, 1)).toThrow()
})
