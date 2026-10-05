import type { NotificationChange, NotificationDraft, NotificationMarker, NotificationPage, NotificationPreferences, NotificationQuery, NotificationSourceResult, NotificationSourceState } from '../domain/notification'

/** Storage lifecycle, not a business event or proof that an interrupted write rolled back. */
export interface NotificationRepositoryLifecycle { state: 'unavailable' | 'recovered'; generation: number }

export interface NotificationRepository {
  subscribeLifecycle?(listener: (event: NotificationRepositoryLifecycle) => void): () => void
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
