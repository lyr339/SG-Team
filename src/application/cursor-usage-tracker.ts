import { USAGE_HISTORY_RETENTION_MS, reduceUsage, upgradeUsageEstimate, type CursorUsageSample, type UsageObservation, type CursorSessionUsage, type CursorUsageEvent, type CursorUsageSnapshot } from '../domain/cursor-usage'

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
 * 会话生命周期 = Composer 生命周期（阶段 2 · 2E）：一个 Composer 一本账，账本的开与关跟着
 * 「席位 ↔ Composer 绑定」走，不跟 run——会话池长生命周期，run 内席位会一个个重建 / 自动轮换。
 * 只有活动 run 在绑的 Composer 入账（窗口里其他会话不进本轮账），入账时打上所绑席位（slotId），
 * 统计页据此把重建前的旧 Composer 仍归到席位、按席位 / 组 / 池求和。离开绑定集合的账本封口
 * （席位重建换了 Composer、池被替换），此后显示值固定、迟到事件不再入账；同一 Composer 重新入绑
 * 时解冻续记（账本连续，不双计）。封口且超出 USAGE_HISTORY_RETENTION_MS 的账裁掉，在绑的账
 * 无论多久都保留。用户显式结束 run（endActiveRun）时全部封口（collecting=false），在线状态变化
 * 不影响计数。没有 run 切换语义：新池的 Composer 都是新的，旧池的账随出绑封口、随窗口裁掉。
 */
export interface CursorUsageTrackerOptions {
  /** composerId → 当前模型 id（费用估算用；缺省走默认价格档）。 */
  resolveModelForComposer?: (composerId: string) => string | undefined
  /** 变更通知（已节流）；测试可注入短值驱动。生产 800ms。 */
  notifyDelayMs?: number
  /** 测试时钟。 */
  now?: () => number
  /** 启动时恢复的 composer 累积快照（在绑的开放账本 + 出绑后封口的历史账）。 */
  initialSnapshot?: CursorUsageSnapshot
  /** 每次计数变化后同步持久化；失败由 tracker 隔离。 */
  persistSnapshot?: (snapshot: CursorUsageSnapshot) => void
  /** 缺省 true；主进程按活动 run 是否 running 给出，显式结束后为 false（全部封口）。 */
  collecting?: boolean
  /**
   * 活动 run 当前绑定的 Composer（席位 ↔ Composer）。给出后只有在绑的 Composer 入账并打上席位标签，
   * 出绑的账本封口、超出保留窗口后裁掉（见 setBoundComposers）。省略 = 不按绑定限定：一切 Composer
   * 视为在绑（无 run 上下文 / 测试），不打标签、不封口也不裁旧。
   */
  boundComposers?: Iterable<BoundComposer>
}

/** 一条「席位 ↔ Composer」绑定：Composer 入账时打上 slotId。 */
export interface BoundComposer {
  composerId: string
  slotId: string
}

const DEFAULT_NOTIFY_DELAY_MS = 800

