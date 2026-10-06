import { it, expect } from 'vitest'
import { NotificationCenterProjection } from '../src/renderer/src/notifications/notification-center-projection'
import type { NotificationPage, NotificationRecord, NotificationPush } from '../src/domain/notification'
const row = (id: string, patch: Partial<NotificationRecord> = {}): NotificationRecord => ({ id, key: id, category: 'run', source: 'fixture', title: id, scope: { workspaceId: 'a' }, tone: 'info', attention: 'notice', state: 'resolved',
  occurredAt: 1, sourceRevision: 1, revision: 1, attentionRevision: 1, readRevision: 0, createdAt: 1, updatedAt: 1, ...patch })
const page = (records: NotificationRecord[], revision = 10): NotificationPage => ({ records, summary: { revision, total: 40, unread: 40, pending: 0, clearable: 0 }, reset: false })
const event = (record: NotificationRecord, revision: number): NotificationPush => ({ health: 'ready', historyIncomplete: false, change: { changed: true, record, summary: { revision, total: 40, unread: 39, pending: 0, clearable: 1 } } })
it('a duplicate read RPC/push has one delta, including reads of previous pages omitted from a late result', () => {
  const model = new NotificationCenterProjection(), first = row('first'), second = row('second'), read = { ...first, readRevision: 1 }
  model.observe(event(read, 11), [first]); model.observe(event(read, 11), [read])
  const merged = model.merge(page([second]), page([read]), true, 11)
  expect(merged.page.summary.unread).toBe(39); expect(merged.page.summary.clearable).toBe(1); expect(merged.page.records[0]?.readRevision).toBe(1); expect(merged.dirty).toBe(false)
})
it('outside-workspace changes are proven irrelevant, but unknown/missing revision steps cannot fake exact scoped counts', () => {
  const model = new NotificationCenterProjection(); model.reset({ workspaceId: 'a' })
  model.observe(event(row('other', { scope: { workspaceId: 'b' } }), 11), [])
  expect(model.merge(page([]), undefined, false, 11).dirty).toBe(false)
  model.observe(event(row('unknown-row'), 12), [])
  expect(model.merge(page([]), undefined, false, 12).dirty).toBe(true)
  expect(model.merge(page([]), undefined, false, 12).page.summary.unread).toBe(40)
})
it('a bounded revision cache stays conservative beyond its exact coverage and generation reset cannot reuse old reads', () => {
  const model = new NotificationCenterProjection(), original = row('row'), read = { ...original, readRevision: 1 }
  for (let version = 11; version < 311; version++) model.observe(event(read, version), [original])
  expect(model.merge(page([original]), undefined, false, 310).dirty).toBe(true)
  model.changeStorage(1)
  expect(model.merge({ ...page([{ ...original, storageEpoch: 1 }], 1), storageEpoch: 1 }, undefined, false, 1).page.records[0]?.readRevision).toBe(0)
})
