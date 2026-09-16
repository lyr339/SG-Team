// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  estimateTurnCostUsd,
  priceForModel,
  projectUsage,
  type CursorUsageSnapshot,
  type UsageTurn
} from '../src/domain/cursor-usage'
import { SettingsPage } from '../src/renderer/src/settings/SettingsPage'
import { SettingsStats } from '../src/renderer/src/settings/SettingsStats'
import type { SettingsPageProps } from '../src/renderer/src/settings/settings-view'
import type { StatsSeatSource } from '../src/renderer/src/settings/stats-view'

const HOUR = 3_600_000
const DAY = 86_400_000
/** 钉死时钟在本地 14:00：夹具把「今天」的回合放在 now - 0.5h / 1h / 2h，跨过午夜跑真实时钟会全部落到昨天。 */
const FIXED_NOW = new Date(2026, 8, 16, 14, 0, 0).getTime()

function turnAt(at: number, modelId = 'claude-fable-5'): UsageTurn {
  const price = priceForModel(modelId)
  const counts = { inputTokens: 33_480, outputTokens: 760, cacheReadTokens: 31_000, cacheWriteTokens: 2_400 }
  return { ...counts, estimatedCostUsd: estimateTurnCostUsd({ ...counts, occurredAt: at }, price), price, exact: true, at }
}

/** 组件测试用的 now（已钉死）：回合分布在今天与最近几天。 */
function fixture(now: number): { usage: CursorUsageSnapshot; seats: StatsSeatSource[] } {
  const usageEntries: Array<[string, UsageTurn[]]> = [
    ['composer-01', [turnAt(now - 30 * 60_000), turnAt(now - 2 * HOUR), turnAt(now - DAY)]],
    ['composer-02', [turnAt(now - HOUR, 'gpt-5-6-sol')]],
    ['hist-9a8b7c6d', [turnAt(now - 2 * DAY)]]
  ]
  return {
    usage: Object.fromEntries(usageEntries.map(([composerId, turns]) => [
      composerId,
      projectUsage(composerId, { turns: Object.fromEntries(turns.map((turn, index) => [`g${index}`, turn])) })
    ])),
    seats: [
      { channelId: '1', roleName: '主控席', displayName: '主控席 · CH-1', avatarId: 'lead', online: true, composerId: 'composer-01' },
      { channelId: '2', roleName: '实现席', displayName: '实现席 · CH-2', online: true, telemetryChannelComposerId: 'composer-02' }
    ]
  }
}

