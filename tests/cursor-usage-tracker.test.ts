import { describe, expect, it, vi } from 'vitest'
import { CursorUsageTracker, cursorUsageRunDecision } from '../src/application/cursor-usage-tracker'
import { reduceUsage, estimateUsageFromReference, priceForModel, totalUsageTokens, type CursorUsageEvent } from '../src/domain/cursor-usage'

const sample = (used: number, generationId = 'g1', occurredAt = used) => ({ composerId: 'c', generationId, used, occurredAt, modelId: 'gpt-5' })
const exact = (generationId = 'g1'): CursorUsageEvent => ({ composerId: 'c', generationId, inputTokens: 12168, outputTokens: 42, cacheReadTokens: 3968, cacheWriteTokens: 0, occurredAt: 90000, modelId: 'gpt-5' })

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

  it('结束冻结含迟到结算，重启仍冻结；新 run reset 后旧账归档保留、新 composer 另起新账', () => {
    const first = new CursorUsageTracker({ now: () => 5000, runId: 'a' })
    first.recordRequestSample(sample(1000))
    expect(first.getSnapshot().c?.runId).toBe('a')
    first.setCollecting(false)
    const frozen = first.getSnapshot()
    first.record(exact())
    expect(first.getSnapshot()).toEqual(frozen)
    const second = new CursorUsageTracker({ initialSnapshot: frozen, now: () => 6000, runId: 'a' })
    second.record(exact())
    expect(second.getSnapshot()).toEqual(frozen)
    second.reset('b'); second.setCollecting(true)
    // 旧 run 的账不清空：仍在快照里、归属 'a'、保持冻结（统计页据此跨 run 累计）。
    expect(second.getSnapshot().c).toEqual(frozen.c)
    second.recordRequestSample({ ...sample(500), composerId: 'd' })
    expect(second.getSnapshot().d).toMatchObject({ inputTokens: 500, runId: 'b' })
    expect(second.getSnapshot().c).toEqual(frozen.c)
    first.dispose(); second.dispose()
  })

  it('reset 冻结当前 run 的开放账本并切换归属；同 composer 跨 run 续用时解冻续记不双计', () => {
    const persist = vi.fn()
    const tracker = new CursorUsageTracker({ now: () => 7000, runId: 'a', persistSnapshot: persist })
    tracker.recordRequestSample(sample(1000, 'g1', 10))
    tracker.reset('b')
    const archived = tracker.getSnapshot().c!
    expect(archived).toMatchObject({ runId: 'a', inputTokens: 1000 })
    expect(archived.ledger?.frozenAt).toBe(7000)
    // reset 立即落盘：归档不依赖后续事件。
    expect(persist).toHaveBeenLastCalledWith({ c: archived })
    // 上游理论上不会再放行旧 composer；若真续用，账本连续（1000 → 1500）并改归新 run，不清零重数。
    tracker.recordRequestSample(sample(500, 'g1', 20))
    expect(tracker.getSnapshot().c).toMatchObject({ runId: 'b', inputTokens: 1500, turns: 1 })
    expect(tracker.getSnapshot().c?.ledger?.frozenAt).toBeUndefined()
    // 已冻结的历史账在下一次结束时不重写冻结时间。
    const later = new CursorUsageTracker({ initialSnapshot: { c: archived }, now: () => 9000, runId: 'b' })
    later.setCollecting(false)
    expect(later.getSnapshot().c?.ledger?.frozenAt).toBe(7000)
    tracker.dispose(); later.dispose()
  })

  it('历史 run 的账超出保留窗口即裁掉（reset 与启动加载都裁），当前 run 不受窗口限制', () => {
    const day = 86_400_000
    const now = 100 * day
    const tracker = new CursorUsageTracker({ now: () => now, runId: 'a' })
    tracker.recordRequestSample(sample(100, 'g1', now - 60 * day))
    tracker.recordRequestSample({ ...sample(100, 'g1', now - 60 * day), composerId: 'old-b' })
    tracker.recordRequestSample({ ...sample(100, 'g1', now - 2 * day), composerId: 'recent-b' })
    // 当前 run 内即便 60 天前的账也不裁。
    expect(Object.keys(tracker.getSnapshot()).sort()).toEqual(['c', 'old-b', 'recent-b'])
    tracker.reset('b')
    // 切到新 run 后，'a' 的账成为历史：60 天前的裁掉，2 天前的保留。
    expect(Object.keys(tracker.getSnapshot()).sort()).toEqual(['recent-b'])
    expect(tracker.getSnapshot()['recent-b']).toMatchObject({ runId: 'a' })
    // 启动加载同样按当前 run 与窗口裁旧。
    const restored = new CursorUsageTracker({
      initialSnapshot: {
        stale: { composerId: 'stale', runId: 'z', turns: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, pricedModel: 'GPT', lastTurnAt: now - 40 * day },
        mine: { composerId: 'mine', runId: 'b', turns: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, pricedModel: 'GPT', lastTurnAt: now - 40 * day },
        fresh: { composerId: 'fresh', runId: 'z', turns: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, pricedModel: 'GPT', lastTurnAt: now - 30 * day }
      },
      now: () => now,
      runId: 'b'
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

  it('V2 旧账只保留展示到下一 run，不与未知归属的新结算相加', () => {
    const tracker = new CursorUsageTracker({ now: () => 100_000, initialSnapshot: { c: { composerId: 'c', turns: 222, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 900, cacheWriteTokens: 100, estimatedCostUsd: 1, pricedModel: 'old', lastTurnAt: 1 } } })
    tracker.record(exact())
    tracker.recordRequestSample(sample(2000))
    expect(tracker.getSnapshot().c).toMatchObject({ quality: 'legacy', inputTokens: 1000 })
    // 新 run 里同 composer 的精确账另起（V2 无 generation 身份，无法与 V3 账本合并）。
    tracker.reset('next'); tracker.record(exact())
    expect(tracker.getSnapshot().c).toMatchObject({ quality: 'exact', runId: 'next', turns: 1 })
    tracker.dispose()
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

  it('只有新 run 清零，同 run 状态变化不清账；只有 running 在采集', () => {
    expect(cursorUsageRunDecision({ runId: 'a', status: 'running' }, { runId: 'b', status: 'running' }).reset).toBe(true)
    expect(cursorUsageRunDecision({ runId: 'a', status: 'running' }, { runId: 'a', status: 'completed' })).toEqual({ reset: false, collecting: false })
    expect(cursorUsageRunDecision({ runId: 'a', status: 'completed' }, { runId: 'a', status: 'running' })).toEqual({ reset: false, collecting: true })
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
