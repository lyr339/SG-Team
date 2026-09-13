import type { ProcessBlock, ProcessToolKind } from './conversation-entry'

/**
 * Cursor 3.6.31 会话列表副标题（status line）算法复刻。
 *
 * 出处（workbench.desktop.main.js，只读反查 2026-09-12）：`Tu_`（当前动作标签）+ `V7d`/`Ppw`
 * （`subagentTaskStatusLine.js` 收口）。生成中从最新气泡往前扫，命中一条即止：
 *
 * ```text
 * bubble.thinking !== undefined                     → "Thinking"（有字段即算，不看内容）
 * 工具气泡：todo 且有 todos                          → "3/7 To-Dos Completed"
 *          s31(tool, {includeVerbWithoutDetails:false}) → "Reading foo.ts" 这类「动词 + 对象」
 *            详情 i31：读取 basename（+ 行号范围）、目录 basename / current directory、grep 的
 *            pattern in dir (glob) [type]、lints 的 in dir、搜索词、glob 模式、to-do list
 *            动词 oit / eKC：按路径覆盖——~/.cursor/projects/<ws>/terminals/<id>.txt → "Reading terminal <id>"、
 *            agent-tools/<x>.txt → "Reading tool output"、agent-transcripts → "Reading agent transcript …"、
 *            技能根目录下的 SKILL.md → "Using <skill> SKILL.md"、terminals 目录本身 → "Listing terminals"
 *          无详情（shell / MCP / task / await / askQuestion / fetch …） → 跳过，继续往前
 * AI 正文气泡                                       → 首行 → 剥 Markdown → 50 字 + …
 * 一个都没有                                        → "Planning next moves"
 * 非生成                                            → "Completed" / "Stopped"（aborted）
 * ```
 *
 * 待命席位显示 Thinking 的真正原因就在「无详情工具被跳过」：最新气泡是 check_messages（MCP），
 * 被跳过后扫到模型轮询前那段 keepalive 思考。本文件是唯一实现：hook 通过 `.toString()` 把
 * `cursorStatusLineOf` 原样注入 Cursor 页面执行（与 `nativeUsagePayload` 同款做法），
 * 渲染层回退与测试直接调用，三处不会各写一套规则。函数必须保持自包含：无闭包、无导入。
 */
export type CursorStatusLineKind = 'thinking' | 'tool' | 'text' | 'todos'

export interface CursorStatusLine {
  kind: CursorStatusLineKind
  /** Cursor 原文措辞，完整一句（"Reading foo.ts" / "Thinking" / 正文片段 / "3/7 To-Dos Completed"）。 */
  label: string
  /** 工具对象（路径 / 模式 / 词）；label 已含它，单列一份供渲染层单独截断。 */
  detail?: string
  /** 工具色相类（渲染层复用过程流的 --tool-hue 调色板）。 */
  toolKind?: ProcessToolKind
}

/** Cursor 原文固定措辞（`subagentTaskStatusLine.js` 与 `Tu_` 里的字面量）。 */
export const CURSOR_STATUS_LINE_TEXT = {
  thinking: 'Thinking',
  planning: 'Planning next moves',
  starting: 'Starting up',
  completed: 'Completed',
  stopped: 'Stopped',
  stoppedWithError: 'Stopped with error',
  awaitingApproval: 'Awaiting approval'
} as const

/** Cursor 3.6.31 ComposerData 的最小只读形态（页面内与测试夹具共用）。 */
export interface CursorComposerDataLike {
  status?: string
  fullConversationHeadersOnly?: Array<{ type?: number; bubbleId?: string } | undefined>
  conversationMap?: Record<string, CursorBubbleLike | undefined>
  todos?: Array<{ status?: string } | undefined>
}

export interface CursorBubbleLike {
  thinking?: unknown
  text?: unknown
  toolFormerData?: {
    toolCall?: { tool?: { case?: unknown; value?: { args?: unknown } } }
    tool?: unknown
    name?: unknown
    params?: unknown
    rawArgs?: unknown
  }
}

/**
 * 生成中的副标题（`Tu_` 的 isGenerating 分支）。在 Cursor 页面内执行，故自包含。
 * `maxSteps` 只是防御性上界（Cursor 本身无界）：持续会话里连续几十次不带思考的轮询也远够。
 */
