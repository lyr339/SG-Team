import type { SessionHandoffResult } from './session-handoff'
import type { TeamFailoverRecord } from './team-failover'

/**
 * 成员身份迁移（阶段 2 · 2C）：把协作组内一个席位的组身份（组角色 + lead 身份）移交给
 * 池内另一个独立席位。通道即席位，绑定 / 令牌 / Composer 全部不动——迁移的是组成员关系，
 * 不是会话；上下文交接（Cursor 转录文档）是可选的随迁件（SessionHandoffService）。
 */

/** 目标候选：当前会话池内未入组的独立席位。任何独立席位都可接收（离线的排队生效）。 */
export interface MembershipTransferCandidate {
  slotId: string
  channelId?: string
  /** 独立席位当前的角色名。 */
  roleName: string
  avatarId?: string
  online: boolean
  /** 展示给用户的状态说明（在线待命 / 离线排队）。 */
  impact: string
}

export interface MembershipTransferOptions {
  runId: string
  groupId: string
  groupName: string
  sourceSlotId: string
  /** 原成员的组内角色名。 */
  sourceRoleName: string
  sourceChannelId?: string
  /** 原成员是本组有效 lead：lead 身份随成员身份一并迁移。 */
  transfersLead: boolean
  candidates: MembershipTransferCandidate[]
}

export interface MembershipTransferInput {
  groupId: string
  fromSlotId: string
  toSlotId: string
  /**
   * 迁移成功后，把原席位的上下文文档（Cursor 转录 + 拾光会话记录）作为一条用户消息
   * 排进目标席位的通道队列。解析或投递失败不回滚迁移，结果在 contextHandoff。
   */
  includeContext?: boolean
}

export interface MembershipTransferResult {
  groupId: string
  fromSlotId: string
  toSlotId: string
  toChannelId?: string
  /** 目标席位接过的组内角色名。 */
  roleName: string
  /** 有效 lead 是否随迁（原成员是本组有效 lead：组 lead，或临时主控）；目标席位另收一条 lead_changed。 */
  transferredLead: boolean
  /** 审计行（team_failovers，reason='manual_membership_transfer'，落库即 completed）。 */
  failover: TeamFailoverRecord
  /** 原成员出组时释放回队列的任务。 */
  releasedTaskIds: string[]
}

/** 随成员身份迁移附带的上下文交接结果；只在 includeContext 时出现。 */
export type ContextHandoffOutcome =
  | { ok: true; result: SessionHandoffResult }
  | { ok: false; error: string }

export interface MembershipTransferOutcome {
  transfer: MembershipTransferResult
  contextHandoff?: ContextHandoffOutcome
}
