import { createHash } from 'node:crypto'
import { notificationContentSignature, type NotificationDraft } from '../domain/notification'

/** Opaque private-ledger identity, not retained plaintext from a cleared notification. */
export function notificationFingerprint(value: NotificationDraft): string {
  return fingerprintSignature(notificationContentSignature(value))
}
export function fingerprintSignature(signature: string): string {
  return `sha256:${createHash('sha256').update(signature).digest('hex')}`
}
