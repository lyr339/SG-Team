import { describe, expect, it } from 'vitest'
import {
  CURSOR_STATUS_LINE_TEXT,
  cursorStatusLineFromBlocks,
  cursorStatusLineOf,
  parseCursorStatusLine,
  type CursorComposerDataLike
} from '../src/domain/cursor-status-line'

/** 3.6.31 现代气泡形态（只读 CDP 探针 2026-09-12 实测）。 */
const ai = (bubbleId: string) => ({ type: 2, bubbleId })
const user = (bubbleId: string) => ({ type: 1, bubbleId })
const mcp = (toolName: string, status: 'loading' | 'completed' = 'completed') => ({
  toolFormerData: { status, toolCall: { tool: { case: 'mcpToolCall', value: { args: { providerIdentifier: 'SG Team', toolName } } } } }
})
const tool = (toolCase: string, args: Record<string, unknown>, status: 'loading' | 'completed' = 'loading') => ({
  toolFormerData: { status, toolCall: { tool: { case: toolCase, value: { args } } } }
})
const composer = (
  bubbles: Array<[header: { type: number; bubbleId: string }, bubble: Record<string, unknown>]>,
  patch: Partial<CursorComposerDataLike> = {}
): CursorComposerDataLike => ({
  status: 'generating',
  fullConversationHeadersOnly: bubbles.map(([header]) => header),
  conversationMap: Object.fromEntries(bubbles.map(([header, bubble]) => [header.bubbleId, bubble])),
  ...patch
})

