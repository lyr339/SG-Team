import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteReplyIdentityIndex } from '../src/infrastructure/notifications/sqlite-reply-identity-index'
const sourceKey = `reply-source:${'1'.repeat(64)}`, other = `reply-source:${'2'.repeat(64)}`
const row = { key: '3'.repeat(64), aliases: ['4'.repeat(64)], entryId: 'native:old', failed: false, recorded: true }
const opened: DatabaseSync[] = []
function fixture() { const db = new DatabaseSync(':memory:'); opened.push(db); const index = new SqliteReplyIdentityIndex(db); index.create(); return { db, index } }
afterEach(() => { for (const db of opened.splice(0)) db.close() })
describe('normalized private reply identity index', () => {
  it('retains alias ownership across many unrelated identities and isolates other sources', () => {
    const { index } = fixture(); index.write({ sourceKey, rows: [row] })
    for (let i = 0; i < 2100; i++) index.write({ sourceKey, rows: [{ ...row, key: i.toString(16).padStart(64, '0'), aliases: [], entryId: `native:${i}` }] })
    expect(index.lookup(sourceKey, row.aliases)).toEqual([{ row, aliases: row.aliases }]); expect(index.lookup(other, row.aliases)).toEqual([])
  })
  it('participates in rollback with the caller transaction rather than publishing an index receipt early', () => {
    const { db, index } = fixture(); db.exec('BEGIN IMMEDIATE'); index.write({ sourceKey, rows: [row] }); db.exec('ROLLBACK')
    expect(index.lookup(sourceKey, row.aliases)).toEqual([])
  })
  it('keeps ambiguous owners as candidates instead of overwriting one and silently guessing', () => {
    const { index } = fixture(); const second = { ...row, key: '5'.repeat(64), entryId: 'native:other' }
    index.write({ sourceKey, rows: [row, second] })
    expect(index.lookup(sourceKey, row.aliases).map(value => value.row.key).sort()).toEqual([row.key, second.key])
  })
})

describe('reply alias queries fail closed, not into duplicate unread results', () => {
  it('retains an old alias outside the working payload and reports its exact owner', () => {
    const { index } = fixture(); index.write({ sourceKey, rows: [row] })
    const updated = { ...row, aliases: ['9'.repeat(64)], entryId: 'reply:canonical' }
    index.write({ sourceKey, rows: [updated] })
    expect(index.lookup(sourceKey, row.aliases)).toEqual([{ row: updated, aliases: row.aliases }])
  })
  it('rejects orphan aliases and corrupt private payloads instead of treating them as unseen replies', () => {
    const { db, index } = fixture(); index.write({ sourceKey, rows: [row] })
    db.prepare('UPDATE desktop_notification_reply_keys SET payload=?').run(JSON.stringify({ ...row, text: 'forbidden body' }))
    expect(() => index.lookup(sourceKey, row.aliases)).toThrow('格式异常')
    db.exec('DELETE FROM desktop_notification_reply_keys')
    expect(() => index.lookup(sourceKey, row.aliases)).toThrow('格式异常')
  })
  it('keeps published ownership monotonic and rejects an unsafe merge of two recorded notifications', () => {
    const { db, index } = fixture(); const second = { ...row, key: '5'.repeat(64) }
    index.write({ sourceKey, rows: [row, second] })
    expect(() => index.write({ sourceKey, rows: [{ ...row, recorded: false }] })).toThrow('不能回退')
    db.exec('BEGIN IMMEDIATE')
    expect(() => index.write({ sourceKey, rows: [row], merges: [{ from: second.key, to: row.key }] })).toThrow('已发布')
    db.exec('ROLLBACK')
    expect(index.lookup(sourceKey, [row.key, second.key])).toHaveLength(2)
  })
  it('bounds lookup aliases and candidate ownership without replacing ambiguity by the first returned record', () => {
    const { index } = fixture()
    expect(() => index.lookup(sourceKey, Array.from({ length: 801 }, (_, i) => i.toString(16).padStart(64, '0')))).toThrow('查询无效')
    expect(() => index.lookup(sourceKey, [row.key, row.key])).toThrow('查询无效')
    for (let i = 0; i < 101; i++) index.write({ sourceKey, rows: [{ ...row, key: i.toString(16).padStart(64, '0') }] })
    expect(() => index.lookup(sourceKey, row.aliases)).toThrow('过多候选')
  })
})
