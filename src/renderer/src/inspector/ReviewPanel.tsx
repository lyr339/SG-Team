import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  WorkspaceDiffHunk,
  WorkspaceReviewAction,
  WorkspaceReviewFileDiff,
  WorkspaceReviewFileStatus,
  WorkspaceReviewFileSummary,
  WorkspaceReviewScope,
  WorkspaceReviewSummary
} from '../../../domain/workspace-review'
import { fileActionAvailability, hunkActionAvailability } from '../../../domain/workspace-review'
import { FileTypeIcon } from '../FileTypeIcon'
import { fileIconKind } from '../file-type'
import { describeLineCounts, turnTotalsTitle, type TurnFileView, type TurnFilesView } from '../turn-files-view'
import { RefreshIcon } from '../UiIcons'
import { Collapsible } from './Collapsible'
import { inspectorDesktopApi } from './desktop-api'
import { hunkInlineSegments, type InlineSegment } from './inline-diff'
import { ChevronIcon, CollapseAllIcon, CopyIcon, DiffIcon, ExpandAllIcon, FolderIcon, OpenExternalIcon, QuoteIcon, RevertIcon, StageIcon, UnstageIcon } from './InspectorIcons'
import { InspectorSkeleton, InspectorState, InspectorToast, useTransientFeedback } from './InspectorState'
import { cssEscape } from './reveal-bus'
import { subscribeReviewFocus } from './review-focus-bus'
import { fileTouchedBy, filterSummaryToPaths, reviewPathsMatch, type ReviewScopeId } from './review-scope'
import type { TurnReviewEdit } from './turn-review-view'
import { useWorkspaceFileActions } from './use-workspace-file-actions'

export interface ReviewPanelProps {
  /** 工作区身份变化时重置全部状态。 */
  workspaceKey: string
  /** 本轮（最近一条已投递用户消息之后）改动过的路径；其他范围的「本轮」徽标据此标注。 */
  turnPaths: readonly string[]
  /**
   * 「本轮」范围的文件列表与计数：与输入区上方的本轮文件栏同一份视图（`buildTurnFilesView`），
   * 三处（名册 / 栏 / 右栏）永远一致。缺省时「本轮」退回旧行为（按 turnPaths 过滤 Git 摘要）。
   */
  turnFiles?: TurnFilesView
  /** 每个文件在本轮（或被保住的上一轮）的逐次编辑差异（Cursor 编辑流）。 */
  turnEdits?: ReadonlyMap<string, TurnReviewEdit[]>
  /** 把一段引用写进输入框（反馈给 Agent）。缺省不显示该动作。 */
  onQuote?: (text: string) => void
  /** 摘要更新回调（供产物面板复用同一份数据，不重复拉取）。 */
  onSummary?: (summary: WorkspaceReviewSummary | undefined) => void
  /**
   * 右栏收起但仍挂载：停掉兜底轮询，主进程推送只记一个「待刷新」标记；
   * 重新展开时补拉一次。展开状态与已加载的差异原样保留。
   */
  paused?: boolean
  /** 测试注入：轮询间隔。 */
  pollIntervalMs?: { live: number; fallback: number }
}

const STATUS_TITLES: Record<WorkspaceReviewFileStatus, string> = {
  modified: '已修改',
  added: '新增',
  deleted: '已删除',
  renamed: '已重命名',
  untracked: '未跟踪',
  conflicted: '有冲突'
}

const SCOPE_ORDER: ReviewScopeId[] = ['turn', 'uncommitted', 'branch']
const SCOPE_TITLES: Record<ReviewScopeId, string> = {
  uncommitted: '工作树相对 HEAD 的全部未提交变更',
  turn: '本轮 Agent 的逐次编辑（来自 Cursor 编辑流，不依赖 Git）',
  branch: '当前分支相对基线分支的全部变更（含已提交）'
}

const EDIT_ACTION_LABELS: Record<TurnReviewEdit['action'], string> = {
  edit: '编辑',
  write: '写入',
  delete: '删除'
}
const SCOPE_STORAGE_KEY = 'sg-team.inspector:review-scope:v2'
const DEFAULT_POLL = { live: 15_000, fallback: 2_000 }
const KEYBOARD_HINT = 'j / k 切换文件 · n / p 切换代码块'
const SCOPE_DISPLAY: Record<ReviewScopeId, string> = {
  turn: 'Last Turn', uncommitted: 'Uncommitted', branch: 'Branch'
}

function readStoredScope(): ReviewScopeId {
  try {
    const stored = localStorage.getItem(SCOPE_STORAGE_KEY)
    return SCOPE_ORDER.includes(stored as ReviewScopeId) ? stored as ReviewScopeId : 'turn'
  } catch {
    return 'turn'
  }
}

function gitScopeOf(scope: ReviewScopeId): WorkspaceReviewScope {
  return scope === 'branch' ? 'branch' : 'uncommitted'
}

/**
 * 路径拆成目录 / 文件名主干 / 扩展名三段：目录从头部截断，主干从尾部截断，扩展名永不截断——
 * 窄栏里 `workspace-inspector…` 会变成 `workspace-insp….css`，类型信息不丢。
 * 点开头的隐藏文件（.gitignore）与无扩展名文件整体视为主干。
 */
