import type { AssignedAgentSkill } from './agent-skill'

export type TeamMessageKind = 'directive' | 'question' | 'response' | 'status' | 'notice'

export type TeamMessageNotificationState =
  | 'queued'
  | 'sending'
  | 'notified'
  | 'uncertain'
  | 'failed'
  | 'not_required'

export type TeamMessageReceiptStage =
  | 'queued'
  | 'notified'
  | 'read'
  | 'acknowledged'
  | 'responded'
  | 'uncertain'
  | 'failed'

export type TeamMessageActor =
  | { type: 'agent'; slotId: string }
  | { type: 'operator' }

export interface TeamMessageReceipt {
  notificationState: TeamMessageNotificationState
  notificationCommandId?: string
  notificationDetail: string
  notifiedAt?: number
  readAt?: number
  acknowledgedAt?: number
  respondedAt?: number
  responseMessageId?: string
  updatedAt: number
}

export interface TeamMessage {
  id: string
  runId: string
  threadId: string
  sender: TeamMessageActor
  recipient: TeamMessageActor
  kind: TeamMessageKind
  content: string
  replyToMessageId?: string
  clientMessageId: string
  createdAt: number
  receipt: TeamMessageReceipt
  /**
   * 所属协作组（会话池）：写入时的快照——显式传入，或由接收方 / 发送方席位当时的组推得；不回填。
   * 空 = legacy 团队 run 的 run 级消息。Agent 视角只见同组消息；操作员视角按 run 看全部。
   */
  groupId?: string
}

export interface TeamMessageThread {
  id: string
  runId: string
  subject: string
  createdAt: number
  updatedAt: number
  /** 线程随首条消息定组；同一线程内的消息都属同组。 */
  groupId?: string
}

export interface TeamCollaborationEvent {
  seq: number
  type: string
  runId: string
  threadId?: string
  messageId?: string
  actor: TeamMessageActor
  detail?: string
  at: number
}

export interface TeamCollaborationSnapshot {
  schemaVersion: 1
  revision: number
  seq: number
  runId?: string
  /** 快照作用域：给出时 threads / messages 只含该组；空 = 整个 run（操作员视角 / legacy）。 */
  groupId?: string
  threads: TeamMessageThread[]
  messages: Record<string, TeamMessage>
  messageOrder: string[]
  events: TeamCollaborationEvent[]
  updatedAt: number
}

export interface CreateTeamMessageInput {
  runId: string
  sender: TeamMessageActor
  recipient: TeamMessageActor
  kind: TeamMessageKind
  content: string
  clientMessageId: string
  subject?: string
  threadId?: string
  replyToMessageId?: string
  /**
   * 目标协作组。省略时由仓储按「接收方席位的组 → 发送方席位的组」推得（写入时快照），
   * 让操作员 / 编排器发给入组成员的消息自动落进该组；显式给出时双方席位都必须在该组内。
   */
  groupId?: string
}

export interface AuthorizedTeamAgent {
  agentSessionId: string
  workspaceId: string
  runId: string
  slotId: string
  channelId: string
  roleKey: string
  roleTemplateKey: string
  roleName: string
  capabilities: string[]
  skills: AssignedAgentSkill[]
  /** 是否为临时主控：主控离线时由系统或手动指定，优先级高于角色模板。 */
  isActingLead?: boolean
  /** 当前唯一有效主控；acting lead 存在时原始 lead 为 false。组内以组的 lead / acting lead 为准。 */
  isEffectiveLead?: boolean
  /** 所在协作组（会话池）；legacy 团队 run 的成员没有。 */
  groupId?: string
}

/** 通道活性状态。 */
export type ChannelLiveness =
  | 'active'           // 已验证活跃
  | 'suspected_offline' // 疑似离线（ping 失败但未确认）
  | 'confirmed_offline' // 已确认离线（连续多次 ping 失败）

export interface ChannelLivenessRecord {
  channelId: string
  liveness: ChannelLiveness
  lastVerifiedAt: number
  consecutiveFailures: number
  lastPingAt?: number
  lastPongAt?: number
}

export interface TeamMemberDirectoryEntry {
  slotId: string
  roleKey: string
  roleTemplateKey: string
  roleName: string
  channelId?: string
  capabilities: string[]
  skills: AssignedAgentSkill[]
  isEffectiveLead?: boolean
  groupId?: string
}

export interface TeamAgentRuntimeIdentity {
  agentSessionId: string
  runId: string
  slotId: string
  capabilities: string[]
  /** 所在协作组；每次工具调用前由 refreshIdentity 实时解析，入组 / 出组即时生效。 */
  groupId?: string
}

export function emptyTeamCollaborationSnapshot(runId?: string): TeamCollaborationSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    seq: 0,
    runId,
    threads: [],
    messages: {},
    messageOrder: [],
    events: [],
    updatedAt: Date.now()
  }
}

export function teamMessageReceiptStage(receipt: TeamMessageReceipt): TeamMessageReceiptStage {
  if (receipt.respondedAt !== undefined) return 'responded'
  if (receipt.acknowledgedAt !== undefined) return 'acknowledged'
  if (receipt.readAt !== undefined) return 'read'
  if (receipt.notificationState === 'notified' || receipt.notificationState === 'not_required') {
    return 'notified'
  }
  if (receipt.notificationState === 'uncertain') return 'uncertain'
  if (receipt.notificationState === 'failed') return 'failed'
  return 'queued'
}

export function teamMessageRequiresResponse(kind: TeamMessageKind): boolean {
  return kind === 'directive' || kind === 'question'
}

export function sameTeamMessageActor(left: TeamMessageActor, right: TeamMessageActor): boolean {
  return left.type === right.type
    && (left.type === 'operator' || (right.type === 'agent' && left.slotId === right.slotId))
}
