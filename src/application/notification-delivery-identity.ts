import { notificationContentSignature, type NotificationPush } from '../domain/notification'
import type { NotificationDeliveryClaim } from '../domain/notification-delivery-claim'
import { fingerprintSignature } from './notification-fingerprint'

export const deliveryHash = (value: string): string => fingerprintSignature(value).slice(7)

/** Capture BEFORE current() refines the target. Read flags, expiry extensions,
 * global badge counts and passive canonical changes are not a new opportunity. */
export function notificationDeliveryIdentity(event: NotificationPush): NotificationDeliveryClaim | undefined {
  const record = event.change?.record, signal = event.announcement
  if (!record || !signal) return
  if (typeof signal.id !== 'string' || !signal.id || signal.id.length > 700) throw Error('提醒来源身份无效')
  const group = signal.group
  const displayed = group ? { ...record, source: group.source, title: group.title, detail: group.detail, target: group.target ?? record.target, tone: group.tone ?? record.tone } : record
  return { signalHash: deliveryHash(signal.id), contentHash: deliveryHash(JSON.stringify([
    record.id, record.key, record.revision, record.attentionRevision, record.sourceRevision, record.occurredAt,
    signal.signal ?? null, notificationContentSignature(displayed), group?.recordIds ?? []
  ])), expiresAt: signal.expiresAt }
}
