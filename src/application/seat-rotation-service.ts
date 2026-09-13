import type { AgentLaunchPlan } from '../domain/agent-launch'
import type { SessionHandoffContext, SessionHandoffResult, SessionHandoffTarget } from '../domain/session-handoff'
import {
  SEAT_ROTATION_MAX_CONSECUTIVE_FAILURES,
  isSeatIdle,
  lastConversationActivityAt,
  seatRotationHandoffNote,
  seatRotationVerdict,
  type SeatRotationChannelState,
  type SeatRotationNotice,
  type SeatRotationSeatFacts,
  type SeatRotationSettings
} from '../domain/seat-rotation'
import type { ConversationEntry } from '../domain/conversation-entry'
import type { TeamControlSnapshot } from '../domain/team-control'
import type { DesktopSnapshot } from '../shared/desktop-api'

export interface SeatRotationPorts {
  sessions: {
    getSnapshot(): DesktopSnapshot
    subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void
    /** 席位现任会话的围栏令牌（轮换前记下，作为交接消息的保持位）。 */
    currentSessionToken(channelId: string): string | undefined
    /** 把轮换结果投影进会话视图（名册提示）。 */
    noteSeatRotation(channelId: string, notice: SeatRotationNotice | undefined): void
  }
  /** 通道时间线（relay.conversationsOf）：静默守卫据此判断用户最近是否在这个通道上聊。 */
  conversationsOf(channelId: string): readonly ConversationEntry[] | undefined
  team: {
    getSnapshot(): TeamControlSnapshot
    /** 轮换绑定键与会话令牌（allowIdleOnline：在线但待命的席位也放行）。 */
    prepareComposerRelaunch(channelId: string, options: { allowIdleOnline?: boolean }): string | undefined
  }
  handoff: {
    context(channelId: string): SessionHandoffContext
    deliverFrom(
      source: SessionHandoffContext,
      target: SessionHandoffTarget,
      note?: string,
      options?: { holdSessionToken?: string }
    ): SessionHandoffResult
  }
  launcher: {
    launch(
      requests: string[],
      onProgress?: (plan: AgentLaunchPlan) => void,
      options?: { origin?: AgentLaunchPlan['origin'] }
    ): Promise<AgentLaunchPlan>
    getPlan(): AgentLaunchPlan | undefined
  }
  /** 当前设置（每次评估读取；store.load 足够便宜）。 */
  settings(): SeatRotationSettings
  /** 一键建会话链的进度（与手动创建同一条 IPC 推送，运行页可见）。 */
  onLaunchProgress?: (plan: AgentLaunchPlan) => void
  now?: () => number
  onerror?: (error: unknown) => void
  /** 兜底评估节拍：快照推送之外按固定间隔再评估一次（连续待命时长跨过阈值不一定伴随推送）。 */
  tickMs?: number
  /**
   * 快照推送驱动的评估最小间隔：流式期推送可达 ~10Hz，而决策 1s 一次足够
   *（check_messages 调用栈内的窗口每 65s 里占 60s）。每次评估要取一份团队快照，不能跟着帧率跑。
   */
  minEvaluateIntervalMs?: number
}

const DEFAULT_TICK_MS = 5_000
const DEFAULT_MIN_EVALUATE_INTERVAL_MS = 1_000

/**
 * 席位自动轮换编排（主进程）。
 *
 * 决策见 domain/seat-rotation.ts#seatRotationVerdict；这里只负责跨快照跟踪「连续待命自何时起」、
 * 冷却 / 连续失败计数，以及把一次轮换按固定顺序串起来：
 *
 * 1. 记下旧会话令牌、解析上下文（Composer + 转录路径）——都在轮换之前，轮换后绑定的
 *    composer_id 已清空，context(通道) 定位不到它；
 * 2. prepareComposerRelaunch(allowIdleOnline)：原子轮换绑定键与令牌。旧会话在 check_messages
 *    的下一轮取队列复核围栏时（≤1 个轮询间隔，1s）以 retired 退出，不会取走之后的消息；返回 undefined
 *    表示席位状态刚刚变了（开始干活 / 掉线），本次放弃，不算失败，只重置待命计时；
 * 3. deliverFrom(self, 旧令牌保持位)：上下文文档消息只有新会话能取。投递失败不回滚令牌
 *   （回滚等于把旧会话再拉回来），带着说明继续建会话——没有上下文的新会话也好过一个死席位；
 * 4. launcher.launch([通道])：现有一键建会话链；plan.done 即成功。
 *
 * 同一时刻只轮换一个席位，相邻两次轮换（跨通道）间隔 ≥2 分钟（重启后多席位同时超阈值不连发）；
 * launcher 有手动创建任务进行中时不触发。成功 / 失败都进入 10 分钟冷却；连续失败 2 次停用该通道
 *（run 结束或重新开启设置后恢复）。设置关闭时撤下名册上已结束的轮换提示。
 */
