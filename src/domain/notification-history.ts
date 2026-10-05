/** Private history integrity, independent of notification reading and business outcomes. */
export interface NotificationHistoryIntegrity {
  revision: number
  acknowledgedRevision: number
  latestGapId?: string
  observedAt?: number
  acknowledgedAt?: number
}
export interface NotificationHistoryStatus { integrity: NotificationHistoryIntegrity; known?: boolean }
export const NOTIFICATION_ROUTINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
export function notificationHistoryNeedsAcknowledgement(value: NotificationHistoryIntegrity | undefined): boolean {
  return Boolean(value && value.revision > value.acknowledgedRevision)
}
export function validateNotificationGapId(value: string): void {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw Error('通知历史缺口身份无效')
}
export function validateNotificationIntegrity(value: NotificationHistoryIntegrity): void {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.acknowledgedRevision)
    || value.acknowledgedRevision < 0 || value.acknowledgedRevision > value.revision) throw Error('通知历史完整性版本异常，原数据保留')
  if (value.revision > 0) { if (!value.latestGapId) throw Error('通知历史完整性身份缺失'); validateNotificationGapId(value.latestGapId) }
  for (const time of [value.observedAt, value.acknowledgedAt]) if (time !== undefined && (!Number.isSafeInteger(time) || time < 0 || time > 8_640_000_000_000_000)) throw Error('通知历史完整性时间异常')
}
