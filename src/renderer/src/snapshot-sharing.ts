import type { AgentSession } from '../../domain/agent-session'
import type { ConversationEntry } from '../../domain/conversation-entry'
import type { DesktopSnapshot } from '../../shared/desktop-api'

// 会话对象指纹缓存：同一对象只算一次（WeakMap 随 GC 自动清理）。
const sessionFingerprintCache = new WeakMap<AgentSession, string>()
function sessionFingerprint(session: AgentSession): string {
  let fingerprint = sessionFingerprintCache.get(session)
  if (fingerprint === undefined) {
    fingerprint = JSON.stringify(session)
    sessionFingerprintCache.set(session, fingerprint)
  }
  return fingerprint
}

/** 按通道复用旧引用（同进程快路径：预览 / 测试）；跨 IPC 的引用身份已丢失，靠版本号（见 mergeConversations）。 */
function shareByChannel<T>(
  previous: Record<string, T> | undefined,
  incoming: Record<string, T> | undefined
): Record<string, T> | undefined {
  if (!incoming) return incoming
  return Object.fromEntries(Object.entries(incoming).map(([channelId, state]) => [
    channelId,
    previous?.[channelId] === state ? previous[channelId]! : state
  ]))
}

type Conversations = DesktopSnapshot['conversations']
type Revisions = NonNullable<DesktopSnapshot['conversationRevisions']>

/**
 * 时间线按每通道版本号合并，与到达顺序无关：
 * - 主进程推送会省略接收方已持有同版本的通道（`stripKnownConversations`），
 *   拉取回包又可能晚于更新的推送到达——所以不能整体替换，只能逐通道比版本；
 * - 本地版本 ≥ 来包版本：沿用本地数组引用（历史回合的 memo 全部命中，迟到的旧包不回退）；
 * - 来包版本更高且带数组：换新；
 * - 来包版本更高却没带数组（瘦身与拉取竞态的窗口期）：记下版本、留空，
 *   由 `missingConversationChannels` 触发一次完整拉取补齐；
 * - 来包不是迟到包时，版本表里没有的通道即已被移除（作用域切换）；迟到包只补不删。
 * 没有版本号的来包（旧主进程 / 预览夹具）退回整体替换 + 引用复用。
 */
function mergeConversations(
  previous: DesktopSnapshot,
  incoming: DesktopSnapshot,
  stale: boolean
): Pick<DesktopSnapshot, 'conversations' | 'conversationRevisions'> {
  const incomingRevisions = incoming.conversationRevisions
  if (!incomingRevisions) {
    return {
      conversations: shareByChannel(previous.conversations, incoming.conversations) ?? {},
      conversationRevisions: undefined
    }
  }
  const previousRevisions = previous.conversationRevisions ?? {}
  const conversations: Conversations = {}
  const conversationRevisions: Revisions = {}
  const keep = (channelId: string, entries: ConversationEntry[] | undefined, revision: number): void => {
    if (entries) conversations[channelId] = entries
    conversationRevisions[channelId] = revision
  }
  if (stale) {
    for (const [channelId, revision] of Object.entries(previousRevisions)) {
      keep(channelId, previous.conversations[channelId], revision)
    }
  }
  for (const [channelId, revision] of Object.entries(incomingRevisions)) {
    const previousRevision = previousRevisions[channelId]
    const previousEntries = previous.conversations[channelId]
    if (previousEntries && previousRevision !== undefined && previousRevision >= revision) {
      keep(channelId, previousEntries, previousRevision)
      continue
    }
    keep(channelId, incoming.conversations[channelId], revision)
  }
  return { conversations, conversationRevisions }
}

/** 合并结果与本地时间线完全一致（同引用、同版本、同通道集）。 */
function sameTimeline(
  previous: DesktopSnapshot,
  timeline: Pick<DesktopSnapshot, 'conversations' | 'conversationRevisions'>
): boolean {
  const previousRevisions = previous.conversationRevisions ?? {}
  const mergedRevisions = timeline.conversationRevisions ?? {}
  const channels = Object.keys(mergedRevisions)
  if (channels.length !== Object.keys(previousRevisions).length) return false
  return channels.every((channelId) => (
    previousRevisions[channelId] === mergedRevisions[channelId]
    && previous.conversations[channelId] === timeline.conversations[channelId]
  ))
}

