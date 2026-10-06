import { ipcMain, type BrowserWindow } from 'electron'
import { NotificationService } from '../application/notification-service'
import { NOTIFICATION_CATEGORIES, NotificationActionError, type NotificationCategory, type NotificationQuery } from '../domain/notification'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'
import type { NotificationDeliveryService } from '../application/notification-delivery-service'

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
  if (input.eventType !== undefined && (typeof input.eventType !== 'string' || !/^[a-z][a-z0-9_.-]{0,60}$/.test(input.eventType))) throw new NotificationActionError('通知类型筛选无效')
  if (input.filter !== undefined && !['all', 'unread', 'pending'].includes(String(input.filter))) throw new NotificationActionError('通知筛选无效')
  if (input.category !== undefined && !NOTIFICATION_CATEGORIES.includes(input.category as NotificationCategory)) throw new NotificationActionError('通知分类无效')
  if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new NotificationActionError('通知分页大小无效')
  const cursor = input.cursor === undefined ? undefined : object(input.cursor)
  const readCursor = input.readCursor === undefined || input.readCursor === 'start' ? input.readCursor : object(input.readCursor)
  if (cursor && readCursor !== undefined) throw new NotificationActionError('通知分页方式不能混用')
  if (readCursor && readCursor !== 'start' && revision(readCursor.revision) > revision(readCursor.ceiling)) throw new NotificationActionError('通知阅读游标无效')
  return {
    ...(input.key !== undefined ? { key: id(input.key) } : {}),
    ...(input.eventType !== undefined ? { eventType: input.eventType as string } : {}),
    ...(input.runId !== undefined ? { runId: id(input.runId) } : {}),
    ...(input.operationFamilyId !== undefined ? { operationFamilyId: id(input.operationFamilyId) } : {}),
    ...(input.sessionId !== undefined ? { sessionId: id(input.sessionId) } : {}),
    ...(input.contextDomain !== undefined ? { contextDomain: id(input.contextDomain) } : {}),
    ...(input.installationId !== undefined ? { installationId: id(input.installationId) } : {}),
    ...(input.memoryId !== undefined ? { memoryId: id(input.memoryId) } : {}),
    ...(input.generation !== undefined ? { generation: id(input.generation) } : {}),
    ...(input.toolCallId !== undefined ? { toolCallId: id(input.toolCallId) } : {}),
    ...(input.entryId !== undefined ? { entryId: id(input.entryId) } : {}),
    ...(input.filter ? { filter: input.filter as NotificationQuery['filter'] } : {}),
    ...(input.category ? { category: input.category as NotificationCategory } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: id(input.workspaceId) } : {}),
    ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
    ...(cursor ? { cursor: { revision: revision(cursor.revision), offset: revision(cursor.offset) } } : {}),
    ...(readCursor !== undefined ? { readCursor: readCursor === 'start' ? 'start' : { revision: revision(readCursor.revision), id: id(readCursor.id), ceiling: revision(readCursor.ceiling) } } : {})
  }
}

/** No renderer publish endpoint: business adapters in main own the facts and allowed navigation references. */
export function registerNotificationIpc(service: NotificationService, getWindow: () => BrowserWindow | undefined,
  delivery?: Pick<NotificationDeliveryService, 'subscribe' | 'status' | 'openRequested'>): () => void {
  const handlers: Array<[string, (payload: unknown) => unknown]> = [
    [IPC.notificationPage, input => {
      const page = service.page(query(input))
      return delivery ? page.then(value => ({ ...value, delivery: delivery.status(), ...(delivery.openRequested() ? { openRequested: delivery.openRequested() } : {}) })) : page
    }],
    [IPC.notificationAcknowledgeHistory, input => service.acknowledgeHistoryGap(revision(input))],
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
  const unsubscribe = (delivery ?? service).subscribe(event => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.notificationChanged, event)
  })
  return () => { unsubscribe(); for (const [channel] of handlers) ipcMain.removeHandler(channel) }
}
