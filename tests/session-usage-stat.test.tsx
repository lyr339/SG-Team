// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionUsageStat } from '../src/renderer/src/SessionUsageStat'
import { CursorUsageTracker } from '../src/application/cursor-usage-tracker'
import { formatCostUsd, formatTokenCount, totalUsageTokens } from '../src/domain/cursor-usage'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

it('参考比例的数字在运行、中断及重开面板后完整呈现；标签及提示统一英文', async () => {
  const tracker = new CursorUsageTracker()
  tracker.recordRequestSample({ composerId: 'c', generationId: 'g', modelId: 'claude-fable-5-1', used: 278120, occurredAt: 1 })
  const usage = tracker.getSnapshot().c!
  await act(async () => root.render(<SessionUsageStat usage={usage} />))
  await act(async () => host.querySelector<HTMLButtonElement>('.session-usage')!.click())
  let dialog = document.querySelector<HTMLElement>('.usage-popover')!
  const rows = Array.from(dialog.querySelectorAll('li'))
  expect(rows.map((row) => row.querySelector('span')!.textContent)).toEqual(['Input', 'Output', 'Cache Write', 'Cache Read'])
  const expected = [usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens, usage.outputTokens, usage.cacheWriteTokens, usage.cacheReadTokens]
  expect(rows.map((row) => row.querySelector('b')!.textContent)).toEqual(expected.map(formatTokenCount))
  expect(rows.reduce((sum, row) => sum + Number(row.querySelector('b')!.title.replaceAll(',', '')), 0)).toBe(totalUsageTokens(usage))
  expect(dialog.textContent).toContain(formatCostUsd(usage.estimatedCostUsd))
  expect(dialog.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  expect(dialog.textContent).not.toContain('incomplete')
  const text = dialog.textContent
  tracker.recordRequestSample({ composerId: 'c', generationId: 'g', used: 278120, stopped: true, occurredAt: 2 })
  tracker.setCollecting(false)
  await act(async () => root.render(<SessionUsageStat usage={tracker.getSnapshot().c} />))
  expect(dialog.textContent).toBe(text)
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close usage details"]')!.click())
  expect(document.querySelector('.usage-popover')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('.session-usage')!.click())
  dialog = document.querySelector('.usage-popover')!
  expect(dialog.textContent).toBe(text)
  tracker.dispose()
})

it('无缓存写入桶的厂商（Kimi K3）：Cache Write 行保留、行序不变，数值为 — 而不是 0；分段条无该段；其余三段之和仍为总 token', async () => {
  const tracker = new CursorUsageTracker()
  tracker.recordRequestSample({ composerId: 'c', generationId: 'g', modelId: 'kimi-k3', used: 278120, occurredAt: 1 })
  const usage = tracker.getSnapshot().c!
  expect(usage.cacheWriteTokens).toBe(0)
  await act(async () => root.render(<SessionUsageStat usage={usage} />))
  await act(async () => host.querySelector<HTMLButtonElement>('.session-usage')!.click())
  const dialog = document.querySelector<HTMLElement>('.usage-popover')!
  const rows = Array.from(dialog.querySelectorAll('li'))
  expect(rows.map((row) => row.querySelector('span')!.textContent)).toEqual(['Input', 'Output', 'Cache Write', 'Cache Read'])
  const cacheWrite = rows[2]!
  expect(cacheWrite.classList.contains('is-unavailable')).toBe(true)
  expect(cacheWrite.querySelector('b')!.textContent).toBe('—')
  expect(cacheWrite.querySelector('b')!.title).toBe('This model has no separate cache-write bucket')
  const numeric = rows.filter((row) => row !== cacheWrite)
  expect(numeric.every((row) => !row.classList.contains('is-unavailable'))).toBe(true)
  expect(numeric.reduce((sum, row) => sum + Number(row.querySelector('b')!.title.replaceAll(',', '')), 0)).toBe(totalUsageTokens(usage))
  expect(dialog.querySelectorAll('.usage-breakdown-bar i.is-cachewrite')).toHaveLength(0)
  // aria 明细与列表同形：四项恒在，无桶写 —
  expect(host.querySelector('.session-usage')!.getAttribute('aria-label')).toContain('Cache Write — · Cache Read')
  expect(dialog.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  tracker.dispose()
})

it('有缓存写入桶的厂商写入恰为 0 时显示 0（观测值），不是 —', async () => {
  const usage = { composerId: 'c', turns: 1, inputTokens: 100, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0, estimatedCostUsd: 0.02, lastTurnAt: 1, pricedModel: 'Claude Fable 5.1', quality: 'exact' as const }
  await act(async () => root.render(<SessionUsageStat usage={usage} />))
  await act(async () => host.querySelector<HTMLButtonElement>('.session-usage')!.click())
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.usage-popover li'))
  expect(rows.map((row) => row.querySelector('span')!.textContent)).toEqual(['Input', 'Output', 'Cache Write', 'Cache Read'])
  expect(rows[2]!.classList.contains('is-unavailable')).toBe(false)
  expect(rows[2]!.querySelector('b')!.textContent).toBe('0')
  expect(host.querySelector('.session-usage')!.getAttribute('aria-label')).toContain('Cache Write 0 · Cache Read')
})

it('空状态及精确零输出仍为正常 UI；不渲染中文或结算说明', async () => {
  await act(async () => root.render(<SessionUsageStat />))
  await act(async () => host.querySelector<HTMLButtonElement>('.session-usage')!.click())
  expect(document.querySelector('.usage-popover')?.textContent).toContain('Usage will appear')
  await act(async () => root.render(<SessionUsageStat usage={{ composerId: 'c', turns: 1, inputTokens: 100, outputTokens: 0, cacheReadTokens: 20, cacheWriteTokens: 0, estimatedCostUsd: 0.02, lastTurnAt: 1, pricedModel: '默认（Sonnet 档）', quality: 'exact' }} />))
  const dialog = document.querySelector('.usage-popover')!
  expect(dialog.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  expect(dialog.querySelectorAll('li')[1]?.querySelector('b')?.textContent).toBe('0')
})
