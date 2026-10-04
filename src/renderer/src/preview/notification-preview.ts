import type { SgDesktopApi } from '../../../shared/desktop-api'
import { DEFAULT_NOTIFICATION_PREFERENCES, normalizeNotificationPreferences } from '../../../domain/notification'

/** Empty development projection until notification-specific scenes are requested; never emits a native notification. */
export function emptyNotificationPreviewApi(): Pick<SgDesktopApi, 'getNotificationPage' | 'readNotification' | 'readAllNotifications' | 'archiveNotification' | 'clearReadNotifications' | 'getNotificationPreferences' | 'saveNotificationPreferences' | 'onNotificationChanged'> {
  const summary = { revision: 0, total: 0, unread: 0, pending: 0 }
  const unchanged = async () => ({ changed: false, summary })
  let preferences = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES)
  return {
    getNotificationPage: async () => ({ records: [], summary, reset: false, health: 'ready', historyIncomplete: false }),
    readNotification: unchanged, readAllNotifications: unchanged, archiveNotification: unchanged, clearReadNotifications: unchanged,
    getNotificationPreferences: async () => structuredClone(preferences),
    saveNotificationPreferences: async input => { preferences = normalizeNotificationPreferences(input); return structuredClone(preferences) },
    onNotificationChanged: () => () => {}
  }
}
