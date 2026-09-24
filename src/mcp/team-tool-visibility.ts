import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server'

/**
 * 团队工具可见性（阶段 4 · 4A）。
 *
 * 一个 MCP 进程 = 一个 Cursor 窗口 = 该窗口内全部通道，`tools/list` 不带通道信息，所以可见性只能按
 * 工作区决定：活动 run 没有活动协作组时只暴露两项通信工具，有组时暴露全部 9 个。切换直接写 SDK 的
 * `RegisteredTool.enabled`，再发一次 `notifications/tools/list_changed`（逐个 enable/disable 会发七次）；
 * Cursor 收到即重拉工具列表，不响应时退化为「重载 MCP 才刷新」，入组通知里带有这条退化提示。
 *
 * 何时探测：构造时一次（首个 tools/list 就正确），之后每次 check_messages 返回前一次。建组 / 解散的
 * 同一刻拾光会向成员投递成员关系通知，正在长轮询的成员立即返回，于是 list_changed 总是先于通知正文
 * 到达 Cursor——不需要定时器，也不在业务层埋钩子。
 */
export interface TeamToolVisibility {
  readonly visible: boolean
  /** 重新探测；结果变化时切换全部团队工具并发一次 list_changed。探测抛错保持现状，工具面不因存储瞬断抖动。 */
  refresh(): void
}

export function createTeamToolVisibility(
  server: McpServer,
  tools: readonly RegisteredTool[],
  probe: () => boolean,
  onError: (error: unknown) => void = () => {}
): TeamToolVisibility {
  // 起点为「全部可见」：探测失败时宁可让未入组席位多看到 7 个工具，也不能让入组席位失去它们。
  let visible = true
  const probeSafely = (): boolean | undefined => {
    try {
      return probe()
    } catch (error) {
      onError(error)
      return undefined
    }
  }
  const apply = (next: boolean, announce: boolean): void => {
    if (next === visible) return
    visible = next
    for (const tool of tools) tool.enabled = next
    if (announce) server.sendToolListChanged()
  }
  // 构造时静默套用：此刻还没有连接，首个 tools/list 直接读到正确的工具面。
  const initial = probeSafely()
  if (initial !== undefined) apply(initial, false)
  return {
    get visible() {
      return visible
    },
    refresh: () => {
      const next = probeSafely()
      if (next !== undefined) apply(next, true)
    }
  }
}
