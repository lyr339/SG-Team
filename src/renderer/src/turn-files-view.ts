import type { ChangeSummary } from '../../domain/agent-session'
import type { ConversationEntry, ProcessBlock } from '../../domain/conversation-entry'
import type { WorkspaceReviewFileStatus, WorkspaceReviewSummary } from '../../domain/workspace-review'
import type { LiveProcessState } from '../../shared/desktop-api'
import { fileIconKind, type FileIconKind } from './file-type'
import { fileTouchedBy, latestDeliveredUserIndex, normalizeReviewPath, preTurnMutationsExist, previousTurnMutationBlocks, processBlockPath, turnMutationBlocks } from './inspector/review-scope'

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
export interface TurnFileView {
  /** 归一后的仓库相对路径（与右栏审查页同一口径）。 */
  path: string
  /** 目录部分（含末尾 `/`），根目录文件为空串。 */
  dir: string
  /** 文件名主干（不含扩展名）。 */
  stem: string
  /** 扩展名（含点），没有则空串。 */
  ext: string
  /** 文件类型图标族（与 Cursor 原生栏一样用图标而不是文字徽标指认语言）。 */
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
  /** 合计是估算（估算行求和，且没有可用的 Cursor 累计兜底）。逐文件是否估算看 `file.source`。 */
  estimated: boolean
  /**
   * 合计的来源：sum = 逐文件相加（git 精确值与过程估算的混合）；composer = 由 Cursor 持久化的
   * Composer 累计净值差分出的本轮 / 上一轮增量（与名册行同一份读数）。见 `TurnFilesInput.sessionChanges`。
   */
  totalsSource: 'sum' | 'composer'
  /** turn = 本轮的文件；previous = 新回合尚无编辑，保住的是上一轮的文件（见文件头注释）。 */
  scope: 'turn' | 'previous'
}

const EMPTY_VIEW: TurnFilesView = { files: [], additions: 0, deletions: 0, working: false, estimated: false, totalsSource: 'sum', scope: 'turn' }

/**
 * 增删行数的文字形态（悬停 / 读屏用；与栏上的显示同一规则）：只说非零的一侧——
 * `+28`、`−30`、`+18 −20`；两侧都为零说「无行数变化」，二进制说「二进制」。
 */
export function describeLineCounts(additions: number, deletions: number, binary = false): string {
  if (binary) return '二进制'
  const parts = [additions > 0 ? `+${additions}` : '', deletions > 0 ? `−${deletions}` : ''].filter(Boolean)
  return parts.length ? parts.join(' ') : '无行数变化'
}

/**
 * 合计的悬停说明。文件栏与右栏「本轮」头部共用（两处显示同一个数，也说同一句话）。
 */
export function turnTotalsTitle(view: TurnFilesView): string {
  if (view.totalsSource === 'composer') {
    const span = view.scope === 'previous' ? '上一轮开始到本轮开始之间' : '本轮开始到现在'
    return `合计取 Cursor 统计的净增删：${span}的增量，与左侧名册行（本会话累计）同一来源；逐文件是过程估算，同一文件多次编辑会重复计入，相加可能大于合计`
  }
  if (view.estimated) return '含按编辑逐次累计的估算值'
  return `${view.scope === 'previous' ? '上一轮' : '本轮'}文件的增删行数合计（工作树相对 HEAD）`
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
  /**
   * 名册行同款：Cursor 持久化的 Composer 累计净增删（`totalLinesAdded/Removed`）。
   * 逐笔 hint 求和会把同一文件的反复编辑重复计入（估算必然偏大，甚至出现「本轮 > 会话累计」的倒挂）；
   * 合计改由这份读数差分：每条用户消息被取走时主进程盖一枚刻度（`ConversationEntry.changesBaseline`），
   * 本轮 = 现在的累计 − 本轮起点刻度，上一轮 = 本轮起点刻度 − 上一轮起点刻度——与名册行同一来源，
   * 本栏不可能再大于名册。刻度缺失（旧数据 / 投递时桌面端不在）时只剩一种可差分的情形：本轮是会话
   * 迄今唯一的改动区间，起点即零；其余退回逐笔估算并标 ≈。
   */
  sessionChanges?: ChangeSummary
  /** 名册行所属 Composer（`session.composerId`）：刻度只对同一 Composer 有效，席位重建后计数从零重来。 */
  sessionComposerId?: string
}

