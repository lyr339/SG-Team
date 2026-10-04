import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CursorAccountSwitchBackup, type CursorAccountSwitchPaths } from '../src/infrastructure/cursor/cursor-account-switch-backup'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(): CursorAccountSwitchPaths {
  const root = mkdtempSync(join(tmpdir(), 'sg-switch-backup-')); roots.push(root)
  const paths = { database: join(root, 'state.vscdb'), storage: join(root, 'storage.json'), machineId: join(root, 'machineid') }
  const db = new DatabaseSync(paths.database)
  db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value); CREATE TABLE composerHeaders(id TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('auth', 'old')
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?)').run('composer-1', 'keep')
  db.close()
  return paths
}

describe('Cursor switch scoped recovery snapshot', () => {
  it.each(['text', 'blob'])('preserves current tool approvals while restoring account fields in a %s applicationUser row', (encoding) => {
    const p = fixture(), key = 'applicationUser'
    const original = JSON.stringify({ membershipType: 'old', composerState: { toolsAllowed: false } })
    const db = new DatabaseSync(p.database)
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(key, encoding === 'blob' ? Buffer.from(original) : original)
    db.close()
    const backup = CursorAccountSwitchBackup.capture(p, ['auth', key], 1, { key, fields: ['membershipType', 'newUserData'] })
    const next = new DatabaseSync(p.database)
    next.prepare('UPDATE ItemTable SET value=? WHERE key=?').run(JSON.stringify({ membershipType: 'new', newUserData: 'new-account', composerState: { toolsAllowed: true }, editorPreference: 'keep' }), key)
    next.close()
    backup.restore()
    const after = new DatabaseSync(p.database)
    const value = after.prepare('SELECT value FROM ItemTable WHERE key=?').get(key)?.value
    after.close()
    const text = typeof value === 'string' ? value : Buffer.from(value as Uint8Array).toString()
    expect(JSON.parse(text)).toEqual({ membershipType: 'old', composerState: { toolsAllowed: true }, editorPreference: 'keep' })
    expect(value instanceof Uint8Array).toBe(encoding === 'blob')
  })
  it('restores exact SQLite types and missing keys without replacing the database or unrelated rows', () => {
    const p = fixture()
    const db = new DatabaseSync(p.database)
    const set = db.prepare('INSERT INTO ItemTable VALUES (?, ?)')
    set.run('big', 9_007_199_254_740_999n); set.run('fraction', 1.25)
    set.run('null', null); set.run('bytes', new Uint8Array([0, 255, 3]))
    db.close()
    const bytes = Buffer.from([0xff, 0xef, 0xbb, 0xbf, 0])
    writeFileSync(p.storage, bytes); writeFileSync(p.machineId, '')
    const backup = CursorAccountSwitchBackup.capture(p, ['auth', 'big', 'fraction', 'null', 'bytes', 'absent'], 1)
    const changed = new DatabaseSync(p.database)
    changed.exec("UPDATE ItemTable SET value='new'; INSERT INTO ItemTable VALUES ('absent', 'new'); INSERT INTO ItemTable VALUES ('editor-pref','keep')")
    changed.close()
    writeFileSync(p.storage, 'new'); writeFileSync(p.machineId, 'new')
    backup.restore()
    const after = new DatabaseSync(p.database)
    const query = after.prepare('SELECT key, value FROM ItemTable'); query.setReadBigInts(true)
    const values = new Map(query.all().map(row => [row.key, row.value]))
    expect(values.get('auth')).toBe('old'); expect(values.get('big')).toBe(9_007_199_254_740_999n)
    expect(values.get('fraction')).toBe(1.25); expect(values.get('null')).toBeNull()
    expect(Buffer.from(values.get('bytes') as Uint8Array)).toEqual(Buffer.from([0, 255, 3]))
    expect(values.has('absent')).toBe(false); expect(values.get('editor-pref')).toBe('keep')
    expect(after.prepare('SELECT value FROM composerHeaders').get()?.value).toBe('keep')
    after.close()
    expect(readFileSync(p.storage)).toEqual(bytes); expect(readFileSync(p.machineId)).toHaveLength(0)
  })

  it('restores only telemetry in valid storage.json, retaining preferences written during startup', () => {
    const p = fixture()
    writeFileSync(p.storage, JSON.stringify({ 'telemetry.machineId': 'old', 'telemetry.devDeviceId': null, windowState: 'before' }))
    const backup = CursorAccountSwitchBackup.capture(p, ['auth'], 1)
    writeFileSync(p.storage, JSON.stringify({ 'telemetry.machineId': 'new', 'telemetry.macMachineId': 'new', 'telemetry.devDeviceId': 'new', 'telemetry.sqmId': 'new', windowState: 'after', newPreference: true }))
    backup.restore()
    expect(JSON.parse(readFileSync(p.storage, 'utf8'))).toEqual({ 'telemetry.machineId': 'old', 'telemetry.devDeviceId': null, windowState: 'after', newPreference: true })
  })

  it('removes files created solely by this switch when they were originally absent', () => {
    const p = fixture(), backup = CursorAccountSwitchBackup.capture(p, ['auth'], 1)
    writeFileSync(p.storage, JSON.stringify({ 'telemetry.machineId': 'new' })); writeFileSync(p.machineId, 'new')
    backup.restore()
    expect(existsSync(p.storage)).toBe(false); expect(existsSync(p.machineId)).toBe(false)
  })

  it('keeps newly saved editor preferences when originally absent storage.json has acquired them', () => {
    const p = fixture(), backup = CursorAccountSwitchBackup.capture(p, ['auth'], 1)
    writeFileSync(p.storage, JSON.stringify({ 'telemetry.machineId': 'new', windowState: 'keep' }))
    backup.restore()
    expect(JSON.parse(readFileSync(p.storage, 'utf8'))).toEqual({ windowState: 'keep' })
  })

  it('does not overwrite a previous backup when attempts share the same timestamp', () => {
    const p = fixture()
    const first = CursorAccountSwitchBackup.capture(p, ['auth'], 42)
    const second = CursorAccountSwitchBackup.capture(p, ['auth'], 42)
    expect(first.directory).not.toBe(second.directory)
    expect(existsSync(join(first.directory, 'itemtable.sqlite3'))).toBe(true)
    expect(existsSync(join(second.directory, 'itemtable.sqlite3'))).toBe(true)
  })

  it('refuses unreadable/corrupt input rather than silently recording empty old state', () => {
    const p = fixture()
    writeFileSync(p.database, 'not SQLite')
    expect(() => CursorAccountSwitchBackup.capture(p, ['auth'], 1)).toThrow()
    expect(readFileSync(p.database, 'utf8')).toBe('not SQLite')
    const other = fixture(); mkdirSync(other.storage)
    expect(() => CursorAccountSwitchBackup.capture(other, ['auth'], 1)).toThrow()
  })

  it('fails capture if the durable backup cannot be created', () => {
    const p = fixture()
    writeFileSync(join(p.database, '..', 'backups'), 'not a directory')
    expect(() => CursorAccountSwitchBackup.capture(p, ['auth'], 1)).toThrow()
  })

  it('keeps the complete backup available when recovery cannot finish', () => {
    const p = fixture(); writeFileSync(p.machineId, 'old')
    const backup = CursorAccountSwitchBackup.capture(p, ['auth'], 1)
    rmSync(p.machineId); mkdirSync(p.machineId)
    expect(() => backup.restore()).toThrow()
    expect(readFileSync(join(backup.directory, 'machineid'), 'utf8')).toBe('old')
    expect(existsSync(join(backup.directory, 'itemtable.sqlite3'))).toBe(true)
  })
})
