import type { CursorModelSelection } from './cursor-model'

export type AgentLaunchStage = 'trigger' | 'composer' | 'waiting' | 'done' | 'failed'

export type AgentLaunchFailureCode = 'cdp_unavailable' | 'runtime_account_mismatch' | 'membership_blocked' | 'warmup_failed'

export interface AgentLaunchItem {
  channelId: string
  modelSelection?: CursorModelSelection
  stage: AgentLaunchStage
  message: string
  composerId?: string
  /** Observability only: an existing on-duty Composer must not be counted as a new creation. */
  creation?: 'new' | 'existing'
  /** Actual creation+submit API acceptance, distinct from binding and Agent readiness. */
  submitted?: boolean
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
}
