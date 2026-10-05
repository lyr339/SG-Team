import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { SqliteNotificationRepository, notificationSqliteIsBusy, notificationTransactionMayRetry } from '../src/infrastructure/notifications/sqlite-notification-repository'
import type { NotificationDraft } from '../src/domain/notification'

const draft: NotificationDraft = { key: 'fixture:write', category: 'run', source: '验收', title: '已确认的结果', attention: 'notice', state: 'resolved', tone: 'success', scope: {}, occurredAt: 1, sourceRevision: 1 }
const busy = () => Object.assign(Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
function harness() {
  const repository = new SqliteNotificationRepository(':memory:'), db = Reflect.get(repository, 'db') as DatabaseSync, exec = db.exec.bind(db)
  return { repository, db, exec }
}
describe('SQLite lock retry permission requires a confirmed negative boundary', () => {
  it('real typed BUSY/LOCKED and extended codes are distinguished from wording or non-lock SQL errors', () => {
    expect(notificationSqliteIsBusy(busy())).toBe(true)
    expect(notificationSqliteIsBusy(Object.assign(Error('busy snapshot'), { code: 'ERR_SQLITE_ERROR', errcode: 517 }))).toBe(true)
    expect(notificationSqliteIsBusy(Error('database locked SQLITE_BUSY'))).toBe(false)
    expect(notificationSqliteIsBusy(Object.assign(Error('database locked'), { code: 'ERR_SQLITE_ERROR', errcode: 11 }))).toBe(false)
    expect(notificationTransactionMayRetry(busy())).toBe(false)
  })
  it('BEGIN failure never mutates, and does not require rewriting the original (possibly frozen) error', () => {
    const h = harness(), error = Object.freeze(busy()), spy = vi.spyOn(h.db, 'exec').mockImplementationOnce(() => { throw error })
    try { expect(() => h.repository.put(draft, 1)).toThrow(error); expect(notificationTransactionMayRetry(error)).toBe(true); expect(h.repository.marker(draft.key).sourceRevision).toBe(0) }
    finally { spy.mockRestore(); h.repository.close() }
  })
  it('COMMIT failure grants retry only after rollback actually returned; the draft and source were not committed', () => {
    const h = harness(), error = busy(), spy = vi.spyOn(h.db, 'exec').mockImplementation(sql => { if (sql === 'COMMIT') throw error; h.exec(sql) })
    try {
      expect(() => h.repository.commitSource('fixture:source', 0, { version: 1 }, [draft], 1)).toThrow(error)
      expect(notificationTransactionMayRetry(error)).toBe(true); expect(h.repository.marker(draft.key).sourceRevision).toBe(0)
      expect(h.repository.sourceState('fixture:source').revision).toBe(0)
    } finally { spy.mockRestore(); h.repository.close() }
  })
  it('failed rollback leaves outcome unknown and cannot be turned into retryable by an error-text regex', () => {
    const h = harness(), error = busy(), spy = vi.spyOn(h.db, 'exec').mockImplementation(sql => {
      if (sql === 'COMMIT') throw error
      if (sql === 'ROLLBACK') throw Error('rollback not confirmed')
      h.exec(sql)
    })
    try { expect(() => h.repository.put(draft, 1)).toThrow(error); expect(notificationTransactionMayRetry(error)).toBe(false) }
    finally { spy.mockRestore(); h.db.exec('ROLLBACK'); h.repository.close() }
  })
  it('matching wording alone is not permission even when a rollback was confirmed', () => {
    const h = harness(), error = Error('database locked SQLITE_BUSY'), spy = vi.spyOn(h.db, 'exec').mockImplementation(sql => { if (sql === 'COMMIT') throw error; h.exec(sql) })
    try { expect(() => h.repository.put(draft, 1)).toThrow(error); expect(notificationTransactionMayRetry(error)).toBe(false) }
    finally { spy.mockRestore(); h.repository.close() }
  })
})
