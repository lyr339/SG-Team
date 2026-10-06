import { useEffect, useState, type RefObject } from 'react'
import { operatorMessageNativeFields, operatorMessageNotificationDigest, type OperatorMessageReadMetadata } from '../../../domain/operator-message-read'
import { observeSourceNotificationRead } from './observe-source-read'

/** One selected original message. WebCrypto computes only the same thin native material, not any body/receipt or original-source probe. */
export function useOperatorMessageNotificationRead(ref: RefObject<HTMLElement | null>, message: OperatorMessageReadMetadata | undefined,
  scope: { workspaceId: string; runId: string; groupId: string; scoped: boolean }, subject?: string): string | undefined {
  const fields = message && scope.scoped && message.runId === scope.runId && message.groupId === scope.groupId ? operatorMessageNativeFields(message, subject) : undefined
  const material = fields ? JSON.stringify(fields) : undefined
  const { workspaceId, runId, groupId } = scope
  const [proof, setProof] = useState<{ material: string; digest: string }>()
  const digest = proof && proof.material === material ? proof.digest : undefined
  useEffect(() => {
    if (!material || !window.crypto?.subtle) return
    let active = true
    void window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)).then(result => {
      if (active) setProof({ material, digest: [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('') })
    }).catch(() => { /* No verified read proof -> keep unread. Never guess or run a business fallback. */ })
    return () => { active = false }
  }, [material])
  const messageId = message?.id, kind = message?.kind
  useEffect(() => {
    const element = ref.current, api = window.sgDesktop
    if (!element || !digest || !messageId || !workspaceId || !runId || !groupId || !api?.getNotificationPage || !api.onNotificationChanged) return
    return observeSourceNotificationRead(element, api, { key: `operator-message:${messageId}`, eventType: 'team.operator-message', limit: 1 }, record =>
      record.scope.workspaceId === workspaceId && record.scope.runId === runId && record.scope.groupId === groupId && record.subjectState === kind
      && record.target?.kind === 'collaboration' && record.target.messageId === messageId && operatorMessageNotificationDigest(record) === digest,
      () => element.dataset.notificationOperatorMessage === messageId && element.dataset.notificationOperatorDigest === digest
        && element.dataset.notificationOperatorWorkspace === workspaceId && element.dataset.notificationOperatorRun === runId
        && element.dataset.notificationOperatorGroup === groupId && element.dataset.notificationOperatorKind === kind)
  }, [ref, digest, workspaceId, runId, groupId, messageId, kind])
  return digest
}
