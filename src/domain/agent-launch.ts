import type { CursorModelSelection } from './cursor-model'

export type AgentLaunchStage = 'trigger' | 'composer' | 'waiting' | 'done' | 'failed'

export type AgentLaunchFailureCode = 'cdp_unavailable' | 'runtime_account_mismatch' | 'membership_blocked' | 'warmup_failed'

export interface AgentLaunchItem {
  channelId: string
  modelSelection?: CursorModelSelection
  stage: AgentLaunchStage
  message: string
  composerId?: string
  /** 结构性失败原因；存在时 UI 可给出针对性引导（如一键重启 Cursor 启用调试端口）。 */
  code?: AgentLaunchFailureCode
}

export interface AgentLaunchRequest {
  channelId: string
  modelSelection?: CursorModelSelection
}

export type AgentLaunchState = 'running' | 'done' | 'failed'

export interface AgentLaunchPlan {
  id: string
  state: AgentLaunchState
  items: AgentLaunchItem[]
  startedAt: number
  finishedAt?: number
  /**
   * 发起来源。缺省 = 用户手动一键建会话；`seat-rotation` = 席位自动轮换换新 Composer。
   * 会话创建后的账号自动化（奥仔处理 / 加固 / 换号）只跟随用户手动的批量创建，
   * 自动轮换不得触发它——那是不可撤销的账号操作。
   */
  origin?: 'seat-rotation'
}
