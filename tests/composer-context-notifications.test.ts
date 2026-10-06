import { expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ComposerContextNotifications, RuntimeUsageNotifications } from '../src/application/notifications/runtime-usage-notifications'
import { CursorComposerTelemetryReader } from '../src/infrastructure/cursor/cursor-composer-telemetry'
import { notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
import type { RuntimeUsageReadObserver, RuntimeUsageReadResult } from '../src/domain/runtime-usage-observation'

const appKey = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sg-context-source-')), workspace = join(directory, 'workspace'), path = join(directory, 'state.vscdb')
  mkdirSync(workspace)
  const db = new DatabaseSync(path); db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT)')
  const write = (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO ItemTable VALUES(?,?)').run(key, value)
  const team = notificationTeam(); team.workspaces = [{ id: team.activeWorkspaceId!, name: 'PRIVATE workspace', path: workspace, createdAt: 1, updatedAt: 1 }]
  const headers = (ids = ['composer-a']) => write('composer.composerHeaders', JSON.stringify({ allComposers: ids.map((composerId, index) => ({ composerId, name: 'PRIVATE header', createdAt: 1000,
    lastUpdatedAt: 2000 - index, workspaceIdentifier: { uri: { fsPath: workspace } } })) }))
  headers(); write(appKey, JSON.stringify({ availableDefaultModels2: [{ name: 'fixture-model' }] }))
  const h = notificationSourceHarness(); let at = 10000, stamp = 0
  const source = new ComposerContextNotifications(h.owner, () => at); source.setTeam(team)
  const options = { globalStateDatabase: path, projectsRoot: join(directory, 'projects'), workspaceStorageRoot: join(directory, 'workspaces'), now: () => at }
  const reader = new CursorComposerTelemetryReader({ ...options, contextObserver: source })
  const detail = (value: unknown, id = 'composer-a') => db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES(?,?)').run('composerData:' + id, typeof value === 'string' ? value : JSON.stringify(value))
  const touch = () => { const time = new Date(1_000_000 + ++stamp * 1000); utimesSync(path, time, time) }
  return { directory, workspace, path, db, team, h, source, options, reader, detail, headers, write, touch,
    at: (value: number) => { at = value }, read: () => reader.readWorkspace(workspace, team.bindings),
    close: async () => { reader.dispose(); db.close(); await source.close(); await h.owner.close(); rmSync(directory, { recursive: true, force: true }) } }
}

it('preserves original SQL counts, returned values and snapshot references; cached frames are not another read proof', async () => {
  const f = fixture()
  try {
    f.detail({ contextTokensUsed: 5000, contextTokenLimit: 100000 })
    const plain = new CursorComposerTelemetryReader(f.options), get = vi.spyOn(Object.getPrototypeOf(f.db.prepare('SELECT value FROM ItemTable WHERE key = ?')), 'get')
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const reads = () => prepare.mock.calls.filter(([sql]) => String(sql).includes('FROM cursorDiskKV WHERE key = ?')).length
    const rows = () => get.mock.calls.filter(([key]) => key === 'composerData:composer-a').length
    try {
      const before = reads(), rowBefore = rows(); const expected = plain.readWorkspace(f.workspace, f.team.bindings)
      const expectedCalls = reads() - before, expectedRows = rows() - rowBefore
      const observedBefore = reads(), observedRows = rows(); const actual = f.read()
      expect(reads() - observedBefore).toBe(expectedCalls); expect(rows() - observedRows).toBe(expectedRows)
      expect(actual).toEqual(expected); expect(actual.composers[0]?.contextUsage?.used).toBe(5000)
      f.at(20000); expect(f.read()).toBe(actual); expect(rows() - observedRows).toBe(expectedRows)
    } finally { get.mockRestore(); prepare.mockRestore(); plain.dispose() }
    await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.detail('{PRIVATE malformed'); f.touch(); f.at(21000); f.read()
    f.at(30000); f.read(); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.detail('{PRIVATE changed malformed'); f.touch(); f.at(31000); f.read(); await f.source.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(1)
    expect(f.h.ledger.page().records[0]).toMatchObject({ eventType: 'cursor.context-source', target: { kind: 'settings', section: 'maintenance' }, state: 'active' })
  } finally { await f.close() }
})

