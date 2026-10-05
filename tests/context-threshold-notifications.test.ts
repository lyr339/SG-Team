import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ContextThresholdNotifications, contextThresholdObservation } from '../src/application/notifications/context-threshold-notifications'
import { readContextThresholdState } from '../src/domain/context-threshold-notification'
import { notificationSourceHarness, notificationTeam, notificationFrame, notificationSession } from './notification-source-fixtures'
import type { NotificationPush } from '../src/domain/notification'
const now = 10_000
const frame = (ratio: number, patch: Parameters<typeof notificationSession>[0] = {}) =>
  notificationFrame({
    contextUsageSampledAt: now,
    sessions: [
      notificationSession({
        contextUsage: { ratio, used: Math.round(ratio * 100_000), limit: 100_000 },
        contextUsageSource: 'bound',
        contextUsageComposerId: 'composer-a',
        contextUsageModelId: 'native-model-a',
        telemetry: { state: 'bound', detail: 'native' },
        ...patch
      })
    ]
  })
async function settle(h: ReturnType<typeof notificationSourceHarness>, source: ContextThresholdNotifications) {
  await source.flush()
  await h.owner.flush()
}
describe('context thresholds consume only fresh native bound facts', () => {
  it('records one lifecycle, crosses each threshold at most once, has hysteresis and no per-token writes', async () => {
    const h = notificationSourceHarness(),
      source = new ContextThresholdNotifications(h.owner, () => now),
      team = notificationTeam(),
      events: NotificationPush[] = []
    h.owner.subscribe((e) => events.push(e))
    try {
      source.observe(frame(0.4), team)
      await settle(h, source)
      source.observe(frame(0.8), team)
      await settle(h, source)
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
      const first = h.ledger.page().records[0]!
      expect(first.subjectState).toBe('80')
      expect(events.filter((e) => e.announcement)).toHaveLength(1)
      await h.owner.read(first.id, first.revision)
      const commits = vi.mocked(h.port.commitSource).mock.calls.length
      for (const value of [0.81, 0.89, 0.9, 0.91]) source.observe(frame(value), team)
      await settle(h, source)
      expect(vi.mocked(h.port.commitSource).mock.calls.length).toBe(commits)
      source.observe(frame(0.95), team)
      await settle(h, source)
      expect(h.ledger.page().records[0]!.id).toBe(first.id)
      expect(events.filter((e) => e.announcement)).toHaveLength(2)
      source.observe(frame(0.93), team)
      await settle(h, source)
      expect(h.ledger.page().records[0]?.subjectState).toBe('95')
      source.observe(frame(0.91), team)
      await settle(h, source)
      expect(h.ledger.page().records[0]?.subjectState).toBe('80')
      source.observe(frame(0.78), team)
      await settle(h, source)
      expect(h.ledger.page().records[0]?.subjectState).toBe('80')
      source.observe(frame(0.76), team)
      await settle(h, source)
      expect(h.ledger.page().records[0]?.state).toBe('resolved')
      source.observe(frame(0.99), team)
      await settle(h, source)
      expect(events.filter((e) => e.announcement)).toHaveLength(2)
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('unknown/cache/fallback/inconsistent/future/old readings cannot alert or resolve a known high reading', async () => {
    const h = notificationSourceHarness(),
      source = new ContextThresholdNotifications(h.owner, () => now),
      team = notificationTeam()
    try {
      source.observe(frame(0.96), team)
      await settle(h, source)
      const id = h.ledger.page().records[0]!.id
      for (const patch of [
        { contextUsageSource: 'cached' as const },
        { contextUsageSource: 'channel-fallback' as const },
        { contextUsageComposerId: 'other' },
        { contextUsage: { ratio: 0.1, used: 95_000, limit: 100_000 } }
      ]) {
        source.observe(frame(0.1, patch), team)
        await settle(h, source)
        expect(h.ledger.page().records[0]).toMatchObject({ id, subjectState: 'unconfirmed', state: 'active' })
      }
      for (const at of [now - 4_000, now + 1_000, undefined]) {
        source.observe({ ...frame(0.1), contextUsageSampledAt: at }, team)
        await settle(h, source)
        expect(h.ledger.page().records[0]?.subjectState).toBe('unconfirmed')
      }
      source.observe(frame(0.1), team)
      await settle(h, source)
      expect(h.ledger.page().records[0]?.state).toBe('resolved')
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('model/limit domains, new generations and stale topology are isolated; returning to a prior domain never rearms its seen thresholds', async () => {
    const h = notificationSourceHarness(),
      source = new ContextThresholdNotifications(h.owner, () => now),
      team = notificationTeam(),
      events: NotificationPush[] = []
    h.owner.subscribe((e) => events.push(e))
    try {
      source.observe(frame(0.1), team)
      await settle(h, source)
      source.observe(frame(0.96), team)
      await settle(h, source)
      const old = h.ledger.page().records[0]!
      source.observe(frame(0.2, { contextUsageModelId: 'native-model-b' }), team)
      await settle(h, source)
      expect(h.ledger.page().records.find((r) => r.id === old.id)?.state).toBe('expired')
      source.observe(frame(0.96, { contextUsageModelId: 'native-model-b' }), team)
      await settle(h, source)
      source.observe(frame(0.1), team)
      await settle(h, source)
      source.observe(frame(0.96), team)
      await settle(h, source)
      expect(events.filter((e) => e.announcement)).toHaveLength(2)
      const stale = { ...frame(0.2), runtimeScope: { workspaceId: 'wrong', runId: team.activeRun!.id, teamRevision: team.revision } }
      expect(contextThresholdObservation(stale, team, now)).toBeUndefined()
      source.observe(stale, team)
      await settle(h, source)
      expect(h.ledger.page().records.find((r) => r.id === old.id)?.state).toBe('active')
      source.observe(frame(0.1, { generation: 2 }), team)
      await settle(h, source)
      source.observe(frame(0.96, { generation: 2 }), team)
      await settle(h, source)
      expect(events.filter((e) => e.announcement)).toHaveLength(3)
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('hydrate and wake reconstruct current severity quietly, while confirmed end expires only the real scope', async () => {
    const h = notificationSourceHarness(),
      source = new ContextThresholdNotifications(h.owner, () => now),
      team = notificationTeam(),
      events: NotificationPush[] = []
    h.owner.subscribe((e) => events.push(e))
    try {
      source.observe(frame(0.85), team)
      await settle(h, source)
      expect(events.filter((e) => e.announcement)).toHaveLength(0)
      source.suspend()
      source.observe(frame(0.96), team)
      source.resume()
      source.observe(frame(0.96), team)
      await settle(h, source)
      expect(events.filter((e) => e.announcement)).toHaveLength(0)
      expect(h.ledger.page().records[0]?.subjectState).toBe('95')
      source.observe(frame(0.96, { runtimeEvidence: 'stopped', online: false, connected: false }), team)
      await settle(h, source)
      expect(h.ledger.page().records[0]?.state).toBe('expired')
      expect(() => readContextThresholdState({ version: 1, key: 'x', rows: { bad: {} }, active: {} }, 'x')).toThrow()
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
})

describe('durable context-domain histories are not replayed or rearmed', () => {
  it('restores a seen threshold quietly, respects explicit clearing, and permits a new generation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sg-context-notification-')),
      path = join(directory, 'ledger.sqlite'),
      team = notificationTeam()
    try {
      const first = notificationSourceHarness(path),
        source = new ContextThresholdNotifications(first.owner, () => now)
      source.observe(frame(0.1), team)
      await settle(first, source)
      source.observe(frame(0.96), team)
      await settle(first, source)
      const record = first.ledger.page().records[0]!
      await first.owner.read(record.id, record.revision)
      await first.owner.clearRead({ key: record.key })
      await source.close()
      await first.owner.close()
      const restored = notificationSourceHarness(path),
        next = new ContextThresholdNotifications(restored.owner, () => now),
        events: NotificationPush[] = []
      restored.owner.subscribe((e) => events.push(e))
      try {
        next.observe(frame(0.96), team)
        await settle(restored, next)
        next.observe(frame(0.1), team)
        await settle(restored, next)
        next.observe(frame(0.96), team)
        await settle(restored, next)
        expect(restored.ledger.page().summary.total).toBe(0)
        expect(events.some((e) => e.announcement)).toBe(false)
        next.observe(frame(0.1, { generation: 2 }), team)
        await settle(restored, next)
        next.observe(frame(0.96, { generation: 2 }), team)
        await settle(restored, next)
        expect(restored.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
        expect(events.filter((e) => e.announcement)).toHaveLength(1)
      } finally {
        await next.close()
        await restored.owner.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('context source completion and bounded transactions', () => {
  it('an explicitly completed old run is expired after a real scope change, but a workspace switch by itself is not a stop', async () => {
    const h = notificationSourceHarness(),
      source = new ContextThresholdNotifications(h.owner, () => now),
      team = notificationTeam()
    try {
      source.observe(frame(0.96), team)
      await settle(h, source)
      const id = h.ledger.page().records[0]!.id
      const other = notificationTeam()
      other.activeWorkspaceId = 'workspace-b'
      other.activeRun = { ...other.activeRun!, id: 'run-b', workspaceId: 'workspace-b' }
      other.runs = [team.activeRun!, other.activeRun]
      other.bindings = []
      other.members = []
      const empty = notificationFrame({
        sessions: [],
        runtimeScope: { workspaceId: other.activeWorkspaceId, runId: other.activeRun.id, teamRevision: other.revision }
      })
      source.observe(empty, other)
      await settle(h, source)
      expect(h.ledger.page().records.find((r) => r.id === id)?.state).toBe('active')
      source.observe(frame(0.96), team)
      await settle(h, source)
      other.runs = [{ ...team.activeRun!, status: 'completed' }, other.activeRun]
      source.observe(empty, other)
      await settle(h, source)
      expect(h.ledger.page().records.find((r) => r.id === id)?.state).toBe('expired')
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('a long run with more than 100 alert identities closes in batches without truncating history', async () => {
    const { reduceContextThresholdNotifications } = await import('../src/domain/context-threshold-notification')
    const h = notificationSourceHarness(),
      key = 'context-long-test'
    let state: ReturnType<typeof reduceContextThresholdNotifications>['state'] | undefined
    for (let i = 0; i < 220; i++) {
      const identity = i.toString(16).padStart(64, '0'),
        domainKey = (i + 1).toString(16).padStart(64, '0')
      state = reduceContextThresholdNotifications(
        state,
        {
          key,
          completed: false,
          now,
          facts: [
            {
              identity,
              scope: { sessionId: `session-${i}`, generation: '1', channelId: String(i + 1) },
              name: `成员 ${i}`,
              domain: '[null,100000]',
              domainKey,
              zone: 'critical',
              ended: false
            }
          ]
        },
        true,
        1
      ).state
    }
    let count = 0,
      batches = 0
    do {
      const next = reduceContextThresholdNotifications(state, { key, completed: true, now, facts: [] }, false, ++batches)
      expect(next.drafts.length).toBeLessThanOrEqual(100)
      count += next.drafts.length
      state = next.state
      if (next.complete) break
    } while (batches < 10)
    expect(count).toBe(220)
    expect(batches).toBe(3)
    expect(Object.values(state!.rows).every((row) => row.status === 'expired')).toBe(true)
    await h.owner.close()
  })
})
