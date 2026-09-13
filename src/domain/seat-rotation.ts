import { hasInFlightExecution, isOnDutyPhase } from './channel-message'
import type { TeamRunStatus } from './team-control'

/**
 * 席位自动轮换（独立席位）。
 *
 * 持续会话协议让每个席位的 Cursor 回合永不结束：纯待命席位每个 keepalive 周期也要
 * 长出几个气泡（thinking + 工具调用 + 结果），Cursor 每次写入都对整个 composer 做
 * 持久化并重分组当前回合，成本随气泡数线性增长——这一项没有代码 bug 可修，只能靠
 * 「到阈值换新 Composer」把回合体积压在上限之下。轮换全部复用现有部件：上下文交接
 *（转录路径 + 拾光会话记录以保持位消息留给新会话）→ 会话令牌轮换（旧会话被围栏逐轮
 * 复核踢出）→ 一键建会话链（取开场提示 → CDP 建 Composer → 遥测确认绑定 → 等待待命）。
 *
 * v1 只覆盖独立席位（slot.solo）：团队席位涉及主控权、team_check_in 状态与任务租约，
 * 另行评估。
 */

export interface SeatRotationSettings {
  /** 总开关，默认开。 */
  enabled: boolean
  /**
   * 触发阈值：绑定 Composer 的气泡数 ≥ 该值即成为候选。默认 400（实测 ≈9KB/气泡 ≈ 4MB；
   * 活跃席位 20–30 分钟到；纯待命席位每个 keepalive 周期长 4–5 个，周期 5 分钟时约需数小时）。
   */
  bubbleThreshold: number
}

export const SEAT_ROTATION_THRESHOLD_MIN = 100
export const SEAT_ROTATION_THRESHOLD_MAX = 2_000
export const SEAT_ROTATION_THRESHOLD_STEP = 50

export const DEFAULT_SEAT_ROTATION_SETTINGS: SeatRotationSettings = {
  enabled: true,
  bubbleThreshold: 400
}

/**
 * 必须连续待命的时长。正在对话的席位在用户读回复 / 思考的间隙也是「待命」，1 分钟太短——
 * 会把用户正聊着的会话换掉，下一条消息要等新会话建好并读完转录。5 分钟配合下面的静默守卫，
 * 区分「用户在聊」与「席位闲置」。
 */
export const SEAT_ROTATION_IDLE_MS = 5 * 60_000
/** 静默守卫：通道最近这么久内有过用户消息或回复（时间线活动）就不轮换——那是正在进行的对话。 */
export const SEAT_ROTATION_QUIET_MS = 10 * 60_000
/** 同一通道两次轮换尝试（成功或失败）之间的冷却；名册上的「已自动轮换」提示也只显示这么久。 */
export const SEAT_ROTATION_COOLDOWN_MS = 10 * 60_000
/** 相邻两次轮换（跨通道）之间的全局间隔：重启后多个席位同时超阈值时不连发建会话。 */
export const SEAT_ROTATION_GLOBAL_SPACING_MS = 2 * 60_000
/** 连续失败达到该次数即停用该通道的自动轮换（run 结束或重新开启设置后恢复）。 */
export const SEAT_ROTATION_MAX_CONSECUTIVE_FAILURES = 2

export function normalizeSeatRotationSettings(value: unknown): SeatRotationSettings {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const threshold = typeof raw.bubbleThreshold === 'number' && Number.isFinite(raw.bubbleThreshold)
    ? Math.round(raw.bubbleThreshold / SEAT_ROTATION_THRESHOLD_STEP) * SEAT_ROTATION_THRESHOLD_STEP
    : DEFAULT_SEAT_ROTATION_SETTINGS.bubbleThreshold
  return {
    // 默认开：字段缺失（首次运行 / 旧设置文件）按开处理，只有显式 false 才关。
    enabled: raw.enabled !== false,
    bubbleThreshold: Math.min(SEAT_ROTATION_THRESHOLD_MAX, Math.max(SEAT_ROTATION_THRESHOLD_MIN, threshold))
  }
}

