import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_AUTOMATION_STEPS, type AccountAutomationRun } from '../src/domain/account-automation'
import { connectAutomationNotifications } from '../src/application/notifications/automation-notifications'
import { NotificationService } from '../src/application/notification-service'
import type { NotificationRepository } from '../src/application/notification-repository'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import type { NotificationPush } from '../src/domain/notification'

const running = (): AccountAutomationRun => ({ operationId: 'test-operation', revision: 1, planId: 'real-plan', scope: { workspaceId: 'original-workspace', runId: 'original-run' },
  phase: 'countdown', message: '5 seconds', startedAt: 100, remainingSec: 5, processingProvider: 'aozai',
  observations: Object.fromEntries(ACCOUNT_AUTOMATION_STEPS.map(key => [key, { status: key === 'prepare' ? 'running' : 'not_started' }])) as NonNullable<AccountAutomationRun['observations']> })
function harness() {
  const ledger = new SqliteNotificationRepository(':memory:')
  const port: NotificationRepository = { marker: async key => ledger.marker(key), sourceState: async key => ledger.sourceState(key), commitSource: async (key, revision, data, drafts, now) => ledger.commitSource(key, revision, data, drafts, now),
    put: async (draft, now) => ledger.put(draft, now), page: async query => ledger.page(query), read: async (id, revision, now) => ledger.read(id, revision, now), readAll: async (query, revision, now) => ledger.readAll(query, revision, now),
    archive: async (id, now) => ledger.archive(id, now), clearRead: async (query, now) => ledger.clearRead(query, now), preferences: async () => ledger.preferences(), savePreferences: async value => ledger.savePreferences(value), close: async () => ledger.close() }
  const owner = new NotificationService(port, () => 500)
  let current: AccountAutomationRun = { phase: 'idle', message: '', startedAt: 0 }; let listener!: (value: AccountAutomationRun) => void
  const source = { getRun: () => current, subscribe: (callback: typeof listener) => { listener = callback; return () => {} } }
  const events: NotificationPush[] = []; owner.subscribe(value => events.push(value))
  return { ledger, owner, source, events, emit: (value: AccountAutomationRun) => { current = value; listener(value) } }
}
describe('automation observation to durable notifications', () => {
  it('ticks do not write or announce; one attempt receives one terminal result and late child changes stay in it', async () => {
    const h = harness(); const stop = connectAutomationNotifications(h.source, h.owner, () => 500)
    try {
      const first = running(); h.emit(first); await h.owner.flush()
      const before = h.ledger.page().summary.revision
      for (let revision = 2; revision < 12; revision++) h.emit({ ...first, revision, remainingSec: 6 - revision / 2, message: `tick ${revision}` })
      await h.owner.flush(); expect(h.ledger.page().summary.revision).toBe(before)
      const done = { ...first, phase: 'done' as const, revision: 12, finishedAt: 300,
        observations: Object.fromEntries(ACCOUNT_AUTOMATION_STEPS.map(key => [key, { status: key === 'cleanup' ? 'unknown' : key === 'handover' || key === 'refresh' ? 'skipped' : 'succeeded' }])) as NonNullable<AccountAutomationRun['observations']> }
      h.emit(done); await h.owner.flush(); const id = h.ledger.page().records[0]!.id
      expect(h.ledger.page().records[0]!.title).toContain('清场结果待确认')
      h.emit({ ...done, revision: 13, observations: { ...done.observations, cleanup: { status: 'succeeded' } } }); await h.owner.flush()
      expect(h.ledger.page().records[0]!.id).toBe(id); expect(h.ledger.page().summary.total).toBe(1)
      expect(h.ledger.page().records[0]!.title).toBe('自动化已完成')
      expect(h.events.filter(event => event.announcement)).toHaveLength(2)
      h.emit({ ...done, revision: 11 }); await h.owner.flush()
      expect(h.ledger.page().records[0]!.title).toBe('自动化已完成')
    } finally { stop(); await h.owner.close() }
  })
  it('a previous unended attempt becomes pending verification, not automatic replay or a made-up result', async () => {
    const h = harness()
    h.ledger.put({ key: 'automation:old-attempt', eventType: 'automation.running', category: 'automation', source: '自动化', title: '进行中', tone: 'info', attention: 'activity', state: 'active',
      scope: { workspaceId: 'old-workspace' }, occurredAt: 1, sourceRevision: 1 }, 2)
    const stop = connectAutomationNotifications(h.source, h.owner, () => 500)
    try {
      await vi.waitFor(() => expect(h.ledger.page().records[0]!.eventType).toBe('automation.interrupted'))
      expect(h.ledger.page().records[0]!.title).toBe('上次自动化结果待核对')
      expect(h.events.some(event => event.announcement)).toBe(false)
    } finally { stop(); await h.owner.close() }
  })
  it('a terminal main flow with a missing child receipt is reconciled on restart without rerunning or erasing confirmed effects', async () => {
    const h = harness()
    h.ledger.put({ key: 'automation:old-terminal', eventType: 'automation.unconfirmed', category: 'automation', source: '自动化', title: 'Cursor 接手待确认', tone: 'warning', attention: 'notice', state: 'active',
      scope: { workspaceId: 'old-workspace' }, detail: '处理：已确认完成\nCursor 接手：结果待确认', occurredAt: 1, sourceRevision: 1 }, 2)
    const stop = connectAutomationNotifications(h.source, h.owner, () => 500)
    try {
      await vi.waitFor(() => expect(h.ledger.page().records[0]!.eventType).toBe('automation.interrupted'))
      expect(h.ledger.page().records[0]!.title).toBe('上次自动化有未确认的步骤结果')
      expect(h.ledger.page().records[0]!.detail).toContain('处理：已确认完成')
      expect(h.events.some(event => event.announcement)).toBe(false)
    } finally { stop(); await h.owner.close() }
  })
})
