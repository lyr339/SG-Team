import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const CURSOR_COMPOSER_HEADERS_KEY = 'composer.composerHeaders'
const HEADER_VERSION_KEY = 'composer.composerHeaders.version'
const MAX_HEADER_BYTES = 32 * 1024 * 1024
const tableSnapshots = new WeakMap<DatabaseSync, { version: string; json: string }>()

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : undefined
}

function hasHeaderTable(database: DatabaseSync): boolean {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='composerHeaders'").get()) return false
  const names = new Set(database.prepare('PRAGMA table_info(composerHeaders)').all().map((row) => row.name))
  if (!names.has('composerId') || !names.has('value')) throw new Error('Cursor 会话索引表结构不兼容')
  return true
}

/** 3.6.31 JSON index / 3.21.12 migrated table, shared by telemetry and storage maintenance. */
export function readCursorComposerHeadersJson(database: DatabaseSync): string | undefined {
  const read = database.prepare('SELECT value FROM ItemTable WHERE key = ?')
  const legacy = text(read.get(CURSOR_COMPOSER_HEADERS_KEY)?.value)
  if (!hasHeaderTable(database)) return legacy
  const version = text(read.get(HEADER_VERSION_KEY)?.value)
  const cached = tableSnapshots.get(database)
  if (version && cached?.version === version) return cached.json
  const rows = database.prepare('SELECT composerId, value FROM composerHeaders').iterate()
  const values: string[] = []
  let bytes = 0
  for (const row of rows) {
    const value = text(row.value)
    if (!value) throw new Error('Cursor 会话索引表存在空记录')
    bytes += Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_HEADER_BYTES) throw new Error('Cursor 会话索引异常过大，已停止读取')
    const header = JSON.parse(value) as { composerId?: unknown }
    if (!header || header.composerId !== row.composerId) throw new Error('Cursor 会话索引身份不一致')
    values.push(value)
  }
  // A version sentinel makes an EMPTY migrated table authoritative; don't resurrect stale legacy chats.
  if (!values.length && !version && legacy) return legacy
  const json = `{"allComposers":[${values.join(',')}]}`
  if (version) tableSnapshots.set(database, { version, json })
  return json
}

/** Called within the existing per-composer cleanup transaction, never deletes unrelated rows. */
export function createTableComposerHeaderDeleter(database: DatabaseSync): (composerId: string) => number {
  if (!hasHeaderTable(database)) return () => 0
  const remove = database.prepare('DELETE FROM composerHeaders WHERE composerId = ?')
  const version = database.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
  return (composerId) => {
    const changed = Number(remove.run(composerId).changes)
    if (changed) version.run(HEADER_VERSION_KEY, `${Date.now()}-${randomUUID()}`)
    return changed
  }
}
