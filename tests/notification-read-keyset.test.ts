import { it, expect } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import type { NotificationDraft } from '../src/domain/notification'
const draft = (key: string): NotificationDraft => ({ key, eventType: 'session.reply', category: 'sessions', source: 'fixture', title: key, scope: { sessionId: 'session', generation: '1' },
  target: { kind: 'session', scope: { sessionId: 'session', generation: '1' }, entryId: key }, tone: 'info', attention: 'notice', state: 'resolved', sourceRevision: 1, occurredAt: 1 })
it('a shrinking unread set and advancing global read counters cannot skip or restart keyset traversal of 431 exact private records', () => {
  const ledger = new SqliteNotificationRepository(':memory:')
  try {
    for (let index = 0; index < 431; index++) ledger.put(draft(`reply-${index}`), 1)
    let page = ledger.page({ sessionId: 'session', filter: 'unread', readCursor: 'start', limit: 37 })
    const ids = new Set<string>(), ceiling = page.nextReadCursor!.ceiling
    let pages = 0
    for (;;) {
      ++pages; expect(page.reset).toBe(false)
      for (const record of page.records) { expect(ids.has(record.id)).toBe(false); ids.add(record.id); ledger.read(record.id, record.revision, 2) }
      if (!page.nextReadCursor) break
      expect(page.nextReadCursor.ceiling).toBe(ceiling)
      page = ledger.page({ sessionId: 'session', filter: 'unread', readCursor: page.nextReadCursor, limit: 37 })
    }
    expect(pages).toBe(12); expect(ids.size).toBe(431); expect(ledger.page().summary.unread).toBe(0)
  } finally { ledger.close() }
})
it('the first source ceiling bounds new business versions; later results do not move the cursor, and an old visible receipt cannot clear a newer attention version', () => {
  const ledger = new SqliteNotificationRepository(':memory:')
  try {
    for (let index = 0; index < 150; index++) ledger.put(draft(`reply-${index}`), 1)
    const first = ledger.page({ filter: 'unread', readCursor: 'start', limit: 100 })
    const old = ledger.page({ key: 'reply-0' }).records[0]!
    const changed = ledger.put({ ...draft('reply-0'), title: 'new original result', sourceRevision: 2, renewAttention: true }, 2).record!
    ledger.put(draft('new-live'), 2)
    const second = ledger.page({ filter: 'unread', readCursor: first.nextReadCursor, limit: 100 })
    expect(second.records).toHaveLength(49); expect(second.records.some(record => record.key === 'reply-0' || record.key === 'new-live')).toBe(false)
    expect(ledger.read(changed.id, old.revision, 3).changed).toBe(false)
    expect(ledger.page({ key: 'reply-0' }).summary.unread).toBe(1)
  } finally { ledger.close() }
})
it('readCursor validation and a private global-counter rewind reset do not change ordinary center offset/reset semantics', () => {
  const ledger = new SqliteNotificationRepository(':memory:')
  try {
    ledger.put(draft('first'), 1); ledger.put(draft('second'), 1)
    for (const cursor of [null, 'wrong', { revision: 2, ceiling: 1, id: 'x' }, { revision: -1, ceiling: 1, id: 'x' }]) expect(() => ledger.page({ readCursor: cursor as never })).toThrow()
    expect(() => ledger.page({ cursor: { revision: 1, offset: 0 }, readCursor: 'start' })).toThrow()
    const reset = ledger.page({ readCursor: { revision: 2, id: 'old-record', ceiling: 300 }, limit: 1 })
    expect(reset.reset).toBe(true); expect(reset.nextReadCursor?.ceiling).toBe(2)
    const old = ledger.page({ limit: 1 }); ledger.put(draft('third'), 1)
    const ordinary = ledger.page({ limit: 1, cursor: old.nextCursor })
    expect(ordinary.reset).toBe(true); expect(ordinary.records[0]?.key).toBe('third'); expect(ordinary.nextReadCursor).toBeUndefined()
  } finally { ledger.close() }
})
