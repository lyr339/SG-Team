import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createTableComposerHeaderDeleter, readCursorComposerHeadersJson } from '../src/infrastructure/cursor/cursor-composer-headers'

function fixture() {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value); CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, subagentTypeName TEXT, value TEXT)')
  return database
}

describe('native migrated Composer index', () => {
  it('prioritizes table rows over a stale legacy key and preserves native fields', () => {
    const db = fixture()
    try {
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer.composerHeaders', '{"allComposers":[{"composerId":"stale"}]}')
      db.prepare('INSERT INTO composerHeaders(composerId,value) VALUES (?, ?)').run('modern', '{"composerId":"modern","workspaceIdentifier":{"id":"workspace"},"totalLinesAdded":42}')
      expect(JSON.parse(readCursorComposerHeadersJson(db)!)).toEqual({ allComposers: [{ composerId: 'modern', workspaceIdentifier: { id: 'workspace' }, totalLinesAdded: 42 }] })
    } finally { db.close() }
  })
  it('does not resurrect legacy rows after all migrated chats are deleted', () => {
    const db = fixture()
    try {
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer.composerHeaders', '{"allComposers":[{"composerId":"stale"}]}')
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer.composerHeaders.version', 'migrated')
      expect(JSON.parse(readCursorComposerHeadersJson(db)!)).toEqual({ allComposers: [] })
    } finally { db.close() }
  })
  it('keeps legacy JSON usable before the table migration has occurred', () => {
    const db = fixture()
    try {
      const legacy = '{"allComposers":[{"composerId":"legacy"}]}'
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer.composerHeaders', legacy)
      expect(readCursorComposerHeadersJson(db)).toBe(legacy)
    } finally { db.close() }
  })
  it('invalidates cached headers on native version changes and atomically deletes only the requested row', () => {
    const db = fixture()
    try {
      db.prepare('INSERT INTO composerHeaders(composerId,value) VALUES (?, ?)').run('first', '{"composerId":"first"}')
      db.prepare('INSERT INTO composerHeaders(composerId,value) VALUES (?, ?)').run('second', '{"composerId":"second"}')
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer.composerHeaders.version', 'v1')
      expect(JSON.parse(readCursorComposerHeadersJson(db)!).allComposers).toHaveLength(2)
      const remove = createTableComposerHeaderDeleter(db)
      db.exec('BEGIN IMMEDIATE'); expect(remove('first')).toBe(1); db.exec('ROLLBACK')
      expect(JSON.parse(readCursorComposerHeadersJson(db)!).allComposers).toHaveLength(2)
      db.exec('BEGIN IMMEDIATE'); expect(remove('first')).toBe(1); db.exec('COMMIT')
      expect(JSON.parse(readCursorComposerHeadersJson(db)!).allComposers).toEqual([{ composerId: 'second' }])
    } finally { db.close() }
  })
  it('fails closed on malformed table identity rather than falling back to stale data', () => {
    const db = fixture()
    try {
      db.prepare('INSERT INTO composerHeaders(composerId,value) VALUES (?, ?)').run('wrong', '{"composerId":"different"}')
      expect(() => readCursorComposerHeadersJson(db)).toThrow(/身份不一致/)
    } finally { db.close() }
  })
})
