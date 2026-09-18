import type { ProcessBlock, ProcessBlockTool, ProcessDiff, ProcessImage, ProcessQuestion, ProcessToolKind } from '../../domain/conversation-entry'
import { normalizeEscapedNewlines, normalizeProcessBlockText } from '../../domain/conversation-entry'

export type ProcessStepKind = 'thinking' | 'message' | ProcessToolKind

export interface ProcessStepDetail {
  label: string
  value: string
  kind?: 'text' | 'code' | 'path'
}

export interface ProcessTurnStep {
  id: string
  /** 原生过程块 id（step id 是它加 `block:` 前缀与去重下标后的视图键）。 */
  blockId: string
  kind: ProcessStepKind
  /** 原始工具名（`read_file_v2` / `mcp-SG Team-team_task` / `todos`）；分组回退推断 case 用。 */
  toolName?: string
  /** Cursor 原生工具 case 名（`readToolCall` …）；缺失时分组层按 toolName / kind 推断。 */
  toolCase?: string
  /** 头部主文案：模型给出的意图说明优先，否则是按状态变化的动词（读取中 / 已读取）。 */
  action: string
  /** 有意图说明时的副文案（动词），让「做了什么」仍可见。 */
  verb?: string
  /** 动作对象（路径 / 命令 / 模式 / 地址），无意图说明时内联在头部。 */
  target?: string
  /** 结果侧紧凑提示（程序名、行范围、增删行数、文件数、服务器名）。 */
  hint?: string
  /** 头部右侧状态词（进行中 / 完成 / 失败 / 等待回答 / 已回答 / 已跳过）。 */
  stateText: string
  body?: string
  status: 'running' | 'done' | 'failed'
  startedAt?: number
  completedAt?: number
  timingEstimated?: boolean
  durationMs?: number
  details: ProcessStepDetail[]
  todos?: Array<{ content: string; status: string }>
  /** Cursor 原生 ask_question：渲染为可点选卡片。 */
  question?: ProcessQuestion
  /** Shell 独立卡（kind=command）：命令行、输出与退出码，渲染层据此内联输出预览。 */
  shell?: ProcessShellStep
  /** 编辑步骤的结构化 diff：展开后按行着色渲染；缺失时明细里回退 diffString 文本。 */
  diff?: ProcessDiff
  /** 图片生成步骤（kind=image）的产出：卡片正文直接内联缩略图，点击看大图。 */
  image?: ProcessImage
}

export interface ProcessShellStep {
  command?: string
  output?: string
  /** 非零退出码（来自 hook 的 `exit N` 提示）。 */
  exitCode?: number
  error?: string
}

export interface ProcessTurnViewModel {
  id: string
  steps: ProcessTurnStep[]
  status: 'running' | 'done' | 'failed'
  startedAt?: number
  completedAt?: number
  elapsedMs?: number
  thinkingCount: number
  toolCount: number
  timingEstimated: boolean
}

const ACTIONS: Record<'thinking' | 'message', string> = {
  thinking: '思考',
  message: 'Agent'
}

interface StepVerbs { running: string; done: string; failed: string }

/**
 * 工具动词随状态变化（对齐 Cursor 自身的 Reading / Read / Read 三态），
 * 而不是一个固定名词——「运行验证」这种猜测性的标签会把普通 shell 调用说成验证。
 */
const TOOL_VERBS: Record<ProcessToolKind, StepVerbs> = {
  read: { running: '读取中', done: '已读取', failed: '读取失败' },
  search: { running: '搜索中', done: '已搜索', failed: '搜索失败' },
  edit: { running: '编辑中', done: '已编辑', failed: '编辑失败' },
  write: { running: '写入中', done: '已写入', failed: '写入失败' },
  command: { running: '运行中', done: '已运行', failed: '运行失败' },
  browser: { running: '浏览中', done: '已浏览', failed: '浏览失败' },
  mcp: { running: '调用中', done: '已调用', failed: '调用失败' },
  todo: { running: '更新待办', done: '已更新待办', failed: '更新待办失败' },
  task: { running: '子任务进行中', done: '子任务完成', failed: '子任务失败' },
  question: { running: '等待回答', done: '已回答', failed: '提问失败' },
  image: { running: '生成图片中', done: '已生成图片', failed: '生成图片失败' },
  other: { running: '执行中', done: '已执行', failed: '执行失败' }
}