type ModelCatalog = Pick<DesktopSnapshot, 'cursorModels' | 'cursorModelsRevision'>

/**
 * 模型目录按版本合并（与时间线同一规则）：本地版本 ≥ 来包沿用本地；来包更高且带目录换新；
 * 来包更高却省略了目录（竞态窗口）记版本留空，由 snapshotGaps 触发补拉。无版本号按来包为准。
 */
function mergeModelCatalog(previous: DesktopSnapshot, incoming: DesktopSnapshot, stale: boolean): ModelCatalog {
  const revision = incoming.cursorModelsRevision
  if (revision === undefined) {
    return stale
      ? { cursorModels: previous.cursorModels, cursorModelsRevision: previous.cursorModelsRevision }
      : { cursorModels: incoming.cursorModels }
  }
  const previousRevision = previous.cursorModelsRevision
  if (previous.cursorModels && previousRevision !== undefined && previousRevision >= revision) {
    return { cursorModels: previous.cursorModels, cursorModelsRevision: previousRevision }
  }
  return { cursorModels: incoming.cursorModels, cursorModelsRevision: revision }
}

/**
 * 把主进程快照（推送或拉取）合并进渲染层状态。
 * 非时间线部分沿用 updatedAt 单调守卫：迟到的旧快照不覆盖会话 / 直播态 / 连接状态；
 * 会话按指纹复用引用，直播态按引用复用。时间线与模型目录按版本合并——
 * 迟到的快照仍可能带来本地缺失的段落，所以对它也要合并而不是丢弃。
 */
export function mergeDesktopSnapshot(previous: DesktopSnapshot, incoming: DesktopSnapshot): DesktopSnapshot {
  if (previous === incoming) return incoming
  if (previous.updatedAt === 0) return incoming
  const stale = incoming.updatedAt < previous.updatedAt
  const timeline = mergeConversations(previous, incoming, stale)
  const catalog = mergeModelCatalog(previous, incoming, stale)
  if (stale) {
    // 迟到包只有真的补上了段落才值得换一个状态对象；否则原样保留，不触发重渲。
    const timelineSame = timeline.conversationRevisions === undefined || sameTimeline(previous, timeline)
    const catalogSame = catalog.cursorModels === previous.cursorModels
    if (timelineSame && catalogSame) return previous
    return {
      ...previous,
      ...(timelineSame ? {} : { conversations: timeline.conversations, conversationRevisions: timeline.conversationRevisions }),
      ...(catalogSame ? {} : catalog)
    }
  }
  const previousSessionsById = new Map(previous.sessions.map((session) => [session.id, session]))
  const sessions = incoming.sessions.map((session) => {
    const old = previousSessionsById.get(session.id)
    return old && sessionFingerprint(old) === sessionFingerprint(session) ? old : session
  })
  const merged: DesktopSnapshot = {
    ...incoming,
    sessions,
    conversations: timeline.conversations,
    liveProcess: shareByChannel(previous.liveProcess, incoming.liveProcess),
    liveAgentResponses: shareByChannel(previous.liveAgentResponses, incoming.liveAgentResponses),
    liveStatusLine: shareByChannel(previous.liveStatusLine, incoming.liveStatusLine)
  }
  if (timeline.conversationRevisions) merged.conversationRevisions = timeline.conversationRevisions
  if (catalog.cursorModels) merged.cursorModels = catalog.cursorModels
  else delete merged.cursorModels
  if (catalog.cursorModelsRevision !== undefined) merged.cursorModelsRevision = catalog.cursorModelsRevision
  return merged
}

/**
 * 版本表里有、本地却没有内容的段落，形如 `conversation:<通道>@<版本>` / `cursorModels@<版本>`：
 * 推送瘦身与拉取回包竞态的窗口期，需要补拉一次完整快照（同一缺口只拉一次，版本进键）。正常情况下为空。
 */
export function snapshotGaps(snapshot: DesktopSnapshot): string[] {
  const revisions = snapshot.conversationRevisions ?? {}
  const gaps = Object.keys(revisions)
    .filter((channelId) => snapshot.conversations[channelId] === undefined)
    .map((channelId) => `conversation:${channelId}@${revisions[channelId]}`)
  if (snapshot.cursorModelsRevision !== undefined && snapshot.cursorModels === undefined) {
    gaps.push(`cursorModels@${snapshot.cursorModelsRevision}`)
  }
  return gaps
}
