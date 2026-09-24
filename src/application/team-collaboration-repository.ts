import type {
  AuthorizedTeamAgent,
  CreateTeamMessageInput,
  TeamAgentRuntimeIdentity,
  TeamCollaborationSnapshot,
  TeamMessage,
  TeamMemberDirectoryEntry
} from '../domain/team-collaboration'

/** 待随 check_messages 内联投递的团队消息：消息本体 + 所在线程的主题。 */
export type TeamInboxRow = TeamMessage & { subject: string }

export interface TeamCollaborationRepository {
  /** 装载 run 内消息；给出 `groupId` 时只装载该协作组的线程与消息（Agent 视角）。 */
  loadRun(runId: string, groupId?: string): TeamCollaborationSnapshot
  revision(): number
  resolveAuthorizedAgent(identity: TeamAgentRuntimeIdentity): AuthorizedTeamAgent
  /**
   * 成员目录：给出 `groupId` 时 = 该组成员；省略时保留旧语义 = run 内全部非 solo 席位
   *（legacy 团队 run 的全员；会话池里则是所有已入组席位，跨组——只供池级视图使用）。
   */
  listRunMembers(runId: string, groupId?: string): TeamMemberDirectoryEntry[]
  clearRun(runId: string, at?: number): boolean
  createMessage(input: CreateTeamMessageInput): TeamMessage
  /**
   * 发给该席位、属于其当前协作组的未读团队消息，按时间升序（阶段 4 · 4C：check_messages 每轮查询）。
   * 孤儿回执（成员出组时名下仍待回应的消息）不再投递——即使它之后重新入同一个组。
   */
  listUnreadForRecipient(input: { runId: string; slotId: string; groupId: string; limit: number }): TeamInboxRow[]
  /** 投递即已读：推进确实发给该接收者且仍未读的消息（notified + read，事件 `message.read`），返回实际推进的 id。 */
  markDelivered(messageIds: string[], recipient: TeamMessage['recipient'], at?: number): string[]
  markRead(messageId: string, recipient: TeamMessage['recipient'], at?: number): TeamMessage
  acknowledge(messageId: string, recipient: TeamMessage['recipient'], at?: number): TeamMessage
  /**
   * 成员出组 / 组解散（任务书 §7 规则 2）：该席位名下仍待回应的 directive / question 标记为孤儿——
   * 尚未投递的（queued / sending）改为 `not_required`，不再投给已出组的会话；已投递的只在
   * `notificationDetail` 追加 `ORPHANED_RECEIPT_DETAIL`，stage 不变。返回受影响的消息 id。
   */
  orphanPendingReceipts(input: { runId: string; slotId: string; groupId?: string; at?: number }): string[]
  close(): void
}