/**
 * 按 Cursor 原生 case 细分的动词（Cursor `zJv` 三态表的中文对应）：toolKind 只能分到
 * read / search 一级，ls、glob、semSearch、webSearch、fetch、readLints、await 各有其词。
 */
const CASE_VERBS: Record<string, StepVerbs> = {
  lsToolCall: { running: '列出中', done: '已列出', failed: '列出失败' },
  globToolCall: { running: '搜索文件中', done: '已搜索文件', failed: '搜索文件失败' },
  semSearchToolCall: { running: '语义搜索中', done: '已语义搜索', failed: '语义搜索失败' },
  webSearchToolCall: { running: '搜索网页中', done: '已搜索网页', failed: '搜索网页失败' },
  fetchToolCall: { running: '抓取中', done: '已抓取', failed: '抓取失败' },
  webFetchToolCall: { running: '抓取中', done: '已抓取', failed: '抓取失败' },
  readLintsToolCall: { running: '读取诊断中', done: '已读取诊断', failed: '读取诊断失败' },
  deleteToolCall: { running: '删除中', done: '已删除', failed: '删除失败' },
  readTodosToolCall: { running: '读取待办', done: '已读取待办', failed: '读取待办失败' },
  getMcpToolsToolCall: { running: '探索工具中', done: '已探索工具', failed: '探索工具失败' },
  awaitToolCall: { running: '等待后台命令', done: '后台命令已结束', failed: '等待后台命令失败' }
}

const STATE_TEXT: Record<ProcessTurnStep['status'], string> = { running: '进行中', done: '完成', failed: '失败' }

/** Cursor `iav` 同款：意图说明开头的 “run ” 去掉并首字母大写（模型常写成 “run tests”）。 */
export function normalizeShellDescription(description: string): string {
  const stripped = description.replace(/^run(?=\s|$)\s*/i, '').trim()
  if (!stripped) return description.trim()
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

/** 有意图说明时，对象仍要在展开明细里可见；标签按对象类型取词。 */
const TARGET_LABEL: Record<ProcessToolKind, string> = {
  read: '文件', search: '模式', edit: '文件', write: '文件', command: '命令',
  browser: '地址', mcp: '工具', todo: '清单', task: '模型', question: '提问', image: '图片', other: '对象'
}

function kindOf(toolKind?: string): ProcessToolKind {
  return toolKind && toolKind in TOOL_VERBS ? toolKind as ProcessToolKind : 'other'
}

function clean(value?: string): string | undefined {
  const text = value ? normalizeEscapedNewlines(value).trim() : ''
  return text || undefined
}

/**
 * v28 之前已落库的编辑块把 unified diff 保存在 output；视图层兼容解析，
 * 让旧会话也能使用与新结构化 diff 相同的三行预览/完整展开组件。
 */
function legacyDiffFromOutput(value?: string): ProcessDiff | undefined {
  if (!value?.includes('@@ ')) return undefined
  const lines: ProcessDiff['lines'] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const raw of value.split(/\r?\n/)) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('diff ') || raw.startsWith('index ')) continue
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      lines.push({ type: 'hunk', text: raw })
      continue
    }
    if (!inHunk || raw.startsWith('\\')) continue
    const marker = raw[0]
    const text = raw.slice(1)
    if (marker === '+') {
      lines.push({ type: 'added', text, newLine })
      newLine += 1
    } else if (marker === '-') {
      lines.push({ type: 'removed', text, oldLine })
      oldLine += 1
    } else if (marker === ' ' || raw === '') {
      lines.push({ type: 'context', text, oldLine, newLine })
      oldLine += 1
      newLine += 1
    }
  }
  if (!lines.some((line) => line.type === 'added' || line.type === 'removed')) return undefined
  // output 已是持久化的有限快照；视图解析不再截断，否则展开后也读不到原有内容。
  return { lines }
}

