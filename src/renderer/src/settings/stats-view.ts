import type { CursorSessionUsage, CursorUsageSnapshot } from '../../../domain/cursor-usage'
import { priceForModel, totalUsageTokens } from '../../../domain/cursor-usage'

/**
 * 统计页视图模型（纯函数）。
 *
 * 数据口径与会话页一致（docs 定稿）：缓存读/写是输入的子集，总 token = 输入 + 输出；
 * 费用是「等价 API 成本」参考值。时间序列来自用量账本（V3 ledger）的逐回合时间戳；
 * 无账本的旧会话（quality = legacy / V2）折叠为 lastTurnAt 上的一笔近似回合，
 * 质量列如实标注，不伪装成精确值。
 *
 * 席位归属：composerId（含遥测回退 id）→ 当前会话席位；查不到的 composer 归入
 * 「历史会话」组——席位轮换 / run 更替后旧 Composer 的账不消失，只换归属。
 */

export type StatsRange = 'today' | '7d' | '30d'

export const STATS_RANGE_OPTIONS: ReadonlyArray<{ key: StatsRange; label: string }> = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' }
]

/** 席位来源投影（App 从会话快照映射；只带统计需要的字段）。 */
export interface StatsSeatSource {
  channelId: string
  roleName: string
  displayName: string
  avatarId?: string
  online: boolean
  composerId?: string
  telemetryChannelComposerId?: string
}

/** 光谱带 / 图例的席位分组；history 表示无法归属到当前席位的旧 Composer。 */
export interface StatsSeatGroup {
  key: string
  label: string
  sub?: string
  avatarId?: string
  online?: boolean
  /** 0..7 循环取色；-1 = 历史灰。 */
  colorIndex: number
}

export interface StatsSpectrumSegment {
  seat: StatsSeatGroup
  costUsd: number
  tokens: number
}

export interface StatsBucketPart {
  seatKey: string
  colorIndex: number
  costUsd: number
  tokens: number
}

export interface StatsBucket {
  key: string
  /** 轴刻度（14时 / 9/12）。 */
  tick: string
  /** 悬浮与朗读的完整名（14:00–14:59 / 9月12日）。 */
  label: string
  costUsd: number
  tokens: number
  turns: number
  parts: StatsBucketPart[]
}

/** 每席位的 token 构成（跟随席位筛选）；命中率 = 缓存读 ÷ 总输入。 */
export interface StatsSeatMixRow {
  seat: StatsSeatGroup
  freshInput: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  cacheHitRatio?: number
}

export interface StatsModelRow {
  label: string
  costUsd: number
  tokens: number
  turns: number
  share: number
}

export type StatsQuality = NonNullable<CursorSessionUsage['quality']>

export interface StatsSessionRow {
  composerId: string
  seatKey: string
  colorIndex: number
  title: string
  sub: string
  avatarId?: string
  online?: boolean
  modelLabel: string
  turns: number
  tokens: number
  costUsd: number
  freshInput: number
  output: number
  cacheRead: number
  cacheWrite: number
  quality: StatsQuality
  lastTurnAt: number
}

export interface SessionStatsView {
  hasAnyUsage: boolean
  rangeEmpty: boolean
  totals: {
    costUsd: number
    tokens: number
    turns: number
    freshInput: number
    output: number
    cacheRead: number
    cacheWrite: number
    /** 相对无缓存全价的节省（可能为 0；写入溢价未回本时为负，展示层按 0 处理）。 */
    savingsUsd: number
    /** savings / 全价成本；全价为 0 时 undefined。 */
    savingsRatio?: number
    exactTurns: number
  }
  cumulative: { costUsd: number; tokens: number }
  seatGroups: StatsSeatGroup[]
  spectrum: StatsSpectrumSegment[]
  /** 光谱带的分母（永远全量，不随席位筛选收窄）。 */
  spectrumTotals: { costUsd: number; tokens: number }
  bucketUnit: 'hour' | 'day'
  buckets: StatsBucket[]
  maxBucketCost: number
  maxBucketTokens: number
  seatMix: StatsSeatMixRow[]
  models: StatsModelRow[]
  rows: StatsSessionRow[]
}

export const STATS_PALETTE_SIZE = 8
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export const STATS_HISTORY_SEAT: StatsSeatGroup = { key: 'history', label: '历史会话', colorIndex: -1 }

interface NormalizedTurn {
  at: number
  freshInput: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  /** 无缓存等价成本：全部输入按全价 + 输出。 */
  fullCostUsd: number
  modelLabel: string
  exact: boolean
}