/**
 * rotating：进行中；done：新会话就绪且已收到上下文交接；partial：新会话就绪但交接消息没投出去
 *（新会话没有上一段的上下文，用户需要知道）；failed：新会话未能就绪；disabled：连续失败停用。
 */
export type SeatRotationStatus = 'rotating' | 'done' | 'partial' | 'failed' | 'disabled'

/** 一次轮换的可见结果：投影到 AgentSession.seatRotation，名册卡据此提示。 */
export interface SeatRotationNotice {
  status: SeatRotationStatus
  /** 触发时的气泡数。 */
  bubbleCount: number
  at: number
  message: string
}

/** 名册是否还需要展示该通知：成功提示只在冷却期内显示，其余状态一直显示到被替换或 run 结束。 */
export function isSeatRotationNoticeVisible(notice: SeatRotationNotice | undefined, now: number): notice is SeatRotationNotice {
  if (!notice) return false
  if (notice.status === 'done') return now - notice.at < SEAT_ROTATION_COOLDOWN_MS
  return true
}

export function seatRotationNoticeLabel(notice: SeatRotationNotice): string {
  switch (notice.status) {
    case 'rotating': return '自动轮换中'
    case 'done': return `已自动轮换 · ${notice.bubbleCount} 气泡`
    case 'partial': return '已轮换 · 未交接上下文'
    case 'failed': return '自动轮换失败'
    case 'disabled': return '自动轮换已停用'
  }
}

/** 通道时间线的最近活动时刻（用户消息 / 回复，含排队消息的投递时刻）；静默消息不算。 */
export function lastConversationActivityAt(
  entries: ReadonlyArray<{ timestamp: number; deliveredAt?: number; silent?: boolean }> | undefined
): number | undefined {
  let latest: number | undefined
  for (const entry of entries ?? []) {
    if (entry.silent) continue
    const at = Math.max(entry.timestamp, entry.deliveredAt ?? 0)
    if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at
  }
  return latest
}

/** 决策所需的席位事实（从 AgentSession + TeamMemberView 投影，纯数据便于测试）。 */
export interface SeatRotationSeatFacts {
  channelId: string
  /** 独立席位（slot.solo）。 */
  solo: boolean
  /** 席位已签发会话令牌：围栏可用，才能保证旧会话取不到后续消息。 */
  hasSessionToken: boolean
  online: boolean
  /** check_messages 调用栈内为 true；keepalive 推理间隙为 false。 */
  waiting: boolean
  connectionPhase?: string
  queueDepth: number
  pendingOutboundId?: string
  awaitingUser?: boolean
  composerId?: string
  composerBubbleCount?: number
  /** 直播正文正在流式输出（liveAgentResponses[ch].status === 'streaming'）。 */
  streaming: boolean
  /** 通道时间线最近一次用户消息 / 回复的时刻（见 lastConversationActivityAt）；没有历史时缺省。 */
  lastActivityAt?: number
}

/**
 * 席位此刻是否「在岗但空闲」：在线、处于协议内相位且不在处理中、队列为空、没有待同步回复、
 * 不在等用户决策、正文没有在流。keepalive 推理间隙（waiting=false、相位 keepalive）也算空闲：
 * 连续待命的计时不能被每个周期末尾的模型间隙打断，否则窗口一旦短于 SEAT_ROTATION_IDLE_MS 就永远凑不齐。
 */
export function isSeatIdle(facts: SeatRotationSeatFacts): boolean {
  if (!facts.online) return false
  const phase = facts.connectionPhase ?? ''
  if (hasInFlightExecution({ connectionPhase: phase })) return false
  if (!facts.waiting && !isOnDutyPhase(phase)) return false
  return facts.queueDepth === 0
    && !facts.pendingOutboundId
    && facts.awaitingUser !== true
    && !facts.streaming
}

export type SeatRotationSkipReason =
  | 'disabled'
  | 'run_not_running'
  | 'not_solo'
  | 'no_session_token'
  | 'no_composer'
  | 'below_threshold'
  | 'not_idle'
  | 'idle_too_short'
  | 'recent_activity'
  | 'not_in_poll'
  | 'cooldown'
  | 'global_spacing'
  | 'channel_disabled'
  | 'busy'