export function splitPath(path: string): { dir: string; stem: string; ext: string } {
  const index = path.lastIndexOf('/')
  const dir = index < 0 ? '' : path.slice(0, index + 1)
  const name = index < 0 ? path : path.slice(index + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { dir, stem: name, ext: '' }
  return { dir, stem: name.slice(0, dot), ext: name.slice(dot) }
}

function hunkLineRange(hunk: WorkspaceDiffHunk): { from: number; to: number } | undefined {
  const numbers = hunk.lines
    .map((line) => line.newLine ?? line.oldLine)
    .filter((value): value is number => typeof value === 'number')
  if (!numbers.length) return undefined
  return { from: Math.min(...numbers), to: Math.max(...numbers) }
}

/** 引用一个 hunk 给 Agent：路径 + 行区间 + diff 代码块，用户在后面补一句话。 */
export function buildHunkQuote(path: string, hunk: WorkspaceDiffHunk): string {
  const range = hunkLineRange(hunk)
  const where = range ? (range.from === range.to ? `L${range.from}` : `L${range.from}–L${range.to}`) : ''
  const body = hunk.lines
    .filter((line) => line.kind !== 'meta')
    .map((line) => `${line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '}${line.text}`)
    .slice(0, 120)
  return [`> 关于 \`${path}\`${where ? ` ${where}` : ''}：`, '', '```diff', hunk.header, ...body, '```', ''].join('\n')
}

export function buildFileQuote(file: WorkspaceReviewFileSummary): string {
  const counts = file.binary ? '二进制' : `+${file.additions ?? 0} −${file.deletions ?? 0}`
  return `> 关于 \`${file.path}\`（${STATUS_TITLES[file.status]} · ${counts}）：\n\n`
}

/** 「本轮」行的引用：没有 Git 状态可说，说的是这一轮的编辑次数与行数。 */
export function buildTurnFileQuote(file: TurnFileView, editCount: number): string {
  return `> 关于 \`${file.path}\`（本轮 ${editCount} 次编辑 · ${describeLineCounts(file.additions, file.deletions, file.binary)}）：\n\n`
}

function InlineText({ text, segments }: { text: string; segments?: InlineSegment[] }): React.JSX.Element {
  if (!segments) return <>{text}</>
  return <>{segments.map((segment, index) => segment.changed ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>)}</>
}

interface HunkViewProps {
  path: string
  hunk: WorkspaceDiffHunk
  index: number
  actions: { stage: boolean; unstage: boolean; revert: boolean }
  onQuote?: (text: string) => void
  onAction: (action: WorkspaceReviewAction, hunkHeader: string) => void
}

const HunkView = memo(function HunkView({ path, hunk, index, actions, onQuote, onAction }: HunkViewProps): React.JSX.Element {
  const segments = useMemo(() => hunkInlineSegments(hunk.lines), [hunk.lines])
  const range = hunkLineRange(hunk)
  return (
    <div className="review-hunk" data-hunk-index={index}>
      {hunk.skippedBefore > 0 ? <div className="review-hunk__skipped">{hunk.skippedBefore} 行未修改</div> : null}
      <div className="review-hunk__header" tabIndex={-1}>
        <code>{hunk.header}</code>
        <span className="review-hunk__actions">
                  {onQuote ? <button type="button" title="把这段差异引用到输入框，向 Agent 提问或要求修改" aria-label="反馈这段差异给 Agent" onClick={() => onQuote(buildHunkQuote(path, hunk))}><QuoteIcon /></button> : null}
          {actions.stage ? <button type="button" title="暂存这个代码块" aria-label={`暂存代码块 ${range ? `L${range.from}` : index + 1}`} onClick={() => onAction('stage', hunk.header)}><StageIcon /></button> : null}
          {actions.unstage ? <button type="button" title="取消暂存这个代码块" aria-label={`取消暂存代码块 ${range ? `L${range.from}` : index + 1}`} onClick={() => onAction('unstage', hunk.header)}><UnstageIcon /></button> : null}
          {actions.revert ? <button type="button" className="is-danger" title="撤销这个代码块的改动（不可恢复）" aria-label={`撤销代码块 ${range ? `L${range.from}` : index + 1}`} onClick={() => onAction('revert', hunk.header)}><RevertIcon /></button> : null}
        </span>
      </div>
      {hunk.lines.map((line, lineIndex) => (
        <div className={`review-line is-${line.kind}`} key={`${index}:${lineIndex}`}>
          <span>{line.oldLine ?? ''}</span>
          <span>{line.newLine ?? ''}</span>
          <pre><i>{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '}</i><InlineText text={line.text} segments={segments[lineIndex]} /></pre>
        </div>
      ))}
    </div>
  )
})

function FileDiffView({ path, diff, actions, onQuote, onAction }: {
  path: string
  diff: WorkspaceReviewFileDiff
  actions: { stage: boolean; unstage: boolean; revert: boolean }
  onQuote?: (text: string) => void
  onAction: (action: WorkspaceReviewAction, hunkHeader: string) => void
}): React.JSX.Element {
  if (diff.state === 'binary') return <p className="review-file__empty">二进制文件已变化</p>
  if (diff.state === 'missing' || diff.state === 'error') {
    return <p className="review-file__empty is-error">{diff.detail || '差异读取失败'}</p>
  }
  if (!diff.hunks.length) return <p className="review-file__empty">文件状态已变化，当前没有可展示的文本差异</p>
  return (
    <div className="review-diff">
      {diff.hunks.map((hunk, index) => (
        <HunkView key={`${path}:${hunk.header}:${index}`} path={path} hunk={hunk} index={index} actions={actions} onQuote={onQuote} onAction={onAction} />
      ))}
      {diff.truncated ? <div className="review-diff__truncated">差异过长，已显示前 4,000 行</div> : null}
    </div>
  )
}

/** 编辑流的 hunk 不对应 Git 的补丁头：按块暂存 / 撤销在「本轮」视图不可用，引用照常。 */
const NO_HUNK_ACTIONS = { stage: false, unstage: false, revert: false }
const noHunkAction = (): void => {}

/**
 * 一个文件在本轮的逐次编辑（Cursor 编辑流）。每次编辑一张卡：动作、hook 行数提示、
 * 逐行差异（与 Git 差异同一套行渲染）。多次编辑不合并——行号是各次编辑当时的行号，
 * 合并需要基线文件内容，编辑流里没有；逐次呈现本身就是事实。
 */
function TurnEditsView({ path, edits, onQuote }: {
  path: string
  edits: readonly TurnReviewEdit[]
  onQuote?: (text: string) => void
}): React.JSX.Element {
  if (!edits.length) {
    return <p className="review-file__empty">这一轮没有留下该文件的编辑记录</p>
  }
  return (
    <div className="review-diff">
      {edits.map((edit, index) => (
        <section key={edit.blockId} className={`review-edit${edit.running ? ' is-running' : ''}${edit.failed ? ' is-failed' : ''}`}>
          <div className="review-edit__head">
            <b>第 {index + 1} 次</b>
            <span>{EDIT_ACTION_LABELS[edit.action]}</span>
            {edit.hint ? <code>{edit.hint}</code> : null}
            {edit.running ? <em className="is-running">进行中…</em> : null}
            {edit.failed ? <em className="is-failed">失败</em> : null}
          </div>
          {edit.hunks.length ? (
            edit.hunks.map((hunk, hunkIndex) => (
              <HunkView key={`${edit.blockId}:${hunkIndex}`} path={path} hunk={hunk} index={hunkIndex} actions={NO_HUNK_ACTIONS} onQuote={onQuote} onAction={noHunkAction} />
            ))
          ) : (
            <p className="review-file__empty">{edit.running ? '正在写入，差异稍后出现…' : '这次操作没有逐行差异记录'}</p>
          )}
          {edit.truncatedLineCount ? <div className="review-diff__truncated">差异过长，传输截断了 {edit.truncatedLineCount} 行</div> : null}
        </section>
      ))}
      {edits.length > 1 ? <p className="review-diff__footnote">多次编辑按发生顺序逐次展示；行号是各次编辑当时的行号，不做跨次合并。</p> : null}
    </div>
  )
}

interface PendingConfirm {
  path: string
  hunkHeader?: string
  label: string
}

/**
 * 撤销确认：锚在所属文件行下方的浮层，不挤开列表；Esc 或「取消」关闭，
 * 焦点落在确认按钮上，回车即确认。
 */
function RevertConfirm({ confirm, onCancel, onConfirm }: { confirm: PendingConfirm; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  return (
    <div className="inspector-confirm" role="alertdialog" aria-label="确认撤销" onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCancel()
      }
    }}>
      <p>{confirm.label}</p>
      <div>
        <button type="button" className="is-secondary" onClick={onCancel}>取消</button>
        <button type="button" className="is-danger" autoFocus onClick={onConfirm}>确认撤销</button>
      </div>
    </div>
  )
}

