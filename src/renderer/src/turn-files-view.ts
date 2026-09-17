import type { ConversationEntry, ProcessBlock } from '../../domain/conversation-entry'
import type { WorkspaceReviewFileStatus, WorkspaceReviewSummary } from '../../domain/workspace-review'
import type { LiveProcessState } from '../../shared/desktop-api'
import { fileTouchedBy, normalizeReviewPath, previousTurnMutationBlocks, processBlockPath, turnMutationBlocks } from './inspector/review-scope'

/**
 * 输入区上方「本轮文件栏」的视图模型（Cursor 原生输入框上方的 “N Files” 栏）。
 *
 * 一个文件一行：它来自本轮（最近一条已投递用户消息之后）的 edit / write 过程块；
 * 增删行数优先取 Git 工作树相对 HEAD 的文件级 diff（与右栏审查页同一口径，点「审查」进去
 * 看到的就是同一组数字），Git 不可用（非 git 工程 / 摘要未就绪）时回退到过程块 hint 的逐次
 * 求和并标为估算——同一文件多次编辑会重叠，和不等于净变化。
 *
 * 「上一轮」保持：队列传输下消息是被 check_messages 自动取走的，不是用户按发送——新回合开始
 * 那一刻本轮还没有任何编辑，若栏随之清零，就会在用户没有操作时消失并让输入区跳一截。所以
 * Agent 正在处理新消息、本轮尚无编辑时，栏保留上一轮的文件并标「上一轮」，直到本轮第一次编辑替换；
 * 回复落库后仍然没有编辑就正常消失（这一轮确实什么都没改）。
 */
/** 文件类型图标（按扩展名归族）：与 Cursor 原生栏一样用图标而不是文字徽标指认语言。 */
export type FileIconKind =
  | 'typescript' | 'react' | 'javascript' | 'json' | 'styles' | 'markdown' | 'markup'
  | 'image' | 'shell' | 'config' | 'code' | 'file'

export interface TurnFileView {
  /** 归一后的仓库相对路径（与右栏审查页同一口径）。 */
  path: string
  /** 目录部分（含末尾 `/`），根目录文件为空串。 */
  dir: string
  /** 文件名主干（不含扩展名）。 */
  stem: string
  /** 扩展名（含点），没有则空串。 */
  ext: string
  icon: FileIconKind
  /** 列表里有别的文件同名（如多个 index.ts）：只有这时才需要把目录摆出来区分。 */
  ambiguous: boolean
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
  /** turn = 本轮的文件；previous = 新回合尚无编辑，保住的是上一轮的文件（见文件头注释）。 */
  scope: 'turn' | 'previous'
}

const EMPTY_VIEW: TurnFilesView = { files: [], additions: 0, deletions: 0, working: false, estimated: false, scope: 'turn' }

/**
 * 扩展名 → 图标族。tsx / jsx 归 React（与 Cursor 一致：组件文件看框架不看语言）；
 * 未列出的扩展名给通用文件图标——名字里本来就带着扩展名，图标只是辅助指认。
 */
const ICON_KINDS: Record<string, FileIconKind> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'react', jsx: 'react',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', jsonl: 'json',
  css: 'styles', scss: 'styles', less: 'styles',
  md: 'markdown', mdx: 'markdown',
  html: 'markup', htm: 'markup', svg: 'markup', xml: 'markup', vue: 'markup', svelte: 'markup',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', avif: 'image',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell',
  yml: 'config', yaml: 'config', toml: 'config', ini: 'config', env: 'config', lock: 'config', properties: 'config',
  py: 'code', rs: 'code', go: 'code', java: 'code', kt: 'code', swift: 'code', rb: 'code', php: 'code',
  c: 'code', h: 'code', cc: 'code', cpp: 'code', hpp: 'code', cs: 'code', sql: 'code', graphql: 'code', gql: 'code'
}

export function fileIconKind(ext: string): FileIconKind {
  return ICON_KINDS[ext.replace(/^\./, '').toLowerCase()] ?? 'file'
}

