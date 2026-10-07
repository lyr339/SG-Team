import type { NotificationChange, NotificationDraft, NotificationMarker, NotificationPage, NotificationPreferences, NotificationQuery, NotificationSourceResult, NotificationSourceState } from '../domain/notification'
import type { NotificationHistoryIntegrity, NotificationHistoryStatus } from '../domain/notification-history'
import type { NotificationSourceListPage, NotificationSourceListQuery } from '../domain/native-scope-availability'
import type { OperatorMessageRecordMetadata } from '../domain/team-message-notification'
import type { McpWriteRecordMetadata } from '../domain/mcp-write-notification'
import type { ReplyIdentityBatch, ReplyIdentityMatch } from '../domain/reply-identity-index'
import type { QuestionTerminalBatch, QuestionTerminalReceipt } from '../domain/question-terminal-receipt'
import type { NotificationDeliveryClaim } from '../domain/notification-delivery-claim'

/** Storage lifecycle, not a business event or proof that an interrupted write rolled back. */
export interface NotificationRepositoryLifecycle { state: 'unavailable' | 'recovered'; generation: number }

export interface NotificationRepository {
  historyGap?(id?: string): Promise<NotificationHistoryStatus>
  recordHistoryGap?(id: string, now: number): Promise<NotificationHistoryIntegrity>
  acknowledgeHistoryGap?(revision: number, now: number): Promise<NotificationHistoryIntegrity>
  pruneRoutine?(now: number): Promise<NotificationChange & { removed: number; more: boolean }>
  subscribeLifecycle?(listener: (event: NotificationRepositoryLifecycle) => void): () => void
  marker(key: string): Promise<NotificationMarker>
  sourceState(key: string): Promise<NotificationSourceState>
  listNativeSources?(query: NotificationSourceListQuery): Promise<NotificationSourceListPage>
  operatorMessageRecords?(keys: string[]): Promise<OperatorMessageRecordMetadata[]>
  mcpWriteRecords?(keys: string[]): Promise<McpWriteRecordMetadata[]>
  replyIdentities?(sourceKey: string, aliases: string[]): Promise<ReplyIdentityMatch[]>
  questionTerminals?(sourceKey: string, identities: string[]): Promise<QuestionTerminalReceipt[]>
  claimDelivery?(claim: NotificationDeliveryClaim, now: number): Promise<boolean>
  commitSource(key: string, expectedRevision: number, data: unknown, drafts: NotificationDraft[], now: number, replyIdentities?: ReplyIdentityBatch, questionTerminals?: QuestionTerminalBatch): Promise<NotificationSourceResult>
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
