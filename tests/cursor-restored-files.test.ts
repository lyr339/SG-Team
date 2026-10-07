import { DatabaseSync } from 'node:sqlite'
import { statSync, utimesSync, renameSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cursorRestoredFiles } from '../scripts/fixtures/cursor-restored-files'

describe('actual Cursor file restoration without a source restart', () => {
  it.each(['legacy', 'table'] as const)('%s detects restored same-inode/mtime/size/counter data and keeps the unchanged next frame cached', shape => {
    const f = cursorRestoredFiles(shape)
    try {
      expect(f.databaseHeader(f.old)).toBe(f.databaseHeader(f.next))
      const before = f.stamp(), current = f.read()
      expect(current.composers[0]?.contextUsage?.used).toBe(8000)
      expect(current.composers[0]?.changes?.additions).toBe(33)
      expect(f.read().composers).toBe(current.composers)
      f.restore(f.old)
      const after = f.stamp()
      expect([after.ino, after.mtime, after.size]).toEqual([before.ino, before.mtime, before.size])
      expect(after.ctime).not.toBe(before.ctime)
      const restored = f.read()
      expect(restored.composers[0]?.contextUsage?.used).toBe(7000)
      expect(restored.composers[0]?.changes?.additions).toBe(22)
      expect(restored.composers).not.toBe(current.composers); expect(f.read().composers).toBe(restored.composers)
    } finally { f.close() }
  })
  it('table updates from another connection are visible even if the native version sentinel is unchanged', () => {
    const f = cursorRestoredFiles('table')
    try {
      expect(f.read().composers[0]?.changes?.additions).toBe(33)
      const current = (f.reader as unknown as { sharedDatabase: { handle: DatabaseSync } }).sharedDatabase.handle
      const original = vi.spyOn(current, 'prepare')
      const count = original.mock.calls.length
      for (let i = 0; i < 100; i++) f.read()
      expect(original).toHaveBeenCalledTimes(count)
      original.mockRestore()
      f.updateBranch(f.path, 44, 9000)
      expect(f.read().composers[0]?.changes?.additions).toBe(44)
      expect(f.read().composers[0]?.contextUsage?.used).toBe(9000)
      expect((f.reader as unknown as { sharedDatabase: { handle: DatabaseSync } }).sharedDatabase.handle).toBe(current)
    } finally { f.close() }
  })
  it.each(['legacy', 'table'] as const)('%s also rejects an in-place replacement with a NEWER file timestamp but the same SQLite change counter', shape => {
    const f = cursorRestoredFiles(shape)
    try {
      expect(f.read().composers[0]?.contextUsage?.used).toBe(8000)
      f.restore(f.old); utimesSync(f.path, new Date(30000), new Date(30000))
      const fresh = f.read()
      expect(fresh.composers[0]?.contextUsage?.used).toBe(7000)
      expect(fresh.composers[0]?.changes?.additions).toBe(22)
    } finally { f.close() }
  })
  it('closes the previous read-only connection on atomic inode replacement, not merely the outer snapshot cache', () => {
    const f = cursorRestoredFiles('table')
    try {
      expect(f.read().composers[0]?.contextUsage?.used).toBe(8000)
      const old = (f.reader as unknown as { sharedDatabase: { handle: DatabaseSync } }).sharedDatabase.handle
      const replacement = join(f.directory, 'replacement.sqlite'); copyFileSync(f.old, replacement); renameSync(replacement, f.path)
      const snapshot = f.read()
      expect(snapshot.composers[0]?.contextUsage?.used).toBe(7000)
      expect((f.reader as unknown as { sharedDatabase: { handle: DatabaseSync } }).sharedDatabase.handle !== old).toBe(true)
      expect(() => old.prepare('SELECT 1')).toThrow('database is not open')
    } finally { f.close() }
  })
  it('keeps the existing connection for ordinary WAL commits while still returning fresh original rows', () => {
    const f = cursorRestoredFiles('table'), writer = new DatabaseSync(f.path)
    try {
      writer.exec('PRAGMA journal_mode=WAL')
      expect(f.read().composers[0]?.contextUsage?.used).toBe(8000)
      const old = (f.reader as unknown as { sharedDatabase: { handle: DatabaseSync } }).sharedDatabase.handle
      writer.prepare('UPDATE cursorDiskKV SET value=? WHERE key=?').run(JSON.stringify({ contextTokensUsed: 6000, contextTokenLimit: 10000 }), `composerData:${f.composerId}`)
      expect(f.read().composers[0]?.contextUsage?.used).toBe(6000)
      expect((f.reader as unknown as { sharedDatabase: { handle: DatabaseSync } }).sharedDatabase.handle).toBe(old)
      expect(f.read().composers).toBe(f.read().composers)
    } finally { writer.close(); f.close() }
  })
  it('an equal-length transcript rewrite cannot keep the former channel or complete reply cached merely by retaining mtime', () => {
    const f = cursorRestoredFiles('legacy')
    try {
      const before = statSync(f.transcript), first = f.read()
      expect(first.channelActivities?.['1']?.channelId).toBe('1')
      expect(first.composers[0]?.lastAssistantResponse?.text).toBe('PRIVATE reply old')
      f.rewriteTranscript('2', 'PRIVATE reply new'); f.nextFrame()
      const after = statSync(f.transcript)
      expect([after.ino, after.mtimeMs, after.size]).toEqual([before.ino, before.mtimeMs, before.size])
      const next = f.read()
      expect(next.channelActivities?.['1']).toBeUndefined()
      expect(next.composers[0]?.lastAssistantResponse?.text).toBe('PRIVATE reply new')
      expect(f.read().composers).toBe(next.composers)
    } finally { f.close() }
  })
  it('the same table connection observes its own update without needing an external data_version change', async () => {
    const f = cursorRestoredFiles('table'), database = new DatabaseSync(f.path)
    try {
      const { readCursorComposerHeadersJson } = await import('../src/infrastructure/cursor/cursor-composer-headers')
      const first = readCursorComposerHeadersJson(database)!
      const header = JSON.parse(first).allComposers[0]; header.totalLinesAdded = 55
      database.prepare('UPDATE composerHeaders SET value=? WHERE composerId=?').run(JSON.stringify(header), f.composerId)
      expect(readCursorComposerHeadersJson(database)).toContain('"totalLinesAdded":55')
    } finally { database.close(); f.close() }
  })
  it('a read inside a rolled-back table transaction never becomes the committed cached index', async () => {
    const f = cursorRestoredFiles('table'), database = new DatabaseSync(f.path)
    try {
      const { readCursorComposerHeadersJson } = await import('../src/infrastructure/cursor/cursor-composer-headers')
      const original = readCursorComposerHeadersJson(database)!, header = JSON.parse(original).allComposers[0]
      database.exec('BEGIN')
      header.totalLinesAdded = 66
      database.prepare('UPDATE composerHeaders SET value=? WHERE composerId=?').run(JSON.stringify(header), f.composerId)
      expect(readCursorComposerHeadersJson(database)).toContain('"totalLinesAdded":66')
      database.exec('ROLLBACK')
      expect(readCursorComposerHeadersJson(database)).toBe(original)
    } finally { if (database.isTransaction) database.exec('ROLLBACK'); database.close(); f.close() }
  })
})
