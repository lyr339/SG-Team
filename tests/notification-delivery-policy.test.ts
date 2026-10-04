import { describe, expect, it } from 'vitest'
import { notificationDeliveryRoute, notificationIsQuiet, notificationNativeContent, notificationQuietBoundary } from '../src/domain/notification-delivery-policy'
import { normalizeNotificationPreferences, type NotificationPush, type NotificationRecord } from '../src/domain/notification'

const at = new Date(2026, 9, 5, 14, 0).getTime()
const record: NotificationRecord = { key: 'result:1', id: 'notice:1', category: 'automation', title: '自动化已结束', detail: '真实完成的步骤保留', source: '自动化', scope: { sessionId: 'sg-channel:1', generation: '1', composerId: 'composer-a', bindingGeneration: 'binding-a' },
  tone: 'success', attention: 'notice', state: 'resolved', occurredAt: at, createdAt: at, updatedAt: at, sourceRevision: 1, revision: 1, attentionRevision: 1, readRevision: 0 }
const announcement: NonNullable<NotificationPush['announcement']> = { id: 'notice:1:1', expiresAt: at + 60_000 }
const prefs = (patch: Record<string, unknown> = {}) => normalizeNotificationPreferences(patch)
describe('quiet delivery policy, not workflow status policy', () => {
  it('default is one in-app opportunity with native/sound/preview/extra dynamics off', () => {
    expect(prefs()).toMatchObject({ nativeEnabled: false, sound: false, preview: false, connectionUpdates: false, replyUpdates: false, quietHours: { enabled: false } })
    expect(notificationDeliveryRoute(record, announcement, prefs(), { foreground: false, nativeSupported: true, now: at })).toBe('in-app')
    expect(notificationDeliveryRoute(record, announcement, prefs({ nativeEnabled: true }), { foreground: false, nativeSupported: true, now: at })).toBe('native')
    expect(notificationDeliveryRoute(record, announcement, prefs({ nativeEnabled: true }), { foreground: true, nativeSupported: true, now: at })).toBe('in-app')
  })
  it('per-channel categories do not silently disable each other or erase human records', () => {
    const current = prefs({ nativeEnabled: true, inAppMutedCategories: ['automation'] })
    expect(notificationDeliveryRoute(record, announcement, current, { foreground: false, nativeSupported: true, now: at })).toBe('native')
    expect(notificationDeliveryRoute(record, announcement, current, { foreground: true, nativeSupported: true, now: at })).toBe('none')
    expect(notificationDeliveryRoute(record, announcement, prefs({ nativeEnabled: true, nativeMutedCategories: ['automation'] }), { foreground: false, nativeSupported: true, now: at })).toBe('in-app')
    expect(notificationDeliveryRoute(record, announcement, prefs({ nativeEnabled: true, mutedCategories: ['automation'] }), { foreground: false, nativeSupported: true, now: at })).toBe('none')
    expect(record.readRevision).toBe(0)
  })
  it('a new CH generation/binding cannot inherit another session quiet/focus override', () => {
    const quiet = prefs({ nativeEnabled: true, sessionPreferences: [{ scope: record.scope, mode: 'quiet' }] })
    expect(notificationDeliveryRoute(record, announcement, quiet, { foreground: true, nativeSupported: true, now: at })).toBe('none')
    const replacement = { ...record, scope: { ...record.scope, composerId: 'composer-b', generation: '2', bindingGeneration: 'binding-b' } }
    expect(notificationDeliveryRoute(replacement, announcement, quiet, { foreground: false, nativeSupported: true, now: at })).toBe('native')
  })
  it('opt-in life/reply signals never manufacture unread activity or interrupt the foreground', () => {
    const signal = { ...announcement, signal: 'connection' as const }, activity = { ...record, attention: 'activity' as const, attentionRevision: 0 }
    expect(notificationDeliveryRoute(activity, signal, prefs({ nativeEnabled: true }), { foreground: false, nativeSupported: true, now: at })).toBe('none')
    expect(notificationDeliveryRoute(activity, signal, prefs({ nativeEnabled: true, connectionUpdates: true }), { foreground: false, nativeSupported: true, now: at })).toBe('native')
    expect(notificationDeliveryRoute(activity, signal, prefs({ nativeEnabled: true, connectionUpdates: true }), { foreground: true, nativeSupported: true, now: at })).toBe('none')
    expect(notificationDeliveryRoute(activity, signal, prefs({ nativeEnabled: true, sessionPreferences: [{ scope: record.scope, mode: 'focus' }] }), { foreground: false, nativeSupported: true, now: at })).toBe('native')
    expect(notificationDeliveryRoute(activity, signal, prefs({ nativeEnabled: true, quiet: true, sessionPreferences: [{ scope: record.scope, mode: 'focus' }] }), { foreground: false, nativeSupported: true, now: at })).toBe('none')
  })
  it('scheduled quiet follows local boundaries, crosses midnight and treats equal times as all-day', () => {
    const current = prefs({ quietHours: { enabled: true, startMinute: 1_320, endMinute: 480 } })
    const local = (hour: number, minute = 0) => new Date(2026, 9, 5, hour, minute).getTime()
    expect(notificationIsQuiet(current, local(21, 59))).toBe(false); expect(notificationIsQuiet(current, local(22))).toBe(true)
    expect(notificationIsQuiet(current, local(7, 59))).toBe(true); expect(notificationIsQuiet(current, local(8))).toBe(false)
    expect(notificationQuietBoundary(current, local(21, 59))).toBe(local(22))
    expect(notificationQuietBoundary(current, local(22))).toBe(new Date(2026, 9, 6, 8).getTime())
    expect(notificationIsQuiet(prefs({ quietHours: { enabled: true, startMinute: 600, endMinute: 600 } }), at)).toBe(true)
    expect(notificationQuietBoundary(prefs(), at)).toBeUndefined()
  })
  it('read, archived, expired and stale signals stay silent; privacy remains safe even for explicit previews', () => {
    for (const value of [{ ...record, readRevision: 1 }, { ...record, archivedAt: at }, { ...record, state: 'expired' as const }]) expect(notificationDeliveryRoute(value, announcement, prefs({ nativeEnabled: true }), { foreground: false, nativeSupported: true, now: at })).toBe('none')
    expect(notificationDeliveryRoute(record, announcement, prefs({ nativeEnabled: true }), { foreground: false, nativeSupported: true, now: at + 60_000 })).toBe('none')
    const privateRecord = { ...record, title: 'person@example.com 操作结束', detail: 'Bearer private-value; /Users/test/private/foo.json; CTI-00000000000000000000000000000000' }
    expect(notificationNativeContent(privateRecord, false)).toEqual({ title: '拾光', body: '有新的通知，请打开拾光查看。' })
    const preview = JSON.stringify(notificationNativeContent(privateRecord, true))
    expect(preview).not.toContain('person@example.com'); expect(preview).not.toContain('private-value'); expect(preview).not.toContain('/Users/test'); expect(preview).not.toContain('000000000000')
  })
  it('legacy prefs normalize without enabling new channels or accepting malformed scope/times', () => {
    const current = prefs({ nativeEnabled: false, quietHours: { enabled: true, startMinute: -1, endMinute: 10_000 }, nativeMutedCategories: ['updates', 'injected', 'updates'],
      sessionPreferences: [{ scope: { channelId: '1' }, mode: 'quiet' }, { scope: { ...record.scope, secret: 'bad' }, mode: 'focus' }] })
    expect(current.nativeMutedCategories).toEqual(['updates']); expect(current.quietHours).toEqual({ enabled: true, startMinute: 1_320, endMinute: 480 }); expect(current.sessionPreferences).toEqual([])
  })
})
