import type { NotificationChange, NotificationDraft, NotificationPage, NotificationPreferences, NotificationQuery } from '../domain/notification'

export interface NotificationRepository {
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
