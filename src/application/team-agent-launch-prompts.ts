import { buildSoloLaunchHint, type TeamControlSnapshot } from '../domain/team-control'
import type { AgentLaunchPromptPort } from './agent-session-launcher'

export interface TeamAgentLaunchPromptSource {
  getSnapshot(): TeamControlSnapshot
}

/**
 * S4 底层注入：启动提示只保留一句话引导，角色职责 / 目标 / 规范经 MCP instructions 与
 * team_check_in 返回值注入。会话池里每个席位都以独立会话开场（阶段 2 · 2B 起没有团队启动提示）：
 * 入组席位重建后的新会话同样先进入 check_messages，成员关系通知随首个轮询送达。
 */
export function createTeamAgentLaunchPromptPort(source: TeamAgentLaunchPromptSource): AgentLaunchPromptPort {
  return {
    async fetchStartPrompt(channelId: string): Promise<string> {
      const normalizedChannelId = String(channelId ?? '').trim()
      if (!/^\d+$/.test(normalizedChannelId)) throw new Error('通道号无效')

      const team = source.getSnapshot()
      const run = team.activeRun
      if (!run) throw new Error('当前没有可启动的会话池')
      const binding = team.bindings.find((candidate) =>
        candidate.runId === run.id && candidate.channelId === normalizedChannelId
      )
      if (!binding) throw new Error(`CH-${normalizedChannelId} 尚未安装 Team MCP`)
      return buildSoloLaunchHint({ channelId: normalizedChannelId, sessionToken: binding.sessionToken })
    }
  }
}