it('optional table/column absence, empty/zero/unknown fields, unqueried binding and header-only fallback stay quiet and cannot restore an earlier failed detail read', async () => {
  const f = fixture()
  try {
    f.db.exec('DROP TABLE cursorDiskKV'); f.touch(); expect(f.read().availability).toBe('available')
    f.at(17000); f.touch(); f.read(); await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.db.exec('CREATE TABLE cursorDiskKV(other TEXT)'); f.touch(); f.at(18000); f.read(); f.at(24000); f.touch(); f.read()
    await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.db.exec('DROP TABLE cursorDiskKV; CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT)')
    for (const value of [{}, { contextTokensUsed: 0, contextTokenLimit: 1000 }, { contextUsagePercent: 20 }, { contextTokensUsed: 2000 }]) {
      f.detail(value); f.touch(); f.at(25000); f.read()
    }
    await f.source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.detail('{bad'); f.touch(); f.at(26000); f.read(); f.touch(); f.at(32000); f.read(); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.write('composer.composerHeaders', JSON.stringify({ allComposers: [{ composerId: 'composer-a', name: 'old compatible header',
      contextTokensUsed: 1000, contextTokenLimit: 10000, contextUsagePercent: 10, createdAt: 1000, lastUpdatedAt: 2000, workspaceIdentifier: { uri: { fsPath: f.workspace } } }] }))
    f.detail({}); f.touch(); f.at(33000); const fallback = f.read()
    expect(fallback.composers[0]?.contextUsage?.used).toBe(1000)
    await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.headers([]); f.touch(); f.at(34000); f.read(); await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
  } finally { await f.close() }
})

it('confirms only actual queried owned rows, retains original partial maps and never treats another scope/healthy runtime source as detail recovery', async () => {
  const f = fixture(), runtime = new RuntimeUsageNotifications(f.h.owner, () => 20000)
  try {
    runtime.setTeam(f.team); f.detail('{bad'); f.touch(); f.read(); f.at(16000); f.touch(); f.read(); await f.source.source.flush()
    const incident = f.h.ledger.page().records[0]!
    runtime.begin({ workspacePath: f.workspace, composerIds: ['composer-a'] })?.complete({ state: 'ready' }); await runtime.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.headers(['composer-a', 'unbound-long']); f.detail({ contextTokensUsed: 3000, contextTokenLimit: 10000 }); f.detail('{unrelated malformed', 'unbound-long')
    f.touch(); f.at(17000); const partial = f.read()
    expect(partial.composers.find(c => c.composerId === 'composer-a')?.contextUsage?.used).toBe(3000)
    await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
    expect(f.h.ledger.page().records[0]?.id).toBe(incident.id)
    f.headers(['unbound-long', 'composer-a']); f.touch(); f.at(18000); f.read(); f.touch(); f.at(24000); f.read(); await f.source.source.flush()
    // Original routine aborts before the owned row; don't manufacture its read from a separate query.
    expect(f.h.ledger.page().records[0]?.state).toBe('active'); expect(f.h.ledger.page().summary.total).toBe(2)
    expect(JSON.stringify(f.h.ledger.page())).not.toMatch(/PRIVATE|composer-a|unbound|sg-context-source-|state\.vscdb/)
  } finally { await runtime.close(); await f.close() }
})

it('uses the original 3.21 header table and same routine; guarded native details survive original JSON-index migration', async () => {
  const f = fixture()
  try {
    f.db.exec('CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,value TEXT)')
    f.db.prepare('INSERT INTO composerHeaders VALUES(?,?)').run('composer-a', JSON.stringify({ composerId: 'composer-a', name: 'native', createdAt: 1000,
      lastUpdatedAt: 2000, workspaceIdentifier: { uri: { fsPath: f.workspace } } }))
    f.write('composer.composerHeaders.version', 'native-1'); f.db.prepare('DELETE FROM ItemTable WHERE key=?').run('composer.composerHeaders')
    f.detail({ contextTokensUsed: 4000, contextUsagePercent: 40, contextTokenLimit: 10000 }); f.touch()
    expect(f.read().composers[0]?.contextUsage?.used).toBe(4000)
    f.detail('{broken-native'); f.at(11000); f.touch(); f.read(); f.at(17000); f.touch(); f.read(); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.detail({ contextTokensUsed: 4001, contextTokenLimit: 10000 }); f.at(18000); f.touch(); f.read(); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('resolved')
  } finally { await f.close() }
})

