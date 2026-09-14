import type {
  AuthorizedTeamAgent,
  CreateTeamMessageInput,
  TeamAgentRuntimeIdentity,
  TeamCollaborationSnapshot,
  TeamMessage,
  TeamMemberDirectoryEntry
} from '../domain/team-collaboration'

import type { ChannelLivenessRecord } from '../domain/team-collaboration'

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
  markNotificationSending(messageId: string, commandId: string, detail?: string, at?: number): TeamMessage
  markNotificationResult(
    messageId: string,
    result: 'notified' | 'uncertain' | 'failed',
    detail: string,
    at?: number
  ): TeamMessage
  markRead(messageId: string, recipient: TeamMessage['recipient'], at?: number): TeamMessage
  acknowledge(messageId: string, recipient: TeamMessage['recipient'], at?: number): TeamMessage
  listPendingNotifications(runId?: string, limit?: number): TeamMessage[]
  recoverStaleSending(beforeAt: number): number
  /** 记录通道活性验证结果。 */
  recordLiveness(input: { channelId: string; runId: string; verified: boolean; at: number }): void
  /** 获取通道活性记录。 */
  getLiveness(channelId: string, runId: string): ChannelLivenessRecord | undefined
  /** 列出当前 run 的所有活性记录。 */
  listLiveness(runId: string): ChannelLivenessRecord[]
  close(): void
}
