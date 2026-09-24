import { describeMcpToolName, type ProcessTurnStep } from './process-turn-view'

/**
 * 过程步骤分组：把 Cursor 3.6.31 聊天面板的分组算法（bundle 内 `Jmd` 及其谓词
 * `jev / Omd / B3n / Xev / Nei / Umd / qmd`，摘要 `FAh`，组头 `HAh`）移植到拾光的
 * 投影层。输入是 `buildProcessTurnView` 产出的扁平步骤（已过滤 check_messages /
 * record_reply 等传输噪音），输出「单步 | 组」序列供会话页渲染。
 *
 * 密度默认 `detailed`（Cursor 编辑器内 Agent 面板的默认值，用户拍板）：shell / edit /
 * delete 永远独立成卡；read / ls / grep / glob / semSearch / readLints / readTodos /
 * fetch / webFetch / webSearch / getMcpTools 这些「探索类」连续调用折叠为 `Explored …`；
 * thinking 与短正文只能加入已有组，不能开组；仅 read / ls 且无 thinking 的组至少 3 步才折叠。
 *
 * 组 id 取组内首步 id：块持续到达时组只会在尾部增长，首步不变 ⇒ React key 稳定，
 * 组内 Thinking 的打字机缓冲不会因分组变化而重播。
 */

export type ProcessDensity = 'detailed' | 'compact-grouped' | 'compact-all-grouped'

export type ProcessGroupVariant = 'thought' | 'explore' | 'commands' | 'edits' | 'browser' | 'waiting'

export interface ProcessFileChangeStats {
  additions: number
  deletions: number
}

export interface ProcessTurnGroup {
  kind: 'group'
  /** `group:<首步 step id>`。 */
  id: string
  variant: ProcessGroupVariant
  /** 组头动词：running 取 loading 形态（Exploring），否则 completed 形态（Explored）。 */
  action: string
  /** 组头明细：`1 file` / `3 files, 2 searches` / `2 commands` / `for 12s`。 */
  details?: string
  fileChangeStats?: ProcessFileChangeStats
  thinkingDurationMs?: number
  status: 'running' | 'done' | 'failed'
  steps: ProcessTurnStep[]
}

export type ProcessTurnItem = { kind: 'step'; step: ProcessTurnStep } | ProcessTurnGroup

export interface GroupingOptions {
  density?: ProcessDensity
  /** 回合已结束：最后一步若是正文片段则单独成条（Cursor `isCompleted` 同款）。 */
  isCompleted?: boolean
  /** 可被吸入组的正文片段长度上限（Cursor `groupedTextMaxLength`，默认 100）。 */
  textMaxLength?: number
}

/** 任何密度下都可归组的「探索类」工具（Cursor `ZUv`）。 */
const GROUPABLE_CASES: ReadonlySet<string> = new Set([
  'readToolCall', 'grepToolCall', 'globToolCall', 'lsToolCall', 'semSearchToolCall', 'readLintsToolCall',
  'readTodosToolCall', 'fetchToolCall', 'webFetchToolCall', 'webSearchToolCall', 'getMcpToolsToolCall'
])

/** 「轻探索」工具（Cursor `XUv`）：只有它们且无 thinking 的组至少 3 步才折叠。 */
const LIGHT_CASES: ReadonlySet<string> = new Set(['readToolCall', 'lsToolCall'])

/** 浏览器 MCP 提供方标识（Cursor `eqv`）。 */
const BROWSER_MCP_PROVIDERS = ['cursor-ide-browser', 'cursor-browser-extension']

/** 等待组（后台任务监控）成组所需的工具数（Cursor `QUv`）。 */
const WAITING_GROUP_MIN_TOOLS = 2

/** 单文件组头直接显示文件名的长度上限（Cursor `iqv`）。 */
const SINGLE_FILE_NAME_MAX = 20

interface StepFacts {
  type: 'thinking' | 'assistant-message' | 'tool-call'
  toolCase?: string
  browserMcp: boolean
  text: string
  thinkingDurationMs?: number
  /** 工具正阻塞用户决策（待答 ask_question）：Cursor `shouldSkip`，单独成卡不入组。 */
  blocksUserDecision: boolean
  /** 待审批的 edit / delete（Cursor `Zev`）；拾光暂无审批状态来源，恒 false。 */
  approvalPending: boolean
  target?: string
  fileChangeStats?: ProcessFileChangeStats
}

