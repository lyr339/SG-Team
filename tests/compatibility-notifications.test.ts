import { describe, expect, it, vi } from 'vitest'
import { CompatibilityNotifications } from '../src/application/notifications/compatibility-notifications'
import { notificationSourceHarness } from './notification-source-fixtures'
import type { CursorCompatibilityObservation } from '../src/domain/cursor-compatibility-notification'
import type { NotificationPush } from '../src/domain/notification'
const installationId = '1'.repeat(64)
const valid = (patch: Partial<CursorCompatibilityObservation> = {}): CursorCompatibilityObservation => ({
  installationId,
  version: '3.21.12',
  compatibility: 'supported',
  patch: 'installed',
  profileRefreshReady: true,
  ...patch
})
describe('version and capability facts are not installer execution', () => {
  it('separates version/capability/profile checks, updates one issue, and treats unknown as unknown not loss of patch', async () => {
    const h = notificationSourceHarness(),
      source = new CompatibilityNotifications(h.owner, () => 10000),
      events: NotificationPush[] = []
    h.owner.subscribe((e) => events.push(e))
    try {
      source.begin().complete(valid())
      await source.flush()
      expect(h.ledger.page().summary.total).toBe(0)
      source.begin().complete(valid({ patch: 'unsupported' }))
      await source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe('capability')
      expect(events.filter((e) => e.announcement)).toHaveLength(1)
      const id = h.ledger.page().records[0]!.id
      source.begin().complete(valid({ compatibility: 'unavailable', patch: 'unavailable', version: undefined }))
      await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ id, subjectState: 'unconfirmed', state: 'active' })
      expect(h.ledger.page().records[0]?.detail).toContain('不据此认定补丁已丢失')
      source.begin().complete(valid({ profileRefreshReady: false }))
      await source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe('profile')
      source.begin().complete(valid({ patch: 'not-installed' }))
      await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ id, state: 'resolved' })
      expect(h.ledger.page().records[0]?.detail).toContain('不代表无感切换已经可用')
      expect(events.filter((e) => e.announcement)).toHaveLength(1)
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('new versions are quiet facts, unsupported startup stays actionable in center, stale old inspections cannot overwrite a newer installation', async () => {
    const h = notificationSourceHarness(),
      source = new CompatibilityNotifications(h.owner, () => 10000),
      events: NotificationPush[] = []
    h.owner.subscribe((e) => events.push(e))
    try {
      source.begin().complete(valid({ version: '3.99.0', compatibility: 'unsupported', patch: 'unsupported' }))
      await source.flush()
      expect(h.ledger.page().summary.unread).toBe(1)
      expect(events.some((e) => e.announcement)).toBe(false)
      const stale = source.begin(),
        latest = source.begin()
      latest.complete(valid())
      stale.complete(valid({ version: '3.99.0', compatibility: 'unsupported', patch: 'unsupported' }))
      await source.flush()
      expect(h.ledger.page().records.find((r) => r.eventType === 'cursor.version')?.attention).toBe('activity')
      expect(h.ledger.page().records.find((r) => r.eventType === 'cursor.compatibility')?.state).toBe('resolved')
      const commits = vi.mocked(h.port.commitSource).mock.calls.length
      source.begin().complete(valid())
      await source.flush()
      expect(vi.mocked(h.port.commitSource).mock.calls.length).toBe(commits)
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
  it('unidentified installation recovery does not repair a different known installation', async () => {
    const h = notificationSourceHarness(),
      source = new CompatibilityNotifications(h.owner, () => 10000)
    try {
      source.begin().complete(valid({ compatibility: 'unsupported', patch: 'unsupported', version: '3.99.0' }))
      await source.flush()
      source.begin().complete({ compatibility: 'unavailable', patch: 'unavailable' })
      await source.flush()
      source.begin().complete(valid({ installationId: '2'.repeat(64) }))
      await source.flush()
      expect(h.ledger.page().records.find((r) => r.scope.installationId === installationId)?.state).toBe('active')
      expect(h.ledger.page().records.find((r) => r.key.includes('unidentified'))?.state).toBe('resolved')
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
})
