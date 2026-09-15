import { useEffect, useMemo, useRef, useState } from 'react'
import { formatCostUsd, formatTokenCount } from '../../../domain/cursor-usage'
import { AgentAvatar } from '../AgentAvatar'
import { formatClock, formatRelativeClock, formatFullClock } from '../format'
import type { SettingsPageProps } from './settings-view'
import {
  STATS_HISTORY_SEAT,
  STATS_METRIC_OPTIONS,
  STATS_QUALITY_LABEL,
  STATS_RANGE_OPTIONS,
  buildSessionStatsView,
  sortStatsRows,
  statsTickVisible,
  type StatsBucket,
  type StatsMetric,
  type StatsRange,
  type StatsSortKey,
  type StatsSpectrumSegment
} from './stats-view'

type StatsProps = Pick<SettingsPageProps, 'usageSnapshot' | 'statsSeats'> & { active?: boolean }

const TABLE_ROW_CAP = 20
// 缺省引用恒定：props 缺席时不因 {} / [] 的新建引用而击穿 useMemo。
const EMPTY_USAGE: NonNullable<SettingsPageProps['usageSnapshot']> = {}
const EMPTY_SEATS: NonNullable<SettingsPageProps['statsSeats']> = []

/** 数值缓动滚动（400ms，尊重 prefers-reduced-motion；面板隐藏时直接落位）。 */
function useAnimatedNumber(target: number, animate: boolean): number {
  const [value, setValue] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    const start = from.current
    from.current = target
    if (start === target) return
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!animate || reduced || typeof requestAnimationFrame !== 'function') {
      setValue(target)
      return
    }
    const startedAt = performance.now()
    let frame = requestAnimationFrame(function tick(time: number) {
      const progress = Math.min(1, (time - startedAt) / 400)
      const eased = 1 - (1 - progress) ** 3
      setValue(start + (target - start) * eased)
      if (progress < 1) frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [target, animate])
  return value
}

function seatToneClass(colorIndex: number): string {
  return colorIndex < 0 ? 'is-history' : `is-c${colorIndex}`
}

/** 悬浮卡的水平贴靠：两端的桶不越出卡片。 */
function tooltipAlign(index: number, count: number): 'start' | 'center' | 'end' {
  if (count <= 1) return 'center'
  const ratio = index / (count - 1)
  return ratio < 0.18 ? 'start' : ratio > 0.82 ? 'end' : 'center'
}

