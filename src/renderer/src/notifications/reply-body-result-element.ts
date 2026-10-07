import type { NotificationRecord, NotificationTarget } from '../../../domain/notification'
import { validReplyBodyProof } from '../../../domain/reply-body-proof'
import { notificationSessionScopeMatches } from './notification-session-scope'

/** ID/status alone, a legacy comparison, imported text or an unplayed suffix is never a human read proof. */
export function replyBodyTargetElement(root: ParentNode, target: Extract<NotificationTarget, { kind: 'session' }>): HTMLElement | undefined {
  if (!target.entryId || !validReplyBodyProof(target.replyBody)) return
  for (const element of root.querySelectorAll<HTMLElement>('[data-notification-reply]')) {
    const d = element.dataset, scope = target.scope
    if (d.notificationReply !== target.entryId || d.notificationReplyDigest !== target.replyBody.digest || d.notificationReplyStatus !== target.replyBody.status || d.notificationReplySource !== 'cursor') continue
    if (!notificationSessionScopeMatches(scope, { sessionId: d.notificationReplySession, channelId: d.notificationReplyChannel, generation: d.notificationReplyGeneration,
      composerId: d.notificationReplyComposer, bindingGeneration: d.notificationReplyBinding })) continue
    if (scope.workspaceId && scope.workspaceId !== d.notificationReplyWorkspace || scope.runId && scope.runId !== d.notificationReplyRun || scope.slotId && scope.slotId !== d.notificationReplySlot) continue
    return element
  }
}
export function replyBodyResultElement(root: ParentNode, record: NotificationRecord): HTMLElement | undefined {
  if (record.eventType !== 'session.reply' || record.state !== 'resolved' || !['complete', 'failed', 'body-changed'].includes(record.subjectState ?? '') || record.target?.kind !== 'session') return
  if (['complete', 'failed'].includes(record.subjectState!) && record.target.replyBody?.status !== record.subjectState) return
  return replyBodyTargetElement(root, record.target)
}