/** 账本逐回合展开；无账本（legacy / V2）折叠为 lastTurnAt 上的一笔近似回合。 */
function normalizeTurns(usage: CursorSessionUsage): NormalizedTurn[] {
  const ledgerTurns = usage.ledger ? Object.values(usage.ledger.turns) : []
  if (ledgerTurns.length > 0) {
    return ledgerTurns.map((turn) => ({
      at: turn.at,
      freshInput: Math.max(0, turn.inputTokens - turn.cacheReadTokens - turn.cacheWriteTokens),
      output: turn.outputTokens,
      cacheRead: turn.cacheReadTokens,
      cacheWrite: turn.cacheWriteTokens,
      costUsd: turn.estimatedCostUsd,
      fullCostUsd: (turn.inputTokens * turn.price.inputPerM + turn.outputTokens * turn.price.outputPerM) / 1e6,
      modelLabel: turn.price.label,
      exact: turn.exact
    }))
  }
  if (usage.turns <= 0) return []
  const price = priceForModel(usage.pricedModel)
  return [{
    at: usage.lastTurnAt,
    freshInput: Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens),
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    costUsd: usage.estimatedCostUsd,
    fullCostUsd: (usage.inputTokens * price.inputPerM + usage.outputTokens * price.outputPerM) / 1e6,
    modelLabel: usage.pricedModel,
    exact: false
  }]
}

