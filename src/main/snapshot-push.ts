import type { DesktopSnapshot } from '../shared/desktop-api'

/**
 * 某个接收方（一个 webContents）已持有的可瘦身段落的版本：
 * 每通道时间线，以及 Cursor 模型目录。
 */
export interface SnapshotDeliveryState {
  conversationRevisions: Record<string, number>
  cursorModelsRevision?: number
}

/** 从一份（完整）快照提取「交付后接收方将持有」的版本状态；没有版本号的快照不产生状态。 */
export function deliveryStateOf(snapshot: DesktopSnapshot): SnapshotDeliveryState | undefined {
  if (!snapshot.conversationRevisions) return undefined
  return {
    conversationRevisions: snapshot.conversationRevisions,
    ...(snapshot.cursorModelsRevision === undefined ? {} : { cursorModelsRevision: snapshot.cursorModelsRevision })
  }
}

/**
 * 推送瘦身：接收方已持有同版本的段落，不再随这份快照重复发送。
 *
 * 快照经 `webContents.send` 结构化克隆，序列化成本与字节数成正比；历史时间线
 * （几百条回复 + 过程块）占了一份快照的绝大多数字节，却只在新消息 / 投递 / 回复落库时变化；
 * 模型目录约 80KB，只随 Cursor 偏好变化；而直播态（当前回合的过程块与流式正文）在流式期
 * 以约 10Hz 推送。不瘦身时每一帧都把它们整体序列化一遍——这是拾光长会话卡顿的第三根因。
 *
 * 契约：`conversationRevisions` / `cursorModelsRevision` 始终完整（接收方据此判断哪些段落
 * 沿用本地副本、哪些缺失需要补拉）；`conversations` 只含接收方尚未持有该版本的通道，
 * `cursorModels` 在接收方已持有同版本时省略。没有版本号的快照（旧主进程 / 测试夹具）
 * 与一无所知的接收方（首次推送、页面重载后）都原样发送。
 */
export function stripKnownSections(
  snapshot: DesktopSnapshot,
  known: SnapshotDeliveryState | undefined
): DesktopSnapshot {
  const revisions = snapshot.conversationRevisions
  if (!revisions || !known) return snapshot
  let stripped = false
  const conversations: DesktopSnapshot['conversations'] = {}
  for (const [channelId, entries] of Object.entries(snapshot.conversations)) {
    const revision = revisions[channelId]
    if (revision !== undefined && known.conversationRevisions[channelId] === revision) {
      stripped = true
      continue
    }
    conversations[channelId] = entries
  }
  const stripModels = snapshot.cursorModels !== undefined
    && snapshot.cursorModelsRevision !== undefined
    && known.cursorModelsRevision === snapshot.cursorModelsRevision
  if (!stripped && !stripModels) return snapshot
  const result: DesktopSnapshot = { ...snapshot, conversations }
  if (stripModels) delete result.cursorModels
  return result
}