/**
 * 增删行数的文字形态（悬停 / 读屏用；与栏上的显示同一规则）：只说非零的一侧——
 * `+28`、`−30`、`+18 −20`；两侧都为零说「无行数变化」，二进制说「二进制」。
 */
export function describeLineCounts(additions: number, deletions: number, binary = false): string {
  if (binary) return '二进制'
  const parts = [additions > 0 ? `+${additions}` : '', deletions > 0 ? `−${deletions}` : ''].filter(Boolean)
  return parts.length ? parts.join(' ') : '无行数变化'
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

/** 一组改动块 → 首次出现顺序的路径表 + 每个路径的过程块累计增删。 */
function collectMutations(blocks: readonly ProcessBlock[], workspacePath?: string): { order: string[]; counts: Map<string, { additions: number; deletions: number }> } {
  const order: string[] = []
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (const block of blocks) {
    const raw = processBlockPath(block)
    if (!raw) continue
    const path = normalizeReviewPath(raw, workspacePath)
    if (!path) continue
    const contribution = blockCounts(block)
    const current = counts.get(path)
    if (!current) {
      order.push(path)
      counts.set(path, contribution)
    } else {
      current.additions += contribution.additions
      current.deletions += contribution.deletions
    }
  }
  return { order, counts }
}

export function buildTurnFilesView(input: TurnFilesInput): TurnFilesView {
  let scope: TurnFilesView['scope'] = 'turn'
  let { order, counts: processCounts } = collectMutations(turnMutationBlocks(input.entries, input.liveProcess), input.workspacePath)
  if (!order.length && input.working) {
    // 新回合刚开始、还没有编辑：保住上一轮的文件（只看已落库回复），标为「上一轮」。
    const previous = collectMutations(previousTurnMutationBlocks(input.entries), input.workspacePath)
    if (previous.order.length) {
      scope = 'previous'
      order = previous.order
      processCounts = previous.counts
    }
  }
  // 没有文件就没有栏：常量引用让调用方的 memo 边界在空态下天然稳定，working 此时无人消费。
  if (!order.length) return EMPTY_VIEW

  const gitFiles = input.summary?.state === 'ready' ? input.summary.files : []
  // 同名文件（多个 index.ts）才把目录摆出来；文件名唯一时目录留在悬停里，和 Cursor 原生栏一样只看名字。
  const nameCounts = new Map<string, number>()
  for (const path of order) {
    const { stem, ext } = splitTurnFilePath(path)
    nameCounts.set(stem + ext, (nameCounts.get(stem + ext) ?? 0) + 1)
  }
  const files: TurnFileView[] = order.map((path) => {
    const parts = splitTurnFilePath(path)
    const identity = { path, ...parts, icon: fileIconKind(parts.ext), ambiguous: (nameCounts.get(parts.stem + parts.ext) ?? 0) > 1 }
    const git = gitFiles.find((file) => fileTouchedBy(file, [path]))
    if (git) {
      return {
        ...identity,
        additions: git.additions ?? 0,
        deletions: git.deletions ?? 0,
        status: git.status,
        ...(git.binary ? { binary: true } : {}),
        source: 'git'
      }
    }
    const estimate = processCounts.get(path) ?? { additions: 0, deletions: 0 }
    return { ...identity, additions: estimate.additions, deletions: estimate.deletions, source: 'process' }
  })
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    working: input.working,
    estimated: files.some((file) => file.source === 'process'),
    scope
  }
}

/**
 * 两份视图是否等价（路径集、顺序、数字、状态、生成态、范围）。过程流以 ~10Hz 推送，投影结果
 * 若每帧换新对象，本轮文件栏就会每帧重渲：调用方据此复用上一份对象，让 memo 边界生效。
 */
export function sameTurnFilesView(left: TurnFilesView | undefined, right: TurnFilesView): boolean {
  if (!left) return false
  if (left === right) return true
  if (left.working !== right.working || left.estimated !== right.estimated || left.scope !== right.scope) return false
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
