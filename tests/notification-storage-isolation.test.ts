import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'

describe('notification database isolation', () => {
  it('wires the main notification worker to its own file, not the shared task pool DB', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    expect(source).toContain("new NotificationWorkerPort(createNotificationWorker, join(app.getPath('userData'), 'notifications.sqlite3'))")
    expect(source).not.toContain('new NotificationWorkerPort(createNotificationWorker, databasePath)')
  })
  it('notification transactions remain usable while the business database has a write lock', () => {
    const folder = mkdtempSync(join(tmpdir(), 'sg-notification-isolation-'))
    const business = new DatabaseSync(join(folder, 'task-pool.sqlite3'))
    const notifications = new SqliteNotificationRepository(join(folder, 'notifications.sqlite3'))
    try {
      business.exec('CREATE TABLE business_rows(id INTEGER);BEGIN IMMEDIATE;INSERT INTO business_rows VALUES(1)')
      const saved = notifications.put({ key: 'test:1', category: 'run', source: '运行', title: '完成', attention: 'notice', tone: 'success',
        state: 'resolved', scope: {}, occurredAt: 1, sourceRevision: 1 }, 2)
      expect(saved.changed).toBe(true)
      expect(notifications.page().summary.total).toBe(1)
      business.exec('COMMIT')
      expect(business.prepare('SELECT COUNT(*) AS n FROM business_rows').get()).toMatchObject({ n: 1 })
    } finally { notifications.close(); business.close(); rmSync(folder, { recursive: true, force: true }) }
  })
})