describe('cursorStatusLineOf：Cursor 3.6.31 会话列表副标题算法复刻（Tu_ 生成分支）', () => {
  it('待命席位（探针实证 CH-2 尾部）：record_reply / check_messages 是无详情 MCP → 全部跳过，扫到正文 → 首行 50 字片段', () => {
    const line = cursorStatusLineOf(composer([
      [user('u1'), {}],
      [ai('shell'), tool('shellToolCall', { command: 'node probe.mjs' }, 'completed')],
      [ai('text'), { text: 'I dug into the Cursor 3.6.31 bundle and probed the four seats read-only.\n\nDetails follow.' }],
      [ai('rr'), mcp('record_reply')],
      [ai('cm1'), mcp('check_messages')],
      [ai('cm2'), mcp('check_messages')],
      [ai('cm3'), mcp('check_messages', 'loading')]
    ]))
    expect(line).toEqual({ kind: 'text', label: 'I dug into the Cursor 3.6.31 bundle and probed the…' })
  })

  it('待命席位轮询前有一段 keepalive 思考 → Thinking（有 thinking 字段即算，不看内容与状态）', () => {
    expect(cursorStatusLineOf(composer([
      [user('u1'), {}],
      [ai('text'), { text: '已完成。' }],
      [ai('th'), { thinking: { text: '' } }],
      [ai('cm'), mcp('check_messages', 'loading')]
    ]))).toEqual({ kind: 'thinking', label: 'Thinking' })
    expect(cursorStatusLineOf(composer([[user('u1'), {}], [ai('th'), { thinking: 'legacy string' }]])))
      .toEqual({ kind: 'thinking', label: 'Thinking' })
  })

  it('有详情的工具 → 动词（loading 形态）+ 对象；探针实证：CH-1 Reading settings-cleanup-light.png、CH-4 运行中的 shell 被跳过落到 Editing probe.mjs', () => {
    expect(cursorStatusLineOf(composer([
      [user('u1'), {}],
      [ai('await'), tool('awaitToolCall', { taskId: 't' }, 'completed')],
      [ai('shell'), tool('shellToolCall', { command: 'ls' }, 'completed')],
      [ai('read'), tool('readToolCall', { path: '/Users/lyr/preview-screenshots/settings-cleanup-light.png' })]
    ]))).toEqual({ kind: 'tool', label: 'Reading settings-cleanup-light.png', detail: 'settings-cleanup-light.png', toolKind: 'read' })
    expect(cursorStatusLineOf(composer([
      [user('u1'), {}],
      [ai('edit'), tool('editToolCall', { path: '/tmp/sg-probe/probe.mjs' }, 'completed')],
      [ai('shell'), tool('shellToolCall', { command: 'node probe.mjs' }, 'loading')]
    ]))).toEqual({ kind: 'tool', label: 'Editing probe.mjs', detail: 'probe.mjs', toolKind: 'edit' })
  })

  it('详情规则（i31）：读取行号范围、目录 current directory / dir/、grep 的 in dir (glob) [type]、lints 的 in dir、web 搜索词、glob 模式', () => {
    const only = (toolCase: string, args: Record<string, unknown>) => cursorStatusLineOf(composer([[user('u'), {}], [ai('t'), tool(toolCase, args)]]))?.label
    expect(only('readToolCall', { path: 'src/a.ts', offset: 10, limit: 30 })).toBe('Reading a.ts L10-40')
    expect(only('readToolCall', { path: 'src/a.ts', offset: '5', limit: '20' })).toBe('Reading a.ts L5-25')
    expect(only('readToolCall', { relativeWorkspacePath: 'src/a.ts', startLineOneIndexed: 1, endLineOneIndexedInclusive: 9 })).toBe('Reading a.ts L1-9')
    expect(only('readToolCall', { targetFile: 'src/a.ts', readEntireFile: true, offset: 1, limit: 2 })).toBe('Reading a.ts')
    expect(only('lsToolCall', {})).toBe('Listing current directory')
    expect(only('lsToolCall', { path: '.' })).toBe('Listing current directory')
    // 目录走 Cursor `Su_` → basename：尾斜杠不保留（grep / lints 的 "dir/" 是另外两处手写规则）。
    expect(only('lsToolCall', { path: 'src/renderer/' })).toBe('Listing renderer')
    expect(only('lsToolCall', { targetDirectory: 'src/renderer' })).toBe('Listing renderer')
    expect(only('editToolCall', { path: 'src/renderer/src/styles.css' })).toBe('Editing styles.css')
    expect(only('deleteToolCall', { path: 'tmp/old.txt' })).toBe('Deleting old.txt')
    expect(only('grepToolCall', { pattern: 'sessionRailActivity' })).toBe('Grepping sessionRailActivity')
    expect(only('grepToolCall', { pattern: 'foo', path: 'src/renderer/', glob: '*.ts', type: 'ts' })).toBe('Grepping foo in renderer/ (*.ts) [type:ts]')
    expect(only('grepToolCall', { pattern: 'foo', path: '/Users/lyr/repo/src' })).toBe('Grepping foo in src')
    expect(only('globToolCall', { globPattern: '**/*.test.ts' })).toBe('Searching files **/*.test.ts')
    expect(only('semSearchToolCall', { query: 'where is the rail activity computed' })).toBe('Searching where is the rail activity computed')
    expect(only('webSearchToolCall', { searchTerm: 'cursor 3.6.31 status line' })).toBe('Searching web cursor 3.6.31 status line')
    expect(only('readLintsToolCall', { paths: ['src/renderer/src/App.tsx'] })).toBe('Reading lints in App.tsx')
    expect(only('readLintsToolCall', { path: 'src/renderer/' })).toBe('Reading lints in renderer/')
    expect(only('globToolCall', { query: 'legacy file search' })).toBe('Searching files legacy file search')
  })

  it('Cursor 项目目录的路径规则（Ivs / MJt / Ney / eKC / aVw）：终端文件、工具输出、Agent 转录、技能文件与 terminals 目录', () => {
    const only = (toolCase: string, args: Record<string, unknown>) => cursorStatusLineOf(composer([[user('u'), {}], [ai('t'), tool(toolCase, args)]]))
    const projects = '/Users/lyr/.cursor/projects/Users-lyr-Downloads'
    expect(only('readToolCall', { path: `${projects}/terminals/412327.txt` }))
      .toEqual({ kind: 'tool', label: 'Reading terminal 412327', detail: '412327', toolKind: 'read' })
    // 行号范围对终端 / 工具输出文件不生效（Cursor 在 basename 之前就返回了）。
    expect(only('readToolCall', { path: `${projects}/agent-tools/3453eef8-b40b-48d6-8044-ef95783a2f64.txt`, offset: 1, limit: 40 }))
      .toEqual({ kind: 'tool', label: 'Reading tool output', detail: 'tool output', toolKind: 'read' })
    expect(only('readToolCall', { path: `${projects}/agent-transcripts/e398c645/e398c645.jsonl` })?.label)
      .toBe('Reading agent transcript e398c645.jsonl')
    expect(only('readToolCall', { path: '/Users/lyr/.claude/skills/pdf/SKILL.md' })?.label).toBe('Using pdf SKILL.md')
    expect(only('readToolCall', { path: '/Users/lyr/.cursor/cloud-skills/deploy.md' })?.label).toBe('Using deploy deploy.md')
    // 不在 .cursor/projects 树下、或不是 <id>.txt：按普通文件。
    expect(only('readToolCall', { path: '/Users/lyr/repo/terminals/412327.txt' })?.label).toBe('Reading 412327.txt')
    expect(only('readToolCall', { path: `${projects}/terminals/notes.txt` })?.label).toBe('Reading notes.txt')
    expect(only('readToolCall', { path: '/Users/lyr/repo/docs/SKILL.md' })?.label).toBe('Reading SKILL.md')
    // 目录本身：Cursor 原文 "Listing terminals terminals" 只保留动词（有意去掉重复的对象）。
    expect(only('lsToolCall', { path: `${projects}/terminals` })).toEqual({ kind: 'tool', label: 'Listing terminals', toolKind: 'read' })
    expect(only('lsToolCall', { path: `${projects}/agent-transcripts/` })?.label).toBe('Listing agent transcripts')
    expect(only('lsToolCall', { path: `${projects}/terminals/sub` })?.label).toBe('Listing sub')
  })

  it('无详情的工具全部跳过（shell / MCP / task / await / askQuestion / fetch / getMcpTools / partial）；一个都扫不到 → undefined（渲染层落 Planning next moves）', () => {
    const line = cursorStatusLineOf(composer([
      [user('u1'), {}],
      [ai('a'), tool('shellToolCall', { command: 'npm test' })],
      [ai('b'), tool('taskToolCall', { description: 'x' })],
      [ai('c'), tool('awaitToolCall', { taskId: '1' })],
      [ai('d'), tool('askQuestionToolCall', { title: 'q' })],
      [ai('e'), tool('webFetchToolCall', { url: 'https://x' })],
      [ai('f'), tool('getMcpToolsToolCall', { server: 'SG Team' })],
      [ai('g'), tool('partialToolCall', {})],
      [ai('h'), mcp('team_task', 'loading')]
    ]))
    expect(line).toBeUndefined()
  })

  it('todo 工具：有 todos → "n/m To-Dos Completed"；没有 → 按 i31 的 "to-do list" 详情', () => {
    const todos = [{ status: 'completed' }, { status: 'completed' }, { status: 'pending' }, { status: 'in_progress' }]
    expect(cursorStatusLineOf(composer([[user('u'), {}], [ai('t'), tool('updateTodosToolCall', {})]], { todos })))
      .toEqual({ kind: 'todos', label: '2/4 To-Dos Completed', toolKind: 'todo' })
    expect(cursorStatusLineOf(composer([[user('u'), {}], [ai('t'), tool('readTodosToolCall', {})]]))?.label).toBe('Reading todos to-do list')
  })

  it('正文片段（o31 → l31 → a31）：只取首行，剥 fence / 反引号 / 图片与链接 / 标题 / 引用 / 列表 / 强调 / 表格竖线，折叠空白，50 字加省略号', () => {
    const snippet = (text: string) => cursorStatusLineOf(composer([[user('u'), {}], [ai('t'), { text }]]))?.label
    expect(snippet('## **结论**：先修 `hook`，再看[渲染层](x) ![图](y)\n\n第二段')).toBe('结论：先修 hook，再看渲染层 图')
    expect(snippet('> - 1. quoted   list    item')).toBe('1. quoted list item')
    expect(snippet('| a | b |')).toBe('a b')
    expect(snippet('<think>hidden</think>visible')).toBe('hiddenvisible')
    expect(snippet(`${'x'.repeat(60)}\nnext`)).toBe(`${'x'.repeat(50)}\u2026`)
    // Cursor 先 trim 整段再取首行：前导空行不算一行。
    expect(snippet('   \n\nonly-second-line')).toBe('only-second-line')
    expect(snippet('   \n\n  ')).toBeUndefined()
    // 用户气泡（type 1）的正文不算：往前扫直到 AI 正文。
    expect(cursorStatusLineOf(composer([[ai('a'), { text: 'AI 正文' }], [user('u'), { text: '用户输入' }]]))?.label).toBe('AI 正文')
  })

  it('旧形态（toolFormerData.name）同样识别；扫描上界防御性截止；空数据返回 undefined', () => {
    expect(cursorStatusLineOf(composer([[user('u'), {}], [ai('t'), { toolFormerData: { name: 'read_file_v2', params: { path: 'src/a.ts' } } }]])))
      .toEqual({ kind: 'tool', label: 'Reading a.ts', detail: 'a.ts', toolKind: 'read' })
    expect(cursorStatusLineOf(composer([[user('u'), {}], [ai('t'), { toolFormerData: { name: 'run_terminal_command_v2', rawArgs: '{"command":"ls"}' } }]])))
      .toBeUndefined()
    const many = composer([[ai('text'), { text: '很久以前的正文' }], ...Array.from({ length: 5 }, (_, index) => [ai(`cm${index}`), mcp('check_messages')] as [{ type: number; bubbleId: string }, Record<string, unknown>])])
    expect(cursorStatusLineOf(many)?.label).toBe('很久以前的正文')
    expect(cursorStatusLineOf(many, 3)).toBeUndefined()
    expect(cursorStatusLineOf(undefined)).toBeUndefined()
    expect(cursorStatusLineOf({})).toBeUndefined()
  })

  it('自包含：源码可原样注入页面执行（与 nativeUsagePayload 同款 .toString() 注入）', () => {
    const injected = new Function(`return (${cursorStatusLineOf.toString()})`)() as typeof cursorStatusLineOf
    expect(injected(composer([[user('u'), {}], [ai('th'), { thinking: { text: 'x' } }], [ai('cm'), mcp('check_messages', 'loading')]])))
      .toEqual({ kind: 'thinking', label: 'Thinking' })
  })
})

