import type { ChannelSessionOwnership } from '../domain/session-fence'
import {
  teamMessageNeedsAgentResponse,
  type TeamInboxBatch,
  type TeamMemberDirectoryEntry,
  type TeamMessageActor
} from '../domain/team-collaboration'
import type { TeamCollaborationRepository } from './team-collaboration-repository'

/**
 * check_messages 取团队消息的端口（阶段 4 · 4C）：团队消息不再经 outbox 信封转投，
 * 长轮询每一轮直接查该通道席位的未读消息，投递即已读。
 */
export interface ChannelTeamInbox {
  /** 通道席位当前所在协作组里发给它的未读消息；未入组、无席位或会话池已结束时为 undefined。 */
  unread(channelId: string, limit: number): TeamInboxBatch | undefined
  markDelivered(batch: TeamInboxBatch, at: number): void
}

/**
 * 归属用会话围栏的轻量查询（每轮本来就要复核），消息用协作仓储的收件查询；
 * 两者都是单条索引 SQL，长轮询每秒一次的成本可以忽略。成员目录只在真有消息时才读。
 */
export function createChannelTeamInbox(deps: {
  ownershipFor(channelId: string): ChannelSessionOwnership | undefined
  collaboration: Pick<TeamCollaborationRepository, 'listUnreadForRecipient' | 'listRunMembers' | 'markDelivered'>
}): ChannelTeamInbox {
  return {
    unread(channelId, limit) {
      const owner = deps.ownershipFor(channelId)
      if (!owner?.bound || owner.runStatus !== 'running' || !owner.slotId || !owner.groupId) return undefined
      const rows = deps.collaboration.listUnreadForRecipient({
        runId: owner.runId,
        slotId: owner.slotId,
        groupId: owner.groupId,
        limit
      })
      if (!rows.length) return undefined
      const members = new Map(deps.collaboration.listRunMembers(owner.runId, owner.groupId)
        .map((member) => [member.slotId, member]))
      return {
        runId: owner.runId,
        slotId: owner.slotId,
        messages: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          senderLabel: senderLabelOf(row.sender, members),
          subject: row.subject,
          content: row.content,
          needsResponse: teamMessageNeedsAgentResponse(row),
          ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {})
        }))
      }
    },
    markDelivered(batch, at) {
      deps.collaboration.markDelivered(
        batch.messages.map((message) => message.id),
        { type: 'agent', slotId: batch.slotId },
        at
      )
    }
  }
}

function senderLabelOf(sender: TeamMessageActor, members: Map<string, TeamMemberDirectoryEntry>): string {
  if (sender.type === 'operator') return '拾光系统'
  const member = members.get(sender.slotId)
  if (!member) return sender.slotId
  return member.channelId ? `${member.roleName} · CH-${member.channelId}` : member.roleName
}
