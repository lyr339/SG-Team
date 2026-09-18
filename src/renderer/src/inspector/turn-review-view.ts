import type { ConversationEntry, ProcessBlock, ProcessDiffLine } from '../../../domain/conversation-entry'
import type { WorkspaceDiffHunk } from '../../../domain/workspace-review'
import type { LiveProcessState } from '../../../shared/desktop-api'
import { normalizeReviewPath, previousTurnMutationBlocks, processBlockPath, turnMutationBlocks } from './review-scope'

/**
 * 「本轮」审查的差异来源：Agent 的编辑流（过程块的结构化 diff），不是 Git。
 *
 * Git 口径在两种常态下对本轮无话可说——工作区不是 Git 仓库（右栏此前直接空转），
 * 以及 Agent 中途提交 / 在池工作区之外改文件（工作树相对 HEAD 归零或根本看不见）。
 * 而 Cursor 编辑流的每一次 edit / write 都带着逐行差异经 hook 进了过程块：这里把
 * 本轮的改动块按文件聚合、按 `@@` 分隔切成 hunk，右栏用与 Git 差异同一套行渲染展示。
 * 这就是 Cursor 原生「Review changes」的口径：看 Agent 改了什么，而不是仓库差了什么。
 *
 * 行号是编辑发生那一刻的行号：后一次编辑会让前一次的行号过时，各次差异之间不做合并
 *（合并需要基线文件内容，编辑流里没有）——逐次呈现本身就是事实，卡片头写明第几次。
 */
export interface TurnReviewEdit {
  blockId: string
  /** 编辑动词：edit（改）/ write（写入 / 新建）/ delete（删除）。 */
  action: 'edit' | 'write' | 'delete'
  /** hook 的紧凑提示（`+18 −20`），没有结构化 diff 时它是唯一的量化线索。 */
  hint?: string
  hunks: WorkspaceDiffHunk[]
  /** 传输上限截断的行数（如实披露，与过程卡一致）。 */
  truncatedLineCount?: number
  running: boolean
  failed: boolean
}

function editAction(block: Extract<ProcessBlock, { kind: 'tool' }>): TurnReviewEdit['action'] {
  if (block.toolCase === 'deleteToolCall' || /delete/i.test(block.toolName)) return 'delete'
  if (block.toolKind === 'write') return 'write'
  return 'edit'
}

/** 过程块的结构化 diff → 审查页的 hunk 形态（`@@` 行开新块，块外前导行归入一个无头块）。 */
export function processDiffHunks(lines: readonly ProcessDiffLine[]): WorkspaceDiffHunk[] {
  const hunks: WorkspaceDiffHunk[] = []
  let current: WorkspaceDiffHunk | undefined
  for (const line of lines) {
    if (line.type === 'hunk') {
      current = { header: line.text, lines: [], skippedBefore: 0 }
      hunks.push(current)
      continue
    }
    if (!current) {
      current = { header: '', lines: [], skippedBefore: 0 }
      hunks.push(current)
    }
    current.lines.push({
      kind: line.type === 'added' ? 'addition' : line.type === 'removed' ? 'deletion' : 'context',
      text: line.text,
      ...(line.oldLine !== undefined ? { oldLine: line.oldLine } : {}),
      ...(line.newLine !== undefined ? { newLine: line.newLine } : {})
    })
  }
  // 只有 `@@` 头没有内容行的块不值得渲染（流截断可能让最后一个头悬空）。
  return hunks.filter((hunk) => hunk.lines.length > 0)
}

/**
 * 本轮（或被文件栏保住的上一轮）的编辑，按归一路径聚合、保持块的时间顺序。
 * 文件列表与计数由 `turn-files-view` 给出（栏、名册与右栏同一来源）；这里只补每个文件的差异明细。
 */
export function turnReviewEditsByPath(
  scope: 'turn' | 'previous',
  entries: readonly ConversationEntry[],
  liveProcess: LiveProcessState | undefined,
  workspacePath?: string
): ReadonlyMap<string, TurnReviewEdit[]> {
  const blocks = scope === 'previous' ? previousTurnMutationBlocks(entries) : turnMutationBlocks(entries, liveProcess)
  const edits = new Map<string, TurnReviewEdit[]>()
  for (const block of blocks) {
    if (block.kind !== 'tool') continue
    const raw = processBlockPath(block)
    if (!raw) continue
    const path = normalizeReviewPath(raw, workspacePath)
    if (!path) continue
    const edit: TurnReviewEdit = {
      blockId: block.id,
      action: editAction(block),
      hint: block.hint,
      hunks: block.diff ? processDiffHunks(block.diff.lines) : [],
      ...(block.diff?.truncatedLineCount ? { truncatedLineCount: block.diff.truncatedLineCount } : {}),
      running: block.status === 'running',
      failed: block.status === 'failed'
    }
    const list = edits.get(path)
    if (list) list.push(edit)
    else edits.set(path, [edit])
  }
  return edits
}