/** Cursor 图片生成工具的原生 case 名（hook v35 起 toolKind=image；更早落库的块只有这个 case）。 */
const GENERATE_IMAGE_CASE = 'generateImageToolCall'

function fileNameOf(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
}

/**
 * v35 之前落库的图片生成块：toolKind 是 other，结果路径埋在 output 的 JSON 文本里
 *（`{"filePath": "…", "imageData": "[binary/image payload omitted]"}`）。视图层把路径救出来，
 * 旧会话同样内联缩略图；新块直接带 image 字段，不走这里。
 */
function legacyImageFromOutput(block: ProcessBlockTool): ProcessImage | undefined {
  if (block.toolCase !== GENERATE_IMAGE_CASE || block.image || !block.output) return undefined
  try {
    const parsed: unknown = JSON.parse(block.output)
    const filePath = parsed && typeof parsed === 'object' ? (parsed as { filePath?: unknown }).filePath : undefined
    const path = typeof filePath === 'string' ? filePath.trim() : ''
    return path ? { path } : undefined
  } catch {
    return undefined
  }
}

/** `mcp-<server>-<tool>` → 工具名与服务器名（服务器名可含连字符，按最后一个连字符切分）。 */
export function describeMcpToolName(toolName: string): { tool: string; server?: string } {
  const rest = toolName.startsWith('mcp-') ? toolName.slice(4) : toolName
  const split = rest.lastIndexOf('-')
  if (!toolName.startsWith('mcp-') || split <= 0) return { tool: rest }
  return { tool: rest.slice(split + 1), server: rest.slice(0, split) }
}

/** 问卷状态词：等待回答 / 已回答 / 已跳过（超时） */
function questionStateText(question: ProcessQuestion, status: ProcessTurnStep['status']): string {
  if (status === 'failed') return '失败'
  if (question.status === 'submitted') return '已回答'
  if (question.status === 'cancelled') return question.skipReason === 'timeout' ? '已超时' : '已跳过'
  return '等待回答'
}

/**
 * step id 只由原生 block id 决定（不掺位置下标）：直播→封口时若前置的重复
 * message 块被滤除，位置会整体前移，含下标的 id 会让后续 Thinking 播放器
 * 误判为新来源而从头重播。重复 id（理论上不出现）才追加下标去重。
 */