export type SeatRotationVerdict =
  | { rotate: true; bubbleCount: number }
  | { rotate: false; reason: SeatRotationSkipReason }

export interface SeatRotationChannelState {
  /** 上次轮换尝试（成功或失败）的时刻；冷却期以它为基准。 */
  lastAttemptAt?: number
  consecutiveFailures: number
}

/**
 * 逐席位判定（纯函数）。全部条件成立才轮换：
 * 开关开 → run 运行中 → 独立席位 → 有令牌 → 有 Composer → 气泡数达阈值 → 该通道未被停用 →
 * 不在冷却期 → 距上一次任何通道的轮换 ≥ 全局间隔 → 此刻空闲 → 已连续空闲 ≥ SEAT_ROTATION_IDLE_MS →
 * 通道时间线最近 SEAT_ROTATION_QUIET_MS 内没有消息往来（用户没在聊）→ presence 声明 waiting=true
 *（长轮询中，或 keepalive 返回后的推理间隙——服务端在两处都置 waiting=true；令牌一换，前者在下一轮
 * 取队列复核时 ≤1s 退出，后者在下一次 check_messages 调用开始时被围栏拒绝，都取不到之后的消息）→
 * 没有别的会话创建 / 轮换在进行。
 */
export function seatRotationVerdict(input: {
  settings: SeatRotationSettings
  runStatus: TeamRunStatus | undefined
  facts: SeatRotationSeatFacts
  /** 该席位从何时起持续空闲（由调用方跨快照跟踪）；未空闲时为 undefined。 */
  idleSince: number | undefined
  channel: SeatRotationChannelState
  /** 上一次轮换尝试（任何通道）的时刻；全局间隔以它为基准。 */
  lastGlobalAttemptAt?: number
  busy: boolean
  now: number
}): SeatRotationVerdict {
  const { settings, facts, channel } = input
  if (!settings.enabled) return { rotate: false, reason: 'disabled' }
  if (input.runStatus !== 'running') return { rotate: false, reason: 'run_not_running' }
  if (!facts.solo) return { rotate: false, reason: 'not_solo' }
  if (!facts.hasSessionToken) return { rotate: false, reason: 'no_session_token' }
  if (!facts.composerId) return { rotate: false, reason: 'no_composer' }
  const bubbleCount = facts.composerBubbleCount
  if (bubbleCount === undefined || bubbleCount < settings.bubbleThreshold) return { rotate: false, reason: 'below_threshold' }
  if (channel.consecutiveFailures >= SEAT_ROTATION_MAX_CONSECUTIVE_FAILURES) return { rotate: false, reason: 'channel_disabled' }
  if (channel.lastAttemptAt !== undefined && input.now - channel.lastAttemptAt < SEAT_ROTATION_COOLDOWN_MS) {
    return { rotate: false, reason: 'cooldown' }
  }
  if (input.lastGlobalAttemptAt !== undefined && input.now - input.lastGlobalAttemptAt < SEAT_ROTATION_GLOBAL_SPACING_MS) {
    return { rotate: false, reason: 'global_spacing' }
  }
  if (!isSeatIdle(facts)) return { rotate: false, reason: 'not_idle' }
  if (input.idleSince === undefined || input.now - input.idleSince < SEAT_ROTATION_IDLE_MS) {
    return { rotate: false, reason: 'idle_too_short' }
  }
  if (facts.lastActivityAt !== undefined && input.now - facts.lastActivityAt < SEAT_ROTATION_QUIET_MS) {
    return { rotate: false, reason: 'recent_activity' }
  }
  if (!facts.waiting) return { rotate: false, reason: 'not_in_poll' }
  if (input.busy) return { rotate: false, reason: 'busy' }
  return { rotate: true, bubbleCount }
}

/** 交接消息里的说明：让新会话知道为什么会收到这份上下文。 */
export function seatRotationHandoffNote(bubbleCount: number): string {
  return `自动轮换：上一段会话已累计 ${bubbleCount} 个气泡（Cursor 单会话体积上限策略），拾光替你换了一个新的 Composer。通道历史与任务不变，请读完上下文后回复「已接手」并继续待命。`
}