function localMidnight(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

export function statsRangeStart(range: StatsRange, now: number): number {
  const midnight = localMidnight(now)
  if (range === 'today') return midnight
  return midnight - (range === '7d' ? 6 : 29) * DAY_MS
}

function emptyBuckets(range: StatsRange, now: number): { unit: 'hour' | 'day'; start: number; step: number; buckets: StatsBucket[] } {
  const start = statsRangeStart(range, now)
  if (range === 'today') {
    const buckets = Array.from({ length: 24 }, (_, hour): StatsBucket => ({
      key: `h${hour}`,
      tick: `${hour}时`,
      label: `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59`,
      costUsd: 0,
      tokens: 0,
      turns: 0,
      parts: []
    }))
    return { unit: 'hour', start, step: HOUR_MS, buckets }
  }
  const days = range === '7d' ? 7 : 30
  const buckets = Array.from({ length: days }, (_, index): StatsBucket => {
    const date = new Date(start + index * DAY_MS)
    return {
      key: `d${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
      tick: `${date.getMonth() + 1}/${date.getDate()}`,
      label: `${date.getMonth() + 1}月${date.getDate()}日`,
      costUsd: 0,
      tokens: 0,
      turns: 0,
      parts: []
    }
  })
  return { unit: 'day', start, step: DAY_MS, buckets }
}

export interface SessionStatsInput {
  usage: CursorUsageSnapshot
  seats: readonly StatsSeatSource[]
  range: StatsRange
  now: number
  /** 光谱带选中的席位（含 'history'）；缺省不筛选。 */
  seatKey?: string
}

export function buildSessionStatsView(input: SessionStatsInput): SessionStatsView {
  const { usage, range, now, seatKey } = input

  // —— 席位分组与 composer 归属 ——
  const seats = [...input.seats].sort((left, right) => {
    const l = Number(left.channelId)
    const r = Number(right.channelId)
    return Number.isFinite(l) && Number.isFinite(r) ? l - r : left.channelId.localeCompare(right.channelId)
  })
  const seatGroups: StatsSeatGroup[] = seats.map((seat, index) => ({
    key: `ch:${seat.channelId}`,
    label: seat.roleName || seat.displayName,
    sub: `CH-${seat.channelId}`,
    avatarId: seat.avatarId,
    online: seat.online,
    colorIndex: index % STATS_PALETTE_SIZE
  }))
  const groupByKey = new Map(seatGroups.map((group) => [group.key, group]))
  const seatKeyByComposer = new Map<string, string>()
  seats.forEach((seat) => {
    for (const composerId of [seat.composerId, seat.telemetryChannelComposerId]) {
      if (composerId && !seatKeyByComposer.has(composerId)) seatKeyByComposer.set(composerId, `ch:${seat.channelId}`)
    }
  })

  const { unit, start, step, buckets } = emptyBuckets(range, now)

  // —— 展开回合并按范围折叠 ——
  const entries = Object.values(usage).filter((entry) => entry.turns > 0)
  const hasAnyUsage = entries.length > 0

  const totals = { costUsd: 0, tokens: 0, turns: 0, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, savingsUsd: 0, exactTurns: 0 }
  let fullCostSum = 0
  const spectrumBySeat = new Map<string, { costUsd: number; tokens: number }>()
  const modelMap = new Map<string, { costUsd: number; tokens: number; turns: number }>()
  const rows: StatsSessionRow[] = []
  let usedHistory = false
  const cumulative = { costUsd: 0, tokens: 0 }

  for (const entry of entries) {
    cumulative.costUsd += entry.estimatedCostUsd
    cumulative.tokens += totalUsageTokens(entry)

    const composerSeatKey = seatKeyByComposer.get(entry.composerId) ?? STATS_HISTORY_SEAT.key
    const group = groupByKey.get(composerSeatKey) ?? STATS_HISTORY_SEAT
    const inRange = normalizeTurns(entry).filter((turn) => turn.at >= start && turn.at <= now)
    if (inRange.length === 0) continue
    if (group.key === STATS_HISTORY_SEAT.key) usedHistory = true

    // 光谱带永远呈现全部席位的范围内量（筛选只影响其余模块，用高亮表达）。
    const spectrumEntry = spectrumBySeat.get(group.key) ?? { costUsd: 0, tokens: 0 }
    for (const turn of inRange) {
      spectrumEntry.costUsd += turn.costUsd
      spectrumEntry.tokens += turn.freshInput + turn.cacheRead + turn.cacheWrite + turn.output
    }
    spectrumBySeat.set(group.key, spectrumEntry)

    if (seatKey && group.key !== seatKey) continue

    const row: StatsSessionRow = {
      composerId: entry.composerId,
      seatKey: group.key,
      colorIndex: group.colorIndex,
      title: group.key === STATS_HISTORY_SEAT.key ? STATS_HISTORY_SEAT.label : group.label,
      sub: group.key === STATS_HISTORY_SEAT.key ? entry.composerId.slice(0, 8) : group.sub ?? '',
      avatarId: group.avatarId,
      online: group.online,
      modelLabel: entry.pricedModel,
      turns: inRange.length,
      tokens: 0,
      costUsd: 0,
      freshInput: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      quality: entry.quality ?? 'estimated',
      lastTurnAt: Math.max(...inRange.map((turn) => turn.at))
    }

    for (const turn of inRange) {
      const tokens = turn.freshInput + turn.cacheRead + turn.cacheWrite + turn.output
      totals.costUsd += turn.costUsd
      totals.tokens += tokens
      totals.turns += 1
      totals.freshInput += turn.freshInput
      totals.output += turn.output
      totals.cacheRead += turn.cacheRead
      totals.cacheWrite += turn.cacheWrite
      totals.savingsUsd += turn.fullCostUsd - turn.costUsd
      totals.exactTurns += turn.exact ? 1 : 0
      fullCostSum += turn.fullCostUsd

      row.tokens += tokens
      row.costUsd += turn.costUsd
      row.freshInput += turn.freshInput
      row.output += turn.output
      row.cacheRead += turn.cacheRead
      row.cacheWrite += turn.cacheWrite

      const model = modelMap.get(turn.modelLabel) ?? { costUsd: 0, tokens: 0, turns: 0 }
      model.costUsd += turn.costUsd
      model.tokens += tokens
      model.turns += 1
      modelMap.set(turn.modelLabel, model)

      const index = Math.floor((turn.at - start) / step)
      const bucket = index >= 0 && index < buckets.length ? buckets[index] : undefined
      if (!bucket) continue
      bucket.costUsd += turn.costUsd
      bucket.tokens += tokens
      bucket.turns += 1
      const part = bucket.parts.find((candidate) => candidate.seatKey === group.key)
      if (part) {
        part.costUsd += turn.costUsd
        part.tokens += tokens
      } else {
        bucket.parts.push({ seatKey: group.key, colorIndex: group.colorIndex, costUsd: turn.costUsd, tokens })
      }
    }

    rows.push(row)
  }

  // 堆叠顺序恒定：席位按通道序，历史殿后——颜色与光谱带一致。
  const stackOrder = new Map<string, number>(seatGroups.map((group, index) => [group.key, index]))
  stackOrder.set(STATS_HISTORY_SEAT.key, seatGroups.length)
  for (const bucket of buckets) {
    bucket.parts.sort((left, right) => (stackOrder.get(left.seatKey) ?? 99) - (stackOrder.get(right.seatKey) ?? 99))
  }

  const spectrumGroups = usedHistory || spectrumBySeat.has(STATS_HISTORY_SEAT.key) ? [...seatGroups, STATS_HISTORY_SEAT] : seatGroups
  const spectrum: StatsSpectrumSegment[] = spectrumGroups
    .map((seat) => ({ seat, ...(spectrumBySeat.get(seat.key) ?? { costUsd: 0, tokens: 0 }) }))
    .filter((segment) => segment.costUsd > 0 || segment.tokens > 0)
  const spectrumTotals = spectrum.reduce(
    (sum, segment) => ({ costUsd: sum.costUsd + segment.costUsd, tokens: sum.tokens + segment.tokens }),
    { costUsd: 0, tokens: 0 }
  )

  // 每席位 token 构成（跟随筛选，与明细同源）：席位序 + 历史殿后，token 多者在前。
  const seatMixMap = new Map<string, StatsSeatMixRow>()
  for (const row of rows) {
    const seat = groupByKey.get(row.seatKey) ?? STATS_HISTORY_SEAT
    const mix = seatMixMap.get(row.seatKey)
      ?? { seat, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0 }
    mix.freshInput += row.freshInput
    mix.output += row.output
    mix.cacheRead += row.cacheRead
    mix.cacheWrite += row.cacheWrite
    mix.tokens += row.tokens
    seatMixMap.set(row.seatKey, mix)
  }
  const seatMix = [...seatMixMap.values()]
    .map((mix) => {
      const input = mix.freshInput + mix.cacheRead + mix.cacheWrite
      return { ...mix, cacheHitRatio: input > 0 ? mix.cacheRead / input : undefined }
    })
    .sort((left, right) => right.tokens - left.tokens)

  const modelTotal = [...modelMap.values()].reduce((sum, model) => sum + model.costUsd, 0)
  const models: StatsModelRow[] = [...modelMap.entries()]
    .map(([label, model]) => ({ label, ...model, share: modelTotal > 0 ? model.costUsd / modelTotal : 0 }))
    .sort((left, right) => right.costUsd - left.costUsd)

  return {
    hasAnyUsage,
    rangeEmpty: totals.turns === 0,
    totals: {
      ...totals,
      savingsRatio: fullCostSum > 0 ? totals.savingsUsd / fullCostSum : undefined
    },
    cumulative,
    seatGroups: usedHistory ? [...seatGroups, STATS_HISTORY_SEAT] : seatGroups,
    spectrum,
    spectrumTotals,
    bucketUnit: unit,
    buckets,
    maxBucketCost: buckets.reduce((max, bucket) => Math.max(max, bucket.costUsd), 0),
    maxBucketTokens: buckets.reduce((max, bucket) => Math.max(max, bucket.tokens), 0),
    seatMix,
    models,
    rows
  }
}

/** 页级度量：全页图形（光谱带 / 节奏 / 模型条）跟随同一把尺子。 */
export type StatsMetric = 'cost' | 'tokens'

export const STATS_METRIC_OPTIONS: ReadonlyArray<{ key: StatsMetric; label: string }> = [
  { key: 'cost', label: '成本' },
  { key: 'tokens', label: 'Tokens' }
]

/** 表格排序键；方向由组件持有。 */
export type StatsSortKey = 'cost' | 'tokens' | 'turns' | 'lastTurnAt'

export function sortStatsRows(rows: readonly StatsSessionRow[], key: StatsSortKey, direction: 'asc' | 'desc'): StatsSessionRow[] {
  const factor = direction === 'asc' ? 1 : -1
  const value = (row: StatsSessionRow): number => (
    key === 'cost' ? row.costUsd : key === 'tokens' ? row.tokens : key === 'turns' ? row.turns : row.lastTurnAt
  )
  return [...rows].sort((left, right) => {
    const delta = value(left) - value(right)
    if (delta !== 0) return delta * factor
    return left.composerId.localeCompare(right.composerId)
  })
}

export const STATS_QUALITY_LABEL: Record<StatsQuality, string> = {
  exact: '精确',
  mixed: '混合',
  estimated: '估算',
  legacy: '旧账'
}

/** 轴刻度抽稀：今天显示 0/6/12/18 时，7 天全显，30 天每 5 天。 */
export function statsTickVisible(unit: 'hour' | 'day', index: number, count: number): boolean {
  if (unit === 'hour') return index % 6 === 0
  if (count <= 7) return true
  return index % 5 === 0 || index === count - 1
}
