import { pageOperationReference, type PageNotificationOperation } from '../../../domain/page-operation-notification'

/** Per-user-action display correlation only; no execution or retry policy lives in the renderer. */
export function pageOperationDisplay(kind: PageNotificationOperation) {
  const notificationId = crypto.randomUUID()
  return { request: { notificationId }, reference: pageOperationReference(kind, notificationId) }
}
