import type { ConversationEntry, ProcessBlock } from './conversation-entry'

export interface VirtualProcessBlockSegment {
  anchorEntryId?: string
  /**
   * true = 该段是锚点回合的「续作」：回合已在回复处封口，块晚于关闭边界、
   * 早于下一条消息投递——Agent 答完用户后没有回到 check_messages 待命，而是在
   * 同一个 Cursor 原生回合里继续工作（典型：会话交接后接续转录里的任务）。
   * 传输噪音（check_messages / keepalive 思考 / capability）在 hook 的
   * processSnapshot 已按气泡整组过滤，能到达这里的封口后块就是真实业务工作；
   * 投影层与封口层把它作为锚点回复之后的独立过程卡展示与持久化，而不是丢弃。
   */
  continuation?: boolean
  blocks: ProcessBlock[]
  startedAt: number
}

function deliveredAt(entry: ConversationEntry, immediateDelivery: boolean): number | undefined {
  return entry.deliveredAt ?? (immediateDelivery ? entry.timestamp : undefined)
}

/**
 * 精确回复关闭边界：replyToEntryId（outboundId 精确链路）关联的回复落库时间。
 * 同一用户消息有多条可见回复时取最早一条（record_reply 去重后正常只有一条）。
 * 旧数据缺少 replyToEntryId 时不设边界，保留时间窗回退语义。
 */
export function replyCloseAtByUserEntryId(entries: readonly ConversationEntry[]): Map<string, number> {
  const closeAt = new Map<string, number>()
  for (const entry of entries) {
    if (entry.role !== 'assistant' || !entry.replyToEntryId) continue
    const existing = closeAt.get(entry.replyToEntryId)
    if (existing === undefined || entry.timestamp < existing) {
      closeAt.set(entry.replyToEntryId, entry.timestamp)
    }
  }
  return closeAt
}

/**
 * 按消息真实投递时间，把一个长期 Cursor turn 的原生块切成用户消息级片段。
 *
 * 虚拟回合窗口（RC-2）：
 * - 开放边界 = outbound.deliveredAt（check_messages 权威投递时间）；
 * - 关闭边界 = 对应 reply.createdAt（replyToEntryId 精确关联）；
 * - 关闭之后、下一条消息投递之前的块属于该锚点的续作段（continuation），
 *   与回合内块分开归属：回合内块随回复封口，续作块挂在回复之后。
 */
export function partitionVirtualProcessBlocks(
  entries: readonly ConversationEntry[],
  blocks: ProcessBlock[],
  fallbackStartedAt: number,
  immediateDelivery = false,
  excludedIds: ReadonlySet<string> = new Set()
): VirtualProcessBlockSegment[] {
  const users = entries
    .filter((entry) => entry.role === 'user' && deliveredAt(entry, immediateDelivery) !== undefined)
    .sort((left, right) => deliveredAt(left, immediateDelivery)! - deliveredAt(right, immediateDelivery)!)
  const replyCloseAt = replyCloseAtByUserEntryId(entries)
  const segments = new Map<string, VirtualProcessBlockSegment>()
  for (const block of blocks) {
    if (excludedIds.has(block.id)) continue
    const startedAt = block.startedAt ?? fallbackStartedAt
    let low = 0
    let high = users.length - 1
    let anchorIndex = -1
    while (low <= high) {
      const middle = (low + high) >>> 1
      if (deliveredAt(users[middle]!, immediateDelivery)! <= startedAt) {
        anchorIndex = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    const anchor = anchorIndex >= 0 ? users[anchorIndex] : undefined
    const closeAt = anchor ? replyCloseAt.get(anchor.id) : undefined
    const continuation = anchor !== undefined && closeAt !== undefined && startedAt > closeAt
    const key = anchor ? (continuation ? `${anchor.id}:continuation` : anchor.id) : '__prelude__'
    const segment = segments.get(key) ?? {
      anchorEntryId: anchor?.id,
      ...(continuation ? { continuation: true } : {}),
      blocks: [],
      startedAt
    }
    segment.blocks.push(block)
    segment.startedAt = Math.min(segment.startedAt, startedAt)
    segments.set(key, segment)
  }
  return [...segments.values()]
}