/** 以 `.is-revealed` 短暂高亮一个元素（与时间线定位同一视觉语言）。 */
function flashElement(element: HTMLElement): void {
  element.classList.add('is-revealed')
  window.setTimeout(() => element.classList.remove('is-revealed'), 1_400)
}

function ReviewScopePicker({ scope, turnCount, onChange }: {
  scope: ReviewScopeId
  turnCount: number
  onChange: (scope: ReviewScopeId) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  useEffect(() => { if (open) menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus() }, [open])
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])
  const close = (): void => { setOpen(false); triggerRef.current?.focus() }
  return (
    <div className="inspector-review__scope" ref={rootRef} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false)
    }}>
      <button ref={triggerRef} type="button" className="inspector-review__scope-trigger"
        aria-label={`审查范围：${SCOPE_DISPLAY[scope]}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        title={SCOPE_TITLES[scope]} onClick={() => setOpen((value) => !value)}>
        <span>{SCOPE_DISPLAY[scope]}</span>
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div className="inspector-review__scope-menu" id={menuId} role="menu" aria-label="审查范围" ref={menuRef}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
            const index = choices.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
            choices[next]?.focus()
          }}>
          {SCOPE_ORDER.map((candidate) => (
            <button key={candidate} type="button" role="menuitemradio" aria-checked={candidate === scope}
              title={SCOPE_TITLES[candidate]}
              onClick={() => { onChange(candidate); close() }}>
              <span>{SCOPE_DISPLAY[candidate]}</span>
              {candidate === 'turn' && turnCount > 0 ? <small>{turnCount}</small> : null}
              {candidate === scope ? <span className="inspector-review__scope-check" aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ReviewPanel({ workspaceKey, turnPaths, turnFiles, turnEdits, onQuote, onSummary, paused = false, pollIntervalMs = DEFAULT_POLL }: ReviewPanelProps): React.JSX.Element {
  const [scope, setScope] = useState<ReviewScopeId>(readStoredScope)
  /** 「本轮」走 Agent 编辑流（有 turnFiles 才启用；预览 / 旧调用方退回 Git 过滤）。 */
  const turnActive = scope === 'turn' && turnFiles !== undefined
  const [summary, setSummary] = useState<WorkspaceReviewSummary>()
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [diffs, setDiffs] = useState<Record<string, WorkspaceReviewFileDiff | 'loading'>>({})
  const [confirm, setConfirm] = useState<PendingConfirm>()
  const [busyPath, setBusyPath] = useState('')
  /** 中栏文件栏点进来要定位的文件；摘要里出现它时展开并滚到它，随后清空。 */
  const [focusPath, setFocusPath] = useState('')
  /** 定位后短暂高亮的文件：走 React 状态而不是直接改 class——同一提交里 className 会被重新赋值，手改的类名会被冲掉。 */
  const [revealedPath, setRevealedPath] = useState('')
  const revealTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (revealTimer.current) window.clearTimeout(revealTimer.current)
  }, [])
  const [feedback, flash] = useTransientFeedback()
  const fileActions = useWorkspaceFileActions(flash)
  const requestId = useRef(0)
  const summaryInFlight = useRef(false)
  const revisionRef = useRef('')
  const initializedWorkspace = useRef('')
  const turnInitializedRef = useRef('')
  const listRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)
  /** 收起期间收到过主进程推送：展开时补拉。 */
  const refreshWhenResumed = useRef(false)

  useEffect(() => {
    try { localStorage.setItem(SCOPE_STORAGE_KEY, scope) } catch { /* 当前窗口仍保持选择。 */ }
  }, [scope])

  // 非 Git 工程：得知 not_git 的那一刻把范围落到「本轮」——Git 两档在这种工程里没有内容，
  // 编辑流才有话说。每个工作区只自动切一次，之后用户的手动选择（包括切回去看提示卡）不再被覆盖。
  const autoTurnedRef = useRef('')
  useEffect(() => {
    if (autoTurnedRef.current === workspaceKey) return
    if (summary?.state !== 'not_git' || turnFiles === undefined) return
    autoTurnedRef.current = workspaceKey
    setScope('turn')
  }, [summary?.state, turnFiles, workspaceKey])

  const loadSummary = useCallback(async (showBusy = false): Promise<void> => {
    if (summaryInFlight.current) return
    summaryInFlight.current = true
    const id = ++requestId.current
    if (showBusy) setRefreshing(true)
    try {
      const api = inspectorDesktopApi()
      if (!api?.getWorkspaceReview) throw new Error('当前环境没有桌面 API，无法读取工作区变更')
      const next = await api.getWorkspaceReview({ scope: gitScopeOf(scope) })
      if (id !== requestId.current) return
      // IPC 返回空值（主进程尚未注册该通道 / 预览环境未 mock）按读取失败处理，不让空对象进入投影。
      if (!next || typeof next !== 'object' || typeof next.state !== 'string') throw new Error('工作区变更摘要不可用')
      setError('')
      setSummary((current) => current?.revision === next.revision && current.state === next.state && current.scope === next.scope
        ? { ...current, updatedAt: next.updatedAt, detail: next.detail, liveUpdates: next.liveUpdates, headCommit: next.headCommit }
        : next)
    } catch (reason) {
      if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (id === requestId.current && showBusy) setRefreshing(false)
      summaryInFlight.current = false
    }
  }, [scope])

  /**
   * 读取单文件差异。`keepStale`（revision 刷新时）让旧差异留在屏幕上直到新差异到达——
   * Agent 连续写文件时监听会高频推送，若每次都先切回骨架屏，已展开的差异会不停闪动。
   * 首次展开没有旧差异，仍显示骨架。
   */
  const loadDiff = useCallback(async (path: string, revision: string, options: { keepStale?: boolean } = {}): Promise<void> => {
    setDiffs((current) => (
      options.keepStale && current[path] !== undefined && current[path] !== 'loading'
        ? current
        : { ...current, [path]: 'loading' }
    ))
    try {
      const api = inspectorDesktopApi()
      if (!api?.getWorkspaceReviewFile) throw new Error('当前环境没有桌面 API')
      const diff = await api.getWorkspaceReviewFile({ path, scope: gitScopeOf(scope) })
      if (revisionRef.current !== revision) return
      setDiffs((current) => ({ ...current, [path]: diff }))
    } catch (reason) {
      if (revisionRef.current !== revision) return
      setDiffs((current) => ({
        ...current,
        [path]: { state: 'error', path, hunks: [], truncated: false, detail: reason instanceof Error ? reason.message : String(reason) }
      }))
    }
  }, [scope])

  // 工作区 / 范围切换：清空并重新拉取；订阅主进程推送；兜底轮询频率随监听状态调整。
  useEffect(() => {
    requestId.current += 1
    summaryInFlight.current = false
    revisionRef.current = ''
    initializedWorkspace.current = ''
    turnInitializedRef.current = ''
    setSummary(undefined)
    setError('')
    setExpanded(new Set())
    setDiffs({})
    setConfirm(undefined)
    void loadSummary()
    const unsubscribe = inspectorDesktopApi()?.onWorkspaceReviewChanged?.(() => {
      if (pausedRef.current) refreshWhenResumed.current = true
      else void loadSummary()
    }) ?? (() => {})
    return () => {
      requestId.current += 1
      summaryInFlight.current = false
      unsubscribe()
    }
  }, [loadSummary, workspaceKey])

  // 收起 → 展开：补拉一次（收起期间的推送只记了标记，兜底轮询也停了）。
  useEffect(() => {
    const wasPaused = pausedRef.current
    pausedRef.current = paused
    if (paused || !wasPaused) return
    refreshWhenResumed.current = false
    void loadSummary()
  }, [loadSummary, paused])

  const liveUpdates = summary?.liveUpdates === true
  useEffect(() => {
    if (paused) return
    const interval = liveUpdates ? pollIntervalMs.live : pollIntervalMs.fallback
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadSummary()
    }, interval)
    return () => window.clearInterval(timer)
  }, [liveUpdates, loadSummary, paused, pollIntervalMs.fallback, pollIntervalMs.live])

  const visible = useMemo(() => (
    summary && scope === 'turn' && !turnActive ? filterSummaryToPaths(summary, turnPaths) : summary
  ), [scope, summary, turnActive, turnPaths])

  useEffect(() => {
    onSummary?.(summary)
  }, [onSummary, summary])

  // 中栏文件栏的「审查」/ 点某一行：范围切到请求的范围（缺省「本轮」——栏与「本轮」视图
  // 同一份数据，栏保住上一轮时这里同样保住），带路径时记下待定位的文件。
  useEffect(() => subscribeReviewFocus((request) => {
    setScope(request.scope ?? 'turn')
    setFocusPath(request.path ?? '')
  }), [])

  // revision 变化 → 已展开文件的差异就地重拉（旧差异保留到新差异到达），
  // 不再出现在摘要里的文件才丢缓存；首次加载默认展开第一个文件（「本轮」在 Agent 编辑流上时
  // 不做这次整份重设——它有自己的列表，Git 摘要迟到不该重排用户已展开的内容）。
  useEffect(() => {
    if (!visible?.revision || visible.state !== 'ready') return
    const revisionChanged = revisionRef.current !== visible.revision
    const firstForWorkspace = initializedWorkspace.current !== workspaceKey && !turnActive
    if (!revisionChanged && !firstForWorkspace) return
    revisionRef.current = visible.revision
    // 「本轮」在编辑流上：列表与差异都不来自 Git，摘要刷新不该预拉 Git 差异，
    // 更不该按 Git 的文件清单清洗展开集合与缓存。
    if (turnActive) return
    let open = expanded
    if (firstForWorkspace) {
      initializedWorkspace.current = workspaceKey
      open = visible.files[0] ? new Set([visible.files[0].path]) : new Set()
      setExpanded(open)
    }
    // 只有正展开着的文件才值得保留旧差异（避免闪动）；收起的文件下次展开时重新读取。
    const listed = new Set(visible.files.map((file) => file.path))
    setDiffs((current) => {
      const kept = Object.entries(current).filter(([path]) => listed.has(path) && open.has(path))
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
    })
    for (const file of visible.files) {
      if (open.has(file.path)) void loadDiff(file.path, visible.revision, { keepStale: true })
    }
  }, [expanded, loadDiff, turnActive, visible, workspaceKey])

  // 「本轮」首次有列表：默认展开第一个文件（与 Git 口径的首载一致）。只做一次，
  // 用户收起全部后不再强行展开；带定位请求进来时目标文件由定位效果叠加展开。
  useEffect(() => {
    if (!turnActive || !turnFiles?.files.length) return
    if (turnInitializedRef.current === workspaceKey) return
    turnInitializedRef.current = workspaceKey
    setExpanded((current) => current.size ? current : new Set([turnFiles.files[0]!.path]))
  }, [turnActive, turnFiles, workspaceKey])

  /** 定位一个已在列表里的文件：展开、滚到它并短暂高亮。 */
  const revealFile = useCallback((path: string): void => {
    setFocusPath('')
    setExpanded((current) => current.has(path) ? current : new Set([...current, path]))
    setRevealedPath(path)
    if (revealTimer.current) window.clearTimeout(revealTimer.current)
    revealTimer.current = window.setTimeout(() => setRevealedPath(''), 1_400)
    const target = listRef.current?.querySelector<HTMLElement>(`.review-file[data-path="${cssEscape(path)}"]`)
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' })
  }, [])

  // 待定位的文件出现在列表里：展开、（Git 口径时）读差异、滚到它并短暂高亮。
  // 「本轮」在 Agent 编辑流上时列表即时可得，不等 Git 摘要。
  // 放在上面的首载效果之后：首载会整份重设展开集合，这里用函数式更新叠加在它之上。
  useEffect(() => {
    if (!focusPath) return
    if (turnActive && turnFiles) {
      const file = turnFiles.files.find((candidate) => reviewPathsMatch(candidate.path, focusPath))
      if (file) revealFile(file.path)
      return
    }
    if (visible?.state !== 'ready') return
    const file = visible.files.find((candidate) => fileTouchedBy(candidate, [focusPath]))
    if (!file) return
    if (diffs[file.path] === undefined) void loadDiff(file.path, visible.revision)
    revealFile(file.path)
  }, [diffs, focusPath, loadDiff, revealFile, turnActive, turnFiles, visible])

  const ensureDiff = (path: string): void => {
    if (visible && diffs[path] === undefined) void loadDiff(path, visible.revision)
  }

  const toggleFile = (file: WorkspaceReviewFileSummary): void => {
    const next = new Set(expanded)
    if (next.has(file.path)) next.delete(file.path)
    else {
      next.add(file.path)
      ensureDiff(file.path)
    }
    setExpanded(next)
  }

  /** 「本轮」行的展开收起：差异在内存里（编辑流），不触发任何 Git 读取。 */
  const toggleTurnFile = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const files = visible?.state === 'ready' ? visible.files : []
  const turnList = turnActive && turnFiles ? turnFiles.files : []
  const listPaths = turnActive ? turnList.map((file) => file.path) : files.map((file) => file.path)
  const allExpanded = listPaths.length > 0 && listPaths.every((path) => expanded.has(path))
  const toggleAll = (): void => {
    if (allExpanded) {
      setExpanded(new Set())
      return
    }
    if (!turnActive) for (const file of files) ensureDiff(file.path)
    setExpanded(new Set(listPaths))
  }

  /** 「本轮」行的 Git 侧影（就绪时）：状态字母、暂存 / 撤销的可用性都从这里来；Git 看不见的文件没有这些。 */
  const gitFileFor = (path: string): WorkspaceReviewFileSummary | undefined => (
    summary?.state === 'ready' ? summary.files.find((file) => fileTouchedBy(file, [path])) : undefined
  )

  const runAction = async (path: string, action: WorkspaceReviewAction, hunkHeader?: string): Promise<void> => {
    setBusyPath(path)
    try {
      const api = inspectorDesktopApi()
      if (!api?.applyWorkspaceReviewAction) throw new Error('当前环境不支持 Git 操作')
      const result = await api.applyWorkspaceReviewAction({ path, action, ...(hunkHeader ? { hunkHeader } : {}) })
      flash(result.message)
      if (result.ok) void loadSummary()
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyPath('')
    }
  }

  const requestAction = (file: WorkspaceReviewFileSummary, action: WorkspaceReviewAction, hunkHeader?: string): void => {
    if (action === 'revert') {
      const inHead = !(file.status === 'untracked' || file.status === 'added')
      setConfirm({
        path: file.path,
        hunkHeader,
        label: hunkHeader
          ? `撤销 ${file.path} 中这个代码块的改动？该操作直接改写工作树文件，无法从拾光恢复。`
          : inHead
            ? `撤销 ${file.path} 的全部未提交改动？文件会恢复到 HEAD 版本，无法从拾光恢复。`
            : `${file.path} 尚未进入任何提交。撤销会把它移到系统回收站。`
      })
      return
    }
    void runAction(file.path, action, hunkHeader)
  }

  // j / k 在文件间移动焦点；n / p 在已展开的代码块间跳转（滚动到块头并短暂高亮）。
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    const list = listRef.current
    if (!list) return
    if (event.key === 'j' || event.key === 'k') {
      const heads = Array.from(list.querySelectorAll<HTMLButtonElement>('.review-file__head'))
      if (!heads.length) return
      const index = heads.findIndex((head) => head === document.activeElement || head.contains(document.activeElement))
      const next = event.key === 'j' ? Math.min(heads.length - 1, index + 1) : Math.max(0, index - 1)
      event.preventDefault()
      heads[next]?.focus()
      heads[next]?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (event.key === 'n' || event.key === 'p') {
      const headers = Array.from(list.querySelectorAll<HTMLElement>('.inspector-collapsible.is-open .review-hunk__header'))
      if (!headers.length) return
      // 以列表视口上沿为基准：n 找第一个还在下方的块头，p 找最后一个已在上方的块头。
      const top = list.getBoundingClientRect().top + 48
      const offsets = headers.map((header) => header.getBoundingClientRect().top - top)
      const index = event.key === 'n'
        ? offsets.findIndex((offset) => offset > 8)
        : offsets.reduce((found, offset, candidate) => offset < -8 ? candidate : found, -1)
      const next = headers[index < 0 ? (event.key === 'n' ? headers.length - 1 : 0) : index]
      if (!next) return
      event.preventDefault()
      next.scrollIntoView({ block: 'start' })
      next.focus({ preventScroll: true })
      flashElement(next)
    }
  }

  const branch = summary?.branch
  const branchLabel = branch
    ? branch.base && !branch.onBase ? `${branch.current} → ${branch.base}` : branch.current
    : ''
  const highlightTurn = scope !== 'turn' && turnPaths.length > 0
  /** 「本轮」按钮上的计数：编辑流视图给出后以它为准（含保住的上一轮），否则退回路径集合。 */
  const turnCount = turnFiles ? turnFiles.files.length : turnPaths.length

  return (
    <section className="inspector-review" aria-label="工作区代码审查">
      <header className="inspector-review__summary">
        <ReviewScopePicker scope={scope} turnCount={turnCount} onChange={setScope} />
        <div
          className="inspector-review__totals"
          title={turnActive && turnList.length && turnFiles ? turnTotalsTitle(turnFiles) : undefined}
          aria-label={turnActive
            ? (turnList.length && turnFiles ? `新增 ${turnFiles.additions} 行，删除 ${turnFiles.deletions} 行${turnFiles.estimated ? '（估算）' : ''}` : undefined)
            : visible?.state === 'ready' ? `新增 ${visible.additions} 行，删除 ${visible.deletions} 行` : undefined}
        >
          {/* 只有真有变更时才显示合计；干净 / 出错态的 +0 −0 是噪音。「本轮」的合计与文件栏 / 名册同源。 */}
          {turnActive
            ? (turnList.length && turnFiles
              ? <>{turnFiles.estimated ? <small aria-hidden="true">≈</small> : null}<b>+{turnFiles.additions}</b><em>−{turnFiles.deletions}</em></>
              : null)
            : visible?.state === 'ready' ? <><b>+{visible.additions}</b><em>−{visible.deletions}</em></> : null}
        </div>
        <div className="inspector-review__toolbar" role="group" aria-label="审查操作">
          {listPaths.length > 1 ? <button type="button" className="inspector-icon-button" aria-label={allExpanded ? '收起全部文件' : '展开全部文件'} title={`${allExpanded ? '收起全部' : '展开全部'} · ${KEYBOARD_HINT}`} onClick={toggleAll}>
            {allExpanded ? <CollapseAllIcon /> : <ExpandAllIcon />}
          </button> : null}
          <button type="button" className={`inspector-icon-button${refreshing ? ' is-spinning' : ''}`} aria-label="刷新工作区变更" title={liveUpdates ? '正在实时监听工作区；点击立即刷新' : '刷新'} onClick={() => void loadSummary(true)}>
            <RefreshIcon />
          </button>
        </div>
      </header>
      {scope !== 'turn' && branchLabel ? <div className="inspector-review__meta" title={branch?.base ? `基线分支：${branch.base}` : '当前分支'}>
        <code className="inspector-review__branch">{branchLabel}</code>
        <span className="inspector-review__count">{listPaths.length} 个文件</span>
      </div> : null}

      {/* Git 侧的错误 / 骨架 / 干净 / 不可用只在 Git 口径下出现：「本轮」的内容来自编辑流，Git 的状态与它无关。 */}
      {error && !turnActive ? <InspectorState tone="error" title="读取工作区变更失败" hint={error} compact /> : null}
      {!summary && !error && !turnActive ? <InspectorSkeleton rows={4} /> : null}
      {!turnActive && visible?.state === 'clean' ? (
        <InspectorState
          icon={<DiffIcon />}
          title={scope === 'turn' ? '本轮尚未修改文件' : scope === 'branch' ? '分支相对基线没有变更' : '工作区干净'}
          hint={scope === 'turn'
            ? 'Agent 在这一轮里执行的 edit / write 会让文件出现在这里'
            : summary?.headCommit
              ? <>当前没有未提交变更 · 最近提交 <code>{summary.headCommit.short}</code> {summary.headCommit.subject}</>
              : '当前没有未提交变更'}
          action={scope === 'turn'
            ? <button type="button" className="inspector-link" onClick={() => setScope('uncommitted')}>查看全部未提交变更</button>
            : undefined}
        />
      ) : null}
      {!turnActive && (summary?.state === 'not_git' || summary?.state === 'unavailable' || summary?.state === 'error') ? (
        <InspectorState
          icon={<DiffIcon />}
          tone={summary.state === 'error' ? 'error' : 'neutral'}
          title={summary.state === 'not_git' ? '当前工程未启用 Git' : summary.state === 'error' ? '读取变更出错' : '变更暂未就绪'}
          hint={summary.detail}
          action={summary.state === 'error'
            ? <button type="button" className="inspector-link" onClick={() => void loadSummary(true)}>重试</button>
            : turnFiles !== undefined
              ? <button type="button" className="inspector-link" onClick={() => setScope('turn')}>查看本轮 Agent 改动</button>
              : undefined}
        />
      ) : null}
      {!turnActive && summary?.detail && summary.state === 'ready' ? <p className="inspector-review__note">{summary.detail}</p> : null}

      {/* ——「本轮」：Agent 编辑流（不依赖 Git；列表、计数与文件栏 / 名册同一份视图）—— */}
      {turnActive && !turnList.length ? (
        <InspectorState
          icon={<DiffIcon />}
          title="本轮尚未修改文件"
          hint="Agent 这一轮执行的 edit / write 会即时出现在这里，不依赖 Git"
          action={summary?.state === 'ready'
            ? <button type="button" className="inspector-link" onClick={() => setScope('uncommitted')}>查看全部未提交变更</button>
            : undefined}
        />
      ) : null}
      {turnActive && turnList.length && turnFiles?.scope === 'previous' ? (
        <p className="inspector-review__turnnote">新一轮尚无编辑：以下是上一轮的改动，本轮第一次编辑后替换。</p>
      ) : null}
      {turnActive && turnList.length ? (
        <div className="review-files" ref={listRef} onKeyDown={onListKeyDown} title={KEYBOARD_HINT} data-turn-scope={turnFiles?.scope}>
          {turnList.map((file) => {
            const open = expanded.has(file.path)
            const edits = turnEdits?.get(file.path) ?? []
            const git = gitFileFor(file.path)
            const availability = git ? fileActionAvailability(git) : { stage: false, unstage: false, revert: false }
            const busy = git ? busyPath === git.path : false
            const confirming = git ? confirm?.path === git.path : false
            const estimated = file.source === 'process'
            const counts = describeLineCounts(file.additions, file.deletions, file.binary)
            const headTitle = [
              file.path,
              file.status ? STATUS_TITLES[file.status] : '',
              `本轮 ${edits.length} 次编辑`,
              estimated ? `${counts}（按编辑逐次累计的估算）` : `${counts}（工作树相对 HEAD）`
            ].filter(Boolean).join(' · ')
            return (
              <article className={`review-file${file.status ? ` is-${file.status}` : ''}${estimated ? ' is-estimated' : ''}${open ? ' is-open' : ''}${busy ? ' is-busy' : ''}${confirming ? ' is-confirming' : ''}${revealedPath === file.path ? ' is-revealed' : ''}`} key={file.path} data-path={file.path} data-source={file.source}>
                <div className="review-file__row">
                  <button className="review-file__head" type="button" onClick={() => toggleTurnFile(file.path)} aria-expanded={open} title={headTitle}>
                    <i className="is-type" title={file.status ? STATUS_TITLES[file.status] : undefined}><FileTypeIcon kind={file.icon} /></i>
                    <span className="review-file__path">
                      {file.dir ? <small><bdi>{file.dir}</bdi></small> : null}
                      <strong><span>{file.stem}</span>{file.ext ? <b>{file.ext}</b> : null}</strong>
                    </span>
                    <span className="review-file__counts">
                      {file.binary
                        ? <small>BIN</small>
                        : <>{estimated ? <small aria-hidden="true">≈</small> : null}<b>+{file.additions}</b><em>−{file.deletions}</em></>}
                    </span>
                    <ChevronIcon open={open} />
                  </button>
                  <span className="review-file__actions" role="group" aria-label={`${file.path} 的操作`}>
                    <span className="review-file__action-group">
                      <button type="button" title="在 Cursor 中打开" aria-label={`在编辑器中打开 ${file.path}`} onClick={() => void fileActions.openFile(file.path)}><OpenExternalIcon /></button>
                      <button type="button" title="复制路径" aria-label={`复制路径 ${file.path}`} onClick={() => void fileActions.copyPath(file.path)}><CopyIcon /></button>
                      {file.status !== 'deleted' ? <button type="button" title="在文件管理器中显示" aria-label={`在文件管理器中显示 ${file.path}`} onClick={() => void fileActions.revealFile(file.path)}><FolderIcon /></button> : null}
                      {onQuote ? <button type="button" title="引用这个文件到输入框，向 Agent 提问或要求修改" aria-label={`反馈 ${file.path} 给 Agent`} onClick={() => onQuote(buildTurnFileQuote(file, edits.length))}><QuoteIcon /></button> : null}
                    </span>
                    {git && (availability.stage || availability.unstage) ? (
                      <span className="review-file__action-group">
                        {availability.stage ? <button type="button" disabled={busy} title="暂存整个文件" aria-label={`暂存 ${file.path}`} onClick={() => requestAction(git, 'stage')}><StageIcon /></button> : null}
                        {availability.unstage ? <button type="button" disabled={busy} title="取消暂存整个文件" aria-label={`取消暂存 ${file.path}`} onClick={() => requestAction(git, 'unstage')}><UnstageIcon /></button> : null}
                      </span>
                    ) : null}
                    {git && availability.revert ? (
                      <span className="review-file__action-group">
                        <button type="button" className="is-danger" disabled={busy} title="撤销整个文件的未提交改动（Git）" aria-label={`撤销 ${file.path}`} onClick={() => requestAction(git, 'revert')}><RevertIcon /></button>
                      </span>
                    ) : null}
                  </span>
                  {confirming && confirm ? (
                    <RevertConfirm
                      confirm={confirm}
                      onCancel={() => setConfirm(undefined)}
                      onConfirm={() => {
                        const pending = confirm
                        setConfirm(undefined)
                        void runAction(pending.path, 'revert', pending.hunkHeader)
                      }}
                    />
                  ) : null}
                </div>
                <Collapsible open={open}>
                  <TurnEditsView path={file.path} edits={edits} onQuote={onQuote} />
                </Collapsible>
              </article>
            )
          })}
        </div>
      ) : null}

      {!turnActive && visible?.state === 'ready' ? (
        <div className="review-files" ref={listRef} onKeyDown={onListKeyDown} title={KEYBOARD_HINT}>
          {visible.files.map((file) => {
            const open = expanded.has(file.path)
            const diff = diffs[file.path]
            const { dir, stem, ext } = splitPath(file.path)
            const availability = fileActionAvailability(file)
            const hunkActions = scope === 'branch' ? { stage: false, unstage: false, revert: false } : hunkActionAvailability(file)
            const busy = busyPath === file.path
            const confirming = confirm?.path === file.path
            const touchedThisTurn = highlightTurn && fileTouchedBy(file, turnPaths)
            const stateLabel = file.committed ? '已提交' : file.staged && file.unstaged ? '部分暂存' : file.staged ? '已暂存' : ''
            const displayState = stateLabel || (file.status === 'modified' ? '' : STATUS_TITLES[file.status])
            const gitActions = scope !== 'branch'
            const headTitle = [
              file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
              STATUS_TITLES[file.status],
              stateLabel
            ].filter(Boolean).join(' · ')
            return (
              <article className={`review-file is-${file.status}${open ? ' is-open' : ''}${busy ? ' is-busy' : ''}${confirming ? ' is-confirming' : ''}${touchedThisTurn ? ' is-turn' : ''}${revealedPath === file.path ? ' is-revealed' : ''}`} key={file.path} data-path={file.path}>
                <div className="review-file__row">
                  <button className="review-file__head" type="button" onClick={() => toggleFile(file)} aria-expanded={open} title={headTitle}>
                    <i className="is-type" title={STATUS_TITLES[file.status]}><FileTypeIcon kind={fileIconKind(ext)} /></i>
                    <span className="review-file__path">
                      {dir ? <small><bdi>{dir}</bdi></small> : null}
                      <strong><span>{stem}</span>{ext ? <b>{ext}</b> : null}</strong>
                      {touchedThisTurn ? <em className="is-turn" title="本轮 Agent 改动过这个文件">本轮</em> : null}
                      {displayState ? <em className="review-file__state">{displayState}</em> : null}
                    </span>
                    <span className="review-file__counts">
                      {file.binary ? <small>BIN</small> : <><b>+{file.additions ?? 0}</b><em>−{file.deletions ?? 0}</em></>}
                    </span>
                    <ChevronIcon open={open} />
                  </button>
                  {/* 动作簇分三组：查看 / 引用 ｜ 暂存 ｜ 撤销（危险，独立成组）。 */}
                  <span className="review-file__actions" role="group" aria-label={`${file.path} 的操作`}>
                    <span className="review-file__action-group">
                      <button type="button" title="在 Cursor 中打开" aria-label={`在编辑器中打开 ${file.path}`} onClick={() => void fileActions.openFile(file.path)}><OpenExternalIcon /></button>
                      <button type="button" title="复制路径" aria-label={`复制路径 ${file.path}`} onClick={() => void fileActions.copyPath(file.path)}><CopyIcon /></button>
                      {file.status !== 'deleted' ? <button type="button" title="在文件管理器中显示" aria-label={`在文件管理器中显示 ${file.path}`} onClick={() => void fileActions.revealFile(file.path)}><FolderIcon /></button> : null}
                      {onQuote ? <button type="button" title="引用这个文件到输入框，向 Agent 提问或要求修改" aria-label={`反馈 ${file.path} 给 Agent`} onClick={() => onQuote(buildFileQuote(file))}><QuoteIcon /></button> : null}
                    </span>
                    {gitActions && (availability.stage || availability.unstage) ? (
                      <span className="review-file__action-group">
                        {availability.stage ? <button type="button" disabled={busy} title="暂存整个文件" aria-label={`暂存 ${file.path}`} onClick={() => requestAction(file, 'stage')}><StageIcon /></button> : null}
                        {availability.unstage ? <button type="button" disabled={busy} title="取消暂存整个文件" aria-label={`取消暂存 ${file.path}`} onClick={() => requestAction(file, 'unstage')}><UnstageIcon /></button> : null}
                      </span>
                    ) : null}
                    {gitActions && availability.revert ? (
                      <span className="review-file__action-group">
                        <button type="button" className="is-danger" disabled={busy} title="撤销整个文件的改动" aria-label={`撤销 ${file.path}`} onClick={() => requestAction(file, 'revert')}><RevertIcon /></button>
                      </span>
                    ) : null}
                  </span>
                  {confirming && confirm ? (
                    <RevertConfirm
                      confirm={confirm}
                      onCancel={() => setConfirm(undefined)}
                      onConfirm={() => {
                        const pending = confirm
                        setConfirm(undefined)
                        void runAction(pending.path, 'revert', pending.hunkHeader)
                      }}
                    />
                  ) : null}
                </div>
                <Collapsible open={open}>
                  {diff === 'loading' || diff === undefined
                    ? <div className="review-file__loading"><InspectorSkeleton rows={3} mono /></div>
                    : <FileDiffView path={file.path} diff={diff} actions={hunkActions} onQuote={onQuote} onAction={(action, hunkHeader) => requestAction(file, action, hunkHeader)} />}
                </Collapsible>
              </article>
            )
          })}
        </div>
      ) : null}
      <InspectorToast message={feedback} />
    </section>
  )
}
