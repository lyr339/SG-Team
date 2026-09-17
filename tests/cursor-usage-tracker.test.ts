import { describe, expect, it, vi } from 'vitest'
import { CursorUsageTracker, type BoundComposer } from '../src/application/cursor-usage-tracker'
import { reduceUsage, estimateUsageFromReference, priceForModel, totalUsageTokens, type CursorUsageEvent } from '../src/domain/cursor-usage'

const sample = (used: number, generationId = 'g1', occurredAt = used) => ({ composerId: 'c', generationId, used, occurredAt, modelId: 'gpt-5' })
const exact = (generationId = 'g1'): CursorUsageEvent => ({ composerId: 'c', generationId, inputTokens: 12168, outputTokens: 42, cacheReadTokens: 3968, cacheWriteTokens: 0, occurredAt: 90000, modelId: 'gpt-5' })
/** 席位 ↔ Composer 绑定（主进程从 teamControl 成员的 binding.composerId + slot.id 投影）。 */
const bound = (...pairs: Array<[composerId: string, slotId: string]>): BoundComposer[] => pairs.map(([composerId, slotId]) => ({ composerId, slotId }))

describe('V3 native-turn accounting', () => {
  it('运行中估算→精确结算原子替换，重复快照/binding/迟到采样均不双计', () => {
    const tracker = new CursorUsageTracker()
    tracker.recordRequestSample(sample(10000))
    tracker.recordRequestSample(sample(11000))
    expect(tracker.getSnapshot().c).toMatchObject({ inputTokens: 21000, quality: 'estimated', turns: 1 })
    tracker.record(exact())
    const settled = tracker.getSnapshot()
    expect(settled.c).toMatchObject({ inputTokens: 12168, outputTokens: 42, quality: 'exact', turns: 1 })
    tracker.recordTurnSnapshot(exact())
    tracker.record(exact())
    tracker.recordRequestSample(sample(13000, 'g1', 100000))
    expect(tracker.getSnapshot()).toEqual(settled)
    tracker.dispose()
  })

  it('不同 generation 数值相同也独立累计；乱序结算旧回合不覆盖新回合', () => {
    const tracker = new CursorUsageTracker()
    tracker.recordRequestSample(sample(1000, 'g1', 1))
    tracker.recordRequestSample(sample(1000, 'g2', 2))
    tracker.record(exact('g1'))
    const estimatedOutput = estimateUsageFromReference(1000, 'gpt-5', priceForModel('gpt-5')).outputTokens
    expect(tracker.getSnapshot().c).toMatchObject({ inputTokens: 13168, outputTokens: 42 + estimatedOutput, turns: 2, quality: 'mixed' })
    tracker.record(exact('g2'))
    expect(tracker.getSnapshot().c).toMatchObject({ inputTokens: 24336, outputTokens: 84, turns: 2, quality: 'exact' })
    tracker.dispose()
  })

  it('同值不推进时间、旧样本忽略、压缩回落只影响本回合估算', () => {
    const tracker = new CursorUsageTracker()
    tracker.recordRequestSample(sample(1000, 'g1', 10))
    const original = tracker.getSnapshot()
    tracker.recordRequestSample(sample(1000, 'g1', 12))
    tracker.recordRequestSample(sample(900, 'g1', 9))
    expect(tracker.getSnapshot()).toEqual(original)
    tracker.recordRequestSample(sample(500, 'g1', 15))
    expect(tracker.getSnapshot().c?.inputTokens).toBe(1500)
    tracker.record(exact()) // 真值比估算高/低均直接替换
    expect(tracker.getSnapshot().c?.inputTokens).toBe(12168)
    tracker.dispose()
  })

  it('重启恢复账本后，同 generation 不重复；快照深拷贝', () => {
    const first = new CursorUsageTracker()
    first.recordRequestSample(sample(1000))
    const restored = first.getSnapshot()
    const second = new CursorUsageTracker({ initialSnapshot: restored })
    restored.c!.ledger!.turns.g1!.inputTokens = 999999
    second.recordRequestSample(sample(1000, 'g1', 9999))
    expect(second.getSnapshot().c?.inputTokens).toBe(1000)
    second.record(exact())
    const third = new CursorUsageTracker({ initialSnapshot: second.getSnapshot() })
    third.record(exact())
    expect(third.getSnapshot()).toEqual(second.getSnapshot())
    first.dispose(); second.dispose(); third.dispose()
  })

  it('同池两次席位重建 → 三个桶：出绑即封口并落盘、迟到事件不入账、新 Composer 另起新账；同池不清账，席位标签随入账时的绑定', () => {
    const persist = vi.fn()
    let now = 5000
    const tracker = new CursorUsageTracker({ now: () => now, boundComposers: bound(['c1', 'seat-1']), persistSnapshot: persist })
    tracker.recordRequestSample({ ...sample(1000, 'g1', 10), composerId: 'c1' })
    expect(tracker.getSnapshot().c1).toMatchObject({ inputTokens: 1000, slotId: 'seat-1' })
    // 第一次重建：席位清空 Composer（出绑）→ c1 封口、立即落盘；迟到事件不再入账。
    now = 6000
    tracker.setBoundComposers([])
    expect(tracker.getSnapshot().c1?.ledger?.frozenAt).toBe(6000)
    expect(persist).toHaveBeenLastCalledWith(tracker.getSnapshot())
    tracker.recordRequestSample({ ...sample(2000, 'g1', 20), composerId: 'c1' })
    expect(tracker.getSnapshot().c1).toMatchObject({ inputTokens: 1000, slotId: 'seat-1' })
    // 新 Composer 绑到同一席位：另起新账、标签同一席位；旧账保留（统计页按 slotId 归回该席位）。
    tracker.setBoundComposers(bound(['c2', 'seat-1']))
    tracker.recordRequestSample({ ...sample(500, 'g1', 30), composerId: 'c2' })
    expect(tracker.getSnapshot().c2).toMatchObject({ inputTokens: 500, slotId: 'seat-1' })
    expect(tracker.getSnapshot().c2?.ledger?.frozenAt).toBeUndefined()
    // 第二次重建。
    now = 7000
    tracker.setBoundComposers(bound(['c3', 'seat-1']))
    tracker.recordRequestSample({ ...sample(300, 'g1', 40), composerId: 'c3' })
    const snapshot = tracker.getSnapshot()
    expect(Object.keys(snapshot).sort()).toEqual(['c1', 'c2', 'c3'])
    expect(snapshot.c1?.ledger?.frozenAt).toBe(6000) // 已封口的不重写封口时间
    expect(snapshot.c2?.ledger?.frozenAt).toBe(7000)
    expect(snapshot.c3).toMatchObject({ inputTokens: 300, slotId: 'seat-1' })
    expect(snapshot.c3?.ledger?.frozenAt).toBeUndefined()
    // teamControl 重复推送同一绑定集合：无变化，不落盘。
    persist.mockClear()
    tracker.setBoundComposers(bound(['c3', 'seat-1']))
    expect(persist).not.toHaveBeenCalled()
    tracker.dispose()
  })

  it('只有在绑的 Composer 入账；未给绑定集合 = 不按绑定限定、不打席位标签', () => {
    const restricted = new CursorUsageTracker({ boundComposers: bound(['c', 's']) })
    restricted.recordRequestSample({ ...sample(1000), composerId: 'stranger' })
    restricted.record({ ...exact(), composerId: 'stranger' })
    expect(restricted.getSnapshot()).toEqual({})
    restricted.record(exact())
    expect(restricted.getSnapshot().c).toMatchObject({ slotId: 's', quality: 'exact' })
    const unrestricted = new CursorUsageTracker()
    unrestricted.recordRequestSample({ ...sample(1000), composerId: 'stranger' })
    expect(unrestricted.getSnapshot().stranger).toMatchObject({ inputTokens: 1000 })
    expect(unrestricted.getSnapshot().stranger).not.toHaveProperty('slotId')
    restricted.dispose(); unrestricted.dispose()
  })

  it('显式结束（collecting=false）全部封口含迟到结算，重启保持封口；结束不清绑定，重推同一绑定集合不解冻', () => {
    const seats = bound(['c', 's1'], ['d', 's2'])
    const first = new CursorUsageTracker({ now: () => 5000, boundComposers: seats })
    first.recordRequestSample(sample(1000))
    first.recordRequestSample({ ...sample(700), composerId: 'd' })
    first.setCollecting(false)
    const frozen = first.getSnapshot()
    expect(Object.values(frozen).map((usage) => usage.ledger?.frozenAt)).toEqual([5000, 5000])
    first.record(exact())
    first.setBoundComposers(seats) // 结束后 teamControl 仍会推送同一绑定集合
    expect(first.getSnapshot()).toEqual(frozen)
    // 重启：run 已结束 → collecting=false，账本保持封口、不再记。
    const second = new CursorUsageTracker({ initialSnapshot: frozen, now: () => 6000, collecting: false, boundComposers: seats })
    second.record(exact())
    expect(second.getSnapshot()).toEqual(frozen)
    // 结束后进程被杀、账本没来得及封口：重启（collecting=false）即封口。
    const open = new CursorUsageTracker({ now: () => 5000, boundComposers: seats })
    open.recordRequestSample(sample(1000))
    const third = new CursorUsageTracker({ initialSnapshot: open.getSnapshot(), now: () => 7000, collecting: false, boundComposers: seats })
    expect(third.getSnapshot().c?.ledger?.frozenAt).toBe(7000)
    first.dispose(); second.dispose(); open.dispose(); third.dispose()
  })

  it('重启回放幂等：同一绑定下恢复快照并重放同一 generation 的事件，快照不变', () => {
    const seats = bound(['c', 's'])
    const first = new CursorUsageTracker({ now: () => 5000, boundComposers: seats })
    first.recordRequestSample(sample(1000, 'g1', 1))
    first.record(exact('g1'))
    first.recordRequestSample(sample(400, 'g2', 2))
    const saved = first.getSnapshot()
    const second = new CursorUsageTracker({ initialSnapshot: saved, now: () => 6000, boundComposers: seats })
    second.recordRequestSample(sample(1000, 'g1', 1))
    second.record(exact('g1'))
    second.recordRequestSample(sample(400, 'g2', 2))
    expect(second.getSnapshot()).toEqual(saved)
    first.dispose(); second.dispose()
  })

  it('同一 Composer 出绑再入绑：采集中解冻续记（账本连续不双计）；已结束的 run 里重推绑定不解冻', () => {
    const tracker = new CursorUsageTracker({ now: () => 7000, boundComposers: bound(['c', 's']) })
    tracker.recordRequestSample(sample(1000, 'g1', 10))
    tracker.setBoundComposers([])
    expect(tracker.getSnapshot().c?.ledger?.frozenAt).toBe(7000)
    tracker.setBoundComposers(bound(['c', 's']))
    expect(tracker.getSnapshot().c?.ledger?.frozenAt).toBeUndefined()
    tracker.recordRequestSample(sample(500, 'g1', 20))
    expect(tracker.getSnapshot().c).toMatchObject({ inputTokens: 1500, turns: 1, slotId: 's' })
    tracker.setCollecting(false)
    tracker.setBoundComposers([])
    tracker.setBoundComposers(bound(['c', 's']))
    expect(tracker.getSnapshot().c?.ledger?.frozenAt).toBe(7000)
    tracker.dispose()
  })

  it('启动对齐绑定：旧构建留下的「出绑却开放」账本补封；在绑且采集中的封口账本解冻续记', () => {
    const open = new CursorUsageTracker({ now: () => 1000 })
    open.recordRequestSample(sample(1000, 'g1', 1))
    open.recordRequestSample({ ...sample(500, 'g1', 2), composerId: 'd' })
    const legacy = open.getSnapshot() // 旧构建：两本都开放、都没有席位标签
    const restored = new CursorUsageTracker({ initialSnapshot: legacy, now: () => 2000, boundComposers: bound(['c', 's']) })
    expect(restored.getSnapshot().d?.ledger?.frozenAt).toBe(2000)
    expect(restored.getSnapshot().c?.ledger?.frozenAt).toBeUndefined()
    // 结束后被封的账本，若同一 Composer 在新的运行中仍在绑（采集中）：启动即解冻、续记不双计并补上席位标签。
    restored.setCollecting(false)
    const thawed = new CursorUsageTracker({ initialSnapshot: restored.getSnapshot(), now: () => 3000, boundComposers: bound(['c', 's']) })
    expect(thawed.getSnapshot().c?.ledger?.frozenAt).toBeUndefined()
    expect(thawed.getSnapshot().d?.ledger?.frozenAt).toBe(2000)
    thawed.recordRequestSample(sample(500, 'g1', 3))
    expect(thawed.getSnapshot().c).toMatchObject({ inputTokens: 1500, turns: 1, slotId: 's' })
    open.dispose(); restored.dispose(); thawed.dispose()
  })

  it('出绑的账超出保留窗口即裁掉（绑定变化与启动加载都裁）；在绑的账无论多久都保留', () => {
    const day = 86_400_000
    const now = 100 * day
    const tracker = new CursorUsageTracker({ now: () => now, boundComposers: bound(['c', 's1'], ['old-b', 's2'], ['recent-b', 's3']) })
    tracker.recordRequestSample(sample(100, 'g1', now - 60 * day))
    tracker.recordRequestSample({ ...sample(100, 'g1', now - 60 * day), composerId: 'old-b' })
    tracker.recordRequestSample({ ...sample(100, 'g1', now - 2 * day), composerId: 'recent-b' })
    // 在绑：即便 60 天前的账也不裁。
    expect(Object.keys(tracker.getSnapshot()).sort()).toEqual(['c', 'old-b', 'recent-b'])
    // 席位重建 / 池被替换让 'old-b'、'recent-b' 出绑：60 天前的裁掉，2 天前的封口保留；在绑的 'c' 不动。
    tracker.setBoundComposers(bound(['c', 's1']))
    expect(Object.keys(tracker.getSnapshot()).sort()).toEqual(['c', 'recent-b'])
    expect(tracker.getSnapshot()['recent-b']).toMatchObject({ slotId: 's3' })
    expect(tracker.getSnapshot()['recent-b']?.ledger?.frozenAt).toBe(now)
    expect(tracker.getSnapshot().c?.ledger?.frozenAt).toBeUndefined()
    // 启动加载同样按绑定与窗口裁旧。
    const restored = new CursorUsageTracker({
      initialSnapshot: {
        stale: { composerId: 'stale', slotId: 'z', turns: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, pricedModel: 'GPT', lastTurnAt: now - 40 * day },
        mine: { composerId: 'mine', slotId: 's', turns: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, pricedModel: 'GPT', lastTurnAt: now - 40 * day },
        fresh: { composerId: 'fresh', turns: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, pricedModel: 'GPT', lastTurnAt: now - 30 * day }
      },
      now: () => now,
      boundComposers: bound(['mine', 's'])
    })
    expect(Object.keys(restored.getSnapshot()).sort()).toEqual(['fresh', 'mine'])
    tracker.dispose(); restored.dispose()
  })

  it('价格固定在回合起点，不以晚到事件或新模型重算以前回合', () => {
    const tracker = new CursorUsageTracker()
    tracker.recordRequestSample(sample(1000000))
    tracker.record({ ...exact(), modelId: 'claude-opus-4-1', inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0 })
    expect(tracker.getSnapshot().c?.estimatedCostUsd).toBe(1.25)
    tracker.record({ ...exact('g2'), modelId: 'claude-opus-4-1', inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0 })
    expect(tracker.getSnapshot().c?.estimatedCostUsd).toBe(16.25)
    tracker.dispose()
  })

  it('V2 旧账没有 generation 身份，只展示不相加；在绑 Composer 再次入账时整行换成 V3 精确账', () => {
    const legacyRow = { composerId: 'c', turns: 222, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 900, cacheWriteTokens: 100, estimatedCostUsd: 1, pricedModel: 'old', lastTurnAt: 1 }
    const idle = new CursorUsageTracker({ now: () => 100_000, initialSnapshot: { c: legacyRow }, boundComposers: [] })
    expect(idle.getSnapshot().c).toMatchObject({ quality: 'legacy', inputTokens: 1000, turns: 222 })
    expect(reduceUsage(idle.getSnapshot().c, { kind: 'checkpoint', value: { ...exact(), generationId: 'g1' } })).toMatchObject({ quality: 'legacy' })
    const tracker = new CursorUsageTracker({ now: () => 100_000, initialSnapshot: { c: legacyRow }, boundComposers: bound(['c', 's']) })
    tracker.record(exact())
    expect(tracker.getSnapshot().c).toMatchObject({ quality: 'exact', turns: 1, inputTokens: 12168, slotId: 's' })
    idle.dispose(); tracker.dispose()
  })

  it('非法计数/身份不产生账目，旧无 generation 补丁不猜归属', () => {
    const tracker = new CursorUsageTracker()
    tracker.record({ ...exact(), generationId: undefined })
    tracker.record({ ...exact(), inputTokens: 1 }) // cache > input
    tracker.recordRequestSample(sample(NaN))
    expect(tracker.getSnapshot()).toEqual({})
    expect(reduceUsage(undefined, { kind: 'sample', value: sample(1, '', 1) })).toBeUndefined()
    tracker.dispose()
  })

  it('节流持久化与推送；无变化不写盘；dispose 停止监听', async () => {
    vi.useFakeTimers()
    try {
      const persist = vi.fn(), listener = vi.fn()
      const tracker = new CursorUsageTracker({ persistSnapshot: persist, notifyDelayMs: 800 })
      tracker.subscribe(listener)
      tracker.recordRequestSample(sample(10)); tracker.recordRequestSample(sample(20))
      await vi.advanceTimersByTimeAsync(800)
      expect(persist).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledTimes(1)
      tracker.recordRequestSample(sample(20, 'g1', 30))
      await vi.advanceTimersByTimeAsync(5000)
      expect(listener).toHaveBeenCalledTimes(1)
      tracker.dispose(); tracker.record(exact())
      await vi.advanceTimersByTimeAsync(1000)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('按用户图表比例拆分四类 token，费用使用固定牌价；不是复制图中费用', () => {
    const fixtures = [
      ['claude-fable-5-1-thinking-max', 1343000, 42535000, 345000000, 12706000000],
      ['claude-4.6-opus-max-thinking', 1343000, 42535000, 345000000, 12706000000],
      ['claude-opus-5-thinking-max-fast', 1343000, 42535000, 345000000, 12706000000],
      ['claude-sonnet-4-5', 1343000, 42535000, 345000000, 12706000000],
      ['haiku-4-5', 1343000, 42535000, 345000000, 12706000000],
      ['cursor-grok-4.6-high', 145900, 7288, 0, 322800]
    ] as const
    for (const [model, input, output, write, read] of fixtures) {
      const price = priceForModel(model)
      const row = estimateUsageFromReference(input + write + read, model, price)
      expect(row.outputTokens).toBe(output)
      expect(row.cacheReadTokens).toBe(read)
      expect(row.cacheWriteTokens).toBe(write)
      expect(row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens).toBe(input)
      expect(totalUsageTokens(row)).toBe(input + output + write + read)
      expect(row.estimatedCostUsd).toBeCloseTo((input * price.inputPerM + output * price.outputPerM + write * price.cacheWritePerM + read * price.cacheReadPerM) / 1e6)
    }
  })

  it('中断最后一拍入账后立即持久化；重复停止/晚到样本不再增长，重启保持', () => {
    const persist = vi.fn()
    const tracker = new CursorUsageTracker({ persistSnapshot: persist })
    tracker.recordRequestSample({ ...sample(10000, 'g1', 1), modelId: 'claude-fable-5-1' })
    tracker.recordRequestSample({ ...sample(11000, 'g1', 2), stopped: true })
    const stopped = tracker.getSnapshot()
    expect(stopped.c?.inputTokens).toBe(21000)
    expect(stopped.c!.outputTokens).toBeGreaterThan(0)
    expect(stopped.c!.ledger!.turns.g1?.stopped).toBe(true)
    expect(persist).toHaveBeenCalledWith(stopped)
    tracker.recordRequestSample({ ...sample(11000, 'g1', 3), stopped: true })
    tracker.recordRequestSample(sample(12000, 'g1', 4))
    tracker.record({ ...exact(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(tracker.getSnapshot()).toEqual(stopped)
    const restored = new CursorUsageTracker({ initialSnapshot: stopped })
    restored.recordRequestSample({ ...sample(12000, 'g1', 5), stopped: true })
    expect(restored.getSnapshot()).toEqual(stopped)
    restored.recordRequestSample(sample(13000, 'g2', 6))
    expect(restored.getSnapshot().c?.turns).toBe(2)
    tracker.dispose(); restored.dispose()
  })

  it('同值的终止帧仍封口；跨毫秒内的尾帧不漏账', () => {
    const tracker = new CursorUsageTracker()
    tracker.recordRequestSample(sample(100, 'g1', 1))
    tracker.recordRequestSample({ ...sample(110, 'g1', 1), stopped: true })
    expect(tracker.getSnapshot().c?.inputTokens).toBe(210)
    tracker.recordRequestSample(sample(100, 'g2', 1))
    tracker.recordRequestSample({ ...sample(100, 'g2', 2), stopped: true })
    expect(tracker.getSnapshot().c?.inputTokens).toBe(310)
    expect(tracker.getSnapshot().c?.ledger?.turns.g2?.stopped).toBe(true)
    tracker.dispose()
  })

  it('已有冻结估算用相同输入补输出，第二次恢复数字不再变化，精确账保持', () => {
    const tracker = new CursorUsageTracker()
    tracker.recordRequestSample({ ...sample(278120), modelId: 'claude-fable-5-1' })
    tracker.setCollecting(false)
    const old = tracker.getSnapshot()
    const row = old.c!.ledger!.turns.g1!
    delete row.estimateProfile
    row.outputTokens = 0
    row.cacheWriteTokens = 42999
    row.cacheReadTokens = 235121
    row.estimatedCostUsd = 0.596
    const upgraded = new CursorUsageTracker({ initialSnapshot: old })
    const after = upgraded.getSnapshot()
    expect(after.c?.inputTokens).toBe(278120)
    expect(after.c!.outputTokens).toBeGreaterThan(0)
    expect(after.c?.ledger?.frozenAt).toBe(old.c?.ledger?.frozenAt)
    const restored = new CursorUsageTracker({ initialSnapshot: after })
    expect(restored.getSnapshot()).toEqual(after)
    tracker.dispose(); upgraded.dispose(); restored.dispose()
  })

  it('旧 Claude 比例一次迁移，保留冻结位与单价；精确账和非 Claude 保持原值', () => {
    const old = new CursorUsageTracker()
    old.recordRequestSample({ ...sample(278120), modelId: 'claude-fable-5-1' })
    old.recordRequestSample({ ...sample(2000, 'g2'), modelId: 'cursor-grok-4-6' })
    old.record(exact('g3'))
    old.setCollecting(false)
    const snapshot = old.getSnapshot()
    const claude = snapshot.c!.ledger!.turns.g1!
    claude.estimateProfile = 'fable'
    claude.outputTokens = 2732
    claude.cacheReadTokens = 259756
    claude.cacheWriteTokens = 18360
    claude.estimatedCostUsd = 0.43109125
    const updated = new CursorUsageTracker({ initialSnapshot: snapshot })
    const next = updated.getSnapshot()
    expect(next.c!.ledger!.turns.g1).toMatchObject({
      ...estimateUsageFromReference(278120, 'claude-fable-5-1', claude.price), price: claude.price
    })
    expect(next.c!.ledger!.turns.g1!.outputTokens).toBe(906)
    expect(next.c!.ledger!.frozenAt).toBe(snapshot.c!.ledger!.frozenAt)
    expect(next.c!.ledger!.turns.g2).toEqual(snapshot.c!.ledger!.turns.g2)
    expect(next.c!.ledger!.turns.g3).toEqual(snapshot.c!.ledger!.turns.g3)
    const reloaded = new CursorUsageTracker({ initialSnapshot: next })
    expect(reloaded.getSnapshot()).toEqual(next)
    old.dispose(); updated.dispose(); reloaded.dispose()
  })
})
