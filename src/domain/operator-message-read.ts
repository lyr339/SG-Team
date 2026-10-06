import type { TeamMessage } from './team-collaboration'
import type { NotificationRecord } from './notification'

export type OperatorMessageReadMetadata = Pick<TeamMessage, 'id' | 'runId' | 'groupId' | 'threadId' | 'kind' | 'createdAt' | 'sender' | 'recipient'>
const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 280
/** Same original thin fields as the durable native digest. Never reads content, credentials or Agent receipt fields. */
export function operatorMessageNativeFields(message: OperatorMessageReadMetadata, subject?: string): unknown[] | undefined {
  if (!id(message.id) || !id(message.runId) || !id(message.threadId) || message.groupId !== undefined && !id(message.groupId)
    || message.sender.type !== 'agent' || !id(message.sender.slotId) || message.recipient.type !== 'operator'
    || !['directive', 'question', 'response', 'status', 'notice'].includes(message.kind)
    || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0 || message.createdAt > 8_640_000_000_000_000
    || subject !== undefined && (typeof subject !== 'string' || subject.length > 4000)) return
  return [message.id, message.kind, message.createdAt, message.sender.slotId, message.groupId, message.threadId, subject]
}
/** Read identity belongs to the exact stored native fact; a rebase suffix is presentation history, not a fresh Agent response. */
export function operatorMessageNotificationDigest(record: NotificationRecord): string | undefined {
  if (record.eventType !== 'team.operator-message' || record.state !== 'resolved' || record.target?.kind !== 'collaboration' || !record.target.messageId
    || !['directive', 'question', 'response', 'status', 'notice'].includes(record.subjectState ?? '') || record.key !== `operator-message:${record.target.messageId}`
    || record.target.runId !== record.scope.runId || record.target.groupId !== record.scope.groupId || !record.scope.workspaceId) return
  const prefix = `${record.key}:facts:`
  if (!record.eventId?.startsWith(prefix)) return
  return /^([a-f0-9]{64})(?::data:\d+)?$/.exec(record.eventId.slice(prefix.length))?.[1]
}