function blockStep(raw: ProcessBlock, id: string): ProcessTurnStep {
  const block = normalizeProcessBlockText(raw)
  const blockId = raw.id
  if (block.kind === 'thinking') {
    return {
      id,
      blockId,
      kind: 'thinking',
      action: ACTIONS.thinking,
      stateText: STATE_TEXT[block.status],
      body: clean(block.text),
      status: block.status,
      startedAt: block.startedAt,
      completedAt: block.completedAt,
      timingEstimated: block.timingEstimated,
      durationMs: block.durationMs,
      details: []
    }
  }
  if (block.kind === 'message') {
    return {
      id,
      blockId,
      kind: 'message',
      action: ACTIONS.message,
      stateText: STATE_TEXT[block.status],
      body: clean(block.text),
      status: block.status,
      startedAt: block.startedAt,
      completedAt: block.completedAt,
      timingEstimated: block.timingEstimated,
      details: []
    }
  }
  if (block.kind === 'command') {
    return {
      id,
      blockId,
      kind: 'command',
      toolCase: 'shellToolCall',
      action: TOOL_VERBS.command[block.status],
      target: clean(block.command),
      stateText: STATE_TEXT[block.status],
      status: block.status,
      startedAt: block.startedAt,
      completedAt: block.completedAt,
      timingEstimated: block.timingEstimated,
      details: block.output ? [{ label: '输出', value: block.output, kind: 'code' }] : [],
      shell: {
        command: clean(block.command),
        output: clean(block.output),
        exitCode: block.exitCode !== undefined && block.exitCode !== 0 ? block.exitCode : undefined
      }
    }
  }
  // v35 之前落库的图片生成块归在 other 类：按原生 case 认回 image，并从 output 里救出路径。
  const legacyImage = legacyImageFromOutput(block)
  const kind = block.toolCase === GENERATE_IMAGE_CASE ? 'image' : kindOf(block.toolKind)
  const image = block.image ?? legacyImage
  const isShell = kind === 'command' && block.toolCase !== 'awaitToolCall'
  const rawTitle = clean(block.title)
  const title = rawTitle && isShell ? normalizeShellDescription(rawTitle) : rawTitle
  const target = clean(block.summary) ?? (image ? fileNameOf(image.path) : undefined)
  const mcp = kind === 'mcp' ? describeMcpToolName(block.toolName) : undefined
  // 动词：MCP 用真实工具名（team_task / browser_navigate），计划更新单列，其余先按原生 case
  // 细分（ls / glob / fetch / await …），再回退类别 + 状态取词。
  const verbs = (block.toolCase ? CASE_VERBS[block.toolCase] : undefined) ?? TOOL_VERBS[kind]
  // 未知工具平时以工具名作标题，但失败时必须由动词说出「执行失败」——
  // 右侧不再挂重复的状态词（审查项 6），失败语义只能落在这里。
  const verb = mcp?.tool
    ? `${TOOL_VERBS.mcp[block.status]} ${mcp.tool}`
    : block.toolName === 'planUpdate'
      ? (block.status === 'running' ? '更新计划' : '已更新计划')
      : kind === 'other' && block.toolName && !title && block.status !== 'failed' ? block.toolName : verbs[block.status]
  const details: ProcessStepDetail[] = []
  // 有意图说明时对象不再占头部，但要在明细里第一眼可见。
  if (title && target) details.push({ label: TARGET_LABEL[kind], value: target, kind: 'code' })
  if (block.input && Object.keys(block.input).length && !block.question) {
    details.push({ label: '输入', value: JSON.stringify(block.input, null, 2), kind: 'code' })
  }
  // 有结构化 diff 时它就是编辑的全部信息，结果消息（"The file … has been updated."）不再进明细。
  const diff = block.diff?.lines.length
    ? block.diff
    : kind === 'edit' ? legacyDiffFromOutput(clean(block.output)) : undefined
  // 旧图片块的 output 只是 `{filePath, imageData:"[omitted]"}` 的 JSON 文本，路径救出后它没有信息量。
  if (block.output && !diff && !legacyImage) details.push({ label: '输出', value: block.output, kind: 'code' })
  if (block.error) details.push({ label: '错误', value: block.error, kind: 'code' })
  // Shell 独立卡的数据：命令 / 输出 / 退出码（hook 把非零退出码放在 hint 的 `exit N`）。
  // await（等待后台命令）虽同为 command 类，但不是可执行的命令行，不走 shell 卡。
  const exitCode = isShell ? Number(clean(block.hint)?.match(/\bexit (\d+)\b/)?.[1]) : Number.NaN
  const shell: ProcessShellStep | undefined = isShell
    ? {
        command: target,
        output: clean(block.output),
        exitCode: Number.isFinite(exitCode) && exitCode !== 0 ? exitCode : undefined,
        error: clean(block.error)
      }
    : undefined
  return {
    id,
    blockId,
    kind,
    toolName: block.toolName || undefined,
    toolCase: block.toolCase,
    action: title ?? verb,
    // 问卷右侧已有「等待回答 / 已回答」状态，再重复同名副文案只会制造噪音。
    verb: title && kind !== 'question' ? verb : undefined,
    target: title ? undefined : target,
    hint: clean(block.hint) ?? mcp?.server,
    stateText: block.question ? questionStateText(block.question, block.status) : STATE_TEXT[block.status],
    status: block.status,
    startedAt: block.startedAt,
    completedAt: block.completedAt,
    timingEstimated: block.timingEstimated,
    details,
    todos: block.todos,
    question: block.question,
    ...(shell ? { shell } : {}),
    ...(diff ? { diff } : {}),
    ...(image ? { image } : {})
  }
}