export function cursorStatusLineOf(
  data: CursorComposerDataLike | undefined,
  maxSteps = 400
): CursorStatusLine | undefined {
  if (!data) return undefined
  const TOOLS: Record<string, { verb: string; kind: ProcessToolKind }> = {
    read: { verb: 'Reading', kind: 'read' },
    ls: { verb: 'Listing', kind: 'read' },
    edit: { verb: 'Editing', kind: 'edit' },
    delete: { verb: 'Deleting', kind: 'edit' },
    reapply: { verb: 'Reapplying edit to', kind: 'edit' },
    grep: { verb: 'Grepping', kind: 'search' },
    glob: { verb: 'Searching files', kind: 'search' },
    semsearch: { verb: 'Searching', kind: 'search' },
    searchsymbols: { verb: 'Searching symbols', kind: 'search' },
    deepsearch: { verb: 'Deep searching for', kind: 'search' },
    definition: { verb: 'Finding definition', kind: 'search' },
    websearch: { verb: 'Searching web', kind: 'browser' },
    readlints: { verb: 'Reading lints', kind: 'read' },
    todoread: { verb: 'Reading todos', kind: 'todo' },
    todowrite: { verb: 'Updating todos', kind: 'todo' }
  }
  const CASE_KEYS: Record<string, string> = {
    readtoolcall: 'read', lstoolcall: 'ls', edittoolcall: 'edit', deletetoolcall: 'delete',
    greptoolcall: 'grep', globtoolcall: 'glob', semsearchtoolcall: 'semsearch',
    websearchtoolcall: 'websearch', readlintstoolcall: 'readlints',
    updatetodostoolcall: 'todowrite', readtodostoolcall: 'todoread'
  }
  const NAME_KEYS: Record<string, string> = {
    read_file: 'read', read_file_v2: 'read', list_dir: 'ls', list_dir_v2: 'ls',
    edit_file: 'edit', edit_file_v2: 'edit', delete_file: 'delete', reapply: 'reapply',
    ripgrep_search: 'grep', ripgrep_raw_search: 'grep', grep_search: 'grep', grep: 'grep',
    file_search: 'glob', glob_file_search: 'glob',
    codebase_search: 'semsearch', semantic_search_full: 'semsearch', read_semsearch_files: 'semsearch',
    search_symbols: 'searchsymbols', deep_search: 'deepsearch', go_to_definition: 'definition',
    web_search: 'websearch', read_lints: 'readlints', todo_read: 'todoread', todo_write: 'todowrite'
  }
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  const num = (value: unknown): number | undefined => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
    return Number.isFinite(parsed) ? parsed : undefined
  }
  // Cursor `Bd` = basename（尾斜杠不算）。
  const lastSegment = (path: string): string => {
    const text = path.replace(/[\\/]+$/, '')
    const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
    return index >= 0 ? text.slice(index + 1) : text
  }
  // grep / lints 的路径对象（Cursor 在这两处手写了尾斜杠保留："dir/"）。
  const dirLabel = (path: string): string => (path.endsWith('/') ? `${lastSegment(path)}/` : lastSegment(path))
  // Cursor `Ivs`：~/.cursor/projects/<workspaceId>/<kind>/… 之后的剩余路径段；不在该目录树下返回 undefined。
  const projectRest = (path: string, kind: string): string[] | undefined => {
    const parts = path.split(/[\\/]/).filter(Boolean)
    for (let index = 0; index < parts.length - 2; index += 1) {
      if (parts[index] === '.cursor' && parts[index + 1] === 'projects' && parts[index + 3] === kind) return parts.slice(index + 4)
    }
    return undefined
  }
  // Cursor `MJt`：terminals/<id>.txt → 终端 id；`Ney`：agent-tools/<x>.txt → 工具输出文件。
  const terminalId = (path: string): string | undefined => {
    const rest = projectRest(path, 'terminals')
    const match = rest && rest.length === 1 ? /^(\d+)\.txt$/.exec(rest[0]!) : null
    return match ? match[1] : undefined
  }
  const isToolOutput = (path: string): boolean => {
    const rest = projectRest(path, 'agent-tools')
    return rest !== undefined && rest.length === 1 && rest[0]!.endsWith('.txt')
  }
  // Cursor `aVw` / `Xem`：技能根目录下的 SKILL.md（或 cloud-skills 里的 .md）→ 技能名。
  const skillName = (path: string): string | undefined => {
    const text = path.replace(/\\/g, '/')
    if (text.endsWith('/SKILL.md')) {
      const roots = ['.cursor/skills/', '.cursor/skills-cursor/', '.cursor/cloud-skills/', '.cursor/plugins/', '.claude/skills/', '.claude/plugins/', '.codex/skills/', '.agents/skills/']
      return roots.some((root) => text.includes(root)) ? lastSegment(text.slice(0, text.lastIndexOf('/'))) || undefined : undefined
    }
    if (text.endsWith('.md') && text.includes('.cursor/cloud-skills/')) return lastSegment(text).slice(0, -3) || undefined
    return undefined
  }
  const readPath = (args: Record<string, unknown>): string => str(args.path) || str(args.targetFile) || str(args.relativeWorkspacePath)
  const lsPath = (args: Record<string, unknown>): string => str(args.path) || str(args.targetDirectory) || str(args.directoryPath)
  // Cursor `eKC`：按路径覆盖动词——终端文件 / Agent 转录 / 技能文件；目录本身是 terminals 或 agent-transcripts。
  const verbOverride = (key: string, args: Record<string, unknown>): string | undefined => {
    if (key === 'read') {
      const path = readPath(args)
      if (!path) return undefined
      if (terminalId(path) !== undefined) return 'Reading terminal'
      if (projectRest(path, 'agent-transcripts')) return 'Reading agent transcript'
      const skill = skillName(path)
      return skill ? `Using ${skill}` : undefined
    }
    if (key === 'ls') {
      const dir = lsPath(args)
      if (projectRest(dir, 'terminals')?.length === 0) return 'Listing terminals'
      if (projectRest(dir, 'agent-transcripts')?.length === 0) return 'Listing agent transcripts'
    }
    return undefined
  }
  const toolKey = (td: NonNullable<CursorBubbleLike['toolFormerData']>): string | undefined => {
    const toolCase = str(td.toolCall?.tool?.case).toLowerCase()
    if (toolCase) return CASE_KEYS[toolCase]
    const name = (str(td.name) || str(td.tool)).toLowerCase()
    return name ? NAME_KEYS[name] : undefined
  }
  const toolArgs = (td: NonNullable<CursorBubbleLike['toolFormerData']>): Record<string, unknown> => {
    const modern = td.toolCall?.tool?.value?.args
    if (modern && typeof modern === 'object') return modern as Record<string, unknown>
    if (td.params && typeof td.params === 'object') return td.params as Record<string, unknown>
    if (typeof td.rawArgs === 'string') {
      try {
        const parsed: unknown = JSON.parse(td.rawArgs)
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
      } catch { /* 无参数即无详情 */ }
    }
    return {}
  }
  // Cursor `i31`：只有这些工具有「详情」；返回 undefined 的工具在副标题里被跳过。
  const toolDetail = (key: string, args: Record<string, unknown>): string | undefined => {
    if (key === 'read') {
      const path = readPath(args)
      if (!path) return undefined
      if (isToolOutput(path)) return 'tool output'
      const terminal = terminalId(path)
      if (terminal !== undefined) return terminal
      const base = lastSegment(path)
      if (args.readEntireFile === true) return base
      const legacyStart = num(args.startLineOneIndexed)
      const legacyEnd = num(args.endLineOneIndexedInclusive)
      if (legacyStart !== undefined && legacyEnd !== undefined) return `${base} L${legacyStart}-${legacyEnd}`
      const offset = num(args.offset)
      const limit = num(args.limit)
      if (offset !== undefined && limit !== undefined) return `${base} L${offset}-${offset + limit}`
      return base
    }
    if (key === 'ls') {
      // Cursor `Su_`：空 / "." 说成 current directory，其余 basename。
      const dir = lsPath(args)
      return !dir || dir === '.' ? 'current directory' : lastSegment(dir)
    }
    if (key === 'edit' || key === 'delete' || key === 'reapply') {
      const path = str(args.path) || str(args.relativeWorkspacePath) || str(args.targetFile)
      return path ? lastSegment(path) : undefined
    }
    if (key === 'grep') {
      const patternInfo = args.patternInfo && typeof args.patternInfo === 'object' ? args.patternInfo as Record<string, unknown> : undefined
      const pattern = str(args.pattern) || str(patternInfo?.pattern)
      const parts: string[] = []
      if (pattern) parts.push(pattern)
      const path = str(args.path)
      if (path) parts.push(`in ${dirLabel(path)}`)
      const options = args.options && typeof args.options === 'object' ? args.options as Record<string, unknown> : undefined
      const includePattern = options?.includePattern && typeof options.includePattern === 'object'
        ? str((options.includePattern as Record<string, unknown>).pattern)
        : ''
      const glob = str(args.glob) || includePattern
      if (glob) parts.push(`(${glob})`)
      const type = str(args.type)
      if (type) parts.push(`[type:${type}]`)
      return parts.join(' ') || undefined
    }
    // GLOB_FILE_SEARCH 用 globPattern；旧 FILE_SEARCH 走 `t31` 的 query。
    if (key === 'glob') return str(args.globPattern) || str(args.pattern) || str(args.query) || undefined
    if (key === 'semsearch' || key === 'searchsymbols' || key === 'deepsearch') return str(args.query) || undefined
    if (key === 'definition') return str(args.symbol) || undefined
    if (key === 'websearch') return str(args.searchTerm) || str(args.query) || undefined
    if (key === 'readlints') {
      const paths = Array.isArray(args.paths) ? args.paths : []
      const path = str(args.path) || str(paths[0])
      return path ? `in ${dirLabel(path)}` : undefined
    }
    if (key === 'todoread' || key === 'todowrite') return 'to-do list'
    return undefined
  }
  // Cursor `o31` → `l31` → `a31(50)`：首行、剥 Markdown、折叠空白、50 字加省略号。
  const snippet = (text: string): string => {
    const newline = text.indexOf('\n')
    let line = (newline === -1 ? text : text.slice(0, newline)).trim()
    line = line
      .replace(/<think>(.*?)<\/think>/gs, '$1').replace(/<think>(.*)$/gs, '$1')
      .replace(/```+/g, '').replace(/`+/g, '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/(^|\n)\s{0,3}#{1,6}\s*/g, '$1').replace(/(^|\n)\s{0,3}>\s?/g, '$1')
      .replace(/(^|\n)\s{0,3}([-*+]|\d+\.)\s+/g, '$1')
      .replace(/(\*\*|__|~~|\*|_)/g, '')
      .replace(/\|/g, ' ').replace(/\s+/g, ' ').trim()
    return line.length <= 50 ? line : `${line.slice(0, 50)}\u2026`
  }

  const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : []
  const map = data.conversationMap || {}
  const floor = Math.max(0, headers.length - Math.max(1, maxSteps))
  for (let index = headers.length - 1; index >= floor; index -= 1) {
    const header = headers[index]
    const bubble = header && header.bubbleId ? map[header.bubbleId] : undefined
    if (!bubble) continue
    if (bubble.thinking !== undefined) return { kind: 'thinking', label: 'Thinking' }
    const td = bubble.toolFormerData
    if (td && (td.toolCall !== undefined || td.tool !== undefined || td.name !== undefined)) {
      const key = toolKey(td)
      if (key === 'todoread' || key === 'todowrite') {
        const todos = Array.isArray(data.todos) ? data.todos.filter(Boolean) : []
        if (todos.length) {
          const done = todos.filter((todo) => todo && todo.status === 'completed').length
          return { kind: 'todos', label: `${done}/${todos.length} To-Dos Completed`, toolKind: 'todo' }
        }
      }
      if (key) {
        const args = toolArgs(td)
        const detail = toolDetail(key, args)
        const tool = TOOLS[key]
        if (detail !== undefined && tool) {
          const verb = verbOverride(key, args)
          // 目录本身就是 terminals / agent-transcripts 时，Cursor 会把对象再说一遍（"Listing terminals terminals"）；
          // 这是它的拼接副作用而非措辞，这里只保留动词——唯一一处有意不逐字复刻。
          if (verb && key === 'ls') return { kind: 'tool', label: verb, toolKind: tool.kind }
          return { kind: 'tool', label: `${verb ?? tool.verb} ${detail}`, detail, toolKind: tool.kind }
        }
      }
      continue
    }
    if (header && header.type === 2) {
      const text = str(bubble.text).trim()
      if (text) return { kind: 'text', label: snippet(text) }
    }
  }
  return undefined
}

