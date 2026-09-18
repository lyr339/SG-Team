/**
 * 名册「清除」偏好（localStorage 持久化，对齐 session-order 的防御级别）。
 *
 * 语义是微信会话列表式的「不显示」，不是删除：只对已离线的行生效，会话数据、
 * 通道历史与席位本身都不动——把席位真正移出会话池牵涉任务回队、租约释放与
 * 通道围栏，归会话池页面（阶段 3/4）管。被清除的席位重新上线即自动回到名册
 *（同一行自愈），席位换代重建（新 session id）也自然重新出现。
 */

const STORAGE_KEY = 'shiguang.sessionRail.cleared.v1'
const MAX_IDS = 200

/** 读取已清除的 session id（坏数据静默忽略）。 */
export function readClearedSessions(storage?: Pick<Storage, 'getItem'>): string[] {
  try {
    const raw = (storage ?? window.localStorage).getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length <= 200))].slice(0, MAX_IDS)
  } catch {
    return []
  }
}

/** 写回（失败静默——清除只是名册偏好，不值得打扰用户）。 */
export function persistClearedSessions(ids: readonly string[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    const unique = [...new Set(ids)].filter((id) => typeof id === 'string').slice(0, MAX_IDS)
    ;(storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(unique))
  } catch {
    // 忽略：本轮会话内仍然生效。
  }
}

export interface ClearedPartition<T> {
  /** 名册可见的行。 */
  visible: T[]
  /** 被清除而隐藏的行（仍离线）。 */
  hidden: T[]
  /**
   * 清除名单的收敛结果：去掉已回到线上（自愈显示）与已离开名册（席位换代/出池）
   * 的 id。与传入名单不同才需要回写。
   */
  prunedIds: string[]
}

/**
 * 划分可见与隐藏：只有「仍在名册且仍离线」的清除项隐藏；回到线上的行立刻可见。
 * 纯函数，方便单测与侧栏自愈回写共用一套规则。
 */
export function partitionClearedSessions<T>(
  sessions: readonly T[],
  clearedIds: readonly string[],
  facts: { idOf: (session: T) => string; isOffline: (session: T) => boolean }
): ClearedPartition<T> {
  const cleared = new Set(clearedIds)
  const visible: T[] = []
  const hidden: T[] = []
  const prunedIds: string[] = []
  for (const session of sessions) {
    const id = facts.idOf(session)
    if (cleared.has(id) && facts.isOffline(session)) {
      hidden.push(session)
      prunedIds.push(id)
    } else {
      visible.push(session)
    }
  }
  return { visible, hidden, prunedIds }
}
