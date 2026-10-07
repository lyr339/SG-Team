import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { notificationIsPending, notificationIsUnread, type NotificationDraft } from '../src/domain/notification'

const draft = (patch: Partial<NotificationDraft> = {}): NotificationDraft => ({
  key: 'launch:plan-1', category: 'run', source: '批量发起', title: '会话创建完成', tone: 'success',
  attention: 'notice', state: 'resolved', scope: { workspaceId: 'a', runId: 'run-a' }, occurredAt: 100,
  sourceRevision: 1, target: { kind: 'run', runId: 'run-a' }, ...patch
})

describe('notification ledger', () => {
  let folder: string; let path: string; let repository: SqliteNotificationRepository
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'sg-notification-test-')); path = join(folder, 'shared.sqlite'); repository = new SqliteNotificationRepository(path) })
  afterEach(() => { repository.close(); rmSync(folder, { recursive: true, force: true }) })

  it('persists records and suppresses duplicate and out-of-order source events across restarts', () => {
    const first = repository.put(draft(), 200)
    expect(first.summary).toMatchObject({ total: 1, unread: 1, pending: 0 })
    expect(repository.put(draft(), 300).changed).toBe(false)
    repository.close(); repository = new SqliteNotificationRepository(path)
    expect(repository.put(draft({ sourceRevision: 0, title: '旧进度' }), 400).changed).toBe(false)
    expect(repository.page().records[0]?.title).toBe('会话创建完成')
  })
  it('records quiet activity without inventing a read receipt or unread badge', () => {
    const record = repository.put(draft({ attention: 'activity', category: 'sessions' }), 200).record!
    expect(notificationIsUnread(record)).toBe(false)
    expect(record.readAt).toBeUndefined()
    expect(repository.read(record.id, record.revision, 300).changed).toBe(false)
    expect(repository.page().summary.unread).toBe(0)
  })
  it('does not revise or resurrect unread state for same-content source observations', () => {
    const first = repository.put(draft(), 200).record!
    repository.read(first.id, first.revision, 300)
    const revision = repository.page().summary.revision
    const repeated = repository.put(draft({ sourceRevision: 5, occurredAt: 400, renewAttention: true }), 400)
    expect(repeated.changed).toBe(false); expect(repeated.summary.revision).toBe(revision)
    expect(repeated.summary.unread).toBe(0)
    expect(repository.put(draft({ sourceRevision: 4, title: '过期结果' }), 500).changed).toBe(false)
  })
  it('accepts absent optional scope fields and canonicalizes them instead of manufacturing a new result', () => {
    repository.put(draft(), 200)
    expect(repository.put(draft({ sourceRevision: 2, scope: { groupId: undefined, runId: 'run-a', workspaceId: 'a' } }), 300).changed).toBe(false)
    expect(() => repository.put(draft({ scope: { arbitrarySecret: 'not-a-scope' } as never }), 400)).toThrow('作用域无效')
    expect(() => repository.put(draft({ target: { kind: 'url', url: 'javascript:alert(1)' } as never }), 400)).toThrow('目标无效')
  })
  it('redacts credential-shaped diagnostic excerpts before persisting them', () => {
    const saved = repository.put(draft({ detail: 'Bearer secret-123; password=my-password; CTI-00000000000000000000000000000000' }), 200).record!
    expect(saved.detail).not.toContain('secret-123'); expect(saved.detail).not.toContain('my-password'); expect(saved.detail).not.toContain('0000000000000000')
  })
  it('stale reading cannot acknowledge a newer meaningful result', () => {
    const first = repository.put(draft(), 200).record!
    const newer = repository.put(draft({ sourceRevision: 2, title: '部分会话失败', renewAttention: true, tone: 'warning' }), 300).record!
    expect(repository.read(first.id, first.revision, 400).changed).toBe(false)
    expect(repository.read(newer.id, newer.revision, 500).summary.unread).toBe(0)
  })
  it('does not move an event ahead of newer results when the user reads it', () => {
    const first = repository.put(draft(), 200).record!
    const second = repository.put(draft({ key: 'launch:plan-2' }), 300).record!
    repository.read(first.id, first.revision, 400)
    expect(repository.page().records.map(record => record.id)).toEqual([second.id, first.id])
  })
  it('reading and clearing do not resolve or hide pending business actions', () => {
    const action = repository.put(draft({ attention: 'action', state: 'active', title: '请回答问卷' }), 200).record!
    repository.read(action.id, action.revision, 300)
    expect(repository.clearRead({}, 400).changed).toBe(false)
    expect(() => repository.archive(action.id, 500)).toThrow('仍待处理')
    expect(notificationIsPending(repository.page().records[0]!)).toBe(true)
  })
  it('scope filtering includes global updates but does not affect other workspaces', () => {
    repository.put(draft(), 200)
    repository.put(draft({ key: 'other', scope: { workspaceId: 'b' } }), 201)
    repository.put(draft({ key: 'update', category: 'updates', scope: {} }), 202)
    const page = repository.page({ workspaceId: 'a' })
    expect(page.summary.unread).toBe(2)
    repository.readAll({ workspaceId: 'a' }, page.summary.revision, 300)
    expect(repository.page({ workspaceId: 'b' }).summary.unread).toBe(1)
  })
  it('resets pagination on intervening mutations instead of duplicating or skipping old offsets', () => {
    repository.put(draft(), 200); repository.put(draft({ key: 'another' }), 201)
    const page = repository.page({ limit: 1 })
    repository.put(draft({ key: 'third' }), 202)
    const next = repository.page({ limit: 1, cursor: page.nextCursor })
    expect(next.reset).toBe(true); expect(next.records[0]?.key).toBe('third')
  })
  it('cleared history cannot be resurrected by replaying the same source version', () => {
    const record = repository.put(draft(), 200).record!
    repository.read(record.id, record.revision, 300); repository.clearRead({}, 400)
    repository.close(); repository = new SqliteNotificationRepository(path)
    expect(repository.put(draft(), 500).changed).toBe(false)
    expect(repository.marker(draft().key)).toMatchObject({ sourceRevision: 1, cleared: true, signature: expect.any(String) })
    expect(repository.page().summary.total).toBe(0)
    expect(repository.put(draft({ sourceRevision: 2, title: '新的已确认结果' }), 600).changed).toBe(true)
  })
  it('stores preferences safely with quiet, sound and native delivery off by default', () => {
    expect(repository.preferences()).toMatchObject({ enabled: true, nativeEnabled: false, sound: false, quiet: false, preview: false })
    repository.savePreferences({ enabled: false, nativeEnabled: true, sound: false, preview: false, quiet: true, mutedCategories: ['accounts', 'accounts'] })
    repository.close(); repository = new SqliteNotificationRepository(path)
    expect(repository.preferences()).toMatchObject({ enabled: false, quiet: true, mutedCategories: ['accounts'] })
  })
  it('migrates the earlier private notification schema without touching other data or the global version', () => {
    const saved = repository.put(draft(), 200).record!
    repository.read(saved.id, saved.revision, 300)
    repository.close()
    const database = new DatabaseSync(path)
    database.exec(`UPDATE desktop_notification_meta SET schema_version=1;
      ALTER TABLE desktop_notification_tombstones DROP COLUMN content_signature;
      CREATE TABLE preserved_business_state(id INTEGER PRIMARY KEY,value TEXT);
      INSERT INTO preserved_business_state VALUES(1,'preserve');PRAGMA user_version=9;`)
    database.close()
    repository = new SqliteNotificationRepository(path)
    expect(repository.page().summary.unread).toBe(0)
    expect(repository.marker(draft().key).sourceRevision).toBe(1)
    const inspect = new DatabaseSync(path)
    try {
      expect(inspect.prepare('SELECT schema_version FROM desktop_notification_meta').get()).toMatchObject({ schema_version: 8 })
      expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 })
      expect(inspect.prepare('SELECT value FROM preserved_business_state').get()).toMatchObject({ value: 'preserve' })
    } finally { inspect.close() }
  })
})
