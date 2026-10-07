import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { NOTIFICATION_SOURCE_PAYLOAD_LIMIT, type NotificationDraft } from '../src/domain/notification'
import type { ReplyIdentityBatch } from '../src/domain/reply-identity-index'
const key = `reply-source:${'1'.repeat(64)}`, row = { key: '2'.repeat(64), aliases: ['3'.repeat(64)], entryId: 'native:private', failed: false, recorded: true }
const batch: ReplyIdentityBatch = { sourceKey: key, rows: [row] }
const event: NotificationDraft = { key: `reply:${row.key}`, eventType: 'session.reply', category: 'sessions', source: 'original session', scope: {}, title: 'Original reply', attention: 'notice', tone: 'info', state: 'resolved', occurredAt: 1, sourceRevision: 1 }
describe('reply metadata is atomic with ledger and source CAS', () => {
  let folder: string, path: string, ledger: SqliteNotificationRepository
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'sg-reply-atomic-')); path = join(folder, 'private.sqlite'); ledger = new SqliteNotificationRepository(path) })
  afterEach(() => { ledger.close(); rmSync(folder, { recursive: true, force: true }) })
  it.each(['desktop_notifications', 'desktop_notification_reply_keys', 'desktop_notification_sources'])('rolls back all three parts when %s fails, not just the cursor', table => {
    const inspect = new DatabaseSync(path); inspect.exec(`CREATE TRIGGER reject_part BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'part rejected'); END`); inspect.close()
    expect(() => ledger.commitSource(key, 0, { cursor: 100 }, [event], 1, batch)).toThrow('part rejected')
    expect(ledger.sourceState(key)).toEqual({ revision: 0 }); expect(ledger.page().summary).toMatchObject({ total: 0, revision: 0 })
    expect(ledger.replyIdentities(key, [row.key, ...row.aliases])).toEqual([])
  })
  it('stale CAS, oversized original payload and cross-source sidecars never write even a metadata alias', () => {
    ledger.commitSource(key, 0, { baseline: true }, [], 1)
    expect(ledger.commitSource(key, 0, { stale: true }, [event], 1, batch).applied).toBe(false)
    expect(() => ledger.commitSource(key, 1, { oversized: 'a'.repeat(NOTIFICATION_SOURCE_PAYLOAD_LIMIT) }, [event], 1, batch)).toThrow('状态过大')
    expect(() => ledger.commitSource(`reply-source:${'4'.repeat(64)}`, 0, {}, [event], 1, batch)).toThrow('跨来源')
    expect(ledger.replyIdentities(key, row.aliases)).toEqual([]); expect(ledger.page().summary.total).toBe(0)
  })
  it('valid metadata, event and source checkpoint restore together after a file-backed restart', () => {
    ledger.commitSource(key, 0, { cursor: 100 }, [event], 1, batch)
    ledger.close(); ledger = new SqliteNotificationRepository(path)
    expect(ledger.sourceState(key)).toMatchObject({ revision: 1, data: { cursor: 100 } })
    expect(ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
    expect(ledger.replyIdentities(key, row.aliases)).toEqual([{ row, aliases: row.aliases }])
  })
  it.each(['missing', 'malformed'])('rejects %s v5 structures without silently reconstructing lost identity history', fault => {
    ledger.commitSource(key, 0, { cursor: 100 }, [event], 1, batch); ledger.close()
    const db = new DatabaseSync(path)
    db.exec('DROP TABLE desktop_notification_reply_aliases')
    if (fault === 'malformed') db.exec('CREATE TABLE desktop_notification_reply_aliases(source_key TEXT,alias TEXT,logical_key TEXT)')
    db.close()
    expect(() => new SqliteNotificationRepository(path)).toThrow('关联结构异常')
    const inspect = new DatabaseSync(path)
    try { expect(inspect.prepare('SELECT COUNT(*) AS n FROM desktop_notification_reply_keys').get()!.n).toBe(1); expect(inspect.prepare('SELECT COUNT(*) AS n FROM desktop_notifications').get()!.n).toBe(1) }
    finally { inspect.close() }
  })
  it('rejects a future private schema rather than downgrading or modifying its saved data', () => {
    ledger.commitSource(key, 0, {}, [event], 1, batch); ledger.close()
    const db = new DatabaseSync(path); db.exec('UPDATE desktop_notification_meta SET schema_version=9'); db.close()
    expect(() => new SqliteNotificationRepository(path)).toThrow('暂不支持')
    const inspect = new DatabaseSync(path)
    try { expect(inspect.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version).toBe(9); expect(inspect.prepare('SELECT payload FROM desktop_notification_reply_keys').get()!.payload).toBe(JSON.stringify(row)) }
    finally { inspect.close() }
  })
})
