import { describe, expect, it } from 'vitest'
import {
  estimateTurnCostUsd,
  priceForModel,
  projectUsage,
  type CursorSessionUsage,
  type CursorUsageSnapshot,
  type UsageTurn
} from '../src/domain/cursor-usage'
import {
  STATS_HISTORY_SEAT,
  buildSessionStatsView,
  sortStatsRows,
  statsTickVisible,
  type StatsSeatSource
} from '../src/renderer/src/settings/stats-view'

// 本地 2026-09-13 15:00：今天的小时桶推到 14 时段有据可查。
const NOW = new Date(2026, 8, 13, 15, 0, 0).getTime()
const HOUR = 3_600_000
const DAY = 86_400_000

/** 标准回合（与预览同一形状）：读 31K / 写 2.4K / 新鲜 80 / 输出 760。 */
function turnAt(at: number, modelId = 'claude-fable-5'): UsageTurn {
  const price = priceForModel(modelId)
  const counts = { inputTokens: 33_480, outputTokens: 760, cacheReadTokens: 31_000, cacheWriteTokens: 2_400 }
  return { ...counts, estimatedCostUsd: estimateTurnCostUsd({ ...counts, occurredAt: at }, price), price, exact: true, at }
}

function usageOf(composerId: string, turns: UsageTurn[]): CursorSessionUsage {
  return projectUsage(composerId, { turns: Object.fromEntries(turns.map((turn, index) => [`g${index}`, turn])) })
}

const FABLE_TURN_COST = 0.0998   // 80×$10 + 31000×$1 + 2400×$12.5 + 760×$50，每百万
const FABLE_TURN_FULL = 0.3728   // 33480×$10 + 760×$50，每百万（无缓存全价）
const SOL_TURN_COST = 0.03992    // GPT-5.6 Sol：80×$4 + 31000×$0.4 + 2400×$5 + 760×$20，每百万

const seats: StatsSeatSource[] = [
  { channelId: '1', roleName: '主控席', displayName: '主控席 · CH-1', avatarId: 'lead', online: true, composerId: 'composer-01' },
  { channelId: '2', roleName: '实现席', displayName: '实现席 · CH-2', online: true, telemetryChannelComposerId: 'composer-02' }
]

/** 旧账（V2 / 无账本）：只有聚合数与 lastTurnAt。 */
const legacyUsage: CursorSessionUsage = {
  composerId: 'legacy-1',
  turns: 3,
  inputTokens: 90_000,
  outputTokens: 3_000,
  cacheReadTokens: 80_000,
  cacheWriteTokens: 6_000,
  estimatedCostUsd: 0.4,
  pricedModel: 'Claude Fable 5',
  lastTurnAt: NOW - 30 * 60_000,
  quality: 'legacy'
}

function snapshot(): CursorUsageSnapshot {
  return {
    'composer-01': usageOf('composer-01', [turnAt(NOW - 50 * 60_000), turnAt(NOW - DAY), turnAt(NOW - 10 * DAY)]),
    'composer-02': usageOf('composer-02', [turnAt(NOW - 2 * HOUR, 'gpt-5-6-sol')]),
    'hist-1': usageOf('hist-1', [turnAt(NOW - 2 * DAY)])
  }
}