/** 解冻：去掉封口时间，账本继续可记（调用方保证 ledger 存在）。 */
function unfrozen(usage: CursorSessionUsage): CursorSessionUsage {
  const { frozenAt: _unfrozen, ...ledger } = usage.ledger!
  return { ...usage, ledger }
}

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
  /** composerId → slotId；undefined = 不按绑定限定。 */
  private bound: Map<string, string> | undefined

  constructor(options: CursorUsageTrackerOptions = {}) {
    this.resolveModelForComposer = options.resolveModelForComposer ?? (() => undefined)
    this.notifyDelayMs = options.notifyDelayMs ?? DEFAULT_NOTIFY_DELAY_MS
    this.now = options.now ?? (() => Date.now())
    this.persistSnapshot = options.persistSnapshot ?? (() => {})
    this.collecting = options.collecting ?? true
    this.bound = options.boundComposers ? boundMap(options.boundComposers) : undefined
    for (const [composerId, usage] of Object.entries(options.initialSnapshot ?? {})) {
      this.sessions.set(composerId, structuredClone(usage.ledger ? upgradeUsageEstimate(usage) : { ...usage, quality: 'legacy' as const }))
    }
    // 落盘的账与当前「绑定 × 采集」对齐：旧构建里重建席位不封口，可能留下「已出绑却仍开放」的账本，
    // 启动即补封；结束后被杀的进程可能来不及封口，collecting=false 时一律封口；再裁旧。
    this.reconcileLedgers()
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
    if (!this.isBound(event.composerId)) return // 窗口里未绑进活动 run 的会话不进本轮账
    let previous = this.sessions.get(event.composerId)
    // V2 旧账没有 generation 身份，无法与 V3 账本合并：在绑的 Composer 再次入账时整行换成精确账
    //（否则这本账会永远挡住新结算）。封口的账本在这里一律不再记——解冻只发生在重新入绑时。
    if (previous && !previous.ledger) previous = undefined
    const hasPrice = previous?.ledger && Object.hasOwn(previous.ledger.turns, event.generationId)
    const next = reduceUsage(previous, { ...observation, value: {
      ...event, modelId: event.modelId || (hasPrice ? undefined : this.resolveModelForComposer(event.composerId))
    } } as UsageObservation)
    if (!next || next === previous) return
    this.sessions.set(event.composerId, this.tagSlot(next))
    if (observation.kind === 'checkpoint' || observation.value.stopped) this.persist()
    this.scheduleNotify()
  }

  /**
   * 采集开关：false = 用户显式结束了 run，全部开放账本封口（含迟到结算）并落盘；
   * true = 新的活动 run 在运行——账本是否开放仍由随后的 setBoundComposers 按绑定决定。
   */
  setCollecting(collecting: boolean): void {
    if (this.disposed) return
    if (this.collecting && !collecting) {
      this.freezeLedgers(() => true)
      this.persist()
      this.scheduleNotify()
    }
    this.collecting = collecting
  }

  /**
   * 活动 run 的绑定集合变化（席位重建换 Composer、池被替换、新会话绑定）：
   * 出绑的账本封口（此后显示值固定，迟到事件不再入账）；在绑的封口账本在采集中时解冻
   * （同一 Composer 重新绑定——账本连续）；封口且超出保留窗口的账裁掉。有变化才落盘与推送。
   */
  setBoundComposers(bound: Iterable<BoundComposer>): void {
    if (this.disposed) return
    this.bound = boundMap(bound)
    const changed = this.reconcileLedgers()
    const before = this.sessions.size
    this.pruneHistory()
    if (!changed && this.sessions.size === before) return
    this.persist()
    this.scheduleNotify()
  }

  /** 未给出绑定集合 = 不按绑定限定（一切 Composer 视为在绑）。 */
  private isBound(composerId: string): boolean {
    return this.bound === undefined || this.bound.has(composerId)
  }

  /** 席位标签跟随当前绑定；无绑定上下文时保留账上已有的标签。 */
  private tagSlot(usage: CursorSessionUsage): CursorSessionUsage {
    const slotId = this.bound?.get(usage.composerId)
    return slotId === undefined || usage.slotId === slotId ? usage : { ...usage, slotId }
  }

  /**
   * 账本状态与「绑定 × 采集」对齐：未采集 → 全部封口；采集中 → 不在绑的封口、在绑的解冻。
   * 返回是否有账本变化。
   */
  private reconcileLedgers(): boolean {
    if (!this.collecting) return this.freezeLedgers(() => true)
    const bound = this.bound
    if (!bound) return false
    let changed = this.freezeLedgers((id) => !bound.has(id))
    for (const id of bound.keys()) {
      const usage = this.sessions.get(id)
      if (usage?.ledger && usage.ledger.frozenAt !== undefined) {
        this.sessions.set(id, unfrozen(usage))
        changed = true
      }
    }
    return changed
  }

  /** 选中的开放账本封口，已封口的不重写封口时间；返回是否有账本被封。 */
  private freezeLedgers(select: (composerId: string) => boolean): boolean {
    const frozenAt = this.now()
    let changed = false
    for (const [id, usage] of this.sessions) {
      if (usage.ledger && usage.ledger.frozenAt === undefined && select(id)) {
        this.sessions.set(id, { ...usage, ledger: { ...usage.ledger, frozenAt } })
        changed = true
      }
    }
    return changed
  }

  /**
   * 不在绑的账超出保留窗口即裁掉——长生命周期的池里，重建 / 轮换过的席位会留下旧 Composer 的账，
   * 与被替换的池同等对待；在绑的账无论多久都保留。未给出绑定集合时不裁。
   */
  private pruneHistory(): void {
    if (!this.bound) return
    const cutoff = this.now() - USAGE_HISTORY_RETENTION_MS
    for (const [id, usage] of this.sessions) {
      if (!this.bound.has(id) && usage.lastTurnAt < cutoff) this.sessions.delete(id)
    }
  }

  /** 当前全量快照（在绑的开放账本 + 封口的历史账；深拷贝，调用方可安全持有）。 */
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
      // 高频到达，同步落盘必须合并（织梦同款防抖语义，dispose/封口兜底写盘）。
      // 快照含历史账，只深拷贝一次，落盘与推送共用（两者都只序列化、不改写）。
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

function boundMap(bound: Iterable<BoundComposer>): Map<string, string> {
  const map = new Map<string, string>()
  for (const { composerId, slotId } of bound) map.set(composerId, slotId)
  return map
}
