/** Proof of an original coordinator-created operator request, not permission to review a proposal. */
export interface MemoryOperatorReviewProof {
  messageId: string
  createdAt: number
  reason: 'no-reviewer' | 'timeout'
  live?: boolean
}
export interface MemoryOperatorReviewObservation {
  workspaceId: string
  runId: string
  groupId?: string
  memoryId: string
  memoryVersion: number
  title: string
  proof: MemoryOperatorReviewProof
}
export interface MemoryOperatorReviewObserver {
  observeOperatorReview(value: MemoryOperatorReviewObservation): void
}
export function validateMemoryOperatorProof(proof: MemoryOperatorReviewProof): void {
  if (
    !proof ||
    typeof proof.messageId !== 'string' ||
    !proof.messageId ||
    proof.messageId.length > 300 ||
    !Number.isSafeInteger(proof.createdAt) ||
    proof.createdAt < 0 ||
    !['no-reviewer', 'timeout'].includes(proof.reason) ||
    Object.keys(proof).some((key) => !['messageId', 'createdAt', 'reason', 'live'].includes(key)) ||
    (proof.live !== undefined && typeof proof.live !== 'boolean')
  )
    throw Error('原记忆人工请求证据无效')
}