describe('统计视图模型', () => {
  it('今天按小时分桶：回合落在发生时刻的桶，未绑定与旧账归入历史组', () => {
    const view = buildSessionStatsView({ usage: { ...snapshot(), 'legacy-1': legacyUsage }, seats, range: 'today', now: NOW })
    expect(view.bucketUnit).toBe('hour')
    expect(view.buckets).toHaveLength(24)
    // 14 时段：composer-01（14:10）+ legacy（14:30，历史组）；13 时段：composer-02。
    expect(view.buckets[14]!.costUsd).toBeCloseTo(FABLE_TURN_COST + 0.4, 4)
    expect(view.buckets[14]!.parts.map((part) => part.seatKey)).toEqual(['ch:1', STATS_HISTORY_SEAT.key])
    expect(view.buckets[13]!.parts.map((part) => part.seatKey)).toEqual(['ch:2'])
    expect(view.totals.turns).toBe(3)
    expect(view.rows).toHaveLength(3)
    expect(view.seatGroups.map((group) => group.key)).toEqual(['ch:1', 'ch:2', STATS_HISTORY_SEAT.key])
    expect(view.hasAnyUsage).toBe(true)
    expect(view.rangeEmpty).toBe(false)
  })

  it('7 天 / 30 天纳入更早的回合；范围外的账不进任何桶', () => {
    const week = buildSessionStatsView({ usage: snapshot(), seats, range: '7d', now: NOW })
    expect(week.bucketUnit).toBe('day')
    expect(week.buckets).toHaveLength(7)
    expect(week.totals.turns).toBe(4) // 今天 2 + 昨天 1 + 前天 hist 1
    const month = buildSessionStatsView({ usage: snapshot(), seats, range: '30d', now: NOW })
    expect(month.totals.turns).toBe(5) // 再纳入 10 天前
    expect(month.buckets).toHaveLength(30)
  })

  it('遥测回退 id 也能归属席位；查不到的 composer 标为历史会话', () => {
    const view = buildSessionStatsView({ usage: snapshot(), seats, range: '7d', now: NOW })
    const ch2 = view.rows.find((row) => row.composerId === 'composer-02')
    expect(ch2?.title).toBe('实现席')
    expect(ch2?.sub).toBe('CH-2')
    const hist = view.rows.find((row) => row.composerId === 'hist-1')
    expect(hist?.title).toBe('历史会话')
    expect(hist?.seatKey).toBe(STATS_HISTORY_SEAT.key)
    expect(hist?.sub).toBe('hist-1'.slice(0, 8))
  })

  it('缓存节省 = 无缓存全价 − 实付，按回合当时牌价累加', () => {
    const view = buildSessionStatsView({ usage: snapshot(), seats, range: 'today', now: NOW, seatKey: 'ch:1' })
    expect(view.totals.costUsd).toBeCloseTo(FABLE_TURN_COST, 4)
    expect(view.totals.savingsUsd).toBeCloseTo(FABLE_TURN_FULL - FABLE_TURN_COST, 4)
    expect(view.totals.savingsRatio).toBeCloseTo((FABLE_TURN_FULL - FABLE_TURN_COST) / FABLE_TURN_FULL, 4)
  })

  it('席位筛选收窄总计 / 模型 / 明细，但光谱带仍呈现全部席位（含成本与 tokens 双量）', () => {
    const view = buildSessionStatsView({ usage: snapshot(), seats, range: '7d', now: NOW, seatKey: 'ch:1' })
    expect(view.rows.every((row) => row.seatKey === 'ch:1')).toBe(true)
    expect(view.models.map((model) => model.label)).toEqual(['Claude Fable 5'])
    expect(view.spectrum.map((segment) => segment.seat.key).sort()).toEqual(['ch:1', 'ch:2', STATS_HISTORY_SEAT.key].sort())
    const costSum = view.spectrum.reduce((sum, segment) => sum + segment.costUsd, 0)
    expect(costSum).toBeCloseTo(view.spectrumTotals.costUsd, 8)
    expect(view.spectrumTotals.tokens).toBe(34_240 * 4) // 7 天内 4 个标准回合
    expect(view.spectrum.every((segment) => segment.tokens > 0)).toBe(true)
  })

  it('分桶与光谱带同时携带 tokens；每席位构成给出缓存命中率并按 tokens 降序', () => {
    const view = buildSessionStatsView({ usage: { ...snapshot(), 'legacy-1': legacyUsage }, seats, range: 'today', now: NOW })
    // 14 时段：composer-01（34,240）+ legacy（93,000 = 4K 新鲜 + 80K 读 + 6K 写 + 3K 输出）。
    expect(view.buckets[14]!.tokens).toBe(34_240 + 93_000)
    expect(view.buckets[14]!.parts.find((part) => part.seatKey === 'ch:1')?.tokens).toBe(34_240)
    expect(view.seatMix.map((mix) => mix.seat.key)).toEqual([STATS_HISTORY_SEAT.key, 'ch:1', 'ch:2'])
    const history = view.seatMix[0]!
    expect(history.tokens).toBe(93_000)
    expect(history.cacheHitRatio).toBeCloseTo(80_000 / 90_000, 4)
    expect(view.seatMix[1]!.cacheHitRatio).toBeCloseTo(31_000 / 33_480, 4)
  })

  it('累计与时间范围无关，且包含旧账全额', () => {
    const usage = { ...snapshot(), 'legacy-1': legacyUsage }
    const today = buildSessionStatsView({ usage, seats, range: 'today', now: NOW })
    const month = buildSessionStatsView({ usage, seats, range: '30d', now: NOW })
    expect(today.cumulative.costUsd).toBeCloseTo(month.cumulative.costUsd, 8)
    // 4 个 Fable 回合 + 1 个 Sol 回合 + 旧账 0.4。
    expect(today.cumulative.costUsd).toBeCloseTo(FABLE_TURN_COST * 4 + SOL_TURN_COST + 0.4, 4)
  })

  it('只有范围外用量时：hasAnyUsage 为真、rangeEmpty 为真', () => {
    const usage: CursorUsageSnapshot = { 'composer-01': usageOf('composer-01', [turnAt(NOW - 10 * DAY)]) }
    const view = buildSessionStatsView({ usage, seats, range: 'today', now: NOW })
    expect(view.hasAnyUsage).toBe(true)
    expect(view.rangeEmpty).toBe(true)
    expect(view.spectrum).toHaveLength(0)
  })

  it('明细排序：主键 + composerId 平局锚定，方向可翻转', () => {
    const view = buildSessionStatsView({ usage: snapshot(), seats, range: '30d', now: NOW })
    const desc = sortStatsRows(view.rows, 'cost', 'desc')
    expect(desc[0]!.composerId).toBe('composer-01') // 3 个回合成本最高
    const asc = sortStatsRows(view.rows, 'cost', 'asc')
    expect(asc[asc.length - 1]!.composerId).toBe('composer-01')
    const byTurns = sortStatsRows(view.rows, 'turns', 'desc')
    expect(byTurns[0]!.turns).toBeGreaterThanOrEqual(byTurns[1]!.turns)
  })

  it('轴刻度抽稀：小时 0/6/12/18，7 天全显，30 天每 5 天并保留末位', () => {
    expect([0, 5, 6, 12, 18, 23].map((index) => statsTickVisible('hour', index, 24))).toEqual([true, false, true, true, true, false])
    expect(Array.from({ length: 7 }, (_, index) => statsTickVisible('day', index, 7)).every(Boolean)).toBe(true)
    expect(statsTickVisible('day', 29, 30)).toBe(true)
    expect(statsTickVisible('day', 28, 30)).toBe(false)
    expect(statsTickVisible('day', 25, 30)).toBe(true)
  })
})
