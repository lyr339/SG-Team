import { useEffect, useState, useMemo } from 'react'
import { replyBodyMaterial } from '../../../domain/reply-body-proof'
import type { ConversationEntry } from '../../../domain/conversation-entry'
import type { NotificationScope } from '../../../domain/notification'
import { replyBodyDigest } from './reply-body-digest'

export type ReplyBodyAttributes = Record<string, string | undefined>
const NO_ATTRIBUTES: ReplyBodyAttributes = Object.freeze({})
/** Hash a final body only, never per-token queries/subscriptions or a future unplayed text. */
export function useReplyBodyDigest(entry: ConversationEntry | undefined, scope: NotificationScope | undefined, ready: boolean): ReplyBodyAttributes {
  const valid = Boolean(ready && entry && entry.source === 'cursor' && entry.role === 'assistant' && entry.channelId === scope?.channelId && !entry.silent && ['complete', 'failed'].includes(entry.status)
    && typeof window !== 'undefined' && typeof window.sgDesktop?.getNotificationPage === 'function' && typeof window.sgDesktop.onNotificationChanged === 'function')
  const { sessionId, channelId, generation, composerId, bindingGeneration, workspaceId, runId, slotId } = scope ?? {}
  const material = useMemo(() => valid && scope && entry ? replyBodyMaterial(entry.text, scope) : undefined,
    [valid, entry?.text, sessionId, channelId, generation, composerId, bindingGeneration, workspaceId, runId, slotId])
  const [proof, setProof] = useState<{ material: string; digest: string }>()
  const digest = proof?.material === material ? proof?.digest : undefined
  useEffect(() => {
    if (!material || !entry || !scope) return
    let active = true
    void replyBodyDigest(entry.text, scope).then(digest => { if (active && digest) setProof({ material, digest }) })
    return () => { active = false }
  }, [material])
  return useMemo(() => !valid || !digest ? NO_ATTRIBUTES : ({ 'data-notification-reply': entry?.id, 'data-notification-reply-digest': digest,
    'data-notification-reply-status': valid ? entry?.status : undefined, 'data-notification-reply-source': valid ? entry?.source : undefined,
    'data-notification-reply-channel': scope?.channelId, 'data-notification-reply-session': scope?.sessionId, 'data-notification-reply-generation': scope?.generation,
    'data-notification-reply-composer': scope?.composerId, 'data-notification-reply-binding': scope?.bindingGeneration,
    'data-notification-reply-workspace': scope?.workspaceId, 'data-notification-reply-run': scope?.runId, 'data-notification-reply-slot': scope?.slotId }),
    [valid, entry?.id, entry?.status, digest, sessionId, channelId, generation, composerId, bindingGeneration, workspaceId, runId, slotId])
}
