import { USAGE_HISTORY_RETENTION_MS, reduceUsage, upgradeUsageEstimate, type CursorUsageSample, type UsageObservation, type CursorSessionUsage, type CursorUsageEvent, type CursorUsageSnapshot } from '../domain/cursor-usage'
import type { TeamRunStatus } from '../domain/team-control'

export interface CursorUsageRunState {
  runId?: string
  status?: TeamRunStatus
}

export function cursorUsageRunDecision(
  previous: CursorUsageRunState,
  next: CursorUsageRunState
): { reset: boolean; collecting: boolean } {
  const runChanged = previous.runId !== next.runId
  return {
    // 新批次有新 runId → 切换账本归属（旧 run 冻结归档，不清空）；run 只有 running / completed 两态（阶段 2 · 2B）。
    reset: runChanged,
    collecting: next.status === 'running'
  }
}

/**
 * Cursor 会话用量聚合器（主进程实时态 + 本地持久化回调）。
 *
 * 输入：CursorStreamObserver 的 onUsageEvent（bundle 补丁在每回合
 * turnEnded 推送的真实计费 token）。
 * 输出：composerId → 累积用量快照（含按模型牌价估算的等价 API 成本），
 * 经 IPC 推送渲染层，与会话卡按 composerId 关联展示。
 *
 * 模型归属：优先使用事件模型，缺失时查会话快照；每个原生回合固化一份牌价。
 * 快照深拷贝，隔离内部逐回合账本。
 *
 * run 作用域：每笔账带 runId。新 run 开始（reset）时旧 run 的账本冻结归档而不是清空——
 * 统计页要跨 run 累计（今天 / 7 天 / 30 天、历史会话组），会话卡徽章则由渲染层按
 * runId 过滤，只显示当前 run。历史 run 的账按 USAGE_HISTORY_RETENTION_MS 裁旧，
 * 当前 run 不受此限。显式结束时冻结，在线状态变化不影响计数。
 */
export interface CursorUsageTrackerOptions {
  /** composerId → 当前模型 id（费用估算用；缺省走默认价格档）。 */
  resolveModelForComposer?: (composerId: string) => string | undefined
  /** 变更通知（已节流）；测试可注入短值驱动。生产 800ms。 */
  notifyDelayMs?: number
  /** 测试时钟。 */
  now?: () => number
  /** 启动时恢复的 composer 累积快照（含历史 run）。 */
  initialSnapshot?: CursorUsageSnapshot
  /** 每次计数变化后同步持久化；失败由 tracker 隔离。 */
  persistSnapshot?: (snapshot: CursorUsageSnapshot) => void
  /** 缺省 true；主进程按 TeamRun 状态切换。 */
  collecting?: boolean
  /** 当前 TeamRun id：新入账 / 续记的 composer 打上此归属。无 run 上下文时省略。 */
  runId?: string
}

const DEFAULT_NOTIFY_DELAY_MS = 800

export class CursorUsageTracker {
  private readonly resolveModelForComposer: (composerId: string) => string | undefined
  private readonly notifyDelayMs: number
  private readonly now: () => number
  private readonly persistSnapshot: (snapshot: CursorUsageSnapshot) => void
  private readonly sessions = new Map<string, CursorSessionUsage>()
  private readonly listeners = new Set<(snapshot: CursorUsageSnapshot) => void>()
  private notifyTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  private collecting: boolean
  private runId: string | undefined

  constructor(options: CursorUsageTrackerOptions = {}) {
    this.resolveModelForComposer = options.resolveModelForComposer ?? (() => undefined)
    this.notifyDelayMs = options.notifyDelayMs ?? DEFAULT_NOTIFY_DELAY_MS
    this.now = options.now ?? (() => Date.now())
    this.persistSnapshot = options.persistSnapshot ?? (() => {})
    this.collecting = options.collecting ?? true
    this.runId = options.runId
    for (const [composerId, usage] of Object.entries(options.initialSnapshot ?? {})) {
      this.sessions.set(composerId, structuredClone(usage.ledger ? upgradeUsageEstimate(usage) : { ...usage, quality: 'legacy' as const }))
    }
    this.pruneHistory()
  }

  /** 同一 generation 的权威结算，优先替换该回合的临时估算。 */
  record(event: CursorUsageEvent): void {
    if (!event.generationId) return // 旧补丁没有归属 ID；由带 ID 的内存快照结算。
    this.observe({ kind: 'checkpoint', value: { ...event, generationId: event.generationId } })
  }

  recordTurnSnapshot(event: CursorUsageEvent): void { this.record(event) }

  recordRequestSample(sample: CursorUsageSample): void {
    this.observe({ kind: 'sample', value: sample })
  }

