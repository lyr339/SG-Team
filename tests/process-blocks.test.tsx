// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProcessBlock } from '../src/domain/conversation-entry'
import { ProcessBlocks } from '../src/renderer/src/ProcessBlocks'
import { ProcessTurnCard } from '../src/renderer/src/ProcessTurnCard'
import { requestReveal } from '../src/renderer/src/inspector/reveal-bus'

describe('ProcessBlocks', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders tool, thinking and command blocks with status labels', () => {
    // shell 独立成卡；其后的 grep + 进行中的 thinking 折叠为尾组，尾组在进行中时带直播预览窗，
    // 成员行与 Thinking 正文在预览里可见（Cursor 组 loading 态同款）。
    const blocks: ProcessBlock[] = [
      {
        kind: 'command',
        id: 'cmd-1',
        command: 'npm test',
        output: '385 passed',
        status: 'failed',
        exitCode: 1
      },
      {
        kind: 'tool',
        id: 'tool-1',
        toolName: 'rg',
        toolKind: 'search',
        summary: 'rg process',
        status: 'done',
        output: 'src/renderer/src/ProcessBlocks.tsx'
      },
      {
        kind: 'thinking',
        id: 'think-1',
        text: '分析过程链路并确认可落地点',
        status: 'running'
      }
    ]

    const html = renderToStaticMarkup(<ProcessBlocks blocks={blocks} />)

    // 动词随状态变化（Cursor 的 Running / Ran / Run 三态，错误态是原形动词 + 红色），不再是猜测性的「运行验证」。
    expect(html).toContain('<strong>Run</strong>')
    expect(html).toContain('is-command is-failed')
    // 组头：进行中取 loading 形态 + 明细计数（Cursor 原文英文，2026-09-22）；预览窗内成员行可见。
    expect(html).toContain('cursor-native-group is-explore is-running')
    expect(html).toContain('<strong>Exploring</strong>')
    expect(html).toContain('1 search')
    expect(html).toContain('cursor-native-group__preview')
    expect(html).toContain('Grepped')
    // 进行中的思考：标题即状态「Thinking」，流光由 CSS 按 is-running 应用（原脉冲点已移除，2026-09-13）
    expect(html).toContain('<strong>Thinking</strong>')
    expect(html).toContain('cursor-native-thought is-running')
    expect(html).not.toContain('cursor-native-thought__pulse')
    expect(html).not.toContain('<strong>Thought</strong>')
    expect(html).toContain('aria-expanded="false"')
  })

  it('inlines the generated image under the head of a finished image step and keeps the running one image-free', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[
      {
        kind: 'tool', id: 'img-done', toolName: 'generate_image', toolKind: 'image', toolCase: 'generateImageToolCall',
        summary: 'board-v1.png', status: 'done', input: { description: 'design board', filePath: 'board-v1.png' },
        image: { path: '/tmp/assets/board-v1.png' }
      },
      { kind: 'tool', id: 'img-running', toolName: 'generate_image', toolKind: 'image', toolCase: 'generateImageToolCall', summary: 'board-v2.png', status: 'running' }
    ]} />)
    // 两张卡都独立成卡（Cursor 也不把图片生成归入探索组），动词随状态：Generated image / Generating image。
    expect(html).toContain('cursor-native-tool is-image is-done')
    expect(html).toContain('<strong>Generated image</strong>')
    expect(html).toContain('cursor-native-tool is-image is-running')
    expect(html).toContain('<strong>Generating image</strong>')
    expect(html).not.toContain('generate_image')
    // 完成卡：缩略图经 sg-image 协议内联在头部之下，不需要展开；进行中的卡没有图片正文。
    expect(html).toContain('src="sg-image://local/%2Ftmp%2Fassets%2Fboard-v1.png"')
    expect(html.match(/cursor-native-image/g)).toHaveLength(1)
    // 输入明细仍可展开（提示词在里面），但输出里没有 {filePath, imageData} 的 JSON 文本。
    expect(html).not.toContain('imageData')
  })

  it('renders a shell as a standalone card with the $ command line and an inline output preview', () => {
    const running = renderToStaticMarkup(<ProcessBlocks blocks={[{
      kind: 'tool', id: 'sh-run', toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall',
      title: '跑回归', summary: 'npx vitest run tests/relay --reporter=dot && echo "done"', hint: 'npx, echo',
      status: 'running', output: 'tick 1\ntick 2\n'
    }]} />)
    expect(running).toContain('cursor-native-shell')
    // 头部：意图说明 + 动词 + 程序名；命令本身移到正文 `$ …` 着色行。
    expect(running).toContain('<strong>跑回归</strong>')
    expect(running).toContain('Running')
    expect(running).toContain('cursor-native-shell__prompt')
    expect(running).toContain('cursor-native-shell__token is-command">npx<')
    expect(running).toContain('cursor-native-shell__token is-flag">--reporter=dot<')
    expect(running).toContain('cursor-native-shell__token is-operator">&amp;&amp;<')
    expect(running).toContain('cursor-native-shell__token is-string">&quot;done&quot;<')
    // 输出预览默认可见（不必展开），且是 5 行预览态。
    expect(running).toContain('cursor-native-shell__output is-preview')
    expect(running).toContain('tick 2')
    expect(running).not.toContain('process-turn-step__details')

    const waiting = renderToStaticMarkup(<ProcessBlocks blocks={[{
      kind: 'tool', id: 'sh-wait', toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall',
      summary: 'sleep 30', hint: 'sleep', status: 'running'
    }]} />)
    expect(waiting).toContain('cursor-native-shell__waiting')
    expect(waiting).not.toContain('cursor-native-shell__output')

    const failed = renderToStaticMarkup(<ProcessBlocks blocks={[{
      kind: 'tool', id: 'sh-fail', toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall',
      summary: 'npm test', hint: 'npm · exit 1', status: 'failed', output: 'FAIL 1 test', error: 'Command exited with code 1'
    }]} />)
    expect(failed).toContain('cursor-native-shell is-command is-failed')
    expect(failed).toContain('npm · exit 1')
    expect(failed).toContain('cursor-native-shell__error')
  })

  it('colours edit stats green/red on the row and renders the structured diff by line when expanded', async () => {
    const block: ProcessBlock = {
      kind: 'tool', id: 'edit-1', toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall',
      summary: 'src/renderer/src/styles.css', hint: '+2 −1', status: 'done', output: 'The file has been updated.',
      diff: { lines: [
        { type: 'hunk', text: '@@ -10,3 +10,4 @@' },
        { type: 'context', text: '.a { }', oldLine: 10, newLine: 10 },
        { type: 'removed', text: '.b { color: red }', oldLine: 11 },
        { type: 'added', text: '.b { color: blue }', newLine: 11 },
        { type: 'added', text: '.c { }', newLine: 12 }
      ], truncatedLineCount: 7 }
    }
    const collapsed = renderToStaticMarkup(<ProcessBlocks blocks={[block]} />)
    expect(collapsed).toContain('<i data-kind="additions">+2</i>')
    expect(collapsed).toContain('<i data-kind="deletions">−1</i>')
    // Cursor 同款：完成态默认保留三行改动预览，点击头部再展开完整双行号 diff。
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).toContain('cursor-native-diff is-preview')
    expect(collapsed).toContain('aria-label="文件改动预览"')
    const collapsedText = collapsed.replace(/<[^>]+>/g, '')
    expect(collapsedText).toContain('.b { color: red }')
    expect(collapsedText).toContain('.b { color: blue }')
    expect(collapsedText).toContain('.c { }')
    expect(collapsed).not.toContain('另有 7 行未内联')
    expect(collapsed).not.toContain('The file has been updated.')

    await act(async () => {
      root.render(<ProcessBlocks blocks={[block]} />)
    })
    const head = container.querySelector<HTMLButtonElement>('.cursor-native-edit__head')!
    await act(async () => { head.click() })
    const rows = [...container.querySelectorAll('.cursor-native-diff__line')].map((row) => row.className.replace('cursor-native-diff__line ', ''))
    expect(rows).toEqual(['is-hunk', 'is-context', 'is-removed', 'is-added', 'is-added'])
    const added = container.querySelector('.cursor-native-diff__line.is-added')!
    expect(added.querySelectorAll('.cursor-native-diff__num')[1]?.textContent).toBe('11')
    expect(added.querySelector('.cursor-native-diff__text')?.textContent).toBe('.b { color: blue }')
    expect(container.querySelector('.cursor-native-diff__truncated')?.textContent).toBe('另有 7 行未内联')
    expect(container.querySelector<HTMLElement>('.cursor-native-diff')?.style.getPropertyValue('--diff-num-width')).toBe('3.2ch')
    expect(container.textContent).not.toContain('The file has been updated.')
  })

  it('widens both diff line-number columns for five-digit source locations', async () => {
    const block: ProcessBlock = {
      kind: 'tool', id: 'large-diff', toolName: 'edit_file', toolKind: 'edit', summary: '/large.ts', status: 'done',
      diff: { lines: [
        { type: 'hunk', text: '@@ -17280,1 +20124,1 @@' },
        { type: 'removed', text: 'before', oldLine: 17280 },
        { type: 'added', text: 'after', newLine: 20124 }
      ] }
    }
    await act(async () => { root.render(<ProcessBlocks blocks={[block]} />) })
    await act(async () => { container.querySelector<HTMLButtonElement>('.cursor-native-edit__head')!.click() })
    expect(container.querySelector<HTMLElement>('.cursor-native-diff')?.style.getPropertyValue('--diff-num-width')).toBe('6.2ch')
    expect([...container.querySelectorAll('.cursor-native-diff__num')].map((node) => node.textContent)).toContain('17280')
  })

  it('shows the Cursor-style code preview for legacy persisted edits whose unified diff lives in output', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[{
      kind: 'tool', id: 'legacy-edit', toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall',
      summary: '/workspace/src/legacy.ts', hint: '+1 −1', status: 'done',
      output: [
        '--- a//workspace/src/legacy.ts',
        '+++ b//workspace/src/legacy.ts',
        '@@ -8,3 +8,3 @@',
        ' const before = true',
        '-const value = 1',
        '+const value = 2',
        ' export { value }'
      ].join('\n')
    }]} />)
    expect(html).toContain('cursor-native-diff is-preview')
    expect(html).toContain('cursor-native-edit__language">TS')
    expect(html).toContain('<strong>legacy.ts</strong>')
    expect(html).toContain('class="is-keyword">const</span>')
    const text = html.replace(/<[^>]+>/g, '')
    expect(text).toContain('const before = true')
    expect(text).toContain('const value = 1')
    expect(text).toContain('const value = 2')
    expect(html).not.toContain('--- a//workspace')
  })

  it('renders an in-progress edit as a live tail-following code window, then keeps the final diff view', async () => {
    const liveBlock: ProcessBlock = {
      kind: 'tool', id: 'live-edit', toolName: 'edit_file', toolKind: 'edit', toolCase: 'editToolCall',
      summary: '/live.ts', hint: '+2 −0', status: 'running', diff: { lines: [
        { type: 'hunk', text: '@@ -40,2 +40,3 @@' },
        { type: 'context', text: 'before', oldLine: 40, newLine: 40 },
        { type: 'added', text: 'new', newLine: 41 },
        { type: 'added', text: 'tail', newLine: 42 },
        { type: 'context', text: '', oldLine: 41, newLine: 43 }
      ] }
    }
    await act(async () => { root.render(<ProcessBlocks blocks={[liveBlock]} />) })
    expect(container.querySelector('.cursor-native-diff.is-live')).not.toBeNull()
    expect(container.querySelector('.cursor-native-diff__line.is-streaming-tail .cursor-native-diff__text')?.textContent).toBe('tail')
    expect(container.querySelector('.cursor-native-diff')?.getAttribute('aria-label')).toBe('正在编辑文件')

    await act(async () => { container.querySelector<HTMLButtonElement>('.cursor-native-edit__toggle')!.click() })
    expect(container.querySelector('.cursor-native-diff.is-full')).not.toBeNull()

    await act(async () => { root.render(<ProcessBlocks blocks={[{ ...liveBlock, status: 'done' }]} />) })
    expect(container.querySelector('.cursor-native-diff.is-live')).toBeNull()
    expect(container.querySelector('.cursor-native-diff')?.getAttribute('aria-label')).toBe('文件改动')
  })

  it('follows live edits, respects manual reading, and settles to preview without remembering an automatic expansion', async () => {
    const block = (tail: string): ProcessBlock => ({
      kind: 'tool', id: 'live-edit-stable', toolName: 'edit_file', toolKind: 'edit', toolCase: 'editToolCall',
      summary: '/live.ts', hint: '+2 −0', status: 'running', diff: { lines: [
        { type: 'context', text: 'before', oldLine: 40, newLine: 40 },
        { type: 'added', text: 'new', newLine: 41 },
        { type: 'added', text: tail, newLine: 42 }
      ] }
    })
    await act(async () => { root.render(<ProcessTurnCard id="live-turn" blocks={[block('tail-1')]} compact live />) })
    const first = container.querySelector<HTMLElement>('.cursor-native-diff.is-live')!
    expect(first).not.toBeNull()
    Object.defineProperty(first, 'scrollHeight', { configurable: true, value: 480 })
    await act(async () => { root.render(<ProcessTurnCard id="live-turn" blocks={[block('tail-2')]} compact live />) })
    const second = container.querySelector<HTMLElement>('.cursor-native-diff.is-live')!
    expect(second).toBe(first)
    expect(second.scrollTop).toBe(480)
    expect(second.querySelector('.is-streaming-tail .cursor-native-diff__text')?.textContent).toBe('tail-2')
    const toggle = container.querySelector<HTMLButtonElement>('.cursor-native-edit__toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => toggle.click())
    second.scrollTop = 35
    await act(async () => { root.render(<ProcessTurnCard id="live-turn" blocks={[block('tail-3')]} compact live />) })
    expect(container.querySelector('.cursor-native-diff.is-full')).toBe(second)
    expect(second.scrollTop).toBe(35)
    await act(async () => toggle.click())
    expect(container.querySelector('.cursor-native-diff.is-live')).toBe(second)
    expect(second.scrollTop).toBe(480)
    await act(async () => { root.render(<ProcessTurnCard id="live-turn" blocks={[{ ...block('tail-3'), status: 'done' }]} compact />) })
    expect(container.querySelector('.cursor-native-diff.is-preview')).toBe(second)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // 相同历史数据首次挂载，也应是预览而非依赖看过直播的时机。
    await act(async () => { root.render(<ProcessTurnCard key="remount" id="live-turn" blocks={[{ ...block('tail-3'), status: 'done' }]} compact />) })
    expect(container.querySelector('.cursor-native-diff.is-preview')).not.toBeNull()
  })

  it('keeps failure details visible in the file card before and after expanding', async () => {
    const failed: ProcessBlock = {
      kind: 'tool', id: 'failed-edit', toolName: 'edit_file_v2', toolKind: 'edit', status: 'failed',
      summary: '/src/a.ts', error: 'DISK_FULL: write failed',
      diff: { lines: [{ type: 'added', text: 'const a = 1', newLine: 1 }] }
    }
    await act(async () => { root.render(<ProcessBlocks blocks={[failed]} />) })
    const head = container.querySelector<HTMLButtonElement>('.cursor-native-edit__head')!
    expect(head.getAttribute('aria-label')).toBe('编辑失败 a.ts')
    expect(container.querySelector('.cursor-native-edit__error')?.textContent).toBe(failed.error)
    await act(async () => head.click())
    expect(container.querySelector('.cursor-native-edit__error')?.textContent).toBe(failed.error)
  })

  it('preserves the captured legacy diff beyond 300 characters and 240 lines for full reading', async () => {
    const longLine = 'const value = "' + 'a'.repeat(340) + 'END_OF_LONG_LINE";'
    const lines = [longLine, ...Array.from({ length: 249 }, (_, i) => `const value${i} = ${i}`)]
    const legacy: ProcessBlock = {
      kind: 'tool', id: 'legacy-long', toolName: 'edit_file_v2', toolKind: 'edit', status: 'done', summary: '/a.ts',
      output: '@@ -0,0 +1,250 @@\n' + lines.map((line) => '+' + line).join('\n')
    }
    await act(async () => { root.render(<ProcessBlocks blocks={[legacy]} />) })
    expect(container.querySelectorAll('.cursor-native-diff__text')).toHaveLength(4)
    await act(async () => { container.querySelector<HTMLButtonElement>('.cursor-native-edit__toggle')!.click() })
    expect([...container.querySelectorAll('.cursor-native-diff__text')].map((node) => node.textContent)).toEqual(lines)
  })

  it('collapses a finished exploration group to its header and expands members only on demand', async () => {
    const blocks: ProcessBlock[] = [
      { kind: 'tool', id: 'r1', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: '/a.ts', hint: 'L1-20', status: 'done' },
      { kind: 'tool', id: 'r2', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: '/b.ts', status: 'done' },
      { kind: 'tool', id: 'r3', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: '/c.ts', status: 'done' },
      { kind: 'tool', id: 'sh', toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall', title: '跑测试', summary: 'npm test', status: 'done', output: 'ok' }
    ]
    const html = renderToStaticMarkup(<ProcessBlocks blocks={blocks} />)
    expect(html).toContain('data-group-id="group:block:r1"')
    expect(html).toContain('<strong>Explored</strong>')
    expect(html).toContain('3 files')
    // 已完成的组不带预览窗，成员行折叠不可见；shell 保持独立卡。
    expect(html).not.toContain('cursor-native-group__preview')
    expect(html).not.toContain('/a.ts')
    expect(html).toContain('<strong>跑测试</strong>')
    // 完成的命令收成一行 `$ 命令`（审查项 2）：输出不再常驻，点头部展开 200px 阅读区。
    expect(html).toContain('cursor-native-shell__command')
    expect(html).not.toContain('cursor-native-shell__output')
    await act(async () => { root.render(<ProcessBlocks blocks={blocks} />) })
    const shellHead = [...container.querySelectorAll<HTMLButtonElement>('.cursor-native-shell .cursor-native-tool__head')].at(-1)!
    await act(async () => { shellHead.click() })
    expect(container.querySelector('.cursor-native-shell__output.is-expanded')?.textContent).toBe('ok')
  })

  it('flips the thinking header to “Thought for Ns” once the block is done', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[
      { kind: 'thinking', id: 'th-done', text: '想清楚了。', status: 'done', durationMs: 38_429 }
    ]} />)
    expect(html).toContain('<strong>Thought</strong>')
    expect(html).toContain('<time>for 38s</time>')
    expect(html).not.toContain('Thinking')
    expect(html).not.toContain('cursor-native-thought__pulse')
  })

  it('does not expose disclosure aria on non-expandable disabled heads', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[{
      kind: 'tool',
      id: 'tool-plain',
      toolName: 'team_check_in',
      toolKind: 'mcp',
      summary: '已连接',
      status: 'done'
    }]} />)

    expect(html).toContain('cursor-native-tool__head" disabled=""')
    // 完成态由动词表达（Ran MCP），右侧不再重复「完成」；无明细也无折叠箭头 → meta 为空。
    expect(html).toMatch(/cursor-native-tool__meta[^>]*><\/span>/)
    expect(html).not.toContain('cursor-native-tool__state')
    expect(html).toContain('过程记录')
  })

  it('leaves the state word to the verb itself; only questionnaire states get the right-side label', () => {
    // 审查项 6：动词随状态取词（Reading / Read），右侧不再挂重复的「进行中 / 失败」；
    // 进行中由行标题流光表达，失败由红色动词（Cursor 错误态原形）与红框表达。
    const running = renderToStaticMarkup(<ProcessBlocks blocks={[
      { kind: 'tool', id: 'r', toolName: 'read_file_v2', toolKind: 'read', summary: '/a.ts', status: 'running' }
    ]} />)
    expect(running).toContain('<strong>Reading</strong>')
    expect(running).toContain('is-read is-running')
    expect(running).not.toContain('cursor-native-tool__state')
    const failed = renderToStaticMarkup(<ProcessBlocks blocks={[
      { kind: 'tool', id: 'f', toolName: 'read_file_v2', toolKind: 'read', summary: '/a.ts', status: 'failed', error: 'ENOENT' }
    ]} />)
    expect(failed).toContain('<strong>Read</strong>')
    expect(failed).toContain('is-read is-failed')
    expect(failed).not.toContain('cursor-native-tool__state')
    // 未知工具平时以工具名作标题，失败时回到动词（Cursor 错误态原形 Run），红色承担失败语义。
    const failedOther = renderToStaticMarkup(<ProcessBlocks blocks={[
      { kind: 'tool', id: 'o', toolName: 'custom_probe', toolKind: 'other', summary: 'probe', status: 'failed', error: 'boom' }
    ]} />)
    expect(failedOther).toContain('<strong>Run</strong>')
    expect(failedOther).not.toContain('<strong>custom_probe</strong>')
    expect(failedOther).toContain('is-other is-failed')
  })

  it('renders escaped newlines inside process text as real line breaks', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[
      {
        kind: 'thinking',
        id: 'think-escaped',
        text: '用户要求内化账号流程。\\n\\n当前依赖问题：\\n- 依赖外部浏览器\\n- 需要手动权限',
        status: 'running'
      },
      {
        kind: 'command',
        id: 'cmd-escaped',
        command: 'npm test',
        output: 'Test Files\\nTests passed',
        status: 'done'
      }
    ]} />)

    expect(html).toContain('当前依赖问题')
    expect(html).toContain('<li>依赖外部浏览器</li>')
    expect(html).not.toContain('\\n')
  })

  it('collapses earlier thoughts and keeps only the running thought expanded by default', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[
      { kind: 'thinking', id: 'thought-1', text: '较早的长思考', status: 'done' },
      { kind: 'thinking', id: 'thought-2', text: '当前最新思考', status: 'running' }
    ]} />)
    expect(html).not.toContain('较早的长思考')
    expect(html).toContain('当前最新思考')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-expanded="true"')
  })

  it('mounts sealed history fully folded and folds the previous auto-expanded thought when a new step begins', async () => {
    // 历史轻量（审查项 2）：封口卡挂载时思考一律折叠成一行，不再默认展开最后一段。
    const sealed = renderToStaticMarkup(<ProcessTurnCard id="turn-sealed" compact blocks={[
      { kind: 'thinking', id: 'th-a', text: '第一段完整思考', status: 'done', durationMs: 2_000 },
      { kind: 'thinking', id: 'th-b', text: '最后一段完整思考', status: 'done', durationMs: 1_000 }
    ]} />)
    expect(sealed).not.toContain('第一段完整思考')
    expect(sealed).not.toContain('最后一段完整思考')

    // 直播中：自动展开的上一段思考在新的一段开始时收起（Cursor 同款）；
    // 用户手动展开过的段落不受自动收起影响。
    const first: ProcessBlock = { kind: 'thinking', id: 'th-1', text: '第一段直播思考', status: 'running' }
    await act(async () => { root.render(<ProcessTurnCard id="turn-live" compact live blocks={[first]} />) })
    // 挂载时已在生成 → 落位直出全文。
    expect(container.textContent).toContain('第一段直播思考')
    const second: ProcessBlock = { kind: 'thinking', id: 'th-2', text: '第二段直播思考', status: 'running' }
    await act(async () => {
      root.render(<ProcessTurnCard id="turn-live" compact live blocks={[{ ...first, status: 'done', durationMs: 900 }, second]} />)
    })
    // 上一段收起（正文不再可见）；新一段展开（is-open，正文由打字机逐帧播出——
    // 打字节奏由 streaming-hydration / use-streaming-text 用例锁定，这里断言结构）。
    expect(container.textContent).not.toContain('第一段直播思考')
    const thoughts = [...container.querySelectorAll('.cursor-native-thought')]
    expect(thoughts[0]!.className).not.toContain('is-open')
    expect(thoughts[1]!.className).toContain('is-open')
    // 用户点开第一段（接管）：下一帧不再被自动收起。
    const heads = [...container.querySelectorAll<HTMLButtonElement>('.cursor-native-thought__head')]
    await act(async () => { heads[0]!.click() })
    await act(async () => {
      root.render(<ProcessTurnCard id="turn-live" compact live blocks={[{ ...first, status: 'done', durationMs: 900 }, { ...second, text: '第二段直播思考继续增长' }]} />)
    })
    expect(container.textContent).toContain('第一段直播思考')
  })

  it('keeps the process DOM through live → sealed, folds by default, and reopens for the right-pane locator', async () => {
    const block: ProcessBlock = { kind: 'tool', id: 'read-1', toolName: 'read_file', toolKind: 'read', summary: 'src/App.tsx', status: 'done', startedAt: 1_000 }
    await act(async () => root.render(<ProcessTurnCard id="turn" compact live turnState="working" blocks={[block]} startedAt={1_000} updatedAt={5_000} />))
    const flow = container.querySelector<HTMLElement>('.cursor-native-process__flow')!
    expect(flow.hidden).toBe(false)
    expect(container.textContent).toContain('Working for 4s')

    await act(async () => root.render(<ProcessTurnCard id="turn" compact turnState="worked" blocks={[block]} startedAt={1_000} updatedAt={10_000} />))
    expect(container.querySelector('.cursor-native-process__flow')).toBe(flow)
    expect(flow.hidden).toBe(true)
    expect(container.querySelector('.cursor-native-process__summary')?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('Worked for 9s')
    await act(async () => { container.querySelector<HTMLButtonElement>('.cursor-native-process__summary')!.click() })
    expect(flow.hidden).toBe(false)
    await act(async () => { container.querySelector<HTMLButtonElement>('.cursor-native-process__summary')!.click() })
    expect(flow.hidden).toBe(true)
    await act(async () => { await requestReveal({ blockId: 'read-1' }) })
    expect(flow.hidden).toBe(false)
  })

  it('keeps a pending question visible even if the reply is already sealed', () => {
    const html = renderToStaticMarkup(<ProcessTurnCard id="question" compact turnState="worked" updatedAt={10_000} blocks={[{
      kind: 'tool', id: 'q1', toolName: 'ask_question', toolKind: 'question', status: 'running', startedAt: 1_000,
      question: { toolCallId: 'tc', status: 'pending', questions: [] }
    }]} />)
    expect(html).toContain('class="cursor-native-process__flow"')
    expect(html).not.toContain('cursor-native-process__flow" hidden')
    expect(html).toContain('Awaiting answer')
  })

  it('returns null for an empty block list', () => {
    expect(renderToStaticMarkup(<ProcessBlocks blocks={[]} />)).toBe('')
  })

  it('labels CDP-observed durations as approximate in the summary but never on tool rows', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[{
      kind: 'tool', id: 'cursor:read', toolName: 'read_file', toolKind: 'read',
      summary: 'package.json', status: 'done', startedAt: 1_000, completedAt: 1_120,
      timingEstimated: true
    }]} />)
    expect(html).toContain('观测 ~0.1 秒')
    // Cursor 不显示单个工具耗时；采样估算的 ~0.1 秒只是噪音，工具行上不再出现。
    expect(html).not.toContain('<time>~0.1 秒</time>')
    expect(html).not.toContain('累计 0.1 秒')
  })

  it('keeps the Thought header duration (native or estimated) while tool rows stay duration-free', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[
      { kind: 'thinking', id: 'th', text: '想一想', status: 'done', startedAt: 1_000, completedAt: 13_400, timingEstimated: true },
      { kind: 'tool', id: 'r', toolName: 'read_file_v2', toolKind: 'read', summary: '/a.ts', status: 'done', startedAt: 13_400, completedAt: 13_500, timingEstimated: true }
    ]} />)
    expect(html).toContain('<time>for ~12s</time>')
    expect(html).not.toContain('<time>~0.1 秒</time>')
  })

  it('renders Cursor-native thinking duration and expandable browser/todo actions', () => {
    const html = renderToStaticMarkup(<ProcessBlocks blocks={[
      { kind: 'thinking', id: 'thought', text: '分析页面', status: 'done', durationMs: 3_000 },
      { kind: 'tool', id: 'browser', toolName: 'browser_navigate', toolKind: 'browser', summary: 'http://localhost', output: '页面已加载', status: 'done' },
      { kind: 'tool', id: 'todo', toolName: 'todos', toolKind: 'todo', summary: '待办清单 0/1', todos: [{ content: '视觉验收', status: 'in_progress' }], status: 'running' }
    ]} />)
    // 单个抓取类调用按 Cursor 规则也成组（非轻探索阈值 1），组头「Explored 1 fetch」，成员折叠。
    expect(html).toContain('<strong>Explored</strong>')
    expect(html).toContain('1 fetch')
    expect(html).not.toContain('1 step')
    expect(html).not.toContain('<strong>Browsed</strong>')
    expect(html).toContain('<time>for 3s</time>')
    expect(html).toContain('待办清单 0/1')
    expect(html).toContain('aria-expanded="false"')
  })

  it('renders todos as a progress bar with circular status indicators', async () => {
    await act(async () => {
      root.render(<ProcessBlocks blocks={[
        {
          kind: 'tool', id: 'todo', toolName: 'todos', toolKind: 'todo', summary: '待办清单 2/4', status: 'done',
          todos: [
            { content: '已完成项 A', status: 'completed' },
            { content: '已完成项 B', status: 'completed' },
            { content: '进行中项', status: 'in_progress' },
            { content: '待办项', status: 'pending' }
          ]
        }
      ]} />)
    })
    // 折叠态只露出头部 summary；点击展开后出现进度条与 Cursor 原生三态指示器
    const head = container.querySelector<HTMLButtonElement>('.cursor-native-tool__head')!
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('待办清单 2/4')
    await act(async () => { head.click() })
    const html = container.innerHTML
    expect(html).toContain('todo-progress')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="2"')
    expect(html).toContain('aria-valuemax="4"')
    // 指示器：完成=描边勾，进行=缺口细环，待办=点线环
    expect(html).toContain('todo-indicator')
    expect(html).toMatch(/is-completed[^>]*>\s*<span class="todo-indicator"[^>]*>\s*<svg/)
    expect(container.querySelector('.is-in_progress .todo-live circle[stroke-dasharray="25 9"]')).toBeTruthy()
    expect(container.querySelector('.is-pending .todo-pending circle[stroke-dasharray="0.1 4.06"]')).toBeTruthy()
    expect(html).not.toContain('todo-spinner')
    expect(html).toContain('is-pending')
  })

  it('normalizes unknown todo statuses into the cancelled bucket instead of injecting raw class names', async () => {
    await act(async () => {
      root.render(<ProcessBlocks blocks={[
        {
          kind: 'tool', id: 'todo', toolName: 'todos', toolKind: 'todo', summary: '待办清单 0/2', status: 'done',
          todos: [
            { content: '已取消项', status: 'cancelled' },
            { content: '未知状态项', status: 'weird status with spaces' }
          ]
        }
      ]} />)
    })
    const head = container.querySelector<HTMLButtonElement>('.cursor-native-tool__head')!
    await act(async () => { head.click() })
    const html = container.innerHTML
    expect(html).toContain('is-cancelled')
    // 未知状态不透传进 class，杜绝「is-weird status with spaces」式注入
    expect(html).not.toContain('is-weird')
    expect(html).not.toContain('with spaces')
    expect(container.textContent).toContain('未知状态项')
  })
})
