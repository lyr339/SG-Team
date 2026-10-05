import type { TeamMemoryItem } from './team-memory'
export interface TeamMemoryInspectionRequest {
  workspaceId: string
  runId: string
  memoryId: string
  version: number
  groupId?: string
}
export interface TeamMemoryInspection {
  operatorReview?: import('./memory-operator-review').MemoryOperatorReviewProof
  canReview?: boolean
  item: TeamMemoryItem
  predecessor?: TeamMemoryItem
  observedAt: number
  revision: number
}
export interface TeamMemoryReviewRequest extends TeamMemoryInspectionRequest {
  decision: 'accept' | 'reject'
  confirmed: boolean
  note?: string
  notificationId?: string
}
export interface TeamMemoryReviewResult {
  inspection: TeamMemoryInspection
  conclusion?: 'accepted' | 'rejected'
  inspectionPending?: boolean
  notification?: import('./notification-reference').NotificationReference
}
export function memoryInspectionMatches(
  request: TeamMemoryInspectionRequest,
  value: TeamMemoryInspection
): boolean {
  return (
    value.item.id === request.memoryId &&
    value.item.version === request.version &&
    value.item.workspaceId === request.workspaceId &&
    value.item.runId === request.runId &&
    value.item.groupId === request.groupId
  )
}
/** A positive prerequisite conflict, not a guessed tool failure or a semantic contradiction detector. */
export function memoryRevisionIssue(
  item: TeamMemoryItem,
  predecessor: TeamMemoryItem | undefined
): 'conflict' | 'eligible' | 'unconfirmed' | TeamMemoryItem['status'] | undefined {
  if (item.status !== 'proposed') return item.status
  if (!item.supersedesId) return undefined
  if (
    !predecessor ||
    predecessor.id !== item.supersedesId ||
    predecessor.workspaceId !== item.workspaceId ||
    predecessor.scope !== item.scope ||
    predecessor.kind !== item.kind ||
    predecessor.groupId !== item.groupId ||
    (item.scope === 'run' && predecessor.runId !== item.runId)
  )
    return 'unconfirmed'
  return predecessor.status === 'accepted' && !predecessor.supersededById ? 'eligible' : 'conflict'
}
