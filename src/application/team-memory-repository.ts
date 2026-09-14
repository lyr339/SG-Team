import type {
  ProposeTeamMemoryInput,
  ReviewTeamMemoryInput,
  TeamMemoryItem,
  TeamMemoryKind,
  TeamMemorySnapshot,
  TeamMemoryStatus
} from '../domain/team-memory'

export interface TeamMemorySearchInput {
  workspaceId: string
  runId: string
  /** 组作用域：run 级条目只搜该组；省略 = 整个 run（操作员 / legacy）。 */
  groupId?: string
  query?: string
  kinds?: TeamMemoryKind[]
  statuses?: TeamMemoryStatus[]
  limit?: number
}

export interface TeamMemoryRepository {
  revision(): number
  /** 装载记忆；给出 `groupId` 时 run 级条目只含该组，项目级条目照常跨组返回。 */
  load(workspaceId: string, runId: string, groupId?: string): TeamMemorySnapshot
  search(input: TeamMemorySearchInput): TeamMemoryItem[]
  propose(input: ProposeTeamMemoryInput): TeamMemoryItem
  review(input: ReviewTeamMemoryInput): TeamMemoryItem
  close(): void
}