export function buildProcessTurnView(input: {
  id: string
  blocks?: ProcessBlock[]
  startedAt?: number
  updatedAt?: number
}): ProcessTurnViewModel {
  const seenIds = new Map<string, number>()
  const blockSteps = (input.blocks ?? []).map((block, index) => {
    // todos/plan 的数据 id 带内容哈希（持久化需要区分每次更新），但视图层它们是
    // 同一张卡片：以稳定 step id 就地更新，避免每次勾选一项就 React 重挂、展开态丢失。
    const stableId = block.id.startsWith('cursor:todos:')
      ? 'cursor:todos'
      : block.id.startsWith('cursor:plan:') ? 'cursor:plan' : block.id
    const count = seenIds.get(stableId) ?? 0
    seenIds.set(stableId, count + 1)
    return blockStep(block, count === 0 ? `block:${stableId}` : `block:${stableId}:${index}`)
  })
  // Cursor 的 conversationMap 数组顺序就是原生时间线顺序；不可再按首次观测时间
  // 排序，否则同一帧出现的 thinking/tool 会被 id 字典序打乱。
  const steps = blockSteps
  const failed = steps.some((step) => step.status === 'failed')
  const running = steps.some((step) => step.status === 'running')
  const startedCandidates = [input.startedAt, ...steps.map((step) => step.startedAt)]
    .filter((value): value is number => typeof value === 'number')
  const completedCandidates = steps.map((step) => step.completedAt)
    .filter((value): value is number => typeof value === 'number')
  const startedAt = startedCandidates.length ? Math.min(...startedCandidates) : undefined
  const completedAt = running ? undefined : completedCandidates.length
    ? Math.max(...completedCandidates)
    : input.updatedAt
  return {
    id: input.id,
    steps,
    status: failed ? 'failed' : running ? 'running' : 'done',
    startedAt,
    completedAt,
    elapsedMs: startedAt !== undefined && (completedAt ?? input.updatedAt) !== undefined
      ? Math.max(0, (completedAt ?? input.updatedAt)! - startedAt)
      : undefined,
    thinkingCount: steps.filter((step) => step.kind === 'thinking').length,
    toolCount: steps.filter((step) => step.kind !== 'thinking' && step.kind !== 'message').length,
    timingEstimated: steps.some((step) => step.timingEstimated === true)
  }
}

/** 建议区标题（明确建议语义才生成按钮）。 */
const SUGGESTION_MARKER = /^(接下来可以|下一步建议|建议操作|可以继续)/

/** Markdown 行内标记转纯展示文本：建议按钮文案与回填输入框都用纯文本，
 *  不把 `**`、反引号、链接语法原样带进 UI（RC-11）。 */
function markdownToPlainText(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从回复正文提取「接下来可以」类建议操作。
 *
 * 约束（阶段 H / RC-11，图片事故回归）：
 * - 仅明确建议标题（接下来可以/下一步建议/建议操作/可以继续，容忍 Markdown
 *   加粗与标题前缀）之后的列表生成建议；无标题时不做任意编号列表兜底——
 *   回复末尾的普通编号内容（图片说明、步骤回顾）不是下一步建议；
 * - 候选先转纯文本再进入按钮（`**`、反引号、链接语法不出现在 UI 与输入框）；
 * - `**加粗**` 行不被误认作 `*` 无序列表项；
 * - 按纯文本去重与长度限制（4–100 字符），最多 4 条。
 */
export function suggestedActionsFromText(text: string): string[] {
  const lines = normalizeEscapedNewlines(text).split('\n').map((line) => line.trim())
  let markerIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    const plain = markdownToPlainText(lines[index]!).replace(/^#+\s*/, '')
    if (SUGGESTION_MARKER.test(plain)) markerIndex = index
  }
  if (markerIndex < 0) return []
  const candidates: string[] = []
  for (const line of lines.slice(markerIndex + 1)) {
    if (/^#{1,6}\s/.test(line) && candidates.length) break
    // `*` 列表项排除 `**加粗**` 形态（第二个字符是 `*` 的是强调，不是列表）。
    const match = line.match(/^(?:[-•]|\*(?!\*)|\d+[.)、])\s*(.+)$/)
    if (match?.[1]) {
      candidates.push(markdownToPlainText(match[1]))
      if (candidates.length === 4) break
    } else if (line && candidates.length) {
      break
    }
  }
  return [...new Set(candidates.filter((line) => line.length >= 4 && line.length <= 100))].slice(0, 4)
}
