import type { ConversationEntry, ProcessBlock } from '../../domain/conversation-entry'
import type { WorkspaceReviewFileStatus, WorkspaceReviewSummary } from '../../domain/workspace-review'
import type { LiveProcessState } from '../../shared/desktop-api'
import { fileTouchedBy, normalizeReviewPath, processBlockPath, turnMutationBlocks } from './inspector/review-scope'

/**
 * 输入区上方「本轮文件栏」的视图模型（Cursor 原生输入框上方的 “N Files” 栏）。
 *
 * 一个文件一行：它来自本轮（最近一条已投递用户消息之后）的 edit / write 过程块；
 * 增删行数优先取 Git 工作树相对 HEAD 的文件级 diff（与右栏审查页同一口径，点「审查」进去
 * 看到的就是同一组数字），Git 不可用（非 git 工程 / 摘要未就绪）时回退到过程块 hint 的逐次
 * 求和并标为估算——同一文件多次编辑会重叠，和不等于净变化。
 */
export interface TurnFileView {
  /** 归一后的仓库相对路径（与右栏审查页同一口径）。 */
  path: string
  /** 目录部分（含末尾 `/`），根目录文件为空串。 */
  dir: string
  /** 文件名主干（不含扩展名）。 */
  stem: string
  /** 扩展名（含点），没有则空串。 */
  ext: string
  /** 语言徽标（TS / CSS / MD …）。 */
  badge: string
  additions: number
  deletions: number
  /** Git 侧状态；只有 git 口径的行才有。 */
  status?: WorkspaceReviewFileStatus
  binary?: boolean
  /** 数字来源：git = 工作树相对 HEAD 的文件级 diff；process = 过程块 hint 求和（估算）。 */
  source: 'git' | 'process'
}

export interface TurnFilesView {
  files: TurnFileView[]
  additions: number
  deletions: number
  /** Agent 仍在处理本轮消息（取走了消息还没 record_reply）：列表可能继续变化。 */
  working: boolean
  /** 任一文件的数字来自过程块估算。 */
  estimated: boolean
}

const EMPTY_VIEW: TurnFilesView = { files: [], additions: 0, deletions: 0, working: false, estimated: false }

/** 扩展名 → 徽标。未列出的取扩展名大写（≤ 4 字符），没有扩展名给 `·`。 */
const BADGES: Record<string, string> = {
  ts: 'TS', tsx: 'TS', mts: 'TS', cts: 'TS',
  js: 'JS', jsx: 'JS', mjs: 'JS', cjs: 'JS',
  css: 'CSS', scss: 'CSS', less: 'CSS',
  md: 'MD', mdx: 'MD',
  json: 'JSON', jsonc: 'JSON', jsonl: 'JSON',
  yml: 'YML', yaml: 'YML', toml: 'TOML',
  html: 'HTML', htm: 'HTML', svg: 'SVG',
  py: 'PY', rs: 'RS', go: 'GO', java: 'JAVA', kt: 'KT', swift: 'SWIFT', rb: 'RB', php: 'PHP',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++', cs: 'C#',
  sh: 'SH', bash: 'SH', zsh: 'SH', ps1: 'PS', bat: 'BAT',
  sql: 'SQL', graphql: 'GQL',
  png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', webp: 'IMG', ico: 'IMG',
  lock: 'LOCK', txt: 'TXT', env: 'ENV', xml: 'XML', csv: 'CSV'
}

export function fileBadge(ext: string): string {
  const key = ext.replace(/^\./, '').toLowerCase()
  if (!key) return '·'
  return BADGES[key] ?? key.toUpperCase().slice(0, 4)
}

