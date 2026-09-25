// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceReviewFileDiff, WorkspaceReviewSummary } from '../src/domain/workspace-review'
import { buildFileQuote, buildHunkQuote, buildTurnFileQuote, ReviewPanel, splitPath } from '../src/renderer/src/inspector/ReviewPanel'
import { requestReviewFocus } from '../src/renderer/src/inspector/review-focus-bus'
import type { TurnReviewEdit } from '../src/renderer/src/inspector/turn-review-view'
import type { TurnFilesView } from '../src/renderer/src/turn-files-view'

const hunk: WorkspaceReviewFileDiff['hunks'][number] = {
  header: '@@ -10,3 +10,3 @@ function login()',
  skippedBefore: 9,
  lines: [
    { kind: 'context', text: 'const theme = useTheme()', oldLine: 10, newLine: 10 },
    { kind: 'deletion', text: 'const color = theme.light', oldLine: 11 },
    { kind: 'addition', text: 'const color = theme.dark', newLine: 11 },
    { kind: 'context', text: 'return color', oldLine: 12, newLine: 12 }
  ]
}

function summaryOf(scope: 'uncommitted' | 'branch', revision: string): WorkspaceReviewSummary {
  return {
    state: 'ready', scope, workspaceName: 'demo', revision, updatedAt: 1, additions: 6, deletions: 2, liveUpdates: true,
    branch: { current: 'feature/dark', base: 'main' },
    files: [
      { path: 'src/login.tsx', status: 'modified', staged: false, unstaged: true, additions: 4, deletions: 1 },
      { path: 'src/theme.ts', status: 'modified', staged: true, unstaged: false, additions: 2, deletions: 1 },
      ...(scope === 'branch' ? [{ path: 'docs/dark.md', status: 'added' as const, staged: false, unstaged: false, committed: true, additions: 12, deletions: 0 }] : [])
    ]
  }
}

interface ApiMock {
  getWorkspaceReview: ReturnType<typeof vi.fn>
  getWorkspaceReviewFile: ReturnType<typeof vi.fn>
  applyWorkspaceReviewAction: ReturnType<typeof vi.fn>
  openWorkspaceFile: ReturnType<typeof vi.fn>
  revealWorkspaceFile: ReturnType<typeof vi.fn>
  onWorkspaceReviewChanged: ReturnType<typeof vi.fn>
  fireChange: () => void
}

function installApi(): ApiMock {
  let revision = 1
  let changeListener: (() => void) | undefined
  const api: ApiMock = {
    getWorkspaceReview: vi.fn(async (input?: { scope?: 'uncommitted' | 'branch' }) => summaryOf(input?.scope ?? 'uncommitted', `rev-${revision}`)),
    getWorkspaceReviewFile: vi.fn(async ({ path }: { path: string }) => ({ state: 'ready', path, truncated: false, hunks: [hunk] })),
    applyWorkspaceReviewAction: vi.fn(async () => { revision += 1; return { ok: true, message: '已撤销 src/login.tsx 的改动' } }),
    openWorkspaceFile: vi.fn(async () => ({ ok: true, method: 'editor' })),
    revealWorkspaceFile: vi.fn(async () => true),
    onWorkspaceReviewChanged: vi.fn((listener: () => void) => { changeListener = listener; return () => { changeListener = undefined } }),
    fireChange: () => { revision += 1; changeListener?.() }
  }
  Object.defineProperty(window, 'sgDesktop', { configurable: true, value: api })
  return api
}

