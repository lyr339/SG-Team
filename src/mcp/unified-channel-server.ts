import { McpServer } from '@modelcontextprotocol/server'
import type { ChannelMessageService } from '../application/channel-message-service'
import { SG_TEAM_MCP_DISPLAY_NAME } from '../domain/channel-message'
import type { ChannelSessionOwnership } from '../domain/session-fence'
import {
  registerChannelCommunicationTools
} from './channel-communication-tools'
import { createTeamToolVisibility } from './team-tool-visibility'
import {
  buildUnifiedServerInstructions,
  registerTeamTools,
  type TeamChannelRuntime
} from './team-tools'

export interface UnifiedChannelServerOptions {
  /** 按 channel_id 懒加载/缓存团队运行时（未注册通道抛授权错误）。 */
  runtimeFor(channelId: string): TeamChannelRuntime
  /** 按 channel_id 解析通道消息服务。 */
  channelServiceFor(channelId: string): ChannelMessageService
  /** 会话围栏：通道在当前活动 run 内的席位归属（缺省不围栏）。 */
  ownershipFor?: (channelId: string) => ChannelSessionOwnership | undefined
  refreshIdentity?: (channelId: string) => void
  /** team_check_in 返回的角色简报（S4 底层注入）。 */
  briefingFor?: (channelId: string) => string | undefined
  /** keepalive 返回前的空队列等待时长；测试可注入短值，生产用默认 CHANNEL_KEEPALIVE_TIMEOUT_MS（5 分钟，可由环境变量覆盖）。 */
  keepaliveTimeoutMs?: number
  /** record_reply 存储瞬断重试间隔；测试可注入短值。 */
  recordReplyRetryDelayMs?: number
  /**
   * 工具面探针（阶段 4 · 4A）：当前工作区是否有活动协作组。给出时 7 个团队工具随它整体启停
   *（构造时探测一次，之后每次 check_messages 返回前一次）；缺省恒暴露全部工具（测试与全貌度量）。
   */
  teamToolsVisible?: () => boolean
  /** 探针抛错时的上报（工具面保持现状）。 */
  onError?: (error: unknown) => void
}

/**
 * 拾光单一 MCP 服务器：Cursor 面板只出现一条原生条目「SG Team」，
 * 7 个团队工具 + 2 个通信工具同服，全部以 channel_id 参数区分通道；
 * 角色权限按每次调用的通道身份围栏校验（暴露超集、调用时收口）。
 * 团队工具只在工作区有活动协作组时出现在 tools/list 里（阶段 4 · 4A）。
 */
export function createUnifiedChannelServer(options: UnifiedChannelServerOptions): McpServer {
  const server = new McpServer(
    { name: SG_TEAM_MCP_DISPLAY_NAME, version: '1.0.0' },
    { instructions: buildUnifiedServerInstructions() }
  )
  const teamTools = registerTeamTools(server, {
    runtimeFor: options.runtimeFor,
    refreshIdentity: options.refreshIdentity,
    briefingFor: options.briefingFor
  })
  const visibility = options.teamToolsVisible
    ? createTeamToolVisibility(server, teamTools, options.teamToolsVisible, options.onError)
    : undefined
  registerChannelCommunicationTools(server, {
    serviceFor: options.channelServiceFor,
    ownershipFor: options.ownershipFor,
    keepaliveTimeoutMs: options.keepaliveTimeoutMs,
    recordReplyRetryDelayMs: options.recordReplyRetryDelayMs,
    refreshToolSurface: visibility ? () => visibility.refresh() : undefined
  })
  return server
}