/** 路径拆成目录 / 主干 / 扩展名（与右栏 `splitPath` 同规则：点开头的隐藏文件与无扩展名整体视为主干）。 */
export function splitTurnFilePath(path: string): { dir: string; stem: string; ext: string } {
  const index = path.lastIndexOf('/')
  const dir = index < 0 ? '' : path.slice(0, index + 1)
  const name = index < 0 ? path : path.slice(index + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { dir, stem: name, ext: '' }
  return { dir, stem: name.slice(0, dot), ext: name.slice(dot) }
}

/** 解析 hook 产出的编辑提示 `+18 −20`（ASCII 减号 / Unicode 减号都认）；不是该形态返回 undefined。 */
export function parseEditHint(hint: string | undefined): { additions: number; deletions: number } | undefined {
  if (!hint) return undefined
  const match = /^\s*\+\s*(\d+)\s*[−-]\s*(\d+)\s*$/.exec(hint)
  if (!match) return undefined
  return { additions: Number(match[1]), deletions: Number(match[2]) }
}

/** 一个编辑块贡献的增删：hint 优先，其次数结构化 diff 的行；两者都没有算 0。 */
function blockCounts(block: ProcessBlock): { additions: number; deletions: number } {
  if (block.kind !== 'tool') return { additions: 0, deletions: 0 }
  const fromHint = parseEditHint(block.hint)
  if (fromHint) return fromHint
  if (block.diff?.lines.length) {
    let additions = 0
    let deletions = 0
    for (const line of block.diff.lines) {
      if (line.type === 'added') additions += 1
      else if (line.type === 'removed') deletions += 1
    }
    return { additions, deletions }
  }
  return { additions: 0, deletions: 0 }
}

export interface TurnFilesInput {
  entries: readonly ConversationEntry[]
  liveProcess?: LiveProcessState
  /** 右栏审查页读到的工作区摘要（uncommitted 范围）；缺省或非 ready 时全部回退到过程块估算。 */
  summary?: WorkspaceReviewSummary
  workspacePath?: string
  working: boolean
}

export function buildTurnFilesView(input: TurnFilesInput): TurnFilesView {
  const order: string[] = []
  const processCounts = new Map<string, { additions: number; deletions: number }>()
  for (const block of turnMutationBlocks(input.entries, input.liveProcess)) {
    const raw = processBlockPath(block)
    if (!raw) continue
    const path = normalizeReviewPath(raw, input.workspacePath)
    if (!path) continue
    const counts = blockCounts(block)
    const current = processCounts.get(path)
    if (!current) {
      order.push(path)
      processCounts.set(path, counts)
    } else {
      current.additions += counts.additions
      current.deletions += counts.deletions
    }
  }
  // 没有文件就没有栏：常量引用让调用方的 memo 边界在空态下天然稳定，working 此时无人消费。
  if (!order.length) return EMPTY_VIEW

  const gitFiles = input.summary?.state === 'ready' ? input.summary.files : []
  const files: TurnFileView[] = order.map((path) => {
    const parts = splitTurnFilePath(path)
    const badge = fileBadge(parts.ext)
    const git = gitFiles.find((file) => fileTouchedBy(file, [path]))
    if (git) {
      return {
        path, ...parts, badge,
        additions: git.additions ?? 0,
        deletions: git.deletions ?? 0,
        status: git.status,
        ...(git.binary ? { binary: true } : {}),
        source: 'git'
      }
    }
    const estimate = processCounts.get(path) ?? { additions: 0, deletions: 0 }
    return { path, ...parts, badge, additions: estimate.additions, deletions: estimate.deletions, source: 'process' }
  })
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    working: input.working,
    estimated: files.some((file) => file.source === 'process')
  }
}

/**
 * 两份视图是否等价（路径集、顺序、数字、状态、生成态）。过程流以 ~10Hz 推送，投影结果
 * 若每帧换新对象，本轮文件栏就会每帧重渲：调用方据此复用上一份对象，让 memo 边界生效。
 */
export function sameTurnFilesView(left: TurnFilesView | undefined, right: TurnFilesView): boolean {
  if (!left) return false
  if (left === right) return true
  if (left.working !== right.working || left.estimated !== right.estimated) return false
  if (left.additions !== right.additions || left.deletions !== right.deletions) return false
  if (left.files.length !== right.files.length) return false
  for (let index = 0; index < left.files.length; index += 1) {
    const a = left.files[index]!
    const b = right.files[index]!
    if (a.path !== b.path || a.additions !== b.additions || a.deletions !== b.deletions
      || a.status !== b.status || a.binary !== b.binary || a.source !== b.source) return false
  }
  return true
}