  private observe(observation: UsageObservation): void {
    if (this.disposed || !this.collecting) return
    const event = observation.value
    let previous = this.sessions.get(event.composerId)
    // 同一 composer 跨 run 续用（上游只放行当前 run 绑定的 composer，属理论路径）：
    // V2 旧账没有 generation 身份，只展示到下一 run，新 run 的精确账另起；
    // V3 账本解冻续记、归属改到当前 run——账本连续，不双计也不丢旧账。
    if (previous && previous.runId !== this.runId) {
      if (!previous.ledger) previous = undefined
      else if (previous.ledger.frozenAt !== undefined) {
        const { frozenAt: _unfrozen, ...ledger } = previous.ledger
        previous = { ...previous, ledger }
      }
    }
    const hasPrice = previous?.ledger && Object.hasOwn(previous.ledger.turns, event.generationId)
    const next = reduceUsage(previous, { ...observation, value: {
      ...event, modelId: event.modelId || (hasPrice ? undefined : this.resolveModelForComposer(event.composerId))
    } } as UsageObservation)
    if (!next || next === previous) return
    this.sessions.set(event.composerId, this.stamp(next))
    if (observation.kind === 'checkpoint' || observation.value.stopped) this.persist()
    this.scheduleNotify()
  }

  setCollecting(collecting: boolean): void {
    if (this.disposed) return
    if (this.collecting && !collecting) {
      this.freezeOpenLedgers()
      this.persist()
      this.scheduleNotify()
    }
    this.collecting = collecting
  }

  /**
   * 新 TeamRun 开始：当前账本冻结归档（统计页继续可见）、归属切到新 run、裁掉保留窗口外的旧账。
   * 不清空——会话卡的「旧徽章消失」由渲染层按 runId 过滤实现（usageBelongsToRun）。
   */
  reset(nextRunId?: string): void {
    if (this.disposed) return
    this.freezeOpenLedgers()
    this.runId = nextRunId
    this.pruneHistory()
    this.persist()
    this.scheduleNotify()
  }

  /** 归属标签跟随当前 run；无 run 上下文时不带 runId。 */
  private stamp(usage: CursorSessionUsage): CursorSessionUsage {
    if (usage.runId === this.runId) return usage
    const { runId: _previous, ...rest } = usage
    return this.runId === undefined ? rest : { ...rest, runId: this.runId }
  }

  /** 未冻结的账本一律封口（含迟到结算）；已冻结的历史账不重写冻结时间。 */
  private freezeOpenLedgers(): void {
    const frozenAt = this.now()
    for (const [id, usage] of this.sessions) {
      if (usage.ledger && usage.ledger.frozenAt === undefined) {
        this.sessions.set(id, { ...usage, ledger: { ...usage.ledger, frozenAt } })
      }
    }
  }

  /** 非当前 run 的账超出保留窗口即裁掉；当前 run 无论多久都保留。 */
  private pruneHistory(): void {
    const cutoff = this.now() - USAGE_HISTORY_RETENTION_MS
    for (const [id, usage] of this.sessions) {
      if (usage.runId !== this.runId && usage.lastTurnAt < cutoff) this.sessions.delete(id)
    }
  }

  /** 当前全量快照（当前 run + 冻结的历史 run；深拷贝，调用方可安全持有）。 */
  getSnapshot(): CursorUsageSnapshot {
    const snapshot: CursorUsageSnapshot = {}
    for (const [composerId, usage] of this.sessions) snapshot[composerId] = structuredClone(usage)
    return snapshot
  }

  subscribe(listener: (snapshot: CursorUsageSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.persist()
    this.disposed = true
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = undefined
    this.listeners.clear()
  }

  private persist(snapshot: CursorUsageSnapshot = this.getSnapshot()): void {
    try {
      this.persistSnapshot(snapshot)
    } catch {
      // 用量文件损坏/磁盘只读不影响 Cursor 会话与实时事件主链。
    }
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      if (this.disposed) return
      // 持久化随通知同拍节流（生产 800ms）：请求级采样在 150ms inspect 循环上
      // 高频到达，同步落盘必须合并（织梦同款防抖语义，dispose/reset 兜底写盘）。
      // 快照含历史 run，只深拷贝一次，落盘与推送共用（两者都只序列化、不改写）。
      const snapshot = this.getSnapshot()
      this.persist(snapshot)
      for (const listener of this.listeners) {
        try {
          listener(snapshot)
        } catch {
          // 单个监听者异常不阻断其余推送
        }
      }
    }, this.notifyDelayMs)
    this.notifyTimer.unref?.()
  }
}