interface IndexedStep {
  step: ProcessTurnStep
  facts: StepFacts
  index: number
}

function isCompactDensity(density: ProcessDensity): boolean {
  return density === 'compact-grouped' || density === 'compact-all-grouped'
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

function toolCallInfo(step: ProcessTurnStep): { toolCase?: string; browserMcp: boolean } {
  const name = (step.toolName ?? '').trim()
  const lower = name.toLowerCase()
  const mcp = name.startsWith('mcp-') ? describeMcpToolName(name) : undefined
  const browserMcp = Boolean(mcp && (
    mcp.tool.startsWith('browser_')
    || BROWSER_MCP_PROVIDERS.some((provider) => (mcp.server ?? '').includes(provider))
  ))
  if (step.toolCase) return { toolCase: step.toolCase, browserMcp }
  return { toolCase: inferToolCase(step.kind, lower, Boolean(mcp)), browserMcp }
}

/**
 * 无 toolCase（旧持久化块 / 旧 hook 帧）时按 toolName 与 kind 推断。
 * 推断只影响分组阈值与摘要计数，不影响块本身的呈现。
 */
export function inferToolCase(kind: ProcessTurnStep['kind'], lowerToolName: string, isMcp: boolean): string | undefined {
  if (isMcp) return 'mcpToolCall'
  if (lowerToolName === 'await' || lowerToolName === 'awaittoolcall') return 'awaitToolCall'
  if (lowerToolName.startsWith('capability:') || lowerToolName === 'servicestatus' || lowerToolName === 'planupdate') return undefined
  switch (kind) {
    case 'read':
      if (lowerToolName.includes('lint')) return 'readLintsToolCall'
      if (lowerToolName.includes('ls_tool') || lowerToolName.includes('lstool') || lowerToolName === 'ls' || lowerToolName === 'list_dir') return 'lsToolCall'
      return 'readToolCall'
    case 'search':
      if (lowerToolName.includes('glob')) return 'globToolCall'
      if (lowerToolName.includes('sem')) return 'semSearchToolCall'
      return 'grepToolCall'
    case 'edit':
      return lowerToolName.includes('delete') ? 'deleteToolCall' : 'editToolCall'
    case 'write':
      return 'editToolCall'
    case 'command':
      return 'shellToolCall'
    case 'browser':
      return lowerToolName.includes('search') ? 'webSearchToolCall' : 'fetchToolCall'
    case 'todo':
      return lowerToolName.includes('read') ? 'readTodosToolCall' : 'updateTodosToolCall'
    case 'task':
      return 'taskToolCall'
    case 'question':
      return 'askQuestionToolCall'
    case 'image':
      return 'generateImageToolCall'
    case 'mcp':
      return 'mcpToolCall'
    default:
      return undefined
  }
}

/** 编辑提示 `+12 −3`（hook `editHint` 形态，减号是 U+2212 或 ASCII）→ 增删统计。 */
export function parseFileChangeStats(hint?: string): ProcessFileChangeStats | undefined {
  if (!hint) return undefined
  const match = hint.match(/\+(\d+)\s+[−-](\d+)/)
  if (!match) return undefined
  return { additions: Number(match[1]), deletions: Number(match[2]) }
}

function factsOf(step: ProcessTurnStep): StepFacts {
  if (step.kind === 'thinking') {
    return {
      type: 'thinking', browserMcp: false, text: step.body ?? '', thinkingDurationMs: step.durationMs,
      blocksUserDecision: false, approvalPending: false
    }
  }
  if (step.kind === 'message') {
    return { type: 'assistant-message', browserMcp: false, text: step.body ?? '', blocksUserDecision: false, approvalPending: false }
  }
  const { toolCase, browserMcp } = toolCallInfo(step)
  const target = step.target ?? step.details.find((detail) => detail.kind === 'code' || detail.kind === 'path')?.value
  return {
    type: 'tool-call',
    toolCase,
    browserMcp,
    text: '',
    blocksUserDecision: step.question?.status === 'pending',
    approvalPending: false,
    target: target?.split('\n')[0]?.trim() || undefined,
    fileChangeStats: toolCase === 'editToolCall' || toolCase === 'deleteToolCall' ? parseFileChangeStats(step.hint) : undefined
  }
}

// ---- 谓词（与 Cursor 同名函数一一对应，注释给出压缩名） ----

/** `Omd`：短正文——≤ maxLength 字符、≤ maxLines 行、且不含代码围栏 / 标题 / 列表 / 表格。 */
export function isGroupableText(text: string, maxLength = 100, maxLines = 2): boolean {
  return !(text.length > maxLength
    || text.split('\n').length > maxLines
    || /```|^#{1,6}\s|^\s*[-*]\s|\|.*\|/m.test(text))
}

/** `B3n`：工具是否可归组（按密度）。 */
function isToolGroupable(toolCase: string, density: ProcessDensity): boolean {
  if (GROUPABLE_CASES.has(toolCase)) return true
  if (toolCase === 'shellToolCall' || toolCase === 'deleteToolCall' || toolCase === 'editToolCall') return isCompactDensity(density)
  return false
}

/** `jev`：步骤能否进入活动组。thinking / 短正文只能加入已有组。 */
function canJoinActivityGroup(facts: StepFacts, hasPending: boolean, density: ProcessDensity, textMaxLength: number): boolean {
  switch (facts.type) {
    case 'thinking':
      return hasPending
    case 'assistant-message':
      return hasPending && isGroupableText(facts.text, textMaxLength)
    case 'tool-call':
      if (facts.approvalPending) return false
      return facts.toolCase ? isToolGroupable(facts.toolCase, density) : false
  }
}

const isEditLike = (facts: StepFacts): boolean => facts.type === 'tool-call' && (facts.toolCase === 'editToolCall' || facts.toolCase === 'deleteToolCall')
const isShell = (facts: StepFacts): boolean => facts.type === 'tool-call' && facts.toolCase === 'shellToolCall'
const isAwait = (facts: StepFacts): boolean => facts.type === 'tool-call' && facts.toolCase === 'awaitToolCall'
const isRead = (facts: StepFacts): boolean => facts.type === 'tool-call' && facts.toolCase === 'readToolCall'
const isMcp = (facts: StepFacts): boolean => facts.type === 'tool-call' && facts.toolCase === 'mcpToolCall'
const isBrowserMcp = (facts: StepFacts): boolean => facts.type === 'tool-call' && facts.browserMcp

/** `Yev`：grep 且路径是 Cursor 终端输出文件（.cursor/projects/<ws>/terminals/N.txt）。 */
function isTerminalGrep(facts: StepFacts): boolean {
  if (facts.type !== 'tool-call' || facts.toolCase !== 'grepToolCall' || !facts.target) return false
  const parts = facts.target.split(/[/\\]/).filter(Boolean)
  for (let index = 0; index < parts.length - 3; index += 1) {
    if (parts[index] === '.cursor' && parts[index + 1] === 'projects' && parts[index + 3] === 'terminals') {
      const rest = parts.slice(index + 4)
      return rest.length === 1 && /^(ext-)?\d+\.txt$/.test(rest[0]!)
    }
  }
  return false
}

/** `ttv`：等待组开启后可继续吸入的步骤。 */
function continuesWaitingGroup(facts: StepFacts): boolean {
  return (facts.type === 'thinking' || isAwait(facts) || isRead(facts) || isTerminalGrep(facts) || isShell(facts) || isMcp(facts))
    && !isEditLike(facts)
}

/** `Xev`：加入活动组前是否要先切组（非 all-grouped 密度下 edit 与非 edit、shell 与非 shell 不混组）。 */
function shouldSplitBefore(pending: IndexedStep[], facts: StepFacts, density: ProcessDensity): boolean {
  if (facts.type !== 'tool-call') return false
  const edit = isEditLike(facts)
  const shell = isShell(facts)
  if (density !== 'compact-all-grouped' && pending.some(({ facts: other }) => other.type === 'tool-call' && isEditLike(other) !== edit)) return true
  return density !== 'compact-all-grouped' && pending.some(({ facts: other }) => other.type === 'tool-call' && isShell(other) !== shell)
}

// ---- 摘要与组头 ----

interface GroupSummary {
  files: string[]
  directories: string[]
  searches: number
  fetches: number
  lints: number
  commands: number
  browserActions: number
  waitingActions: number
  edits: number
  deletes: number
  fileChangeFiles: string[]
  fileChangeStats?: ProcessFileChangeStats
  taskCalls: number
}

/** `FAh`：组摘要。 */
function summarize(steps: IndexedStep[]): { summary: GroupSummary; thinkingDurationMs?: number; hasText: boolean } {
  const summary: GroupSummary = {
    files: [], directories: [], searches: 0, fetches: 0, lints: 0, commands: 0, browserActions: 0, waitingActions: 0,
    edits: 0, deletes: 0, fileChangeFiles: [], taskCalls: 0
  }
  const changedFiles = new Set<string>()
  let additions = 0
  let deletions = 0
  let hasStats = false
  let thinkingDurationMs: number | undefined
  let hasText = false
  for (const { facts } of steps) {
    if (facts.type === 'thinking') {
      if (facts.thinkingDurationMs !== undefined) thinkingDurationMs = (thinkingDurationMs ?? 0) + facts.thinkingDurationMs
      continue
    }
    if (facts.type === 'assistant-message') {
      hasText = true
      continue
    }
    switch (facts.toolCase) {
      case 'readToolCall':
        if (facts.target) summary.files.push(baseName(facts.target))
        break
      case 'lsToolCall':
        if (facts.target) summary.directories.push(baseName(facts.target))
        break
      case 'globToolCall':
      case 'grepToolCall':
      case 'semSearchToolCall':
      case 'webSearchToolCall':
      case 'getMcpToolsToolCall':
        summary.searches += 1
        break
      case 'fetchToolCall':
      case 'webFetchToolCall':
        summary.fetches += 1
        break
      case 'readLintsToolCall':
        summary.lints += 1
        break
      case 'shellToolCall':
        summary.commands += 1
        break
      case 'editToolCall':
      case 'deleteToolCall': {
        if (facts.toolCase === 'editToolCall') summary.edits += 1
        else summary.deletes += 1
        if (facts.target) changedFiles.add(baseName(facts.target))
        if (facts.fileChangeStats) {
          hasStats = true
          additions += facts.fileChangeStats.additions
          deletions += facts.fileChangeStats.deletions
        }
        break
      }
      case 'taskToolCall':
        summary.taskCalls += 1
        break
      case 'awaitToolCall':
        summary.waitingActions += 1
        break
      default:
        if (facts.browserMcp) summary.browserActions += 1
    }
  }
  summary.fileChangeFiles = [...changedFiles]
  if (hasStats) summary.fileChangeStats = { additions, deletions }
  return { summary, thinkingDurationMs, hasText }
}

/** 英文计数（Cursor 组头原文：`1 file` / `3 files` / `2 directories` / `1 search` / `2 searches`）。 */
function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** `UAh`：探索计数明细。组头文案沿用 Cursor 原文英文（2026-09-22 用户拍板：过程流要
 *  Cursor 原生那种英文，撤回 09-18 的中文本地化）；分组算法本身仍是 Cursor 移植。 */
function explorationParts(summary: GroupSummary, exploredPrefix: boolean): string[] {
  const parts: string[] = []
  if (summary.directories.length) parts.push(plural(summary.directories.length, 'directory', 'directories'))
  if (summary.files.length) parts.push(plural(summary.files.length, 'file'))
  if (summary.searches) parts.push(plural(summary.searches, 'search', 'searches'))
  if (summary.fetches) parts.push(plural(summary.fetches, 'fetch', 'fetches'))
  if (summary.lints) parts.push('lints')
  if (exploredPrefix && parts.length) parts[0] = `explored ${parts[0]}`
  return parts
}

/** `$md`：Thought 时长明细（`for 3s` / `for 0.8s` / `briefly`；Cursor 先四舍五入到秒：0.8s → 1s）。 */
export function thoughtDurationDetails(durationMs?: number): string {
  if (durationMs !== undefined && durationMs > 0 && durationMs < 500) return 'briefly'
  const seconds = durationMs !== undefined ? Math.round(durationMs / 1_000) : 0
  if (durationMs !== undefined && durationMs > 0 && seconds === 0) return `for ${(durationMs / 1_000).toFixed(1)}s`
  return seconds > 0 ? `for ${seconds}s` : 'briefly'
}

interface GroupHeader {
  variant: ProcessGroupVariant
  loading: string
  completed: string
  details?: string
}

/** `HAh`（= `ltv ?? ctv ?? utv ?? ptv`）：组头动词与明细（Cursor 原文英文，逐条对应）。 */
function headerOf(steps: IndexedStep[], summary: GroupSummary, thinkingDurationMs: number | undefined): GroupHeader {
  const toolSteps = steps.filter(({ facts }) => facts.type === 'tool-call')
  if (!toolSteps.length) {
    return { variant: 'thought', loading: 'Thinking', completed: 'Thought', details: thoughtDurationDetails(thinkingDurationMs) }
  }
  if (steps.some(({ facts }) => isBrowserMcp(facts))) {
    const count = summary.browserActions || toolSteps.length
    return { variant: 'browser', loading: 'Running', completed: 'Ran', details: plural(count, 'browser action') }
  }
  if (summary.waitingActions > 0) {
    const jobs = new Map<string, 'complete' | 'active'>()
    for (const { step, facts } of steps) {
      if (!isAwait(facts)) continue
      const taskId = (step.target ?? '').trim() || step.id
      jobs.set(taskId, step.status === 'running' ? 'active' : 'complete')
    }
    const complete = [...jobs.values()].filter((state) => state === 'complete').length
    const active = jobs.size - complete
    const parts = [complete ? `${complete} complete` : '', active ? `${active} active` : ''].filter(Boolean)
    const noun = jobs.size === 1 ? 'task' : 'tasks'
    return {
      variant: 'waiting',
      loading: `Monitoring background ${noun}`,
      completed: `Monitored background ${noun}`,
      details: parts.length ? parts.join(', ') : undefined
    }
  }
  if (summary.commands > 0 && summary.commands === toolSteps.length) {
    return { variant: 'commands', loading: 'Running', completed: 'Ran', details: plural(summary.commands, 'command') }
  }
  const change = summary.edits > 0
    ? { loading: 'Editing', completed: 'Edited', fileCount: summary.edits + summary.deletes }
    : summary.deletes > 0
      ? { loading: 'Deleting', completed: 'Deleted', fileCount: summary.deletes }
      : undefined
  if (toolSteps.length && toolSteps.every(({ facts }) => isEditLike(facts)) && !change) {
    return { variant: 'edits', loading: 'Deleting', completed: 'Delete', details: 'attempted' }
  }
  const parts: string[] = []
  if (change) {
    const single = change.fileCount === 1 ? summary.fileChangeFiles[0] : undefined
    parts.push(single && single.length <= SINGLE_FILE_NAME_MAX ? single : plural(change.fileCount, 'file'))
  }
  parts.push(...explorationParts(summary, change !== undefined))
  if (summary.commands) parts.push(`ran ${plural(summary.commands, 'command')}`)
  if (summary.taskCalls) parts.push(plural(summary.taskCalls, 'agent'))
  return {
    variant: change ? 'edits' : 'explore',
    loading: change?.loading ?? 'Exploring',
    completed: change?.completed ?? 'Explored',
    details: parts.length ? parts.join(', ') : undefined
  }
}

function groupStatus(steps: IndexedStep[]): ProcessTurnGroup['status'] {
  if (steps.some(({ step }) => step.status === 'running')) return 'running'
  if (steps.some(({ step }) => step.status === 'failed')) return 'failed'
  return 'done'
}

function single(item: IndexedStep): ProcessTurnItem {
  return { kind: 'step', step: item.step }
}

function makeGroup(steps: IndexedStep[], variantOverride?: ProcessGroupVariant, waitingActions?: number): ProcessTurnGroup {
  const { summary, thinkingDurationMs } = summarize(steps)
  if (waitingActions !== undefined) summary.waitingActions = waitingActions
  const header = headerOf(steps, summary, thinkingDurationMs)
  const status = groupStatus(steps)
  return {
    kind: 'group',
    id: `group:${steps[0]!.step.id}`,
    variant: variantOverride ?? header.variant,
    action: status === 'running' ? header.loading : header.completed,
    details: header.details,
    fileChangeStats: summary.fileChangeStats,
    thinkingDurationMs,
    status,
    steps: steps.map(({ step }) => step)
  }
}

/** `Nei`：活动组成型阈值。 */
function flushActivity(pending: IndexedStep[], minGroupSize: number): ProcessTurnItem[] {
  if (!pending.length) return []
  const hasThinking = pending.some(({ facts }) => facts.type === 'thinking')
  const allLight = !hasThinking && pending.every(({ facts }) => (
    facts.type === 'assistant-message'
    || (facts.type === 'tool-call' && facts.toolCase !== undefined && LIGHT_CASES.has(facts.toolCase))
  ))
  const toolCount = pending.filter(({ facts }) => facts.type === 'tool-call').length
  const singleShell = toolCount === 1 && pending.some(({ facts }) => isShell(facts))
  const threshold = allLight ? Math.max(minGroupSize, 3) : minGroupSize
  const count = singleShell ? toolCount : hasThinking ? pending.length : toolCount
  if (count < threshold) return pending.map(single)
  return [makeGroup(pending)]
}

/** `Umd`：浏览器动作组。 */
function flushBrowser(pending: IndexedStep[]): ProcessTurnItem[] {
  if (!pending.length) return []
  const toolCount = pending.filter(({ facts }) => facts.type === 'tool-call').length
  if (toolCount < 2) return pending.map(single)
  return [makeGroup(pending, 'browser')]
}

/** `qmd`：后台任务等待组。 */
function flushWaiting(pending: IndexedStep[]): ProcessTurnItem[] {
  if (!pending.length) return []
  const toolCount = pending.filter(({ facts }) => facts.type === 'tool-call').length
  if (toolCount < WAITING_GROUP_MIN_TOOLS) return pending.map(single)
  return [makeGroup(pending, 'waiting', toolCount)]
}

/** `Jmd`：分组主循环。 */
export function groupProcessSteps(steps: ProcessTurnStep[], options: GroupingOptions = {}): ProcessTurnItem[] {
  const density = options.density ?? 'detailed'
  const isCompleted = options.isCompleted ?? false
  const textMaxLength = options.textMaxLength ?? 100
  const minGroupSize = isCompactDensity(density) ? 2 : 1
  const indexed: IndexedStep[] = steps.map((step, index) => ({ step, facts: factsOf(step), index }))
  const out: ProcessTurnItem[] = []
  let activity: IndexedStep[] = []
  let browser: IndexedStep[] = []
  let waiting: IndexedStep[] = []
  const flushAll = (): void => {
    if (waiting.length) { out.push(...flushWaiting(waiting)); waiting = [] }
    if (browser.length) { out.push(...flushBrowser(browser)); browser = [] }
    if (activity.length) { out.push(...flushActivity(activity, minGroupSize)); activity = [] }
  }
  for (let index = 0; index < indexed.length; index += 1) {
    const current = indexed[index]!
    const { facts } = current
    if (facts.blocksUserDecision) {
      // 阻塞用户决策的工具（待答 ask_question）：Cursor 单独渲染，不参与分组。
      flushAll()
      out.push(single(current))
      continue
    }
    if (waiting.length) {
      if (facts.type === 'assistant-message') {
        out.push(...flushWaiting(waiting)); waiting = []
      } else if (continuesWaitingGroup(facts)) {
        waiting.push(current)
        continue
      } else {
        out.push(...flushWaiting(waiting)); waiting = []
      }
    }
    if (isAwait(facts)) {
      if (browser.length) { out.push(...flushBrowser(browser)); browser = [] }
      const trailingThinking = activity.length && activity[activity.length - 1]!.facts.type === 'thinking'
        ? activity.pop()
        : undefined
      if (activity.length) { out.push(...flushActivity(activity, minGroupSize)); activity = [] }
      if (trailingThinking) waiting.push(trailingThinking)
      waiting.push(current)
      continue
    }
    if (isCompleted && index === indexed.length - 1 && facts.type === 'assistant-message') {
      flushAll()
      out.push(single(current))
      continue
    }
    const browserCall = isBrowserMcp(facts)
    const thinkingIntoBrowser = browser.length > 0 && facts.type === 'thinking'
    if (browserCall || thinkingIntoBrowser) {
      if (activity.length) { out.push(...flushActivity(activity, minGroupSize)); activity = [] }
      browser.push(current)
      continue
    }
    if (browser.length) { out.push(...flushBrowser(browser)); browser = [] }
    const hasPending = activity.length > 0
    if (canJoinActivityGroup(facts, hasPending, density, textMaxLength)) {
      if (activity.length && shouldSplitBefore(activity, facts, density)) {
        out.push(...flushActivity(activity, minGroupSize)); activity = []
      }
      activity.push(current)
    } else {
      if (activity.length) { out.push(...flushActivity(activity, minGroupSize)); activity = [] }
      out.push(single(current))
    }
  }
  flushAll()
  return out
}
