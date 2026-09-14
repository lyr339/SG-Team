import type { TeamMessageActor, TeamMessageKind, TeamMessageReceiptStage } from './team-collaboration'
import type { TeamMemoryKind } from './team-memory'
import type { TaskStatus } from './task-pool'

export interface TeamCheckpointMember {
  slotId: string
  roleKey: string
  roleName: string
  channelId?: string
  workingFiles: string[]
  /** 所在协作组（会话池）；legacy 团队 run 成员没有。 */
  groupId?: string
}

/** 会话池的协作组快照：组 + 成员 + lead（任务书 §4.5；restore 暂不恢复组结构，记为阶段 2 待办）。 */
export interface TeamCheckpointGroup {
  id: string
  name: string
  goal: string
  status: 'active' | 'dissolved'
  leadSlotId?: string
  actingLeadSlotId?: string
  memberSlotIds: string[]
}

export interface TeamCheckpointTask {
  id: string
  title: string
  status: TaskStatus
  targetSlotId?: string
  assigneeSessionId?: string
  progress: number
  summary?: string
}

export interface TeamCheckpointMessage {
  id: string
  sender: TeamMessageActor
  recipient: TeamMessageActor
  kind: TeamMessageKind
  content: string
  stage: TeamMessageReceiptStage
}

export interface TeamCheckpointMemory {
  id: string
  kind: TeamMemoryKind
  title: string
  content: string
  version: number
}

export interface TeamCheckpointCapsule {
  schemaVersion: 1
  goal: string
  runName: string
  runStatus: string
  members: TeamCheckpointMember[]
  /** 会话池的协作组；legacy 团队 run 与旧检查点没有该字段。 */
  groups?: TeamCheckpointGroup[]
  activeTasks: TeamCheckpointTask[]
  pendingMessages: TeamCheckpointMessage[]
  sharedMemory: TeamCheckpointMemory[]
  capturedAt: number
}

export interface TeamCheckpoint {
  id: string
  workspaceId: string
  runId: string
  reason: 'automatic' | 'before_restore'
  digest: string
  capsule: TeamCheckpointCapsule
  createdAt: number
}

export type TeamRestoreMemberState =
  | 'queued'
  | 'notified'
  | 'read'
  | 'restored'
  | 'attention'

export interface TeamRestoreMember {
  slotId: string
  roleName: string
  messageId?: string
  state: TeamRestoreMemberState
  detail: string
}

export interface TeamRestoreOperation {
  id: string
  workspaceId: string
  runId: string
  checkpointId: string
  status: 'preparing' | 'waiting' | 'completed' | 'attention'
  members: TeamRestoreMember[]
  createdAt: number
  updatedAt: number
}

export interface TeamContinuitySnapshot {
  schemaVersion: 1
  revision: number
  workspaceId?: string
  runId?: string
  checkpoints: TeamCheckpoint[]
  activeRestore?: TeamRestoreOperation
  updatedAt: number
}

export interface TeamTakeoverCapsule {
  checkpointId: string
  taskIds: string[]
  content: string
}

export function emptyTeamContinuitySnapshot(
  workspaceId?: string,
  runId?: string
): TeamContinuitySnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    workspaceId,
    runId,
    checkpoints: [],
    updatedAt: Date.now()
  }
}