export function SettingsStats({ usageSnapshot, statsSeats, active }: StatsProps): React.JSX.Element {
  const [range, setRange] = useState<StatsRange>('today')
  const [metric, setMetric] = useState<StatsMetric>('cost')
  const [seatKey, setSeatKey] = useState<string>()
  const [sort, setSort] = useState<{ key: StatsSortKey; direction: 'asc' | 'desc' }>({ key: 'cost', direction: 'desc' })
  const [activeBucket, setActiveBucket] = useState<number>()
  // 光谱带 hover 悬浮卡：直接持有段对象（而非索引）——hover 期间 usage 推送重算 spectrum 也不会越界；
  // x 为段中心相对容器的水平百分比（hover 时实测，跟随 flexGrow 动画）。
  const [hoverSegment, setHoverSegment] = useState<{ segment: StatsSpectrumSegment; index: number; x: number }>()
  const spectrumRef = useRef<HTMLDivElement>(null)

  // 页级度量：一把尺子量全页——光谱带、节奏柱、模型条与明细默认排序全部跟随。
  const metricOf = (value: { costUsd: number; tokens: number }): number => (metric === 'cost' ? value.costUsd : value.tokens)
  const formatMetric = (value: { costUsd: number; tokens: number }): string => (
    metric === 'cost' ? formatCostUsd(value.costUsd) : `${formatTokenCount(value.tokens)} tokens`
  )
  const bucketSummary = (bucket: StatsBucket): string => `${bucket.label} · ${formatMetric(bucket)} · ${bucket.turns} 回合`

  const usage = usageSnapshot ?? EMPTY_USAGE
  const seats = statsSeats ?? EMPTY_SEATS
  // 快照推送到达即重算；「截至」时间与推送同步，不做每秒跳动。
  // 分组隐藏（active=false）期间冻结上一次视图：推送高频到达时隐藏面板零重算，
  // 重新激活的那一次渲染因 active 翻转而取新数据。
  const frozenView = useRef<ReturnType<typeof buildSessionStatsView>>(undefined)
  const view = useMemo(() => {
    if (active === false && frozenView.current) return frozenView.current
    const next = buildSessionStatsView({ usage, seats, range, now: Date.now(), seatKey })
    frozenView.current = next
    return next
  }, [usage, seats, range, seatKey, active])
  const refreshedAt = useMemo(() => Date.now(), [usageSnapshot])

  const animate = active !== false
  const costValue = useAnimatedNumber(view.totals.costUsd, animate)
  const tokensValue = useAnimatedNumber(view.totals.tokens, animate)

  const sortedRows = useMemo(() => sortStatsRows(view.rows, sort.key, sort.direction), [view.rows, sort])
  const shownRows = sortedRows.slice(0, TABLE_ROW_CAP)
  const foldedRows = sortedRows.slice(TABLE_ROW_CAP)
  const foldedCost = foldedRows.reduce((sum, row) => sum + row.costUsd, 0)
  // 成本列数据条的分母：全量行的最大成本（不只当前页），条宽跨页可比。
  const maxRowCost = useMemo(() => view.rows.reduce((max, row) => Math.max(max, row.costUsd), 0), [view.rows])

  const filteredSeat = seatKey ? view.seatGroups.find((group) => group.key === seatKey) ?? (seatKey === STATS_HISTORY_SEAT.key ? STATS_HISTORY_SEAT : undefined) : undefined
  const savingsVisible = view.totals.savingsUsd > 0 && view.totals.savingsRatio !== undefined

  const toggleSort = (key: StatsSortKey): void => {
    setSort((previous) => previous.key === key
      ? { key, direction: previous.direction === 'desc' ? 'asc' : 'desc' }
      : { key, direction: 'desc' })
  }

  const onBarsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const count = view.buckets.length
    if (count === 0) return
    const move = (next: number): void => {
      event.preventDefault()
      setActiveBucket(Math.min(count - 1, Math.max(0, next)))
    }
    if (event.key === 'ArrowLeft') move((activeBucket ?? count) - 1)
    else if (event.key === 'ArrowRight') move((activeBucket ?? -1) + 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(count - 1)
    else if (event.key === 'Escape') setActiveBucket(undefined)
  }

  // 数字列表头右对齐（is-num），与单元格的 tabular-nums 右对齐同轴。
  const sortHeader = (key: StatsSortKey, label: string, numeric = false): React.JSX.Element => (
    <th className={numeric ? 'is-num' : undefined} aria-sort={sort.key === key ? (sort.direction === 'desc' ? 'descending' : 'ascending') : undefined}>
      <button type="button" className={`stats-table__sort${sort.key === key ? ' is-active' : ''}`} onClick={() => toggleSort(key)}>
        {label}
        <i aria-hidden="true" className={sort.key === key && sort.direction === 'asc' ? 'is-asc' : undefined} />
      </button>
    </th>
  )

  if (!view.hasAnyUsage) {
    return (
      <div className="settings-stats">
        <div className="stats-empty">
          <strong>还没有会话产生用量</strong>
          <p>发起一次会话后，这里会给出成本节奏、Token 构成、模型分布与每个会话的明细账。费用为等价 API 成本参考值。</p>
        </div>
      </div>
    )
  }

  const activeBucketData = activeBucket !== undefined ? view.buckets[activeBucket] : undefined

  return (
    <div className="settings-stats">
      <div className="stats-controls">
        <div className="stats-range" role="group" aria-label="统计时间范围">
          {STATS_RANGE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={range === option.key ? 'is-active' : undefined}
              aria-pressed={range === option.key}
              onClick={() => { setRange(option.key); setActiveBucket(undefined) }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="stats-range" role="group" aria-label="统计度量">
          {STATS_METRIC_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={metric === option.key ? 'is-active' : undefined}
              aria-pressed={metric === option.key}
              onClick={() => {
                setMetric(option.key)
                // 度量即默认排序：切到哪把尺子，明细就按哪把尺子降序（用户随后可自行改排）。
                setSort({ key: option.key === 'cost' ? 'cost' : 'tokens', direction: 'desc' })
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="stats-controls__meta" title="费用为公开牌价折算的等价 API 成本，与实际扣费口径可能不同">
          等价 API 成本 · 截至 {formatClock(refreshedAt)}
        </span>
      </div>

      <section className="stats-spectrum-block" aria-label="席位成本分布">
        <div className="stats-spectrum" role="group" aria-label="按席位筛选" ref={spectrumRef} onMouseLeave={() => setHoverSegment(undefined)}>
          {view.spectrum.length === 0 ? (
            <i className="stats-spectrum__ghost" aria-hidden="true" />
          ) : view.spectrum.map((segment, index) => {
            const denominator = metricOf(view.spectrumTotals)
            const share = denominator > 0 ? metricOf(segment) / denominator : 0
            const showSegmentTip = (target: HTMLElement): void => {
              const container = spectrumRef.current
              if (!container) return
              const rect = target.getBoundingClientRect()
              const parent = container.getBoundingClientRect()
              setHoverSegment({
                segment,
                index,
                x: ((rect.left + rect.width / 2) - parent.left) / Math.max(parent.width, 1) * 100
              })
            }
            return (
              <button
                key={segment.seat.key}
                type="button"
                className={`stats-spectrum__segment ${seatToneClass(segment.seat.colorIndex)}${seatKey && seatKey !== segment.seat.key ? ' is-dimmed' : ''}${seatKey === segment.seat.key ? ' is-selected' : ''}`}
                style={{ flexGrow: Math.max(share, 0.015) }}
                aria-pressed={seatKey === segment.seat.key}
                onMouseEnter={(event) => showSegmentTip(event.currentTarget)}
                onFocus={(event) => showSegmentTip(event.currentTarget)}
                onBlur={() => setHoverSegment(undefined)}
                onClick={() => setSeatKey((previous) => previous === segment.seat.key ? undefined : segment.seat.key)}
              >
                <span className="stats-visually-hidden">{segment.seat.label} {formatMetric(segment)}，占比 {Math.round(share * 100)}%</span>
              </button>
            )
          })}
          {hoverSegment ? (() => {
            const { segment, index, x } = hoverSegment
            const denominator = metricOf(view.spectrumTotals)
            const share = denominator > 0 ? metricOf(segment) / denominator : 0
            return (
              <div
                className={`stats-spectrum__tip is-${tooltipAlign(index, view.spectrum.length)}`}
                style={{ left: `${x}%` }}
                role="presentation"
              >
                <strong>{segment.seat.label}{segment.seat.sub ? ` · ${segment.seat.sub}` : ''}</strong>
                <span>{formatMetric(segment)} · {Math.round(share * 100)}%</span>
                <span className="stats-spectrum__tip-alt">{metric === 'cost' ? `${formatTokenCount(segment.tokens)} tokens` : formatCostUsd(segment.costUsd)}</span>
              </div>
            )
          })() : null}
        </div>
        <p className="stats-ledger">
          {metric === 'cost' ? (
            <>
              <span className="stats-ledger__cost">{formatCostUsd(costValue)}</span>
              <span className="stats-ledger__sep" aria-hidden="true" />
              <span>{formatTokenCount(Math.round(tokensValue))} tokens</span>
            </>
          ) : (
            <>
              <span className="stats-ledger__cost">{formatTokenCount(Math.round(tokensValue))}<small> tokens</small></span>
              <span className="stats-ledger__sep" aria-hidden="true" />
              <span>{formatCostUsd(costValue)}</span>
            </>
          )}
          <span className="stats-ledger__sep" aria-hidden="true" />
          <span>{view.totals.turns} 回合{view.totals.exactTurns > 0 && view.totals.exactTurns < view.totals.turns ? `（精确 ${view.totals.exactTurns}）` : ''}</span>
          {savingsVisible ? (
            <>
              <span className="stats-ledger__sep" aria-hidden="true" />
              <span title="相对无缓存全价输入的节省，按各回合当时牌价计算">
                缓存节省 {Math.round((view.totals.savingsRatio ?? 0) * 100)}%（{formatCostUsd(view.totals.savingsUsd)}）
              </span>
            </>
          ) : null}
          <span className="stats-ledger__cumulative">累计 {formatCostUsd(view.cumulative.costUsd)} · {formatTokenCount(view.cumulative.tokens)} tokens</span>
        </p>
        {filteredSeat ? (
          <button type="button" className="stats-filter-chip" onClick={() => setSeatKey(undefined)}>
            仅看 {filteredSeat.label}{filteredSeat.sub ? ` · ${filteredSeat.sub}` : ''}
            <i aria-hidden="true">×</i>
          </button>
        ) : null}
      </section>

      <div className="stats-grid">
        <section className="stats-card stats-card--rhythm" aria-label={metric === 'cost' ? '成本节奏' : 'Token 节奏'}>
          <header>
            <strong>{metric === 'cost' ? '成本节奏' : 'Token 节奏'}</strong>
            <span>{view.bucketUnit === 'hour' ? '按小时' : '按天'} · {formatMetric(view.totals)}</span>
          </header>
          {view.rangeEmpty ? (
            <p className="stats-card__empty">此范围内没有用量</p>
          ) : (
            <div
              className="stats-bars"
              tabIndex={0}
              role="img"
              aria-label={`${metric === 'cost' ? '成本' : 'Token'}节奏，${view.bucketUnit === 'hour' ? '24 小时' : `${view.buckets.length} 天`}，方向键查看每${view.bucketUnit === 'hour' ? '小时' : '天'}明细`}
              onKeyDown={onBarsKeyDown}
              onMouseLeave={() => setActiveBucket(undefined)}
              onBlur={() => setActiveBucket(undefined)}
            >
              {view.buckets.map((bucket, index) => {
                const maxBucket = metric === 'cost' ? view.maxBucketCost : view.maxBucketTokens
                return (
                  <div
                    key={bucket.key}
                    className={`stats-bars__col${activeBucket === index ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveBucket(index)}
                  >
                    <div className="stats-bars__stack">
                      {bucket.parts.map((part) => (
                        <i
                          key={part.seatKey}
                          className={seatToneClass(part.colorIndex)}
                          style={{ height: maxBucket > 0 ? `${Math.max(metricOf(part) / maxBucket * 100, 1.5)}%` : '0%' }}
                        />
                      ))}
                    </div>
                    <span className="stats-bars__tick" aria-hidden="true">
                      {statsTickVisible(view.bucketUnit, index, view.buckets.length) ? bucket.tick : ''}
                    </span>
                  </div>
                )
              })}
              {activeBucketData ? (
                <div
                  className={`stats-bars__tip is-${tooltipAlign(activeBucket ?? 0, view.buckets.length)}`}
                  style={{ left: `${(((activeBucket ?? 0) + 0.5) / view.buckets.length) * 100}%` }}
                  role="presentation"
                >
                  <strong>{activeBucketData.label}</strong>
                  <span>{formatMetric(activeBucketData)} · {activeBucketData.turns} 回合</span>
                  {activeBucketData.parts.slice(0, 4).map((part) => {
                    const seat = view.seatGroups.find((group) => group.key === part.seatKey)
                    return (
                      <span key={part.seatKey} className="stats-bars__tip-row">
                        <i className={seatToneClass(part.colorIndex)} aria-hidden="true" />
                        {seat?.label ?? part.seatKey} · {formatMetric(part)}
                      </span>
                    )
                  })}
                  {activeBucketData.parts.length > 4 ? (
                    <span className="stats-bars__tip-row is-more">… 另有 {activeBucketData.parts.length - 4} 个席位</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
          {/* 朗读区必须在 role="img" 之外：img 的子树按 ARIA 规范是 presentational。 */}
          <span className="stats-visually-hidden" aria-live="polite">
            {activeBucketData ? bucketSummary(activeBucketData) : ''}
          </span>
        </section>

        <section className="stats-card" aria-label="Token 构成">
          <header>
            <strong>Token 构成</strong>
            <span>{formatTokenCount(view.totals.tokens)} tokens</span>
          </header>
          {view.rangeEmpty ? (
            <p className="stats-card__empty">此范围内没有用量</p>
          ) : (
            <>
              <div className="stats-mix" role="img" aria-label="输入、输出与缓存构成">
                {([
                  ['is-input', view.totals.freshInput],
                  ['is-output', view.totals.output],
                  ['is-cachewrite', view.totals.cacheWrite],
                  ['is-cacheread', view.totals.cacheRead]
                ] as const).map(([tone, tokens]) => (
                  tokens > 0
                    ? <i key={tone} className={tone} style={{ flexGrow: Math.max(tokens / Math.max(view.totals.tokens, 1), 0.01) }} />
                    : null
                ))}
              </div>
              <ul className="stats-mix__legend">
                {([
                  ['is-input', 'Input', view.totals.freshInput],
                  ['is-output', 'Output', view.totals.output],
                  ['is-cachewrite', 'Cache Write', view.totals.cacheWrite],
                  ['is-cacheread', 'Cache Read', view.totals.cacheRead]
                ] as const).map(([tone, label, tokens]) => (
                  <li key={tone}>
                    <i className={tone} aria-hidden="true" />
                    <span className="stats-mix__label">{label}</span>
                    <span className="stats-mix__value">{formatTokenCount(tokens)}</span>
                    <span className="stats-mix__share">{view.totals.tokens > 0 ? `${Math.round(tokens / view.totals.tokens * 100)}%` : '—'}</span>
                  </li>
                ))}
              </ul>
              {view.seatMix.length > 0 ? (
                <ul className="stats-seatmix" aria-label="每席位 token 构成与缓存命中率">
                  {view.seatMix.map((mix) => (
                    <li key={mix.seat.key}>
                      <i className={`stats-seatmix__dot ${seatToneClass(mix.seat.colorIndex)}`} aria-hidden="true" />
                      <span className="stats-seatmix__name" title={mix.seat.sub ? `${mix.seat.label} · ${mix.seat.sub}` : mix.seat.label}>{mix.seat.label}</span>
                      <i
                        className="stats-seatmix__bar"
                        aria-hidden="true"
                        title={`Input ${formatTokenCount(mix.freshInput)} · Output ${formatTokenCount(mix.output)} · Cache Write ${formatTokenCount(mix.cacheWrite)} · Cache Read ${formatTokenCount(mix.cacheRead)}`}
                      >
                        {([
                          ['is-input', mix.freshInput],
                          ['is-output', mix.output],
                          ['is-cachewrite', mix.cacheWrite],
                          ['is-cacheread', mix.cacheRead]
                        ] as const).map(([tone, tokens]) => (
                          tokens > 0 ? <b key={tone} className={tone} style={{ flexGrow: Math.max(tokens / Math.max(mix.tokens, 1), 0.01) }} /> : null
                        ))}
                      </i>
                      <span className="stats-seatmix__tokens">{formatTokenCount(mix.tokens)}</span>
                      <span
                        className="stats-seatmix__hit"
                        title="缓存命中率 = 缓存读取 ÷ 总输入；越高说明重复上下文越多由缓存承担"
                      >
                        {mix.cacheHitRatio !== undefined ? `命中 ${Math.round(mix.cacheHitRatio * 100)}%` : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {savingsVisible ? (
                <p className="stats-card__note">
                  若无缓存约 {formatCostUsd(view.totals.costUsd + view.totals.savingsUsd)} · 实付 {formatCostUsd(view.totals.costUsd)} · 省 {Math.round((view.totals.savingsRatio ?? 0) * 100)}%
                </p>
              ) : null}
            </>
          )}
        </section>

        <section className="stats-card" aria-label="模型分布">
          <header>
            <strong>模型分布</strong>
            <span>{view.models.length > 0 ? `${view.models.length} 个模型` : '—'}</span>
          </header>
          {view.rangeEmpty ? (
            <p className="stats-card__empty">此范围内没有用量</p>
          ) : (
            <ul className="stats-models">
              {view.models.slice(0, 6).map((model) => {
                const denominator = view.models.reduce((sum, candidate) => sum + metricOf(candidate), 0)
                return (
                  <li key={model.label}>
                    <span className="stats-models__name" title={model.label}>{model.label}</span>
                    <span className="stats-models__meta">
                      {model.turns} 回合 · {metric === 'cost' ? formatTokenCount(model.tokens) : formatCostUsd(model.costUsd)}
                    </span>
                    <span className="stats-models__cost">{metric === 'cost' ? formatCostUsd(model.costUsd) : formatTokenCount(model.tokens)}</span>
                    <i className="stats-models__bar" aria-hidden="true">
                      <b style={{ width: `${Math.max(denominator > 0 ? metricOf(model) / denominator * 100 : 0, 2)}%` }} />
                    </i>
                  </li>
                )
              })}
              {view.models.length > 6 ? (
                <li className="stats-models__rest">
                  其他 {view.models.length - 6} 个模型 · {formatMetric({
                    costUsd: view.models.slice(6).reduce((sum, model) => sum + model.costUsd, 0),
                    tokens: view.models.slice(6).reduce((sum, model) => sum + model.tokens, 0)
                  })}
                </li>
              ) : null}
            </ul>
          )}
        </section>
      </div>

      <section className="stats-card stats-card--table" aria-label="会话明细">
        <header>
          <strong>会话明细</strong>
          <span>{view.rows.length} 个会话</span>
        </header>
        {view.rangeEmpty ? (
          <p className="stats-card__empty">此范围内没有用量</p>
        ) : (
          <table className="stats-table">
            <thead>
              <tr>
                <th>会话</th>
                <th>模型</th>
                {sortHeader('turns', '回合', true)}
                {sortHeader('tokens', 'Tokens', true)}
                {sortHeader('cost', '成本', true)}
                <th>质量</th>
                {sortHeader('lastTurnAt', '最后活动')}
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row) => (
                <tr key={row.composerId}>
                  <td>
                    <span className="stats-table__seat">
                      <AgentAvatar avatarId={row.avatarId} name={row.title} online={row.online} size="sm" />
                      <span className="stats-table__seat-name">
                        <strong>{row.title}</strong>
                        <small>{row.sub}</small>
                      </span>
                    </span>
                  </td>
                  <td className="stats-table__model" title={row.modelLabel}>{row.modelLabel}</td>
                  <td className="stats-table__num">{row.turns}</td>
                  <td className="stats-table__num" title={`Input ${formatTokenCount(row.freshInput)} · Output ${formatTokenCount(row.output)} · Cache Write ${formatTokenCount(row.cacheWrite)} · Cache Read ${formatTokenCount(row.cacheRead)}`}>
                    {formatTokenCount(row.tokens)}
                  </td>
                  <td className="stats-table__num is-cost" style={{ '--cost-share': `${maxRowCost > 0 ? row.costUsd / maxRowCost * 100 : 0}%` } as React.CSSProperties}>{formatCostUsd(row.costUsd)}</td>
                  <td><span className={`stats-table__quality is-${row.quality}`}>{STATS_QUALITY_LABEL[row.quality]}</span></td>
                  <td className="stats-table__time" title={formatFullClock(row.lastTurnAt)}>{formatRelativeClock(row.lastTurnAt)}</td>
                </tr>
              ))}
              {foldedRows.length > 0 ? (
                <tr className="stats-table__rest">
                  <td colSpan={7}>其余 {foldedRows.length} 个会话 · {formatCostUsd(foldedCost)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