export class SeatRotationService {
  private readonly now: () => number
  private readonly tickMs: number
  private readonly minEvaluateIntervalMs: number
  private lastEvaluatedAt: number | undefined
  private readonly idleSince = new Map<string, { since: number; composerId: string }>()
  private readonly channels = new Map<string, SeatRotationChannelState>()
  private lastGlobalAttemptAt: number | undefined
  private runId: string | undefined
  private inFlight: string | undefined
  private lastEnabled: boolean | undefined
  private unsubscribe: (() => void) | undefined
  private timer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly ports: SeatRotationPorts) {
    this.now = ports.now ?? Date.now
    this.tickMs = ports.tickMs ?? DEFAULT_TICK_MS
    this.minEvaluateIntervalMs = ports.minEvaluateIntervalMs ?? DEFAULT_MIN_EVALUATE_INTERVAL_MS
  }

  start(): void {
    if (this.unsubscribe || this.disposed) return
    this.unsubscribe = this.ports.sessions.subscribe((snapshot) => {
      // 推送节流：距上次评估不足最小间隔就跳过，交给下一帧或兜底节拍。
      if (this.lastEvaluatedAt !== undefined && this.now() - this.lastEvaluatedAt < this.minEvaluateIntervalMs) return
      this.safeEvaluate(snapshot)
    })
    this.timer = setInterval(() => this.safeEvaluate(), this.tickMs)
    this.timer.unref?.()
    this.safeEvaluate()
  }

  stop(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 设置保存后调用：重新开启时清掉停用 / 冷却记录，立刻按新阈值评估一次。 */
  refreshSettings(): void {
    this.safeEvaluate()
  }

  /** 当前正在轮换的通道（测试 / 诊断）。 */
  rotatingChannelId(): string | undefined {
    return this.inFlight
  }

  private safeEvaluate(snapshot?: DesktopSnapshot): void {
    if (this.disposed) return
    try {
      this.evaluate(snapshot ?? this.ports.sessions.getSnapshot())
    } catch (error) {
      this.ports.onerror?.(error)
    }
  }

  /** 同步决策：跟踪待命时长，命中即发起一次轮换（异步，不阻塞快照推送）。 */
  evaluate(snapshot: DesktopSnapshot): void {
    const team = this.ports.team.getSnapshot()
    const run = team.activeRun
    if (run?.id !== this.runId) {
      this.runId = run?.id
      this.idleSince.clear()
      this.channels.clear()
      this.lastGlobalAttemptAt = undefined
    }
    const settings = this.ports.settings()
    // 关闭：撤下名册上已结束的轮换提示（进行中的那条由 finish 收尾）。
    // 重新开启：解除之前的停用与冷却，让用户的显式操作立刻生效。
    if (this.lastEnabled !== undefined && this.lastEnabled !== settings.enabled) {
      for (const channelId of this.channels.keys()) {
        if (channelId !== this.inFlight) this.ports.sessions.noteSeatRotation(channelId, undefined)
      }
      if (settings.enabled) this.channels.clear()
    }
    this.lastEnabled = settings.enabled
    const now = this.now()
    this.lastEvaluatedAt = now
    const busy = this.inFlight !== undefined || this.ports.launcher.getPlan()?.state === 'running'
    // 一次团队快照派生全部事实：TeamControlService.getSnapshot 不是免费的（读库 + 遥测 + 装配），
    // 不能按席位逐个再取。
    const soloByChannel = new Map(team.members.map((member) => [
      member.binding?.channelId ?? member.slot.channelId,
      member.slot.solo === true
    ]))
    const tokenByChannel = new Map(team.bindings
      .filter((binding) => !run || binding.runId === run.id)
      .map((binding) => [binding.channelId, binding.sessionToken?.trim() || undefined]))
    for (const session of snapshot.sessions) {
      const channelId = session.channelId
      const facts: SeatRotationSeatFacts = {
        channelId,
        solo: soloByChannel.get(channelId) === true,
        hasSessionToken: Boolean(tokenByChannel.get(channelId)),
        online: session.online,
        waiting: session.waiting,
        connectionPhase: session.connectionPhase,
        queueDepth: session.queueDepth,
        pendingOutboundId: session.pendingOutboundId,
        awaitingUser: session.awaitingUser,
        composerId: session.composerId,
        composerBubbleCount: session.composerBubbleCount,
        streaming: snapshot.liveAgentResponses?.[channelId]?.status === 'streaming',
        lastActivityAt: lastConversationActivityAt(this.ports.conversationsOf(channelId))
      }
      const idle = isSeatIdle(facts) && Boolean(facts.composerId)
      const tracked = this.idleSince.get(channelId)
      if (!idle) {
        this.idleSince.delete(channelId)
      } else if (!tracked || tracked.composerId !== facts.composerId) {
        // 换了 Composer（重建 / 轮换后）从零计时：新会话刚待命不能立刻又被换掉。
        this.idleSince.set(channelId, { since: now, composerId: facts.composerId! })
      }
      const channel = this.channels.get(channelId) ?? { consecutiveFailures: 0 }
      const verdict = seatRotationVerdict({
        settings,
        runStatus: run?.status,
        facts,
        idleSince: idle ? this.idleSince.get(channelId)?.since : undefined,
        channel,
        lastGlobalAttemptAt: this.lastGlobalAttemptAt,
        busy,
        now
      })
      if (verdict.rotate) {
        void this.rotate(channelId, verdict.bubbleCount)
        return
      }
    }
  }

  private async rotate(channelId: string, bubbleCount: number): Promise<void> {
    if (this.inFlight) return
    this.inFlight = channelId
    const startedAt = this.now()
    const channel = this.channels.get(channelId) ?? { consecutiveFailures: 0 }
    const finish = (notice: SeatRotationNotice | undefined, failed: boolean): void => {
      const next: SeatRotationChannelState = {
        lastAttemptAt: startedAt,
        consecutiveFailures: failed ? channel.consecutiveFailures + 1 : 0
      }
      this.channels.set(channelId, next)
      this.lastGlobalAttemptAt = startedAt
      if (failed && next.consecutiveFailures >= SEAT_ROTATION_MAX_CONSECUTIVE_FAILURES && notice) {
        notice = {
          ...notice,
          status: 'disabled',
          message: `${notice.message}；连续 ${next.consecutiveFailures} 次失败，该通道的自动轮换已停用（run 结束或重新开启设置后恢复）`
        }
      }
      this.ports.sessions.noteSeatRotation(channelId, notice)
      this.inFlight = undefined
    }
    try {
      // 1. 轮换前解析：旧令牌与上下文都要在绑定被改写前拿到。
      const oldToken = this.ports.sessions.currentSessionToken(channelId)
      if (!oldToken) {
        finish({ status: 'failed', bubbleCount, at: startedAt, message: `CH-${channelId} 没有会话令牌，无法安全轮换` }, true)
        return
      }
      let context: SessionHandoffContext
      try {
        context = this.ports.handoff.context(channelId)
      } catch (error) {
        finish({ status: 'failed', bubbleCount, at: startedAt, message: `解析上下文失败：${describe(error)}` }, true)
        return
      }
      if (!context.composerId || !context.transcript) {
        finish({ status: 'failed', bubbleCount, at: startedAt, message: `CH-${channelId} 找不到上下文文档（Composer 未绑定或转录未定位）` }, true)
        return
      }
      // 2. 令牌轮换：返回 undefined = 席位刚刚不再待命，放弃本次（不算失败，重置待命计时）。
      const bindingKey = this.ports.team.prepareComposerRelaunch(channelId, { allowIdleOnline: true })
      if (!bindingKey) {
        this.idleSince.delete(channelId)
        this.inFlight = undefined
        return
      }
      this.ports.sessions.noteSeatRotation(channelId, {
        status: 'rotating', bubbleCount, at: startedAt, message: `会话已累计 ${bubbleCount} 个气泡，正在换新 Composer…`
      })
      // 3. 上下文交接：旧令牌做保持位——旧会话（已被围栏踢出）取不到，新会话第一轮就能取。
      let handoffIssue: string | undefined
      try {
        this.ports.handoff.deliverFrom(context, { kind: 'self' }, seatRotationHandoffNote(bubbleCount), { holdSessionToken: oldToken })
      } catch (error) {
        handoffIssue = describe(error)
        this.ports.onerror?.(error)
      }
      // 4. 建新会话：复用一键建会话链（取开场提示 → CDP 建 Composer → 遥测确认绑定 → 等待待命）。
      //    origin 标记让装配层不把它当成用户的批量创建：会话创建后的账号自动化（奥仔处理 /
      //    加固 / 换号，不可撤销）只跟随手动创建。
      const plan = await this.ports.launcher.launch([channelId], this.ports.onLaunchProgress, { origin: 'seat-rotation' })
      const item = plan.items.find((candidate) => candidate.channelId === channelId)
      if (plan.state === 'done' && item?.stage === 'done') {
        finish(handoffIssue
          ? {
              status: 'partial',
              bubbleCount,
              at: startedAt,
              message: `已换新 Composer（上一段 ${bubbleCount} 气泡），但上下文交接消息没有投出去：${handoffIssue}。新会话没有上一段的上下文，需要时请手动交接`
            }
          : {
              status: 'done',
              bubbleCount,
              at: startedAt,
              message: `已自动轮换：上一段会话累计 ${bubbleCount} 个气泡，新 Composer 已就绪并收到上下文交接`
            }, false)
        return
      }
      finish({
        status: 'failed',
        bubbleCount,
        at: startedAt,
        message: `自动轮换失败：${item?.message || '新会话未能就绪'}。旧会话已退出，请手动一键建会话接续`
          + (handoffIssue ? `（上下文交接消息也未投出去：${handoffIssue}）` : '（上下文交接消息已在队列中等待新会话）')
      }, true)
    } catch (error) {
      this.ports.onerror?.(error)
      finish({ status: 'failed', bubbleCount, at: startedAt, message: `自动轮换失败：${describe(error)}` }, true)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
