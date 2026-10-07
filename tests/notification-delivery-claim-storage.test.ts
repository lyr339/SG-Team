import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { deliveryHash, notificationDeliveryIdentity } from '../src/application/notification-delivery-identity'
import type { NotificationDeliveryClaim } from '../src/domain/notification-delivery-claim'
import type { NotificationPush } from '../src/domain/notification'
import { persistNotificationFixture } from './notification-source-fixtures'

const roots: string[] = [], at = 1_000_000
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'sg-delivery-claims-')); roots.push(root); return join(root, 'private.sqlite') }
const candidate = (id = 'signal:1', body = 'original'): NotificationDeliveryClaim => ({ signalHash: deliveryHash(id), contentHash: deliveryHash(body), expiresAt: at + 60_000 })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('private indexed delivery tombstones', () => {
  it('keeps exact claims after many events, reopening, clearing and clock rollback; a genuinely different captured result can use a reused signal', () => {
    const path = setup(); let repository = new SqliteNotificationRepository(':memory:')
    try {
      const first = candidate(); expect(repository.claimDelivery(first, at)).toBe(true)
      for (let index = 0; index < 2_048; index++) expect(repository.claimDelivery(candidate(`other:${index}`), at)).toBe(true)
      expect(repository.claimDelivery(first, at)).toBe(false)
      expect(repository.claimDelivery({ ...first, expiresAt: at + 120_000 }, at)).toBe(false)
      repository.pruneRoutine(at + 60 * 24 * 60 * 60_000)
      repository.clearRead({}, at + 60 * 24 * 60 * 60_000)
      persistNotificationFixture(repository, path)
      repository.close(); repository = new SqliteNotificationRepository(path)
      expect(repository.claimDelivery(first, at - 1)).toBe(false)
      expect(repository.claimDelivery(candidate('signal:1', 'different native body'), at)).toBe(true)
      expect(repository.page().summary.total).toBe(0)
    } finally { repository.close() }
  })
  it('imports legacy ID-only evidence once without inventing old body hashes, deadlines, timestamps or rewriting the checkpoint', () => {
    const path = setup(); let repository = new SqliteNotificationRepository(path)
    const old = { version: 1, ids: ['legacy:known', 'legacy:second'] }
    repository.commitSource('notification-delivery:v1', 0, old, [], at)
    repository.close()
    const prior = new DatabaseSync(path)
    prior.exec('DROP TABLE desktop_notification_delivery_claims; ALTER TABLE desktop_notification_meta DROP COLUMN legacy_delivery_imported; UPDATE desktop_notification_meta SET schema_version=8; PRAGMA user_version=57; CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES(\'original\');')
    prior.close(); repository = new SqliteNotificationRepository(path)
    try {
      expect(repository.claimDelivery(candidate('legacy:known'), at)).toBe(false)
      expect(repository.claimDelivery(candidate('legacy:known', 'unproven other historical body'), at)).toBe(false)
      expect(repository.claimDelivery(candidate('fresh'), at)).toBe(true)
      expect(repository.sourceState('notification-delivery:v1')).toEqual({ revision: 1, data: old })
      const inspect = new DatabaseSync(path)
      try {
        expect(inspect.prepare('SELECT schema_version,legacy_delivery_imported FROM desktop_notification_meta').get()).toMatchObject({ schema_version: 9, legacy_delivery_imported: 1 })
        expect(inspect.prepare('SELECT content_hash,claimed_at FROM desktop_notification_delivery_claims WHERE signal_hash=?').get(deliveryHash('legacy:known'))).toMatchObject({ content_hash: '', claimed_at: null })
        expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(57)
        expect(inspect.prepare('SELECT value FROM preserved').get()!.value).toBe('original')
        expect(JSON.stringify(inspect.prepare('SELECT * FROM desktop_notification_delivery_claims').all())).not.toContain('legacy:known')
      } finally { inspect.close() }
    } finally { repository.close() }
  })
  it('corrupt legacy claims fail the claim transaction without losing readable history or partially marking migration complete', () => {
    const path = setup(), repository = new SqliteNotificationRepository(path)
    try {
      repository.put({ key: 'visible', source: '原结果', title: '仍然可查看', category: 'automation', scope: {}, tone: 'success', attention: 'notice', state: 'resolved', occurredAt: at, sourceRevision: 1 }, at)
      repository.commitSource('notification-delivery:v1', 0, { version: 1, ids: ['valid', 42] }, [], at)
      expect(() => repository.claimDelivery(candidate(), at)).toThrow('旧提醒送达记录异常')
      expect(repository.page().records[0]!.title).toBe('仍然可查看')
      const inspect = new DatabaseSync(path)
      try {
        expect(inspect.prepare('SELECT COUNT(*) AS n FROM desktop_notification_delivery_claims').get()!.n).toBe(0)
        expect(inspect.prepare('SELECT legacy_delivery_imported AS n FROM desktop_notification_meta').get()!.n).toBe(0)
      } finally { inspect.close() }
    } finally { repository.close() }
  })
  it('refuses expired/invalid claims and already-current schemas missing claim evidence, rather than recreating an empty dedupe index', () => {
    const path = setup(), repository = new SqliteNotificationRepository(path)
    try {
      expect(repository.claimDelivery(candidate(), at + 60_000)).toBe(false)
      expect(() => repository.claimDelivery({ ...candidate(), contentHash: 'body plaintext' }, at)).toThrow('身份无效')
      expect(() => repository.claimDelivery(candidate(), NaN)).toThrow('身份无效')
      expect(repository.claimDelivery(candidate(), at)).toBe(true)
    } finally { repository.close() }
    const broken = new DatabaseSync(path); broken.exec('DROP TABLE desktop_notification_delivery_claims'); broken.close()
    expect(() => new SqliteNotificationRepository(path)).toThrow('送达结构异常')
    const inspect = new DatabaseSync(path)
    try { expect(inspect.prepare("SELECT 1 FROM sqlite_master WHERE name='desktop_notification_delivery_claims'").get()).toBeUndefined() }
    finally { inspect.close() }
  })
  it('two actual connections elect only one winner for the same candidate', () => {
    const path = setup(), first = new SqliteNotificationRepository(path), second = new SqliteNotificationRepository(path)
    try { expect(first.claimDelivery(candidate(), at)).toBe(true); expect(second.claimDelivery(candidate(), at)).toBe(false) }
    finally { first.close(); second.close() }
  })
  it('derives identity from captured content, not read flags, badge counts or an extended opportunity deadline', () => {
    const path = setup(), repository = new SqliteNotificationRepository(path)
    try {
      const change = repository.put({ key: 'captured', source: '原结果', title: '原始正文', category: 'automation', scope: { workspaceId: 'a' }, tone: 'success', attention: 'notice', state: 'resolved', occurredAt: at, sourceRevision: 1 }, at)
      const event: NotificationPush = { health: 'ready', historyIncomplete: false, change, announcement: { id: 'captured:1', expiresAt: at + 60_000 } }
      const first = notificationDeliveryIdentity(event)!
      const altered = notificationDeliveryIdentity({ ...event, change: { ...change, summary: { ...change.summary, unread: 0 }, record: { ...change.record!, readRevision: 1, readAt: at + 3 } }, announcement: { ...event.announcement!, expiresAt: at + 90_000 } })!
      expect(altered.contentHash).toBe(first.contentHash)
      expect(notificationDeliveryIdentity({ ...event, change: { ...change, record: { ...change.record!, detail: '不同原始正文' } } })!.contentHash).not.toBe(first.contentHash)
      expect(notificationDeliveryIdentity({ ...event, change: { ...change, record: { ...change.record!, scope: { workspaceId: 'b' } } } })!.contentHash).not.toBe(first.contentHash)
    } finally { repository.close() }
  })
})
