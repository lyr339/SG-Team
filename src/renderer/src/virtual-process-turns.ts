import { conversationEntryProcessBlocks, type ConversationEntry, type ProcessBlock } from '../../domain/conversation-entry'
import { partitionVirtualProcessBlocks, replyCloseAtByUserEntryId } from '../../domain/virtual-process-turn'
import type { LiveAgentResponseState, LiveProcessState } from '../../shared/desktop-api'

/** 回复封口之后 Agent 继续工作的实时产物：过程块与（尚未落库的）正文流。 */
export interface VirtualProcessContinuation {
  process?: LiveProcessState
  response?: LiveAgentResponseState
  /** 历史回放与当前直播续作的边界；只有当前来源才能延续 running 状态。 */
  hasLiveSource?: boolean
}

export interface VirtualProcessTurn {
  id: string
  position: number
  process?: LiveProcessState
  response?: LiveAgentResponseState
  /** 锚点回合已封口后到达的续作（见 VirtualProcessBlockSegment.continuation）。 */
  continuation?: VirtualProcessContinuation
  live: boolean
}

interface TurnGroup {
  anchorId?: string
  blocks: ProcessBlock[]
  continuationBlocks: ProcessBlock[]
  response?: LiveAgentResponseState
  continuationResponse?: LiveAgentResponseState
}

function anchorForTime(entries: readonly ConversationEntry[], timestamp: number, immediateDelivery: boolean): ConversationEntry | undefined {
  let anchor: ConversationEntry | undefined
  for (const entry of entries) {
    if (entry.role !== 'user') continue
    const deliveredAt = entry.deliveredAt ?? (immediateDelivery ? entry.timestamp : undefined)
    if (deliveredAt === undefined || deliveredAt > timestamp) continue
    const anchorDeliveredAt = anchor?.deliveredAt ?? (anchor && immediateDelivery ? anchor.timestamp : -1)
    if (!anchor || deliveredAt >= anchorDeliveredAt) anchor = entry
  }
  return anchor
}

function isRunning(blocks: readonly ProcessBlock[]): boolean {
  return blocks.some((block) => block.status === 'running')
}

/**
 * 把 Cursor 的单个长期原生 turn 投影成拾光用户消息级回合。
 * `deliveredAt` 是消息真正从 check_messages 进入模型的边界；仅入队、尚未取走的
 * 用户消息不会提前夺走正在执行的旧过程。原生 block id 用于剔除已随回复持久化的步骤
 * （封口块与续作块都算）。回复封口之后到达的块/正文流归入该锚点的 continuation，
 * 渲染在回复之下——Agent 答完接着干活时，过程流不再消失。
 */
export function projectVirtualProcessTurns(
  entries: readonly ConversationEntry[],
  process?: LiveProcessState,
  response?: LiveAgentResponseState,
  immediateDelivery = false
): VirtualProcessTurn[] {
  if (!process?.blocks.length && !response) return []

  const persistedBlockIds = new Set(entries.flatMap((entry) => (
    conversationEntryProcessBlocks(entry).map((block) => block.id)
  )))
  const groups = new Map<string, TurnGroup>()
  const groupFor = (anchorId?: string): TurnGroup => {
    const key = anchorId ?? '__prelude__'
    const existing = groups.get(key)
    if (existing) return existing
    const created: TurnGroup = { anchorId, blocks: [], continuationBlocks: [] }
    groups.set(key, created)
    return created
  }

  for (const segment of partitionVirtualProcessBlocks(
    entries, process?.blocks ?? [], process?.startedAt ?? 0, immediateDelivery, persistedBlockIds
  )) {
    const group = groupFor(segment.anchorEntryId)
    if (segment.continuation) group.continuationBlocks.push(...segment.blocks)
    else group.blocks.push(...segment.blocks)
  }
  if (response) {
    const anchor = anchorForTime(entries, response.startedAt, immediateDelivery)
    const closeAt = anchor ? replyCloseAtByUserEntryId(entries).get(anchor.id) : undefined
    const group = groupFor(anchor?.id)
    if (closeAt !== undefined && response.startedAt > closeAt) group.continuationResponse = response
    else group.response = response
  }

  const entryIndex = new Map(entries.map((entry, index) => [entry.id, index] as const))
  const positionFor = (group: TurnGroup): number => {
    if (!group.anchorId) {
      const startedAt = group.blocks[0]?.startedAt ?? group.response?.startedAt ?? process?.startedAt ?? 0
      const followingEntry = entries.findIndex((entry) => entry.timestamp >= startedAt)
      if (followingEntry >= 0) return followingEntry - 0.5
      const firstUser = entries.findIndex((entry) => entry.role === 'user')
      return firstUser >= 0 ? firstUser - 0.5 : entries.length + 0.5
    }
    const anchorIndex = entryIndex.get(group.anchorId) ?? entries.length - 1
    let nextUserIndex = entries.findIndex((entry, index) => index > anchorIndex && entry.role === 'user')
    if (nextUserIndex < 0) nextUserIndex = entries.length
    const explicitReplyIndex = entries.findIndex((entry, index) => (
      index > anchorIndex && index < nextUserIndex && entry.replyToEntryId === group.anchorId
    ))
    const replyIndex = explicitReplyIndex >= 0 ? explicitReplyIndex : entries.findIndex((entry, index) => (
      index > anchorIndex && index < nextUserIndex && entry.role === 'assistant'
    ))
    return replyIndex >= 0 ? replyIndex - 0.5 : anchorIndex + 0.5
  }

  let truncationAssigned = false
  const segmentProcess = (
    blocks: ProcessBlock[],
    suffix: string,
    segmentResponse?: LiveAgentResponseState
  ): LiveProcessState | undefined => {
    if (!blocks.length || !process) return undefined
    const view: LiveProcessState = {
      ...process,
      turn: `${process.turn}:virtual:${suffix}`,
      blocks,
      startedAt: blocks[0]?.startedAt ?? segmentResponse?.startedAt ?? process.startedAt,
      truncatedItemCount: !truncationAssigned ? process.truncatedItemCount : undefined
    }
    truncationAssigned = true
    return view
  }
  return [...groups.values()]
    .filter((group) => group.blocks.length || group.response || group.continuationBlocks.length || group.continuationResponse)
    .map((group): VirtualProcessTurn => {
      const anchor = group.anchorId ?? 'prelude'
      const turnProcess = segmentProcess(group.blocks, anchor, group.response)
      const continuationProcess = segmentProcess(group.continuationBlocks, `${anchor}:continuation`, group.continuationResponse)
      const continuation: VirtualProcessContinuation | undefined = continuationProcess || group.continuationResponse
        ? {
            ...(continuationProcess ? { process: continuationProcess } : {}),
            ...(group.continuationResponse ? { response: group.continuationResponse } : {})
          }
        : undefined
      return {
        id: anchor,
        position: positionFor(group),
        process: turnProcess,
        response: group.response,
        ...(continuation ? { continuation } : {}),
        live: group.response?.status === 'streaming'
          || group.continuationResponse?.status === 'streaming'
          || isRunning(group.blocks)
          || isRunning(group.continuationBlocks)
      }
    })
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
}
