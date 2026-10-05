import { describe, expect, it } from 'vitest'
import { WorkspaceNotifications } from '../src/application/notifications/workspace-notifications'
import { notificationSourceHarness } from './notification-source-fixtures'
import type { CursorWorkspaceDetection } from '../src/domain/cursor-workspace'
import type { NotificationPush } from '../src/domain/notification'
const found = (id: string, at: number): CursorWorkspaceDetection => ({
  state: 'detected',
  workspace: { id, name: `工程 ${id}`, path: '/never-retain/local/path' },
  candidates: [],
  detail: 'native',
  observedAt: at
})
const missing = (at: number, cause: CursorWorkspaceDetection['cause'] = 'no-folder'): CursorWorkspaceDetection => ({
  state: 'unavailable',
  cause,
  candidates: [],
  detail: 'raw text does not own outcome',
  observedAt: at
})
describe('workspace observer reuses actual probes and never mutates running scope', () => {
  it('tracks meaningful identity changes quietly, ignores late older probes and drops no existing session/run', async () => {
    const h = notificationSourceHarness(),
      source = new WorkspaceNotifications(h.owner),
      events: NotificationPush[] = []
    h.owner.subscribe((e) => events.push(e))
    try {
      source.begin().complete(found('A', 100))
      await source.flush()
      const old = source.begin(),
        latest = source.begin()
      latest.complete(found('B', 200))
      old.complete(found('A', 300))
      await source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 2, unread: 0, pending: 0 })
      expect(h.ledger.page().records[0]?.detail).toContain('工程 B')
      expect(JSON.stringify(h.ledger.page())).not.toContain('/never-retain')
      source.begin().complete(found('B', 400))
      await source.flush()
      expect(h.ledger.page().summary.total).toBe(2)
      expect(events.some((e) => e.announcement)).toBe(false)
      expect(h.ledger.page().records.every((r) => !r.scope.sessionId && !r.scope.runId)).toBe(true)
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('does not turn a transient or startup missing workspace into a failure storm; repeated original negative evidence enters one issue', async () => {
    const h = notificationSourceHarness(),
      source = new WorkspaceNotifications(h.owner)
    try {
      source.begin().complete(missing(100))
      source.begin().complete(missing(4000))
      await source.flush()
      expect(h.ledger.page().summary.total).toBe(0)
      source.begin().complete(found('A', 5000))
      await source.flush()
      source.begin().complete(missing(6000))
      await source.flush()
      expect(h.ledger.page().summary.unread).toBe(0)
      source.begin().complete(missing(9500))
      await source.flush()
      expect(h.ledger.page().summary.unread).toBe(1)
      source.begin().complete(missing(12000))
      await source.flush()
      expect(h.ledger.page().summary.total).toBe(2)
      source.begin().complete(found('B', 13000))
      await source.flush()
      expect(h.ledger.page().records.find((r) => r.key === 'workspace-issue:1')).toMatchObject({ state: 'resolved', subjectState: 'confirmed' })
      expect(h.ledger.page().records.find((r) => r.key === 'workspace-issue:1')?.detail).toContain('不是会话恢复')
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('seals pending results at quit, and detached old callbacks cannot create another history row', async () => {
    const h = notificationSourceHarness(),
      source = new WorkspaceNotifications(h.owner)
    const observation = source.begin()
    await source.close()
    observation.complete(found('A', 100))
    await h.owner.flush()
    expect(h.ledger.page().summary.total).toBe(0)
    await h.owner.close()
  })
})
