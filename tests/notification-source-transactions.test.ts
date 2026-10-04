import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import type { NotificationDraft } from '../src/domain/notification'

const event: NotificationDraft = { key: 'session:test:incident-1', category: 'sessions', source: '会话', title: 'CH-3 已离线', tone: 'warning', attention: 'notice', state: 'active',
  scope: { channelId: '3', sessionId: 'real-session' }, occurredAt: 100, sourceRevision: 1 }
describe('atomic notification source checkpoints', () => {
  let folder: string; let path: string; let ledger: SqliteNotificationRepository
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'sg-notify-source-')); path = join(folder, 'notifications.sqlite3'); ledger = new SqliteNotificationRepository(path) })
  afterEach(() => { ledger.close(); rmSync(folder, { recursive: true, force: true }) })
  it('commits observations and events together, restores them and rejects a stale source revision', () => {
    const source = ledger.commitSource('sessions:workspace-1', 0, { incident: event.key }, [event], 200)
    expect(source.applied).toBe(true); expect(ledger.page().summary.total).toBe(1)
    ledger.close(); ledger = new SqliteNotificationRepository(path)
    expect(ledger.sourceState('sessions:workspace-1')).toEqual({ revision: 1, data: { incident: event.key } })
    const stale = ledger.commitSource('sessions:workspace-1', 0, { incident: 'wrong' }, [{ ...event, key: 'wrong' }], 300)
    expect(stale.applied).toBe(false); expect(stale.source.revision).toBe(1); expect(ledger.page().summary.total).toBe(1)
  })
  it('does not advance a source cursor if any event write in the transaction fails', () => {
    const db = new DatabaseSync(path)
    db.exec("CREATE TRIGGER reject_bad_notice BEFORE INSERT ON desktop_notifications WHEN NEW.semantic_key='fail' BEGIN SELECT RAISE(ABORT,'fixture write rejected');END")
    db.close()
    expect(() => ledger.commitSource('sessions:test', 0, { observed: true }, [event, { ...event, key: 'fail' }], 200)).toThrow('fixture write rejected')
    expect(ledger.sourceState('sessions:test').revision).toBe(0)
    expect(ledger.page().summary).toMatchObject({ revision: 0, total: 0 })
  })
  it('checkpoint-only observations do not move notification history or bump the unread badge', () => {
    ledger.commitSource('sessions:test', 0, { baseline: true }, [], 200)
    expect(ledger.page().summary).toMatchObject({ revision: 0, total: 0, unread: 0 })
  })
})