it('preserves original fallback if observers, target getters, diagnostics or gap handlers throw; foreign targets cannot confirm health', async () => {
  const f = fixture(), outcomes: RuntimeUsageReadResult[] = [], gap = vi.fn()
  const make = (observer: RuntimeUsageReadObserver) => new CursorComposerTelemetryReader({ ...f.options, contextObserver: observer })
  const readers: CursorComposerTelemetryReader[] = []
  try {
    f.detail({ contextTokensUsed: 5000, contextTokenLimit: 10000 })
    const a = make({ begin: () => { throw Error('begin') }, unavailable: () => { throw Error('gap') } }); readers.push(a)
    expect(a.readWorkspace(f.workspace, f.team.bindings).composers[0]?.contextUsage?.used).toBe(5000)
    const b = make({ begin: () => ({ get composerIds(): readonly string[] { throw Error('diagnostic target') }, complete: () => { throw Error('complete') }, unavailable: () => { throw Error('gap') } }), unavailable: vi.fn() }); readers.push(b)
    expect(b.readWorkspace(f.workspace, f.team.bindings).composers[0]?.contextUsage?.used).toBe(5000)
    const c = make({ begin: () => ({ composerIds: ['foreign'], complete: result => outcomes.push(result), unavailable: gap }), unavailable: gap }); readers.push(c)
    expect(c.readWorkspace(f.workspace, f.team.bindings).composers[0]?.contextUsage?.used).toBe(5000)
    expect(outcomes).toEqual([{ state: 'waiting' }]); expect(gap).toHaveBeenCalledOnce()
  } finally { readers.forEach(reader => reader.dispose()); await f.close() }
})

it('does not add reads/throw or close a new scope from an old receipt; read notices are not source recovery', async () => {
  const f = fixture()
  try {
    f.detail('{bad'); f.touch(); f.read(); f.at(16000); f.touch(); f.read(); await f.source.source.flush()
    const incident = f.h.ledger.page().records[0]!
    await f.h.owner.read(incident.id, incident.revision); expect(f.h.ledger.page().records[0]?.state).toBe('active')
    const old = f.source.begin({ workspacePath: f.workspace, composerIds: ['composer-a'] })!
    const next = structuredClone(f.team); next.bindings[0]!.generation = 'changed'; f.source.setTeam(next)
    old.complete({ state: 'ready' }); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('expired')
    f.source.suspend(); f.detail({ contextTokensUsed: 5000, contextTokenLimit: 10000 }); f.touch(); f.at(17000); f.read(); f.source.resume()
    await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('expired')
  } finally { await f.close() }
})

it('original rounding/clamping and later non-detail projection failures never become context recovery or a false context-read fault', async () => {
  const f = fixture()
  try {
    f.detail('{bad'); f.touch(); f.read(); f.at(16000); f.touch(); f.read(); await f.source.source.flush()
    const incident = f.h.ledger.page().records[0]!
    for (const detail of [
      { contextTokensUsed: 10.5, contextTokenLimit: 100 },
      { contextTokensUsed: 10, contextTokenLimit: 100, contextUsagePercent: 120 },
      { promptTokenBreakdown: { totalUsedTokens: 10.5, maxTokens: 100, categories: [] } }
    ]) {
      f.detail(detail); f.touch(); f.at(17000); expect(f.read().composers[0]?.contextUsage).toBeDefined()
      await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
    }
    f.detail({ contextTokensUsed: 10, contextTokenLimit: 100 }); f.touch(); f.at(18000)
    const project = vi.spyOn(f.reader as any, 'readTranscriptSignals').mockImplementationOnce(() => { throw Error('unrelated projection failed') })
    try { expect(f.read().availability).toBe('error') } finally { project.mockRestore() }
    await f.source.source.flush(); expect(f.h.ledger.page().records[0]?.state).toBe('active')
    f.touch(); f.at(19000); f.read(); await f.source.source.flush()
    expect(f.h.ledger.page().records[0]?.state).toBe('resolved'); expect(f.h.ledger.page().records[0]?.id).toBe(incident.id)
  } finally { await f.close() }
})
