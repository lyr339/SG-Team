import type { NotificationRecord } from '../../../domain/notification'
import { operatorMessageNotificationDigest } from '../../../domain/operator-message-read'

/** An actual selected original body, not a group entry, a newer message or a coincidentally repeated title. */
export function operatorMessageResultElement(root: ParentNode, record: NotificationRecord): HTMLElement | undefined {
  const digest = operatorMessageNotificationDigest(record)
  if (!digest || record.target?.kind !== 'collaboration') return
  for (const element of root.querySelectorAll<HTMLElement>('[data-notification-operator-message]')) {
    const data = element.dataset
    if (data.notificationOperatorMessage === record.target.messageId && data.notificationOperatorWorkspace === record.scope.workspaceId
      && data.notificationOperatorRun === record.scope.runId && data.notificationOperatorGroup === record.scope.groupId
      && data.notificationOperatorKind === record.subjectState && data.notificationOperatorDigest === digest) return element
  }
}
