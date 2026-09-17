// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TURN_FILES_COLLAPSED_KEY, TurnFilesBar } from '../src/renderer/src/TurnFilesBar'
import type { TurnFilesView } from '../src/renderer/src/turn-files-view'

const view: TurnFilesView = {
  files: [
    { path: 'src/domain/team-control.ts', dir: 'src/domain/', stem: 'team-control', ext: '.ts', badge: 'TS', additions: 18, deletions: 20, status: 'modified', source: 'git' },
    { path: 'src/mcp/index.ts', dir: 'src/mcp/', stem: 'index', ext: '.ts', badge: 'TS', additions: 22, deletions: 37, status: 'modified', source: 'git' },
    { path: 'docs/old.md', dir: 'docs/', stem: 'old', ext: '.md', badge: 'MD', additions: 0, deletions: 30, status: 'deleted', source: 'git' },
    { path: 'src/new-file.ts', dir: 'src/', stem: 'new-file', ext: '.ts', badge: 'TS', additions: 9, deletions: 0, source: 'process' }
  ],
  additions: 49,
  deletions: 87,
  working: true,
  estimated: true,
  scope: 'turn'
}

describe('TurnFilesBar（本轮文件栏）', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    localStorage.clear()
  })

  it('renders nothing when the turn has not touched any file', () => {
    expect(renderToStaticMarkup(<TurnFilesBar view={{ files: [], additions: 0, deletions: 0, working: true, estimated: false, scope: 'turn' }} onReview={() => {}} />)).toBe('')
  })

  it('lists one row per file with badge, name, directory, status mark and +/− counts; head carries count, totals, spinner and 审查', () => {
    const html = renderToStaticMarkup(<TurnFilesBar view={view} onReview={() => {}} />)
    expect(html).toContain('turn-files is-open is-working is-estimated')
    expect(html).toContain('data-file-count="4"')
    expect(html).toContain('<b>4</b> 个文件')
    // 合计：绿 + / 红 −，估算前置 ≈。
    expect(html).toMatch(/turn-files__totals[^>]*>.*?≈.*?<b>\+49<\/b><em>−87<\/em>/)
    expect(html).toContain('turn-files__spinner')
    expect(html).toContain('>审查<')
    // 行：路径为 key / data-path，徽标、主干 + 扩展名、目录、增删。
    expect(html).toContain('data-path="src/domain/team-control.ts"')
    expect(html).toMatch(/turn-files__badge[^>]*>TS</)
    expect(html).toMatch(/<strong><span>team-control<\/span><b>\.ts<\/b><\/strong><small><bdi>src\/domain\/<\/bdi><\/small>/)
    expect(html).toMatch(/<b>\+18<\/b><em>−20<\/em>/)
    expect(html).toMatch(/<b>\+22<\/b><em>−37<\/em>/)
    // 删除的文件带 D 标记；只有过程块估算的文件行标 is-estimated。
    expect(html).toContain('turn-files__item is-deleted')
    expect(html).toMatch(/turn-files__status[^>]*title="已删除"[^>]*>D</)
    expect(html).toContain('turn-files__item is-estimated')
    expect(html.match(/class="turn-files__row"/g)?.length).toBe(4)
    expect(html).toContain('aria-expanded="true"')
    // 没有「中止」入口：中止 Cursor 回合不是拾光的能力。
    expect(html).not.toContain('Stop')
    expect(html).not.toContain('中止')
  })

  it('omits the spinner when the Agent has replied and shows exact totals without ≈ when every count is git-backed', () => {
    const settled: TurnFilesView = { ...view, working: false, estimated: false, files: view.files.filter((file) => file.source === 'git') }
    const html = renderToStaticMarkup(<TurnFilesBar view={settled} onReview={() => {}} />)
    expect(html).not.toContain('turn-files__spinner')
    expect(html).not.toContain('≈')
    expect(html).toContain('turn-files is-open"')
  })

  it('without an onReview handler the rows are inert and there is no 审查 button', () => {
    const html = renderToStaticMarkup(<TurnFilesBar view={view} />)
    expect(html).not.toContain('>审查<')
    expect(html.match(/class="turn-files__row" title="[^"]*" disabled=""/g)?.length).toBe(4)
  })

  it('审查 asks for the turn scope without a path; a row asks for that file; the collapse state persists', async () => {
    const onReview = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(<TurnFilesBar view={view} onReview={onReview} />))
    await act(async () => container.querySelector<HTMLButtonElement>('.turn-files__review')!.click())
    expect(onReview).toHaveBeenLastCalledWith({ scope: 'turn' })
    await act(async () => container.querySelector<HTMLButtonElement>('[data-path="src/mcp/index.ts"] .turn-files__row')!.click())
    expect(onReview).toHaveBeenLastCalledWith({ path: 'src/mcp/index.ts', scope: 'turn' })

    const toggle = container.querySelector<HTMLButtonElement>('.turn-files__toggle')!
    const listwrap = container.querySelector<HTMLElement>('.turn-files__listwrap')!
    expect(listwrap.hasAttribute('inert')).toBe(false)
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.turn-files')!.className).toContain('is-collapsed')
    // 列表常驻挂载：收起只 inert，不卸载行（数字继续更新、展开时无需重建）。
    expect(listwrap.hasAttribute('inert')).toBe(true)
    expect(container.querySelectorAll('.turn-files__item')).toHaveLength(4)
    expect(localStorage.getItem(TURN_FILES_COLLAPSED_KEY)).toBe('1')
    await act(async () => root.unmount())

    // 下次挂载读回折叠状态。
    const again = createRoot(container)
    await act(async () => again.render(<TurnFilesBar view={view} onReview={onReview} />))
    expect(container.querySelector('.turn-files')!.className).toContain('is-collapsed')
    await act(async () => again.unmount())
  })

  it('yields to the delivery tray: head only (no spinner), a manual expand is one-off, and the stored preference comes back when the tray leaves', async () => {
    const root = createRoot(container)
    await act(async () => root.render(<TurnFilesBar view={view} onReview={() => {}} yieldToTray />))
    const bar = (): HTMLElement => container.querySelector<HTMLElement>('.turn-files')!
    const listwrap = (): HTMLElement => container.querySelector<HTMLElement>('.turn-files__listwrap')!
    // 让位：默认收起（列表仍挂载、inert），头部保留计数 / 合计 / 审查；托盘头已经在说「正在处理」，这里不再转圈。
    expect(bar().className).toContain('is-collapsed')
    expect(bar().className).toContain('is-yielding')
    expect(bar().className).not.toContain('is-working')
    expect(listwrap().hasAttribute('inert')).toBe(true)
    expect(container.querySelectorAll('.turn-files__item')).toHaveLength(4)
    expect(container.querySelector('.turn-files__spinner')).toBeNull()
    expect(container.textContent).toContain('4 个文件')
    expect(container.textContent).toContain('审查')
    // 手动展开是一次性的，不写入偏好。
    await act(async () => container.querySelector<HTMLButtonElement>('.turn-files__toggle')!.click())
    expect(bar().className).toContain('is-open')
    expect(listwrap().hasAttribute('inert')).toBe(false)
    expect(localStorage.getItem(TURN_FILES_COLLAPSED_KEY)).toBeNull()
    // 托盘走了：回到用户自己的偏好（默认展开）、恢复转圈；托盘再来仍先让位。
    await act(async () => root.render(<TurnFilesBar view={view} onReview={() => {}} yieldToTray={false} />))
    expect(bar().className).toContain('is-open')
    expect(bar().className).toContain('is-working')
    expect(container.querySelector('.turn-files__spinner')).not.toBeNull()
    await act(async () => root.render(<TurnFilesBar view={view} onReview={() => {}} yieldToTray />))
    expect(bar().className).toContain('is-collapsed')
    await act(async () => root.unmount())
  })

  it('a stored collapsed preference is honoured once the tray leaves, independent of the one-off expand while yielding', async () => {
    localStorage.setItem(TURN_FILES_COLLAPSED_KEY, '1')
    const root = createRoot(container)
    await act(async () => root.render(<TurnFilesBar view={view} onReview={() => {}} yieldToTray />))
    await act(async () => container.querySelector<HTMLButtonElement>('.turn-files__toggle')!.click())
    expect(container.querySelector('.turn-files')!.className).toContain('is-open')
    await act(async () => root.render(<TurnFilesBar view={view} onReview={() => {}} />))
    expect(container.querySelector('.turn-files')!.className).toContain('is-collapsed')
    expect(localStorage.getItem(TURN_FILES_COLLAPSED_KEY)).toBe('1')
    await act(async () => root.unmount())
  })

  it('in the 上一轮 hold the head is labelled, the bar is dimmed and 审查 / rows ask for the uncommitted scope', async () => {
    const onReview = vi.fn()
    const previous: TurnFilesView = { ...view, scope: 'previous' }
    const html = renderToStaticMarkup(<TurnFilesBar view={previous} onReview={onReview} />)
    expect(html).toContain('turn-files is-open is-working is-estimated is-previous')
    expect(html).toContain('data-scope="previous"')
    expect(html).toContain('aria-label="上一轮改动的文件"')
    expect(html).toMatch(/turn-files__scope[^>]*>上一轮</)
    expect(html).toContain('范围：未提交')

    const root = createRoot(container)
    await act(async () => root.render(<TurnFilesBar view={previous} onReview={onReview} />))
    await act(async () => container.querySelector<HTMLButtonElement>('.turn-files__review')!.click())
    expect(onReview).toHaveBeenLastCalledWith({ scope: 'uncommitted' })
    await act(async () => container.querySelector<HTMLButtonElement>('[data-path="src/mcp/index.ts"] .turn-files__row')!.click())
    expect(onReview).toHaveBeenLastCalledWith({ path: 'src/mcp/index.ts', scope: 'uncommitted' })
    await act(async () => root.unmount())
  })

  it('keeps row identity when counts change: the DOM node for a path survives a new view object', async () => {
    const root = createRoot(container)
    await act(async () => root.render(<TurnFilesBar view={view} onReview={() => {}} />))
    const before = container.querySelector('[data-path="src/domain/team-control.ts"]')!
    const grown: TurnFilesView = {
      ...view,
      additions: 60,
      files: view.files.map((file) => file.path === 'src/domain/team-control.ts' ? { ...file, additions: 29 } : file)
    }
    await act(async () => root.render(<TurnFilesBar view={grown} onReview={() => {}} />))
    const after = container.querySelector('[data-path="src/domain/team-control.ts"]')!
    expect(after).toBe(before)
    expect(after.textContent).toContain('+29')
    expect(container.querySelector('.turn-files__totals')!.textContent).toContain('+60')
    await act(async () => root.unmount())
  })
})
