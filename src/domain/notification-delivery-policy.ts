import { notificationIsUnread, notificationSafeText, notificationSessionPreferenceKey, type NotificationPreferences, type NotificationPush, type NotificationRecord } from './notification'

export function notificationIsQuiet(preferences: NotificationPreferences, at: number): boolean {
  if (!preferences.enabled || preferences.quiet) return true
  const hours = preferences.quietHours
  if (!hours?.enabled) return false
  const clock = new Date(at), minute = clock.getHours() * 60 + clock.getMinutes()
  return hours.startMinute === hours.endMinute || (hours.startMinute < hours.endMinute
    ? minute >= hours.startMinute && minute < hours.endMinute : minute >= hours.startMinute || minute < hours.endMinute)
}
export function notificationSessionMode(record: NotificationRecord, preferences: NotificationPreferences): 'default' | 'focus' | 'quiet' {
  if (!record.scope.sessionId || record.scope.generation === undefined) return 'default'
  const key = notificationSessionPreferenceKey(record.scope)
  return preferences.sessionPreferences?.find(value => notificationSessionPreferenceKey(value.scope) === key)?.mode ?? 'default'
}
export function notificationDeliveryRoute(record: NotificationRecord, announcement: NonNullable<NotificationPush['announcement']>, preferences: NotificationPreferences,
  context: { foreground: boolean; nativeSupported: boolean; now: number }): 'none' | 'in-app' | 'native' {
  if (announcement.expiresAt <= context.now || notificationIsQuiet(preferences, context.now) || preferences.mutedCategories.includes(record.category)
    || notificationSessionMode(record, preferences) === 'quiet' || record.archivedAt !== undefined || record.state === 'expired') return 'none'
  const passive = announcement.signal !== undefined
  if (passive) {
    if (context.foreground || !(notificationSessionMode(record, preferences) === 'focus'
      || announcement.signal === 'connection' && preferences.connectionUpdates || announcement.signal === 'reply' && preferences.replyUpdates)) return 'none'
  } else if (!notificationIsUnread(record) || record.attention === 'activity') return 'none'
  if (!context.foreground && preferences.nativeEnabled && context.nativeSupported && !preferences.nativeMutedCategories?.includes(record.category)) return 'native'
  return passive || preferences.inAppMutedCategories?.includes(record.category) ? 'none' : 'in-app'
}
export function notificationQuietBoundary(preferences: NotificationPreferences, at: number): number | undefined {
  const hours = preferences.quietHours
  if (!hours?.enabled || hours.startMinute === hours.endMinute) return undefined
  const candidates: number[] = []
  for (let day = 0; day < 2; day++) for (const minute of [hours.startMinute, hours.endMinute]) {
    const date = new Date(at); date.setDate(date.getDate() + day); date.setHours(Math.floor(minute / 60), minute % 60, 0, 0)
    if (date.getTime() > at) candidates.push(date.getTime())
  }
  return Math.min(...candidates)
}
export function notificationNativeContent(record: NotificationRecord, preview: boolean): { title: string; body: string } {
  if (!preview) return { title: '拾光', body: '有新的通知，请打开拾光查看。' }
  const safe = (text: string) => notificationSafeText(text).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[账号]')
    .replace(/(?:[A-Z]:[\\/]|\/(?:Users|home|var|tmp)\/)[^\s，。；]+/gi, '[本地路径]').replace(/\s+/g, ' ').trim()
  return { title: safe(record.title).slice(0, 100) || '拾光通知', body: safe(record.detail ?? record.source).slice(0, 180) || '打开拾光查看这条通知。' }
}
