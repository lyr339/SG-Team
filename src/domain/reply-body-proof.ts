import { normalizeEscapedNewlines } from './conversation-entry'
import type { NotificationScope } from './notification'

/** Exact displayed-body identity, not an Agent receipt, association key or permission. */
export interface ReplyBodyProof { version: 1; digest: string; status: 'complete' | 'failed' }
const scopeFields = ['workspaceId', 'runId', 'slotId', 'sessionId', 'channelId', 'generation', 'composerId', 'bindingGeneration'] as const
export function replyBodyScope(scope: NotificationScope): Array<string | null> | undefined {
  if (!scope.sessionId || !scope.channelId) return
  if (scopeFields.some(key => scope[key] !== undefined && (typeof scope[key] !== 'string' || !scope[key] || scope[key]!.length > 300))) return
  return scopeFields.map(key => scope[key] ?? null)
}
/** Preserve interior whitespace, including code indentation; never use a dedup/whitespace-folded text identity. */
export function replyBodyMaterial(text: string, scope: NotificationScope): string | undefined {
  const fields = replyBodyScope(scope)
  if (!fields || typeof text !== 'string' || text.length > 1_000_000) return
  return JSON.stringify([1, fields, normalizeEscapedNewlines(text).trim()])
}
export function validReplyBodyProof(value: unknown): value is ReplyBodyProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const p = value as ReplyBodyProof
  return Object.keys(p).every(key => ['version', 'digest', 'status'].includes(key)) && p.version === 1
    && typeof p.digest === 'string' && /^[a-f0-9]{64}$/.test(p.digest) && ['complete', 'failed'].includes(p.status)
}
