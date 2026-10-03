import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeStoreFileSync } from '../fs/store-file'

type StateValue = string | number | bigint | Uint8Array | null
type StateRow = { key: string; value: StateValue }
type FileSnapshot = { path: string; name: string; data?: Buffer; mode?: number }
type AccountJsonScope = { key: string; fields: readonly string[] }
const TELEMETRY_KEYS = ['telemetry.machineId', 'telemetry.macMachineId', 'telemetry.devDeviceId', 'telemetry.sqmId'] as const

export interface CursorAccountSwitchPaths {
  database: string
  storage: string
  machineId: string
}

/** A switch's touched keys and two files, never a copy/restore of the whole Cursor database. */
export class CursorAccountSwitchBackup {
  private constructor(
    readonly directory: string,
    private readonly database: string,
    private readonly keys: string[],
    private readonly rows: StateRow[],
    private readonly files: FileSnapshot[],
    private readonly accountJson?: AccountJsonScope
  ) {}

  /** Caller must have confirmed Cursor's exit. Any unreadable input stops the switch before writing. */
  static capture(paths: CursorAccountSwitchPaths, keys: readonly string[], now: number, accountJson?: AccountJsonScope): CursorAccountSwitchBackup {
    const touched = [...new Set(keys)]
    const rows = readRows(paths.database, touched)
    const files = [
      captureFile(paths.storage, 'storage.json'),
      captureFile(paths.machineId, 'machineid')
    ]
    const parent = join(dirname(paths.database), 'backups')
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    // A second attempt in the same millisecond must not overwrite the first recovery snapshot.
    const directory = mkdtempSync(join(parent, `account-switch-${now}-`))
    const backupPath = join(directory, 'itemtable.sqlite3')
    const db = new DatabaseSync(backupPath)
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE backup_meta (source_path TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE item_table_backup (key TEXT PRIMARY KEY, value, existed INTEGER NOT NULL CHECK (existed IN (0, 1)));
        CREATE TABLE file_backup_meta (name TEXT PRIMARY KEY, existed INTEGER NOT NULL CHECK (existed IN (0, 1)));
      `)
      db.prepare('INSERT INTO backup_meta VALUES (?, ?)').run(paths.database, now)
      const saved = new Map(rows.map(row => [row.key, row]))
      const insert = db.prepare('INSERT INTO item_table_backup VALUES (?, ?, ?)')
      for (const key of touched) {
        const row = saved.get(key)
        insert.run(key, row?.value ?? null, row ? 1 : 0)
      }
      const fileMeta = db.prepare('INSERT INTO file_backup_meta VALUES (?, ?)')
      for (const file of files) fileMeta.run(file.name, file.data === undefined ? 0 : 1)
      db.exec('COMMIT')
    } finally { db.close() }
    chmodSync(backupPath, 0o600)
    for (const file of files) {
      if (file.data !== undefined) writeStoreFileSync(join(directory, file.name), file.data, { mode: 0o600 })
    }
    return new CursorAccountSwitchBackup(directory, paths.database, touched, rows, files,
      accountJson ? { key: accountJson.key, fields: [...accountJson.fields] } : undefined)
  }

  /** Caller must stop any partially started Cursor first, or its late flush can undo this recovery. */
  restore(): void {
    const saved = new Map(this.rows.map(row => [row.key, row]))
    const expected = new Map(saved)
    const db = new DatabaseSync(this.database, { timeout: 5_000 })
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const insert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
        const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?')
        for (const key of this.keys) {
          const before = saved.get(key)
          const current = this.accountJson?.key === key
            ? db.prepare('SELECT key, value FROM ItemTable WHERE key=?').get(key) as StateRow | undefined : undefined
          const row = this.accountJson?.key === key ? restoreAccountJson(before, current, this.accountJson) : before
          if (row) insert.run(key, row.value)
          else remove.run(key)
          if (row) expected.set(key, row)
          else expected.delete(key)
        }
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    } finally { db.close() }
    for (const file of this.files) {
      const current = readOptionalFile(file.path)
      if (sameBytes(current, file.data)) continue
      const beforeJson = storageObject(file.data), currentJson = storageObject(current)
      if (file.name === 'storage.json' && (beforeJson || file.data === undefined) && currentJson) {
        // Cursor can save new window/editor preferences during startup. Undo only our four telemetry keys.
        for (const key of TELEMETRY_KEYS) {
          if (beforeJson && Object.hasOwn(beforeJson, key)) currentJson[key] = beforeJson[key]
          else delete currentJson[key]
        }
        if (file.data === undefined && Object.keys(currentJson).length === 0) unlinkSync(file.path)
        else writeStoreFileSync(file.path, JSON.stringify(currentJson, null, 2), { mode: file.mode })
        continue
      }
      if (file.data !== undefined) writeStoreFileSync(file.path, file.data, { mode: file.mode })
      else unlinkSync(file.path)
    }
    const actual = new Map(readRows(this.database, this.keys).map(row => [row.key, row]))
    for (const key of this.keys) {
      const before = expected.get(key), after = actual.get(key)
      if (Boolean(before) !== Boolean(after) || (before && after && !sameValue(before.value, after.value))) {
        throw new Error(`账号切换备份恢复校验失败（数据库键 ${key}）`)
      }
    }
    for (const file of this.files) {
      if (!fileRestored(file)) throw new Error(`账号切换备份恢复校验失败（${file.name}）`)
    }
  }
}

function readRows(path: string, keys: string[]): StateRow[] {
  const db = new DatabaseSync(path, { timeout: 2_000 })
  try {
    const query = db.prepare(`SELECT key, value FROM ItemTable WHERE key IN (${keys.map(() => '?').join(', ')})`)
    query.setReadBigInts(true)
    return query.all(...keys) as StateRow[]
  } finally { db.close() }
}

function readOptionalFile(path: string): Buffer | undefined {
  try { return readFileSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function captureFile(path: string, name: string): FileSnapshot {
  const data = readOptionalFile(path)
  return { path, name, data, mode: data === undefined ? undefined : statSync(path).mode & 0o777 }
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a === undefined || b === undefined ? a === b : Buffer.from(a).equals(b)
}

function sameValue(a: StateValue, b: StateValue): boolean {
  return a instanceof Uint8Array && b instanceof Uint8Array ? sameBytes(a, b) : a === b
}

function storageObject(data: Buffer | undefined): Record<string, unknown> | undefined {
  if (data === undefined) return undefined
  try {
    const value: unknown = JSON.parse(data.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

function fileRestored(file: FileSnapshot): boolean {
  const current = readOptionalFile(file.path)
  if (sameBytes(current, file.data)) return true
  const beforeJson = storageObject(file.data), afterJson = storageObject(current)
  if (file.name !== 'storage.json' || (!beforeJson && file.data !== undefined) || !afterJson) return false
  return TELEMETRY_KEYS.every(key => Object.hasOwn(beforeJson ?? {}, key) === Object.hasOwn(afterJson, key)
    && JSON.stringify(beforeJson?.[key]) === JSON.stringify(afterJson[key]))
}

/** applicationUser contains both account data and device-level tool approvals; restore only account fields. */
function restoreAccountJson(before: StateRow | undefined, current: StateRow | undefined, scope: AccountJsonScope): StateRow | undefined {
  const object = (row: StateRow | undefined) => storageObject(typeof row?.value === 'string'
    ? Buffer.from(row.value) : row?.value instanceof Uint8Array ? Buffer.from(row.value) : undefined)
  const oldObject = object(before), currentObject = object(current)
  if ((before && !oldObject) || !currentObject) return before
  for (const field of scope.fields) {
    if (oldObject && Object.hasOwn(oldObject, field)) currentObject[field] = oldObject[field]
    else delete currentObject[field]
  }
  if (!before && Object.keys(currentObject).length === 0) return undefined
  const text = JSON.stringify(currentObject)
  const value = (before?.value ?? current?.value) instanceof Uint8Array ? Buffer.from(text) : text
  return { key: scope.key, value }
}
