import { ipcMain, type BrowserWindow } from 'electron'
import { NotificationService } from '../application/notification-service'
import { NOTIFICATION_CATEGORIES, NotificationActionError, type NotificationCategory, type NotificationQuery } from '../domain/notification'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotificationActionError('通知请求无效')
  return value as Record<string, unknown>
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NotificationActionError('通知版本无效')
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw new NotificationActionError('通知身份无效')
  return value
}
function query(value: unknown): NotificationQuery {
  if (value === undefined) return {}
  const input = object(value)
  if (input.filter !== undefined && !['all', 'unread', 'pending'].includes(String(input.filter))) throw new NotificationActionError('通知筛选无效')
  if (input.category !== undefined && !NOTIFICATION_CATEGORIES.includes(input.category as NotificationCategory)) throw new NotificationActionError('通知分类无效')
  if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new NotificationActionError('通知分页大小无效')
  const cursor = input.cursor === undefined ? undefined : object(input.cursor)
  return {
    ...(input.key !== undefined ? { key: id(input.key) } : {}),
    ...(input.filter ? { filter: input.filter as NotificationQuery['filter'] } : {}),
    ...(input.category ? { category: input.category as NotificationCategory } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: id(input.workspaceId) } : {}),
    ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
    ...(cursor ? { cursor: { revision: revision(cursor.revision), offset: revision(cursor.offset) } } : {})
  }
}

/** No renderer publish endpoint: business adapters in main own the facts and allowed navigation references. */
export function registerNotificationIpc(service: NotificationService, getWindow: () => BrowserWindow | undefined): () => void {
  const handlers: Array<[string, (payload: unknown) => unknown]> = [
    [IPC.notificationPage, input => service.page(query(input))],
    [IPC.notificationRead, input => { const value = object(input); return service.read(id(value.id), revision(value.revision)) }],
    [IPC.notificationReadAll, input => { const value = object(input); return service.readAll(query(value.query), revision(value.revision)) }],
    [IPC.notificationArchive, input => service.archive(id(input))],
    [IPC.notificationClearRead, input => {
      const value = object(input)
      if (value.confirmed !== true) throw new NotificationActionError('清理通知历史需要确认')
      return service.clearRead(query(value.query))
    }],
    [IPC.notificationPreferences, () => service.preferences()],
    [IPC.notificationSavePreferences, input => service.savePreferences(object(input))]
  ]
  for (const [channel, handler] of handlers) ipcMain.handle(channel, (event, payload) => { assertTrustedSender(event, getWindow); return handler(payload) })
  const unsubscribe = service.subscribe(event => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.notificationChanged, event)
  })
  return () => { unsubscribe(); for (const [channel] of handlers) ipcMain.removeHandler(channel) }
}