describe('ReviewPanel', () => {
  let container: HTMLDivElement
  const scopeKey = 'sg-team.inspector:review-scope:v2'
  const chooseScope = async (label: string): Promise<void> => {
    await act(async () => container.querySelector<HTMLButtonElement>('.inspector-review__scope-trigger')!.click())
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
      .find((button) => button.textContent?.includes(label))!.click())
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem(scopeKey, 'uncommitted')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    localStorage.clear()
  })

  it('opens on Last Turn by default and keeps the range menu keyboard accessible', async () => {
    localStorage.removeItem(scopeKey)
    localStorage.setItem('sg-team.inspector:review-scope', 'uncommitted') // previous UI preference is deliberately reset once
    installApi()
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={['src/login.tsx']} />))
    const trigger = container.querySelector<HTMLButtonElement>('.inspector-review__scope-trigger')!
    expect(trigger.textContent).toContain('Last Turn')
    await act(async () => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.textContent).toContain('Last Turn')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement?.textContent).toContain('Uncommitted')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    await act(async () => root.unmount())
  })

  it('shows files with branch info, filters the turn scope by touched paths and re-fetches on scope switch', async () => {
    const api = installApi()
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={['src/login.tsx']} />))
    expect(container.textContent).toContain('src/')
    expect(container.textContent).toContain('login.tsx')
    expect(container.textContent).toContain('theme.ts')
    expect(container.textContent).toContain('feature/dark → main')
    expect(container.querySelector('.inspector-review__live')).toBeNull()
    expect(container.textContent).toContain('2 个文件')
    // 首个文件默认展开并读取差异；字级高亮只标出变化的 token。
    expect(api.getWorkspaceReviewFile).toHaveBeenCalledWith({ path: 'src/login.tsx', scope: 'uncommitted' })
    const marks = Array.from(container.querySelectorAll('.review-line mark')).map((mark) => mark.textContent)
    expect(marks).toEqual(['light', 'dark'])
    // 已暂存文件显示状态标签。
    expect(container.textContent).toContain('已暂存')

    await chooseScope('Last Turn')
    expect(container.textContent).toContain('login.tsx')
    expect(container.textContent).not.toContain('theme.ts')
    expect(localStorage.getItem(scopeKey)).toBe('turn')

    await chooseScope('Branch')
    expect(api.getWorkspaceReview).toHaveBeenLastCalledWith({ scope: 'branch' })
    expect(container.textContent).toContain('dark.md')
    expect(container.textContent).toContain('已提交')
    // 分支范围只读：没有 Git 动作按钮。
    expect(container.querySelector('[aria-label="撤销 src/login.tsx"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('aligns deleted and added numbers in one gutter even when old and new ranges differ', async () => {
    const api = installApi()
    api.getWorkspaceReviewFile.mockResolvedValue({
      state: 'ready', path: 'src/login.tsx', truncated: false,
      hunks: [{ header: '@@ -799 +813 @@', skippedBefore: 0, lines: [
        { kind: 'deletion', text: 'before', oldLine: 799 },
        { kind: 'addition', text: 'after', newLine: 813 }
      ] }]
    })
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={[]} />))
    const deleted = container.querySelector('.review-line.is-deletion')!
    const added = container.querySelector('.review-line.is-addition')!
    expect(deleted.querySelectorAll(':scope > span')).toHaveLength(1)
    expect(added.querySelectorAll(':scope > span')).toHaveLength(1)
    expect(deleted.querySelector(':scope > span')?.textContent?.trim()).toBe('799')
    expect(added.querySelector(':scope > span')?.textContent?.trim()).toBe('813')
    await act(async () => root.unmount())
  })

  it('reloads when the main process pushes a change signal and re-reads expanded diffs on a new revision', async () => {
    const api = installApi()
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={[]} />))
    const before = api.getWorkspaceReview.mock.calls.length
    const diffCallsBefore = api.getWorkspaceReviewFile.mock.calls.length
    await act(async () => api.fireChange())
    expect(api.getWorkspaceReview.mock.calls.length).toBeGreaterThan(before)
    expect(api.getWorkspaceReviewFile.mock.calls.length).toBeGreaterThan(diffCallsBefore)
    await act(async () => root.unmount())
    expect(api.onWorkspaceReviewChanged).toHaveBeenCalledTimes(1)
  })

  it('quotes a hunk into the composer and only reverts after explicit confirmation', async () => {
    const api = installApi()
    const onQuote = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={[]} onQuote={onQuote} />))

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="反馈这段差异给 Agent"]')!.click())
    expect(onQuote).toHaveBeenCalledTimes(1)
    const quoted = onQuote.mock.calls[0]![0] as string
    expect(quoted).toContain('`src/login.tsx` L10–L12')
    expect(quoted).toContain('```diff')
    expect(quoted).toContain('-const color = theme.light')
    expect(quoted).toContain('+const color = theme.dark')

    const revertButton = container.querySelector<HTMLButtonElement>('[aria-label="撤销 src/login.tsx"]')!
    await act(async () => { revertButton.focus(); revertButton.click() })
    expect(api.applyWorkspaceReviewAction).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('恢复到 HEAD 版本')
    expect(document.activeElement?.textContent).toBe('取消')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })))
    expect(document.activeElement?.textContent).toBe('取消')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })))
    expect(document.activeElement?.textContent).toBe('确认撤销')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement).toBe(revertButton)

    await act(async () => revertButton.click())
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '取消')!.click())
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement).toBe(revertButton)
    expect(api.applyWorkspaceReviewAction).not.toHaveBeenCalled()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="撤销 src/login.tsx"]')!.click())
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认撤销')!.click())
    expect(api.applyWorkspaceReviewAction).toHaveBeenCalledWith({ path: 'src/login.tsx', action: 'revert' })
    expect(container.textContent).toContain('已撤销 src/login.tsx 的改动')

    // 纯未暂存文件的 hunk 可以直接暂存（无需确认）；已暂存文件不提供 hunk 暂存。
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂存代码块 L10"]')!.click())
    expect(api.applyWorkspaceReviewAction).toHaveBeenLastCalledWith({ path: 'src/login.tsx', action: 'stage', hunkHeader: hunk.header })
    await act(async () => root.unmount())
  })

  it('keeps the expanded diff on screen while a new revision is being read instead of flashing a skeleton', async () => {
    const api = installApi()
    let release: ((diff: WorkspaceReviewFileDiff) => void) | undefined
    api.getWorkspaceReviewFile.mockImplementation(async ({ path }: { path: string }) => {
      // 第二次读取挂起：模拟 git diff 尚未返回的窗口。
      if (api.getWorkspaceReviewFile.mock.calls.length > 1) {
        return new Promise<WorkspaceReviewFileDiff>((done) => { release = done })
      }
      return { state: 'ready', path, truncated: false, hunks: [hunk] }
    })
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={[]} />))
    expect(container.querySelector('.review-line')).toBeTruthy()
    const lineBefore = container.querySelector('.review-line')

    await act(async () => api.fireChange())
    // 新 revision 已到、差异还在路上：旧差异原样留在屏幕上，没有骨架屏。
    expect(container.querySelector('.review-file__loading')).toBeNull()
    expect(container.querySelector('.review-line')).toBe(lineBefore)
    expect(release).toBeTypeOf('function')

    const replaced: WorkspaceReviewFileDiff = {
      state: 'ready', path: 'src/login.tsx', truncated: false,
      hunks: [{ ...hunk, lines: [{ kind: 'addition', text: 'const color = theme.midnight', newLine: 11 }] }]
    }
    await act(async () => { release!(replaced) })
    expect(container.textContent).toContain('theme.midnight')
    expect(container.textContent).not.toContain('theme.light')

    // 收起状态的文件不会沿用旧差异：展开时重新读取（骨架屏出现在首次展开）。
    const heads = Array.from(container.querySelectorAll<HTMLButtonElement>('.review-file__head'))
    const callsBefore = api.getWorkspaceReviewFile.mock.calls.length
    await act(async () => heads[1]!.click())
    expect(api.getWorkspaceReviewFile.mock.calls.length).toBe(callsBefore + 1)
    expect(container.querySelector('.review-file__loading')).toBeTruthy()
    await act(async () => root.unmount())
  })

  it('pauses polling while hidden, defers pushed changes and catches up once visible again', async () => {
    vi.useFakeTimers()
    try {
      const api = installApi()
      const root = createRoot(container)
      const render = (paused: boolean): Promise<void> => act(async () => root.render(
        <ReviewPanel workspaceKey="ws" turnPaths={[]} paused={paused} pollIntervalMs={{ live: 1_000, fallback: 500 }} />
      ))
      await render(false)
      const afterMount = api.getWorkspaceReview.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(1_050) })
      expect(api.getWorkspaceReview.mock.calls.length).toBe(afterMount + 1)

      await render(true)
      const whenPaused = api.getWorkspaceReview.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(api.getWorkspaceReview.mock.calls.length).toBe(whenPaused)
      // 收起期间的推送只记标记，不发请求。
      await act(async () => api.fireChange())
      expect(api.getWorkspaceReview.mock.calls.length).toBe(whenPaused)

      // 展开：补拉一次，并恢复轮询。
      await render(false)
      expect(api.getWorkspaceReview.mock.calls.length).toBe(whenPaused + 1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_050) })
      expect(api.getWorkspaceReview.mock.calls.length).toBe(whenPaused + 2)
      await act(async () => root.unmount())
    } finally {
      vi.useRealTimers()
    }
  })

  it('a review-focus request from the turn-files bar switches to the turn scope and expands + highlights the named file', async () => {
    const api = installApi()
    const root = createRoot(container)
    await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={['src/login.tsx', 'src/theme.ts']} />))
    // 默认范围「未提交」，首个文件展开、第二个收起。
    expect(localStorage.getItem(scopeKey)).toBe('uncommitted')
    expect(container.querySelector('.review-file[data-path="src/theme.ts"]')!.className).not.toContain('is-open')

    await act(async () => requestReviewFocus({ path: 'src/theme.ts' }))
    // 范围切到「本轮」（摘要按范围重拉后仍是同一批文件），目标文件被展开、读取差异并短暂高亮。
    expect(localStorage.getItem(scopeKey)).toBe('turn')
    expect(container.querySelector<HTMLButtonElement>('.inspector-review__scope-trigger')!.textContent).toContain('Last Turn')
    const target = container.querySelector('.review-file[data-path="src/theme.ts"]')!
    expect(target.className).toContain('is-open')
    expect(target.className).toContain('is-revealed')
    expect(api.getWorkspaceReviewFile).toHaveBeenCalledWith({ path: 'src/theme.ts', scope: 'uncommitted' })

    // 不带路径：只切范围，不改展开集合。
    await chooseScope('Uncommitted')
    expect(localStorage.getItem(scopeKey)).toBe('uncommitted')
    await act(async () => requestReviewFocus())
    expect(localStorage.getItem(scopeKey)).toBe('turn')

    // 文件栏处于「上一轮」保持态时请求「未提交」范围（那时右栏的「本轮」是空的）：切过去并定位同一文件。
    await act(async () => requestReviewFocus({ path: 'src/login.tsx', scope: 'uncommitted' }))
    expect(localStorage.getItem(scopeKey)).toBe('uncommitted')
    expect(container.querySelector<HTMLButtonElement>('.inspector-review__scope-trigger')!.textContent).toContain('Uncommitted')
    expect(container.querySelector('.review-file[data-path="src/login.tsx"]')!.className).toContain('is-revealed')
    await act(async () => root.unmount())
  })

  describe('本轮 · Agent 编辑流', () => {
    const turnView = (over?: Partial<TurnFilesView>): TurnFilesView => ({
      files: [
        { path: 'src/relay.ts', dir: 'src/', stem: 'relay', ext: '.ts', icon: 'typescript', ambiguous: false, additions: 24, deletions: 6, source: 'process' },
        { path: 'src/app.tsx', dir: 'src/', stem: 'app', ext: '.tsx', icon: 'react', ambiguous: false, additions: 3, deletions: 0, source: 'process' }
      ],
      additions: 27, deletions: 6, working: true, estimated: true, totalsSource: 'sum', scope: 'turn',
      ...over
    })

    const turnEdits = new Map<string, TurnReviewEdit[]>([
      ['src/relay.ts', [
        {
          blockId: 'e1', action: 'edit', hint: '+20 −6', running: false, failed: false,
          hunks: [{
            header: '@@ -8,3 +8,3 @@ relay()', skippedBefore: 0,
            lines: [
              { kind: 'context', text: 'const q = queue()', oldLine: 8, newLine: 8 },
              { kind: 'deletion', text: 'q.push(job)', oldLine: 9 },
              { kind: 'addition', text: 'q.unshift(job)', newLine: 9 }
            ]
          }]
        },
        {
          blockId: 'e2', action: 'edit', hint: '+4 −0', running: false, failed: false,
          hunks: [{ header: '', skippedBefore: 0, lines: [{ kind: 'addition', text: 'export const RETRIES = 3', newLine: 30 }] }],
          truncatedLineCount: 5
        }
      ]],
      ['src/app.tsx', [
        { blockId: 'e3', action: 'write', hint: '+3 −0', hunks: [], running: true, failed: false }
      ]]
    ])

    function installNotGitApi(): ApiMock {
      const api = installApi()
      api.getWorkspaceReview.mockImplementation(async (input?: { scope?: 'uncommitted' | 'branch' }) => ({
        state: 'not_git' as const, scope: input?.scope ?? 'uncommitted', workspaceName: 'cs', revision: 'nogit-1', updatedAt: 1,
        additions: 0, deletions: 0, files: [], liveUpdates: false, detail: '该文件夹不在任何 Git 仓库内；初始化仓库后即可在这里审查变更。'
      }))
      return api
    }

    it('in a non-git workspace the panel auto-switches to 本轮 and renders the edit stream without any git reads', async () => {
      const api = installNotGitApi()
      const onQuote = vi.fn()
      const root = createRoot(container)
      await act(async () => root.render(
        <ReviewPanel workspaceKey="ws" turnPaths={['src/relay.ts', 'src/app.tsx']} turnFiles={turnView()} turnEdits={turnEdits} onQuote={onQuote} />
      ))
      // not_git 一到就自动落到「本轮」；死卡片不出现。
      expect(localStorage.getItem(scopeKey)).toBe('turn')
      expect(container.querySelector<HTMLButtonElement>('.inspector-review__scope-trigger')!.textContent).toContain('Last Turn')
      expect(container.textContent).not.toContain('当前工程未启用 Git')
      // 合计与文件栏同源：估算标 ≈。
      const totals = container.querySelector('.inspector-review__totals')!
      expect(totals.textContent).toContain('≈')
      expect(totals.textContent).toContain('+27')
      expect(totals.textContent).toContain('−6')
      expect(container.querySelectorAll('.review-file')).toHaveLength(2)
      // 首个文件默认展开，差异行来自编辑流；Git 的单文件差异接口一次都没被叫。
      const relay = container.querySelector('.review-file[data-path="src/relay.ts"]')!
      expect(relay.className).toContain('is-open')
      expect(relay.textContent).toContain('q.unshift(job)')
      expect(relay.textContent).toContain('第 1 次')
      expect(relay.textContent).toContain('第 2 次')
      expect(relay.textContent).toContain('多次编辑按发生顺序逐次展示')
      expect(relay.textContent).toContain('差异过长，传输截断了 5 行')
      expect(api.getWorkspaceReviewFile).not.toHaveBeenCalled()
      // Git 动作不可用（工作区没有 Git）；查看 / 引用照常。
      expect(container.querySelector('[aria-label="暂存 src/relay.ts"]')).toBeNull()
      expect(container.querySelector('[aria-label="撤销 src/relay.ts"]')).toBeNull()
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="反馈 src/relay.ts 给 Agent"]')!.click())
      expect(onQuote).toHaveBeenCalledWith('> 关于 `src/relay.ts`（本轮 2 次编辑 · +24 −6）：\n\n')
      // 正在写入的文件：展开后是占位而不是空白。
      const appHead = container.querySelector<HTMLButtonElement>('.review-file[data-path="src/app.tsx"] .review-file__head')!
      await act(async () => appHead.click())
      expect(container.querySelector('.review-file[data-path="src/app.tsx"]')!.textContent).toContain('正在写入，差异稍后出现…')

      // 手动切回「未提交」还能看到 not_git 卡片，且带「查看本轮 Agent 改动」的回程链接。
      await chooseScope('Uncommitted')
      expect(container.textContent).toContain('当前工程未启用 Git')
      const back = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '查看本轮 Agent 改动')!
      await act(async () => back.click())
      expect(container.querySelector<HTMLButtonElement>('.inspector-review__scope-trigger')!.textContent).toContain('Last Turn')
      await act(async () => root.unmount())
    })

    it('with git ready the rows gain status letters and git actions; totals drop the ≈ when counts are exact', async () => {
      const api = installApi()
      localStorage.setItem(scopeKey, 'turn')
      const view = turnView({
        files: [{ path: 'src/login.tsx', dir: 'src/', stem: 'login', ext: '.tsx', icon: 'react', ambiguous: false, additions: 4, deletions: 1, status: 'modified', source: 'git' }],
        additions: 4, deletions: 1, estimated: false, working: false
      })
      const edits = new Map<string, TurnReviewEdit[]>([
        ['src/login.tsx', [{ blockId: 'g1', action: 'edit', hint: '+4 −1', running: false, failed: false, hunks: [{ header: '@@ -10,3 +10,3 @@', skippedBefore: 0, lines: [{ kind: 'addition', text: 'const color = theme.dark', newLine: 11 }] }] }]]
      ])
      const root = createRoot(container)
      await act(async () => root.render(
        <ReviewPanel workspaceKey="ws" turnPaths={['src/login.tsx']} turnFiles={view} turnEdits={edits} />
      ))
      const row = container.querySelector('.review-file[data-path="src/login.tsx"]')!
      expect(row.className).toContain('is-modified')
      expect(row.querySelector('.review-file__head > i .file-type-icon.is-react')).not.toBeNull()
      expect(row.querySelector('.review-file__counts')!.textContent).not.toContain('≈')
      expect(container.querySelector('.inspector-review__totals')!.getAttribute('title')).toContain('工作树相对 HEAD')
      // Git 认识这个文件：暂存可用，撤销走确认（作用于工作树，与「未提交」同一后端）。
      expect(container.querySelector('[aria-label="暂存 src/login.tsx"]')).not.toBeNull()
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="撤销 src/login.tsx"]')!.click())
      expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('恢复到 HEAD 版本')
      await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认撤销')!.click())
      expect(api.applyWorkspaceReviewAction).toHaveBeenCalledWith({ path: 'src/login.tsx', action: 'revert' })
      // 差异行仍来自编辑流，不触发 Git 单文件差异读取。
      expect(row.textContent).toContain('const color = theme.dark')
      expect(api.getWorkspaceReviewFile).not.toHaveBeenCalled()
      await act(async () => root.unmount())
    })

    it('holds the previous turn with a note, and composer-sourced totals name Cursor as the source', async () => {
      installApi()
      localStorage.setItem(scopeKey, 'turn')
      const root = createRoot(container)
      await act(async () => root.render(
        <ReviewPanel workspaceKey="ws" turnPaths={[]} turnFiles={turnView({ scope: 'previous' })} turnEdits={turnEdits} />
      ))
      expect(container.textContent).toContain('新一轮尚无编辑：以下是上一轮的改动')
      expect(container.querySelector('.review-files')!.getAttribute('data-turn-scope')).toBe('previous')

      await act(async () => root.render(
        <ReviewPanel workspaceKey="ws" turnPaths={[]} turnFiles={turnView({ totalsSource: 'composer', estimated: false, additions: 21, deletions: 4 })} turnEdits={turnEdits} />
      ))
      const totals = container.querySelector('.inspector-review__totals')!
      expect(totals.textContent).not.toContain('≈')
      expect(totals.textContent).toContain('+21')
      expect(totals.getAttribute('title')).toContain('Cursor 统计的本会话累计净增删')
      await act(async () => root.unmount())
    })

    it('a focus request reveals the named file instantly from the edit stream, without waiting for git', async () => {
      const api = installNotGitApi()
      const root = createRoot(container)
      await act(async () => root.render(
        <ReviewPanel workspaceKey="ws" turnPaths={[]} turnFiles={turnView()} turnEdits={turnEdits} />
      ))
      await act(async () => requestReviewFocus({ path: 'src/app.tsx', scope: 'turn' }))
      const target = container.querySelector('.review-file[data-path="src/app.tsx"]')!
      expect(target.className).toContain('is-open')
      expect(target.className).toContain('is-revealed')
      expect(api.getWorkspaceReviewFile).not.toHaveBeenCalled()
      await act(async () => root.unmount())
    })

    it('an empty turn shows its own empty state and offers the git jump only when git is ready', async () => {
      installNotGitApi()
      localStorage.setItem(scopeKey, 'turn')
      const empty: TurnFilesView = { files: [], additions: 0, deletions: 0, working: false, estimated: false, totalsSource: 'sum', scope: 'turn' }
      const root = createRoot(container)
      await act(async () => root.render(<ReviewPanel workspaceKey="ws" turnPaths={[]} turnFiles={empty} turnEdits={new Map()} />))
      expect(container.textContent).toContain('本轮尚未修改文件')
      // 非 Git 工程：不给「查看全部未提交变更」的死链接。
      expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '查看全部未提交变更')).toBeUndefined()
      await act(async () => root.unmount())
    })

    it('buildTurnFileQuote names the edit count and counts', () => {
      expect(buildTurnFileQuote({ path: 'src/a.ts', dir: 'src/', stem: 'a', ext: '.ts', icon: 'typescript', ambiguous: false, additions: 3, deletions: 0, source: 'process' }, 2))
        .toBe('> 关于 `src/a.ts`（本轮 2 次编辑 · +3）：\n\n')
    })
  })

  it('splits paths so the extension survives truncation', () => {
    expect(splitPath('src/renderer/workspace-inspector.css')).toEqual({ dir: 'src/renderer/', stem: 'workspace-inspector', ext: '.css' })
    expect(splitPath('README')).toEqual({ dir: '', stem: 'README', ext: '' })
    expect(splitPath('.gitignore')).toEqual({ dir: '', stem: '.gitignore', ext: '' })
    expect(splitPath('docs/notes.')).toEqual({ dir: 'docs/', stem: 'notes.', ext: '' })
    expect(splitPath('tests/inspector-shell.test.tsx')).toEqual({ dir: 'tests/', stem: 'inspector-shell.test', ext: '.tsx' })
  })

  it('builds plain-text quotes for files and hunks', () => {
    expect(buildFileQuote({ path: 'src/a.ts', status: 'modified', staged: false, unstaged: true, additions: 3, deletions: 1 })).toBe('> 关于 `src/a.ts`（已修改 · +3 −1）：\n\n')
    expect(buildHunkQuote('src/a.ts', hunk)).toContain(hunk.header)
  })
})
