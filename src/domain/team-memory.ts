import type { TeamMessageActor } from './team-collaboration'

export type TeamMemoryScope = 'run' | 'project'
export type TeamMemoryKind = 'decision' | 'constraint' | 'fact' | 'risk' | 'lesson'
export type TeamMemoryStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected'
export type TeamMemorySourceType = 'message' | 'task' | 'file'

export interface TeamMemorySource {
  type: TeamMemorySourceType
  ref: string
  label: string
}

export interface TeamMemoryItem {
  id: string
  workspaceId: string
  runId: string
  scope: TeamMemoryScope
  kind: TeamMemoryKind
  title: string
  content: string
  status: TeamMemoryStatus
  version: number
  proposedBy: TeamMessageActor
  reviewedBy?: TeamMessageActor
  reviewNote?: string
  acceptedAt?: number
  supersedesId?: string
  supersededById?: string
  sources: TeamMemorySource[]
  createdAt: number
  updatedAt: number
  /**
   * 所属协作组（会话池）：写入时的快照，不回填。`scope='run'` 的记忆按 (run, group) 过滤；
   * `scope='project'` 的项目级记忆跨组共享，不带组。空 = legacy 团队 run 的 run 级记忆。
   */
  groupId?: string
}

export interface TeamMemoryEvent {
  seq: number
  type: string
  workspaceId: string
  runId: string
  memoryId: string
  actor: TeamMessageActor
  detail?: string
  at: number
}

export interface TeamMemorySnapshot {
  schemaVersion: 1
  revision: number
  seq: number
  workspaceId?: string
  runId?: string
  /** 快照作用域：给出时 run 级条目只含该组（项目级不受影响）；空 = 整个 run。 */
  groupId?: string
  items: Record<string, TeamMemoryItem>
  itemOrder: string[]
  events: TeamMemoryEvent[]
  updatedAt: number
}

export interface ProposeTeamMemoryInput {
  workspaceId: string
  runId: string
  scope: TeamMemoryScope
  kind: TeamMemoryKind
  title: string
  content: string
  proposedBy: TeamMessageActor
  sources: TeamMemorySource[]
  supersedesId?: string
  clientProposalId: string
  /** 目标协作组；省略时按提出者席位当时所在的组推得。项目级记忆忽略。 */
  groupId?: string
}

export interface ReviewTeamMemoryInput {
  memoryId: string
  decision: 'accept' | 'reject'
  reviewer: TeamMessageActor
  note?: string
}

export function emptyTeamMemorySnapshot(
  workspaceId?: string,
  runId?: string
): TeamMemorySnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    seq: 0,
    workspaceId,
    runId,
    items: {},
    itemOrder: [],
    events: [],
    updatedAt: Date.now()
  }
}