describe('cursorStatusLineFromBlocks：过程块回退与 parseCursorStatusLine', () => {
  it('流式正文优先；否则从最新块往前扫；shell / MCP 块跳过；旧块按 toolKind 回填参数位', () => {
    expect(cursorStatusLineFromBlocks([], { text: '# 标题行\n正文', streaming: true })).toEqual({ kind: 'text', label: '标题行' })
    expect(cursorStatusLineFromBlocks([
      { kind: 'thinking', id: 'th', text: '想', status: 'done' },
      { kind: 'tool', id: 'sh', toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall', summary: 'npm test', status: 'running' }
    ])).toEqual({ kind: 'thinking', label: 'Thinking' })
    expect(cursorStatusLineFromBlocks([
      { kind: 'tool', id: 'g', toolName: 'grep_search', toolKind: 'search', summary: 'needle', status: 'done' }
    ])).toEqual({ kind: 'tool', label: 'Grepping needle', detail: 'needle', toolKind: 'search' })
    expect(cursorStatusLineFromBlocks([
      { kind: 'tool', id: 'todo', toolName: 'todos', toolKind: 'todo', toolCase: 'updateTodosToolCall', status: 'running',
        todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }
    ])).toEqual({ kind: 'todos', label: '1/2 To-Dos Completed', toolKind: 'todo' })
    expect(cursorStatusLineFromBlocks([{ kind: 'command', id: 'c', command: 'ls', output: '', status: 'done' }])).toBeUndefined()
    expect(cursorStatusLineFromBlocks([], { text: '已完成的正文', streaming: false })).toEqual({ kind: 'text', label: '已完成的正文' })
  })

  it('parseCursorStatusLine 宽容解析：形状不对即缺省，字段裁剪', () => {
    expect(parseCursorStatusLine(undefined)).toBeUndefined()
    expect(parseCursorStatusLine({ kind: 'weird', label: 'x' })).toBeUndefined()
    expect(parseCursorStatusLine({ kind: 'thinking', label: '' })).toBeUndefined()
    expect(parseCursorStatusLine({ kind: 'tool', label: ' Reading a.ts ', detail: 'a.ts', toolKind: 'read' }))
      .toEqual({ kind: 'tool', label: 'Reading a.ts', detail: 'a.ts', toolKind: 'read' })
    expect(parseCursorStatusLine({ kind: 'text', label: 'x'.repeat(300) })?.label).toHaveLength(200)
    expect(CURSOR_STATUS_LINE_TEXT.thinking).toBe('Thinking')
  })
})