/** 宽容解析页面帧（写后 hook / runtime inspect）里的副标题载荷：形状不对即视为缺省，坏帧不影响过程流。 */
export function parseCursorStatusLine(value: unknown): CursorStatusLine | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const kind = raw.kind
  if (kind !== 'thinking' && kind !== 'tool' && kind !== 'text' && kind !== 'todos') return undefined
  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 200) : ''
  if (!label) return undefined
  const detail = typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail.trim().slice(0, 200) : undefined
  const toolKind = typeof raw.toolKind === 'string' && raw.toolKind ? raw.toolKind as ProcessToolKind : undefined
  return { kind, label, ...(detail ? { detail } : {}), ...(toolKind ? { toolKind } : {}) }
}

/**
 * 块级孪生：同一套规则应用到拾光过程块（hook 帧未携带 statusLine 时的渲染层回退——
 * 旧 hook、观察器离线）。过程块已过滤传输噪音，所以待命席位在这条回退上落到
 * "Planning next moves" 而不是 Thinking；这是回退的固有下限，不是规则分歧。
 */
export function cursorStatusLineFromBlocks(
  blocks: ReadonlyArray<ProcessBlock>,
  response?: { text: string; streaming: boolean }
): CursorStatusLine | undefined {
  if (response?.streaming && response.text.trim()) {
    return cursorStatusLineOf(textOnlyComposer(response.text))
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    const line = cursorStatusLineOf(blockAsComposer(block))
    if (line) return line
  }
  if (response?.text.trim()) return cursorStatusLineOf(textOnlyComposer(response.text))
  return undefined
}

