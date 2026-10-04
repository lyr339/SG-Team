import type { NotificationChange, NotificationDraft, NotificationMarker, NotificationPage, NotificationPreferences, NotificationQuery, NotificationSourceResult, NotificationSourceState } from '../domain/notification'

export interface NotificationRepository {
  marker(key: string): Promise<NotificationMarker>
  sourceState(key: string): Promise<NotificationSourceState>
  commitSource(key: string, expectedRevision: number, data: unknown, drafts: NotificationDraft[], now: number): Promise<NotificationSourceResult>
  put(draft: NotificationDraft, now: number): Promise<NotificationChange>
  page(query?: NotificationQuery): Promise<NotificationPage>
  read(id: string, observedRevision: number, now: number): Promise<NotificationChange>
  readAll(query: NotificationQuery, observedRevision: number, now: number): Promise<NotificationChange>
  archive(id: string, now: number): Promise<NotificationChange>
  clearRead(query: NotificationQuery, now: number): Promise<NotificationChange>
  preferences(): Promise<NotificationPreferences>
  savePreferences(value: NotificationPreferences): Promise<NotificationPreferences>
  close(): Promise<void>
}
