import { parentPort, workerData } from 'node:worker_threads'
import { SqliteNotificationRepository, notificationSqliteIsBusy, notificationTransactionMayRetry } from '../infrastructure/notifications/sqlite-notification-repository'
import type { NotificationDraft, NotificationPreferences, NotificationQuery } from '../domain/notification'

export type NotificationWorkerCommand =
  | { kind: 'sourceState'; key: string }
  | { kind: 'commitSource'; key: string; expectedRevision: number; data: unknown; drafts: NotificationDraft[]; now: number }
  | { kind: 'marker'; key: string }
  | { kind: 'put'; draft: NotificationDraft; now: number }
  | { kind: 'page'; query?: NotificationQuery }
  | { kind: 'read'; id: string; revision: number; now: number }
  | { kind: 'readAll'; query: NotificationQuery; revision: number; now: number }
  | { kind: 'archive'; id: string; now: number }
  | { kind: 'clearRead'; query: NotificationQuery; now: number }
  | { kind: 'preferences' }
  | { kind: 'savePreferences'; preferences: NotificationPreferences }
  | { kind: 'close' }

export type NotificationWorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; retryable: boolean; code?: string }

if (parentPort) {
  let repository: SqliteNotificationRepository
  try {
    repository = new SqliteNotificationRepository((workerData as { databasePath: string }).databasePath)
    parentPort.postMessage({ id: 0, ok: true, result: undefined } satisfies NotificationWorkerReply)
    parentPort.on('message', ({ id, command }: { id: number; command: NotificationWorkerCommand }) => {
      try {
        let result: unknown
        switch (command.kind) {
          case 'sourceState': result = repository.sourceState(command.key); break
          case 'commitSource': result = repository.commitSource(command.key, command.expectedRevision, command.data, command.drafts, command.now); break
          case 'marker': result = repository.marker(command.key); break
          case 'put': result = repository.put(command.draft, command.now); break
          case 'page': result = repository.page(command.query); break
          case 'read': result = repository.read(command.id, command.revision, command.now); break
          case 'readAll': result = repository.readAll(command.query, command.revision, command.now); break
          case 'archive': result = repository.archive(command.id, command.now); break
          case 'clearRead': result = repository.clearRead(command.query, command.now); break
          case 'preferences': result = repository.preferences(); break
          case 'savePreferences': result = repository.savePreferences(command.preferences); break
          case 'close': repository.close(); break
        }
        parentPort!.postMessage({ id, ok: true, result } satisfies NotificationWorkerReply)
        if (command.kind === 'close') parentPort!.close()
      } catch (error) {
        const message = error instanceof Error ? error.message : '通知存储不可用'
        // Negative transaction evidence, not an error-message guess. Read-only
        // queries may safely retry real SQLite BUSY/LOCKED without mutation evidence.
        const readOnly = ['sourceState', 'marker', 'page', 'preferences'].includes(command.kind)
        parentPort!.postMessage({ id, ok: false, error: message, retryable: notificationTransactionMayRetry(error) || readOnly && notificationSqliteIsBusy(error),
          ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}) } satisfies NotificationWorkerReply)
      }
    })
  } catch (error) {
    parentPort.postMessage({ id: 0, ok: false, error: error instanceof Error ? error.message : '通知存储初始化失败', retryable: false } satisfies NotificationWorkerReply)
    parentPort.close()
  }
}