function textOnlyComposer(text: string): CursorComposerDataLike {
  return {
    fullConversationHeadersOnly: [{ type: 2, bubbleId: 'text' }],
    conversationMap: { text: { text } }
  }
}

/** 把一个过程块还原成「单气泡 composer」，让块级回退与页面内算法共用同一条判定。 */
function blockAsComposer(block: ProcessBlock): CursorComposerDataLike {
  if (block.kind === 'thinking') {
    return { fullConversationHeadersOnly: [{ type: 2, bubbleId: 'b' }], conversationMap: { b: { thinking: block.text } } }
  }
  if (block.kind === 'message') return textOnlyComposer(block.text)
  if (block.kind === 'command') {
    return { fullConversationHeadersOnly: [{ type: 2, bubbleId: 'b' }], conversationMap: { b: { toolFormerData: { name: 'run_terminal_command_v2' } } } }
  }
  const args: Record<string, unknown> = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
    ? { ...(block.input as Record<string, unknown>) }
    : {}
  // 过程块的 summary 就是 Cursor 展示的对象（路径 / 模式 / 词）；旧持久化块没有 input 时按
  // 工具色相类回填到对应参数位（grep 只能填 pattern，填进 path 会被说成 "in <pattern>"）。
  if (block.summary) {
    const fields = block.toolKind === 'read' || block.toolKind === 'edit' || block.toolKind === 'write' ? ['path']
      : block.toolKind === 'search' ? ['pattern', 'globPattern', 'query', 'symbol']
      : block.toolKind === 'browser' ? ['searchTerm']
      : []
    for (const field of fields) {
      if (!(field in args)) args[field] = block.summary
    }
  }
  return {
    fullConversationHeadersOnly: [{ type: 2, bubbleId: 'b' }],
    conversationMap: {
      b: {
        toolFormerData: {
          ...(block.toolCase ? { toolCall: { tool: { case: block.toolCase, value: { args } } } } : { name: block.toolName, params: args })
        }
      }
    },
    ...(block.todos ? { todos: block.todos } : {})
  }
}