function clampedDelta(end: { additions: number; deletions: number }, start: { additions: number; deletions: number }): ChangeSummary {
  // 净值可以回落（后一轮删掉了前一轮加的行）：差为负按 0 计，不把别的回合的账记到这一轮头上。
  return { additions: Math.max(0, end.additions - start.additions), deletions: Math.max(0, end.deletions - start.deletions) }
}

const ZERO_CHANGES = { additions: 0, deletions: 0 }

/**
 * 用回合起点刻度差分出本轮 / 上一轮的精确增删（见 `TurnFilesInput.sessionChanges`）。
 * 返回 undefined 表示没有可信的刻度对：调用方退回逐笔估算。
 */
function exactTurnTotals(input: TurnFilesInput, scope: TurnFilesView['scope']): ChangeSummary | undefined {
  const entries = input.entries
  const endIndex = latestDeliveredUserIndex(entries)
  if (endIndex < 0) return undefined
  const end = entries[endIndex]!
  if (scope === 'turn') {
    const current = input.sessionChanges
    if (!current) return undefined
    const baseline = end.changesBaseline
    // 起点按零：会话迄今唯一的改动区间（旧数据没有刻度时仍能同源），或席位重建后新 Composer 从零计数。
    if (!baseline) return preTurnMutationsExist(entries) ? undefined : clampedDelta(current, ZERO_CHANGES)
    if (input.sessionComposerId && baseline.composerId !== input.sessionComposerId) return clampedDelta(current, ZERO_CHANGES)
    return clampedDelta(current, baseline)
  }
  // 上一轮：终点是本轮起点刻度，起点是上一轮自己的刻度（回合之间的续作编辑也算在上一轮里，与块集合边界一致）。
  const endBaseline = end.changesBaseline
  if (!endBaseline) return undefined
  const before = entries.slice(0, endIndex)
  const startIndex = latestDeliveredUserIndex(before)
  const startBaseline = startIndex >= 0 ? before[startIndex]!.changesBaseline : undefined
  if (!startBaseline) return preTurnMutationsExist(before) ? undefined : clampedDelta(endBaseline, ZERO_CHANGES)
  // 两枚刻度分属不同 Composer（上一轮里发生过席位重建）：那一轮的账跨了两个计数器，差分不成立。
  if (startBaseline.composerId !== endBaseline.composerId) return undefined
  return clampedDelta(endBaseline, startBaseline)
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
  const estimated = files.some((file) => file.source === 'process')
  // 合计与名册同源的条件：逐文件含估算（全部走 Git 精确口径时合计就是文件级 diff 相加，与审查页一致）、
  // 刻度能差分出这一轮（本轮或保住的上一轮）、且差出来不是全零——Cursor 的累计在编辑后才写盘，
  // 回合刚开始那几拍先用估算顶住，避免「有文件合计却是 0」。
  const exact = estimated ? exactTurnTotals(input, scope) : undefined
  const composerTotals = exact && (exact.additions > 0 || exact.deletions > 0) ? exact : undefined
  return {
    files,
    additions: composerTotals?.additions ?? files.reduce((total, file) => total + file.additions, 0),
    deletions: composerTotals?.deletions ?? files.reduce((total, file) => total + file.deletions, 0),
    working: input.working,
    estimated: composerTotals ? false : estimated,
    totalsSource: composerTotals ? 'composer' : 'sum',
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
  if (left.totalsSource !== right.totalsSource) return false
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