describe('统计页组件', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    // 只伪造 Date（组件与夹具都读 Date.now()），计时器保持真实，act / 事件派发不受影响。
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] })
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  const render = async (props: Parameters<typeof SettingsStats>[0]): Promise<void> => {
    await act(async () => root.render(<SettingsStats {...props} />))
  }
  const buttonByText = (text: string): HTMLButtonElement => (
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith(text))!
  )

  it('账本行呈现范围成本 / tokens / 回合与累计；光谱带含历史组', async () => {
    const { usage, seats } = fixture(Date.now())
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    const ledger = container.querySelector('.stats-ledger')!
    expect(ledger.querySelector('.stats-ledger__cost')?.textContent).toMatch(/^\$/)
    expect(ledger.textContent).toContain('回合')
    expect(ledger.textContent).toContain('累计')
    // 今天：composer-01 × 2 + composer-02 × 1 = 光谱带两个席位段（历史回合在两天前，不在今天）。
    expect(container.querySelectorAll('.stats-spectrum__segment')).toHaveLength(2)
    expect(container.querySelectorAll('.stats-bars__col')).toHaveLength(24)
  })

  it('切到 7 天：分桶变 7 天，历史会话进入光谱带与明细', async () => {
    const { usage, seats } = fixture(Date.now())
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    await act(async () => { buttonByText('7 天').click() })
    expect(container.querySelectorAll('.stats-bars__col')).toHaveLength(7)
    expect(container.querySelectorAll('.stats-spectrum__segment')).toHaveLength(3)
    const titles = [...container.querySelectorAll('.stats-table__seat-name strong')].map((node) => node.textContent)
    expect(titles).toContain('历史会话')
  })

  it('点击光谱带段位 = 席位筛选：出现清除 chip、明细收窄、再点还原', async () => {
    const { usage, seats } = fixture(Date.now())
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    const segment = container.querySelector<HTMLButtonElement>('.stats-spectrum__segment')!
    await act(async () => { segment.click() })
    expect(container.querySelector('.stats-filter-chip')?.textContent).toContain('主控席')
    const rows = [...container.querySelectorAll('.stats-table tbody tr:not(.stats-table__rest)')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('主控席')
    await act(async () => { container.querySelector<HTMLButtonElement>('.stats-filter-chip')!.click() })
    expect(container.querySelector('.stats-filter-chip')).toBeNull()
    expect(container.querySelectorAll('.stats-table tbody tr:not(.stats-table__rest)').length).toBeGreaterThan(1)
  })

  it('明细默认按成本降序，点表头翻转方向并标注 aria-sort', async () => {
    const { usage, seats } = fixture(Date.now())
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    const firstSeat = (): string | null | undefined => container.querySelector('.stats-table tbody tr .stats-table__seat-name strong')?.textContent
    expect(firstSeat()).toBe('主控席') // 今天两个回合，成本最高
    // 控制行也有「成本」按钮（度量切换），排序断言须锚定在表头内。
    const costHeader = [...container.querySelectorAll<HTMLButtonElement>('.stats-table th button')]
      .find((button) => button.textContent?.startsWith('成本'))!
    expect(costHeader.closest('th')?.getAttribute('aria-sort')).toBe('descending')
    await act(async () => { costHeader.click() })
    expect(costHeader.closest('th')?.getAttribute('aria-sort')).toBe('ascending')
    expect(firstSeat()).not.toBe('主控席')
  })

  it('度量切换为 Tokens：账本行主数字、节奏卡、明细默认排序全部跟随', async () => {
    const { usage, seats } = fixture(Date.now())
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    expect(container.querySelector('.stats-ledger__cost')?.textContent).toMatch(/^\$/)
    expect(container.querySelector('.stats-card--rhythm header strong')?.textContent).toBe('成本节奏')
    // 控制行的度量切换在 DOM 中先于表头排序按钮，buttonByText 命中的是它。
    await act(async () => { buttonByText('Tokens').click() })
    expect(container.querySelector('.stats-ledger__cost')?.textContent).not.toMatch(/^\$/)
    expect(container.querySelector('.stats-ledger__cost')?.textContent).toContain('tokens')
    expect(container.querySelector('.stats-card--rhythm header strong')?.textContent).toBe('Token 节奏')
    const tokensHeader = [...container.querySelectorAll('th')].find((th) => th.textContent?.startsWith('Tokens'))!
    expect(tokensHeader.getAttribute('aria-sort')).toBe('descending')
  })

  it('数字列表头右对齐（is-num），每席位构成给出命中率', async () => {
    const { usage, seats } = fixture(Date.now())
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    expect(container.querySelectorAll('.stats-table th.is-num')).toHaveLength(3)
    const seatMixRows = container.querySelectorAll('.stats-seatmix li')
    expect(seatMixRows.length).toBeGreaterThan(0)
    expect([...seatMixRows].some((row) => row.textContent?.includes('命中'))).toBe(true)
  })

  it('分组隐藏期间冻结视图：新快照不触发重算，重新激活后取新数据', async () => {
    const now = Date.now()
    const { usage, seats } = fixture(now)
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    expect(container.querySelector('.stats-ledger')?.textContent).toContain('3 回合')
    // 隐藏期间到达新快照（composer-02 多出一个回合）：账本行保持冻结值。
    const doubled: CursorUsageSnapshot = {
      ...usage,
      'composer-02': projectUsage('composer-02', {
        turns: { g0: turnAt(now - HOUR, 'gpt-5-6-sol'), g1: turnAt(now - 20 * 60_000, 'gpt-5-6-sol') }
      })
    }
    await render({ usageSnapshot: doubled, statsSeats: seats, active: false })
    expect(container.querySelector('.stats-ledger')?.textContent).toContain('3 回合')
    await render({ usageSnapshot: doubled, statsSeats: seats, active: true })
    expect(container.querySelector('.stats-ledger')?.textContent).toContain('4 回合')
  })

  it('没有任何用量时呈现空态说明', async () => {
    await render({ usageSnapshot: {}, statsSeats: [], active: true })
    expect(container.querySelector('.stats-empty')?.textContent).toContain('还没有会话产生用量')
    expect(container.querySelector('.stats-ledger')).toBeNull()
  })

  it('成本节奏支持键盘漫游：方向键移动活跃桶并给出悬浮明细', async () => {
    const { usage, seats } = fixture(Date.now())
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    const bars = container.querySelector<HTMLDivElement>('.stats-bars')!
    await act(async () => {
      bars.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(container.querySelector('.stats-bars__col.is-active')).not.toBeNull()
    expect(container.querySelector('.stats-bars__tip')).not.toBeNull()
    await act(async () => {
      bars.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('.stats-bars__tip')).toBeNull()
  })

  it('设置页：#account:stats 深链落到「统计」分组', async () => {
    history.replaceState(null, '', '#account:stats')
    const { usage, seats } = fixture(Date.now())
    const pageProps: SettingsPageProps = {
      accounts: [], busy: false, error: '',
      onSave: vi.fn(async () => {}), onSelect: vi.fn(async () => {}), onRemove: vi.fn(async () => {}),
      usageSnapshot: usage, statsSeats: seats
    }
    await act(async () => root.render(<SettingsPage {...pageProps} />))
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('统计')
    expect(container.querySelector('.settings-groups > div:not([hidden]) .settings-stats')).not.toBeNull()
    history.replaceState(null, '', '#account')
  })

  it('光谱带 hover 悬浮卡：即时显示席位明细（替代原生 title），离开即消', async () => {
    const { usage, seats } = fixture(Date.now())
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    const segment = container.querySelector<HTMLButtonElement>('.stats-spectrum__segment')!
    // 原生 title 已移除，席位明细由即时悬浮卡承担
    expect(segment.getAttribute('title')).toBeNull()
    expect(container.querySelector('.stats-spectrum__tip')).toBeNull()
    await act(async () => { segment.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })
    const tip = container.querySelector('.stats-spectrum__tip')
    expect(tip?.textContent).toContain('主控席')
    expect(tip?.textContent).toContain('CH-1')
    expect(tip?.textContent).toMatch(/\d+%/)
    // 次度量行：成本度量下补 tokens
    expect(tip?.querySelector('.stats-spectrum__tip-alt')?.textContent).toContain('tokens')
    await act(async () => { segment.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })) })
    expect(container.querySelector('.stats-spectrum__tip')).toBeNull()
  })

  it('成本列带数据条背景：--cost-share 相对全量行最大成本', async () => {
    const { usage, seats } = fixture(Date.now())
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    const cells = [...container.querySelectorAll<HTMLTableCellElement>('td.is-cost')]
    expect(cells.length).toBeGreaterThan(0)
    const shares = cells.map((cell) => Number.parseFloat(cell.style.getPropertyValue('--cost-share')))
    expect(shares.every((share) => share >= 0 && share <= 100)).toBe(true)
    expect(Math.max(...shares)).toBeCloseTo(100, 0)
  })

  it('节奏柱悬浮卡的席位行超过 4 个时折叠为「另有 N 个席位」', async () => {
    const now = Date.now()
    const composerIds = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5']
    const usage = Object.fromEntries(composerIds.map((id) => [
      id,
      projectUsage(id, { turns: { g0: turnAt(now) } })
    ]))
    const seats: StatsSeatSource[] = composerIds.map((id, index) => ({
      channelId: String(index + 1), roleName: `席位${index + 1}`, displayName: `席位${index + 1}`, online: true, composerId: id
    }))
    await render({ usageSnapshot: usage, statsSeats: seats, active: true })
    const currentHourCol = container.querySelectorAll('.stats-bars__col')[new Date(now).getHours()]!
    await act(async () => { currentHourCol.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })
    const tip = container.querySelector('.stats-bars__tip')
    // 4 行席位明细 + 1 行汇总
    expect(tip?.querySelectorAll('.stats-bars__tip-row').length).toBe(5)
    expect(tip?.textContent).toContain('另有 1 个席位')
  })
})
