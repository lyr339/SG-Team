import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProcessBlock } from '../../domain/conversation-entry'
import { MessageImage } from './AttachmentImageViewer'
import { stepDomId, subscribeReveal } from './inspector/reveal-bus'
import { MessageContent } from './MessageContent'
import { groupProcessSteps, parseFileChangeStats, type ProcessGroupVariant, type ProcessTurnGroup } from './process-step-groups'
import { StepIcon } from './process-step-icon'
import { buildProcessTurnView, type ProcessTurnStep } from './process-turn-view'
import { QuestionCard, type QuestionActions } from './QuestionCard'
import { tokenizeShellCommand } from './shell-command-tokens'
import { TodoIndicator, todoTone } from './TodoIndicator'
import { useStreamingText } from './use-streaming-text'

interface ProcessTurnCardProps {
  id: string
  blocks?: ProcessBlock[]
  startedAt?: number
  updatedAt?: number
  defaultOpen?: boolean
  compact?: boolean
  title?: string
  live?: boolean
  truncatedItemCount?: number
  /** ask_question 卡片的回答 / 跳过动作；缺省只展示、不可作答。 */
  questionActions?: QuestionActions
  /**
   * 观看者（会话视图）挂载那一刻已存在的过程块 id：这些块的正文落位不重播。
   * 不传则退化为"卡片挂载时已存在的步骤"——但直播卡是在首个块到达时才挂载的，
   * 这个退化判据会把观看者眼前到达的第一帧当成历史，所以会话视图应显式传入。
   */
  hydratedBlockIds?: ReadonlySet<string>
}

function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return ''
  if (milliseconds < 1_000) return `${Math.max(0.1, milliseconds / 1_000).toFixed(1)}s`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1_000)
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/** 组头图标：按组语义取与成员工具同一套图标（探索=搜索、命令=终端、编辑=笔、思考=灯泡、浏览器、等待=时钟）。 */
function GroupIcon({ variant }: { variant: ProcessGroupVariant }): React.JSX.Element {
  if (variant === 'thought') return <StepIcon kind="thinking" />
  if (variant === 'commands') return <StepIcon kind="command" />
  if (variant === 'edits') return <StepIcon kind="edit" />
  if (variant === 'browser') return <StepIcon kind="browser" />
  if (variant === 'waiting') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M10 6.2V10l2.6 1.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>
  }
  return <StepIcon kind="search" />
}

function stepDuration(step: ProcessTurnStep): string {
  const native = formatDuration(step.durationMs)
  if (native) return native
  const observed = formatDuration(step.startedAt !== undefined && step.completedAt !== undefined
    ? step.completedAt - step.startedAt
    : undefined)
  return observed && step.timingEstimated ? `~${observed}` : observed
}

const CODE_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import',
  'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'return', 'switch', 'throw', 'true',
  'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'
])

type CodeTokenTone = 'plain' | 'comment' | 'keyword' | 'string' | 'number' | 'name' | 'operator'
interface CodeToken { text: string; tone: CodeTokenTone }

/** 过程卡只需稳定的轻量着色，不引入运行时高亮器或额外 bundle。 */
function tokenizeCodeLine(line: string): CodeToken[] {
  const pattern = /(\/\*.*?\*\/|\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*\b|[=!<>+\-*/|&?:]+)/gi
  const tokens: CodeToken[] = []
  let cursor = 0
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ text: line.slice(cursor, index), tone: 'plain' })
    const text = match[0]
    const tone: CodeTokenTone = text.startsWith('//') || text.startsWith('/*') || text.startsWith('#')
      ? 'comment'
      : /^['"`]/.test(text) ? 'string'
        : /^(?:0x[\da-f]+|\d)/i.test(text) ? 'number'
          : CODE_KEYWORDS.has(text) ? 'keyword'
            : /^[A-Za-z_$]/.test(text) ? 'name' : 'operator'
    tokens.push({ text, tone })
    cursor = index + text.length
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), tone: 'plain' })
  return tokens.length ? tokens : [{ text: line || ' ', tone: 'plain' }]
}

function CodeLine({ text }: { text: string }): React.JSX.Element {
  return <>{tokenizeCodeLine(text).map((token, index) => <span key={index} className={`is-${token.tone}`}>{token.text}</span>)}</>
}

function editFilePath(step: ProcessTurnStep): string {
  return step.target ?? step.details.find((detail) => detail.label === '文件')?.value ?? ''
}

function editFileMeta(path: string): { name: string; language: string } {
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path || '文件'
  const extension = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() ?? '' : ''
  const labels: Record<string, string> = {
    ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX', css: 'CSS', scss: 'SCSS', html: 'HTML',
    json: 'JSON', md: 'MD', py: 'PY', go: 'GO', rs: 'RS', sh: 'SH', zsh: 'SH',
    yaml: 'YAML', yml: 'YAML', sql: 'SQL', vue: 'VUE', svelte: 'SV'
  }
  return { name, language: labels[extension] ?? (extension ? extension.slice(0, 4).toUpperCase() : 'FILE') }
}

/**
 * 会话页工具行右侧的状态词：Cursor 不显示单个工具的耗时，完成态由动词本身表达（已读取 / Ran），
 * 只有进行中（脉冲）、失败与问卷状态（等待回答 / 已回答 / 已跳过）才需要额外的状态词。
 */
function compactStateText(step: ProcessTurnStep): string {
  if (step.question) return step.stateText
  return step.status === 'done' ? '' : step.stateText
}

/**
 * 思考/过程消息正文（阶段 G）：直播卡（live）经共享播放器逐字追赶——稳定
 * step id 保留缓冲，新到即 done 的块同样播放；历史/封口卡直接完整显示。
 * 工具行不套播放器：按生命周期出现，不模拟逐字工具名。
 *
 * 播放模式在挂载时锁定：直播中挂载的正文在回合结束（live 翻 false）后继续把
 * 尾部匀速播完，而不是随 immediate 翻转瞬间跳全文；历史卡挂载即全文。
 * hydrate：观看者到来时就已存在的步骤（切换会话进入进行中的回合）落位不重播，
 * 只有观看者到来之后新出现的步骤才从空串打字。
 */
function StreamingTextBody({
  step,
  live,
  hydrate,
  className
}: {
  step: ProcessTurnStep
  live: boolean
  hydrate: boolean
  className?: string
}): React.JSX.Element | null {
  const immediate = useRef(!live)
  const visible = useStreamingText(
    { id: step.id, text: step.body ?? '', done: step.status !== 'running' },
    { immediate: immediate.current, hydrate }
  )
  if (!step.body) return null
  return <MessageContent text={visible} className={className} />
}

/**
 * Shell 卡正文（Cursor `ui-shell-tool-call` 同款）：`$ 命令` 着色行 + 输出面板。
 * 折叠态是 5 行定高预览：column-reverse 贴底显示最新输出、顶部渐隐，运行中天然跟随尾部；
 * 展开态 200px 可滚动，运行中每帧贴底，完成后停止跟随、把滚动交还用户。
 */
function ShellBody({
  step,
  expanded,
  onToggle
}: {
  step: ProcessTurnStep
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  const shell = step.shell
  const outputRef = useRef<HTMLPreElement | null>(null)
  const running = step.status === 'running'
  const output = shell?.output ?? ''
  useEffect(() => {
    if (!expanded || !running) return
    const node = outputRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [expanded, running, output])
  if (!shell) return null
  const tokens = shell.command ? tokenizeShellCommand(shell.command) : []
  return (
    <div className="cursor-native-shell__body">
      {tokens.length ? (
        <code className="cursor-native-shell__command">
          <span className="cursor-native-shell__prompt" aria-hidden="true">$ </span>
          {tokens.map((token, index) => (
            <span key={`${step.id}:tok:${index}`} className={`cursor-native-shell__token is-${token.type}`}>{token.text}</span>
          ))}
        </code>
      ) : null}
      {output ? (
        <pre
          ref={outputRef}
          className={`cursor-native-shell__output ${expanded ? 'is-expanded' : 'is-preview'}`}
          role={expanded ? undefined : 'button'}
          tabIndex={expanded ? undefined : 0}
          aria-label={expanded ? undefined : '展开完整命令输出'}
          onClick={expanded ? undefined : onToggle}
          onKeyDown={expanded ? undefined : (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } }}
        ><span>{output}</span></pre>
      ) : running ? (
        <div className="cursor-native-shell__waiting" aria-label="等待命令输出"><i /><i /><i /></div>
      ) : null}
      {shell.error ? <pre className="cursor-native-shell__error">{shell.error}</pre> : null}
    </div>
  )
}

/**
 * 编辑步骤的结构化 diff（Cursor diff 卡同款）：每行 = 旧行号 / 新行号 / 标记 / 内容，
 * added 绿底、removed 红底、context 中性、hunk 头灰色分隔；颜色只表达增删语义。
 */
function DiffView({ step, mode = step.status === 'running' ? 'live' : 'full' }: { step: ProcessTurnStep; mode?: 'live' | 'preview' | 'full' }): React.JSX.Element | null {
  const diff = step.diff
  const live = mode === 'live'
  const preview = mode === 'preview'
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastLine = diff?.lines.at(-1)
  let streamingTailIndex = -1
  if (live && diff) {
    for (let index = diff.lines.length - 1; index >= 0; index -= 1) {
      const line = diff.lines[index]!
      if (line.type !== 'hunk' && line.text.trim()) { streamingTailIndex = index; break }
    }
  }
  const scrollTrigger = live && lastLine
    ? `${diff?.lines.length}:${lastLine.type}:${lastLine.oldLine ?? ''}:${lastLine.newLine ?? ''}:${lastLine.text}`
    : ''
  useEffect(() => {
    if (!live || !scrollTrigger) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [live, scrollTrigger])
  if (!diff?.lines.length) return null
  // 默认保留改动附近四行；手动展开与运行状态独立，展开时把滚动交还用户。
  const contentLines = diff.lines.filter((line) => line.type !== 'hunk')
  const changedAt = contentLines.findIndex((line) => line.type === 'added' || line.type === 'removed')
  const previewStart = changedAt < 0 ? 0 : Math.max(0, changedAt - 1)
  const visibleLines = preview && !live
    ? contentLines.slice(previewStart, previewStart + 4)
    : diff.lines
  // 行号列宽随最大行号位数走（4 位行号在固定 3.2em 里会折行）。
  const digits = Math.max(2, ...diff.lines.flatMap((line) => [line.oldLine, line.newLine])
    .filter((value): value is number => value !== undefined)
    .map((value) => String(value).length))
  return (
    <div ref={scrollRef} className={`cursor-native-diff${live ? ' is-live' : preview ? ' is-preview' : ' is-full'}`} role="table" tabIndex={mode === 'full' ? 0 : undefined} aria-label={live ? '正在编辑文件' : preview ? '文件改动预览' : '文件改动'} style={{ '--diff-num-width': `${digits + 1.2}ch` } as React.CSSProperties}>
      {visibleLines.map((line, index) => (
        <div key={`${step.id}:diff:${index}`} className={`cursor-native-diff__line is-${line.type}${index === streamingTailIndex ? ' is-streaming-tail' : ''}`} role="row">
          {line.type === 'hunk' ? (
            <span className="cursor-native-diff__hunk" role="cell">{line.text}</span>
          ) : (
            <>
              <span className="cursor-native-diff__num" role="cell">{line.oldLine ?? ''}</span>
              <span className="cursor-native-diff__num" role="cell">{line.newLine ?? ''}</span>
              <span className="cursor-native-diff__sign" role="cell" aria-hidden="true">{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</span>
              <span className="cursor-native-diff__text" role="cell"><CodeLine text={line.text} /></span>
            </>
          )}
        </div>
      ))}
      {!preview && diff.truncatedLineCount ? (
        <div className="cursor-native-diff__truncated" role="note">另有 {diff.truncatedLineCount} 行未内联</div>
      ) : null}
    </div>
  )
}

/**
 * 图片生成卡正文（Cursor "Generated image" 同款）：产出图直接内联在头部之下，不藏在展开明细里；
 * 缩略图复用附件查看器（点击看大图、右键复制 / 另存 / 在 Finder 中显示）。文件名已是头部对象，
 * 不再作图注重复。运行中没有产物：头部「生成图片中」即状态，不放占位骨架。
 */
function ImageBody({ step }: { step: ProcessTurnStep }): React.JSX.Element | null {
  if (!step.image) return null
  return (
    <div className="cursor-native-image">
      <MessageImage alt="" target={step.image.path} />
    </div>
  )
}

/** 工具行提示：编辑类的 `+N −M` 拆成绿 / 红两段（增删语义色），其余原样。 */
function StepHint({ step }: { step: ProcessTurnStep }): React.JSX.Element | null {
  if (!step.hint) return null
  const stats = step.kind === 'edit' || step.kind === 'write' ? parseFileChangeStats(step.hint) : undefined
  if (!stats) return <span className="cursor-native-tool__hint">{step.hint}</span>
  return (
    <span className="cursor-native-tool__hint cursor-native-tool__stats">
      <i data-kind="additions">+{stats.additions}</i>
      <i data-kind="deletions">−{stats.deletions}</i>
    </span>
  )
}

function StepDetails({ step, questionActions, preview = false }: { step: ProcessTurnStep; questionActions?: QuestionActions; preview?: boolean }): React.JSX.Element {
  const todos = step.todos ?? []
  const completedCount = todos.filter((todo) => todo.status === 'completed').length
  return (
    <div className="process-turn-step__details">
      {!preview && step.body ? <MessageContent text={step.body} className="process-turn-step__thinking" /> : null}
      <DiffView step={step} mode={preview ? (step.status === 'running' ? 'live' : 'preview') : undefined} />
      {!preview ? (
        <>
          {step.question && step.question.status !== 'pending' ? <QuestionCard question={step.question} actions={questionActions} /> : null}
          {todos.length ? (
            <div className="todo-sheet">
              {/* 进度线按任务分段：完成实色、进行中流光、取消灰——线本身就是清单的缩略图。 */}
              <div
                className="todo-progress"
                role="progressbar"
                aria-label={`任务清单进度 ${completedCount}/${todos.length}`}
                aria-valuenow={completedCount}
                aria-valuemin={0}
                aria-valuemax={todos.length}
              >
                {todos.map((todo, index) => (
                  <i key={`${step.id}:seg:${index}`} className={`is-${todoTone(todo.status)}`} />
                ))}
              </div>
              <ul className="process-turn-step__todos">
                {todos.map((todo, index) => {
                  const tone = todoTone(todo.status)
                  return (
                    <li key={`${step.id}:todo:${index}`} className={`is-${tone}`}>
                      <TodoIndicator tone={tone} />
                      <span className="todo-text">{todo.content}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}
          {step.details.map((detail, index) => (
            <dl key={`${step.id}:detail:${index}`}><dt>{detail.label}</dt><dd>{detail.kind === 'code' ? <pre>{detail.value}</pre> : <code>{detail.value}</code>}</dd></dl>
          ))}
        </>
      ) : null}
    </div>
  )
}

export function ProcessTurnCard({
  id,
  blocks,
  startedAt,
  updatedAt,
  defaultOpen = true,
  compact = false,
  title = '过程记录',
  live = false,
  truncatedItemCount = 0,
  hydratedBlockIds,
  questionActions
}: ProcessTurnCardProps): React.JSX.Element | null {
  const model = useMemo(() => buildProcessTurnView({ id, blocks, startedAt, updatedAt }), [id, blocks, startedAt, updatedAt])
  // 会话页（compact）按 Cursor detailed 密度分组：探索类折叠为组头，shell / edit 独立成卡。
  // 组 id = 首步 id，块尾部增长不改变已有组的 key。
  const items = useMemo(
    () => groupProcessSteps(model.steps, { density: 'detailed', isCompleted: model.status !== 'running' }),
    [model.steps, model.status]
  )
  /** step id → 所属组 id：自动展开 / 右栏定位某一步时要连同它的组一起展开。 */
  const groupOfStep = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of items) {
      if (item.kind !== 'group') continue
      for (const step of item.steps) map.set(step.id, item.id)
    }
    return map
  }, [items])
  const [open, setOpen] = useState(defaultOpen)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const lastThinking = [...model.steps].reverse().find((step) => step.kind === 'thinking')
    return new Set(model.steps
      .filter((step) => step.id === lastThinking?.id)
      .map((step) => step.id))
  })
  const toggleExpanded = (key: string): void => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  /** 展开某一步，并连同它所在的组（若有）——右栏定位用。 */
  const revealStep = (stepId: string): void => setExpanded((current) => {
    const groupId = groupOfStep.get(stepId)
    if (current.has(stepId) && (!groupId || current.has(groupId))) return current
    const next = new Set(current)
    next.add(stepId)
    if (groupId) next.add(groupId)
    return next
  })
  /** 已自动展开过的最新步骤：内容继续增长时不与用户的手动收起对抗。 */
  const lastAutoExpanded = useRef<string | null>(null)
  /**
   * 观看者到来前就已存在的步骤落位不重播（hydrate），之后新出现的步骤才打字：
   * 切换会话进入正在生成的回合时，这里就是"早已呈现过"与"正在发生"的分界。
   * 分界以会话视图挂载时的块集合为准；没有该信息时退化为卡片挂载时的步骤集合。
   */
  const stepsAtMount = useRef<ReadonlySet<string> | null>(null)
  if (stepsAtMount.current === null) stepsAtMount.current = new Set(model.steps.map((step) => step.id))
  const hydrated = (step: ProcessTurnStep): boolean => hydratedBlockIds
    ? hydratedBlockIds.has(step.blockId)
    : (stepsAtMount.current?.has(step.id) ?? false)
  useEffect(() => {
    if (!live) return
    // 直播时展开「最新可见的文本内容」：优先运行中的块；Cursor 常把生成中的
    // Thinking 标记为 done（RC-9），因此最新文本块即使 done 也展开——否则
    // 新内容折叠不可见，用户只能看到整段瞬现的最终结果。
    const last = model.steps.at(-1)
    const active = [...model.steps].reverse().find((step) => step.status === 'running')
      ?? (last && (last.kind === 'thinking' || last.kind === 'message') && last.body ? last : undefined)
    if (!active || lastAutoExpanded.current === active.id) return
    // 文件卡的直播预览本来就可见；expanded 仅记录手动展开/右栏定位，避免结束后撑开整卡。
    if (compact && active.kind === 'edit') return
    lastAutoExpanded.current = active.id
    setExpanded((current) => current.has(active.id) ? current : new Set([...current, active.id]))
  }, [live, compact, model.steps])
  // 右栏「定位」到本卡的某一步：先把整卡与该步（及所在组）展开，定位方随后滚动到已展开的节点。
  // 只做准备（返回 undefined），是否找到由定位方判定。
  useEffect(() => subscribeReveal((target) => {
    if (!target.blockId) return
    const wanted = stepDomId(target.blockId)
    const step = model.steps.find((candidate) => candidate.id === wanted || candidate.id.startsWith(`${wanted}:`))
    if (!step) return
    setOpen(true)
    revealStep(step.id)
  }), [model.steps, groupOfStep])
  if (!model.steps.length) return null
  const statusText = model.status === 'running' ? '进行中' : model.status === 'failed' ? '有失败' : '已完成'
  const elapsed = formatDuration(model.elapsedMs)
  const summary = [
    `${model.steps.length} 步`,
    model.toolCount ? `${model.toolCount} 次工具` : '',
    statusText,
    elapsed ? model.timingEstimated ? `观测 ~${elapsed}` : `累计 ${elapsed}` : '',
    truncatedItemCount > 0 ? `另有 ${truncatedItemCount} 步已折叠` : ''
  ].filter(Boolean).join(' · ')

  const toggleAll = (): void => {
    setExpanded((current) => current.size === model.steps.length
      ? new Set()
      : new Set(model.steps.map((step) => step.id)))
  }

  if (compact) {
    const chevron = (isOpen: boolean): React.JSX.Element => (
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d={isOpen ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>
    )
    /**
     * 单步渲染；`nested` = 组内成员（渲染为无边框轻行，Cursor 组展开后的明细行同款）；
     * `preview` = 组的直播预览（正在生成的 Thinking / 正文强制展开正文，让打字机可见）。
     */
    const renderStep = (step: ProcessTurnStep, nested: boolean, preview = false): React.JSX.Element | null => {
      const stepOpen = expanded.has(step.id) || (preview && step.kind === 'thinking' && step.status === 'running')
      const pendingQuestion = step.question?.status === 'pending'
      const hasDetails = Boolean(step.details.length || step.todos?.length || step.diff?.lines.length || (step.question && !pendingQuestion))
      // 工具行不显示耗时（Cursor 同款；采样估算的 ~0.1s 只是噪音），Thought 仍显示原生 / 估算时长。
      const duration = step.kind === 'thinking' ? stepDuration(step) : ''
      const stateText = compactStateText(step)
      if (step.kind === 'thinking') {
        return (
          <article key={step.id} className={`cursor-native-thought is-${step.status} ${stepOpen ? 'is-open' : ''} ${nested ? 'is-nested' : ''}`} data-step-id={step.id}>
            <button className="cursor-native-thought__head" onClick={() => toggleExpanded(step.id)} aria-expanded={stepOpen}>
              {/* 与 Cursor 自身一致：进行中是「Thinking」文字流光，结束后变成「Thought for Ns」。 */}
              {step.status === 'running'
                ? <strong>Thinking</strong>
                : <><strong>Thought</strong>{duration ? <time>for {duration}</time> : null}</>}
              {chevron(stepOpen)}
            </button>
            {stepOpen && step.body ? <StreamingTextBody step={step} live={live} hydrate={hydrated(step)} className="cursor-native-thought__body" /> : null}
          </article>
        )
      }
      if (step.kind === 'message') {
        return step.body ? (
          <article key={step.id} className={`cursor-native-message is-${step.status} ${nested ? 'is-nested' : ''}`} data-step-id={step.id}>
            <StreamingTextBody step={step} live={live} hydrate={hydrated(step)} />
          </article>
        ) : null
      }
      // 编辑卡不是通用工具卡的变体：Cursor 用「语言 / 文件名 / 增删统计」作头，
      // 代码预览与头部共享同一外壳，展开入口位于代码区底部中央。
      if (step.kind === 'edit' && step.diff && !nested) {
        const path = editFilePath(step)
        const file = editFileMeta(path)
        const stats = step.hint ? parseFileChangeStats(step.hint) : undefined
        const error = step.details.find((detail) => detail.label === '错误')?.value
        return (
          <article key={step.id} className={`cursor-native-edit is-${step.status} ${stepOpen ? 'is-open' : ''}`} data-step-id={step.id}>
            <button
              className="cursor-native-edit__head"
              onClick={() => toggleExpanded(step.id)}
              aria-expanded={stepOpen}
              aria-label={`${step.status === 'failed' ? '编辑失败' : step.status === 'running' ? '正在编辑' : '已编辑'} ${file.name}`}
              title={path}
            >
              <span className="cursor-native-edit__language">{file.language}</span>
              <strong>{file.name}</strong>
              {stats ? (
                <span className="cursor-native-edit__stats" aria-label={`新增 ${stats.additions} 行，删除 ${stats.deletions} 行`}>
                  <i data-kind="additions">+{stats.additions}</i>
                  <i data-kind="deletions">−{stats.deletions}</i>
                </span>
              ) : null}
            </button>
            <div className="cursor-native-edit__body">
              <DiffView step={step} mode={stepOpen ? 'full' : step.status === 'running' ? 'live' : 'preview'} />
              <button
                className="cursor-native-edit__toggle"
                onClick={() => toggleExpanded(step.id)}
                aria-expanded={stepOpen}
                aria-label={stepOpen ? `收起 ${file.name} 的改动` : `展开 ${file.name} 的全部改动`}
              >{chevron(stepOpen)}</button>
            </div>
            {error || step.status === 'failed' ? <pre className="cursor-native-edit__error">{error || '编辑失败，Cursor 未返回错误详情。'}</pre> : null}
          </article>
        )
      }
      // Shell 独立卡：头部 = 意图说明（或动词）+ 程序名提示，正文常驻 `$ 命令` + 输出预览；
      // 点击头部 / 预览在 5 行预览与 200px 展开之间切换（不再走「输入 / 输出」明细表）。
      if (step.kind === 'command' && step.shell && !nested) {
        const expandable = Boolean(step.shell.output)
        return (
          <article key={step.id} className={`cursor-native-tool cursor-native-shell is-command is-${step.status} ${stepOpen ? 'is-open' : ''}`} data-step-id={step.id}>
            <button
              className="cursor-native-tool__head"
              disabled={!expandable}
              onClick={() => toggleExpanded(step.id)}
              aria-expanded={expandable ? stepOpen : undefined}
            >
              <span className="cursor-native-tool__icon"><StepIcon kind="command" /></span>
              <span className="cursor-native-tool__label">
                <strong>{step.action}</strong>
                {step.verb ? <em className="cursor-native-tool__verb">{step.verb}</em> : null}
                {step.hint ? <span className="cursor-native-tool__hint">{step.hint}</span> : null}
              </span>
              <span className="cursor-native-tool__meta">
                {stateText ? <span className="cursor-native-tool__state">{stateText}</span> : null}
                {expandable ? chevron(stepOpen) : null}
              </span>
            </button>
            <ShellBody step={step} expanded={stepOpen} onToggle={() => toggleExpanded(step.id)} />
          </article>
        )
      }
      return (
        <article key={step.id} className={`cursor-native-tool is-${step.kind} is-${step.status} ${stepOpen ? 'is-open' : ''} ${pendingQuestion ? 'is-awaiting' : ''} ${nested ? 'is-nested' : ''}`} data-step-id={step.id}>
          <button
            className="cursor-native-tool__head"
            disabled={!hasDetails}
            onClick={() => toggleExpanded(step.id)}
            aria-expanded={hasDetails ? stepOpen : undefined}
          >
            <span className="cursor-native-tool__icon"><StepIcon kind={step.kind} /></span>
            <span className="cursor-native-tool__label">
              <strong>{step.action}</strong>
              {step.verb ? <em className="cursor-native-tool__verb">{step.verb}</em> : null}
              {step.target ? <code title={step.target}>{step.target}</code> : null}
              <StepHint step={step} />
            </span>
            <span className="cursor-native-tool__meta">
              {stateText ? <span className="cursor-native-tool__state">{stateText}</span> : null}
              {hasDetails ? chevron(stepOpen) : null}
            </span>
          </button>
          <ImageBody step={step} />
          {pendingQuestion && step.question ? <QuestionCard question={step.question} actions={questionActions} /> : null}
          {hasDetails && (stepOpen || Boolean(step.diff)) ? (
            <StepDetails step={step} questionActions={questionActions} preview={Boolean(step.diff && !stepOpen)} />
          ) : null}
        </article>
      )
    }
    /**
     * 组：折叠头（Explored 3 files / Ran 2 commands / Edited 2 files +12 −3），展开后逐行列出成员。
     * 直播中的最后一组（Cursor `ytv` 的 loading 态）在折叠头下方给出一个限高、贴底、顶部淡出的
     * 预览窗：成员按到达顺序滚入，正在生成的 Thinking 正文可见；点击预览即完整展开。
     * 回合结束后预览消失，只剩折叠头——Cursor 同款的紧凑收尾。
     */
    const renderGroup = (group: ProcessTurnGroup, isLast: boolean): React.JSX.Element => {
      const groupOpen = expanded.has(group.id)
      // 直播回合的尾组，或任何仍有成员在进行中的尾组（非直播来源也不能把正在生成的 Thinking 藏起来）。
      const preview = isLast && !groupOpen && (live || group.status === 'running')
      const stats = group.fileChangeStats
      return (
        <section key={group.id} className={`cursor-native-group is-${group.variant} is-${group.status} ${groupOpen ? 'is-open' : ''} ${preview ? 'is-previewing' : ''}`} data-group-id={group.id}>
          <button className="cursor-native-group__head" onClick={() => toggleExpanded(group.id)} aria-expanded={groupOpen}>
            <span className="cursor-native-group__icon"><GroupIcon variant={group.variant} /></span>
            <span className="cursor-native-group__label">
              <strong>{group.action}</strong>
              {group.details ? <span className="cursor-native-group__details">{group.details}</span> : null}
              {stats && (stats.additions || stats.deletions) ? (
                <span className="cursor-native-group__stats">
                  {stats.additions ? <i data-kind="additions">+{stats.additions}</i> : null}
                  {stats.deletions ? <i data-kind="deletions">−{stats.deletions}</i> : null}
                </span>
              ) : null}
            </span>
            <span className="cursor-native-group__meta">
              <span className="cursor-native-group__count">{group.steps.length} 步</span>
              {chevron(groupOpen)}
            </span>
          </button>
          {groupOpen ? (
            <div className="cursor-native-group__body">
              {group.steps.map((step) => renderStep(step, true))}
            </div>
          ) : preview ? (
            <div
              className="cursor-native-group__preview"
              role="button"
              tabIndex={0}
              aria-label="展开查看本组全部步骤"
              onClick={() => toggleExpanded(group.id)}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleExpanded(group.id) } }}
            >
              <div className="cursor-native-group__body is-preview">
                {group.steps.map((step) => renderStep(step, true, true))}
              </div>
            </div>
          ) : null}
        </section>
      )
    }
    return (
      <section className={`process-turn cursor-native-process ${live ? 'is-live' : ''} is-${model.status}`} aria-label={`${title}，${summary}`}>
        {live ? (
          <div className="cursor-native-process__live" role="status"><i />Cursor 实时过程</div>
        ) : null}
        <div className="cursor-native-process__flow">
          {truncatedItemCount > 0 ? (
            <div className="cursor-native-process__truncated" role="note">原生回合过长，较早的 {truncatedItemCount} 个步骤已折叠</div>
          ) : null}
          {items.map((item, index) => item.kind === 'group'
            ? renderGroup(item, index === items.length - 1)
            : renderStep(item.step, false))}
        </div>
      </section>
    )
  }

  return (
    <section className={`process-turn ${compact ? 'is-compact' : ''} ${live ? 'is-live' : ''} is-${model.status}`} aria-label={`${title}，${summary}`}>
      <button className="process-turn__header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="process-turn__state" aria-hidden="true">{model.status === 'done' ? '✓' : model.status === 'failed' ? '!' : <i />}</span>
        <strong>{title}</strong>
        {live ? <em className="process-turn__live-label"><i />实时</em> : null}
        <span>{summary}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d={open ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"/></svg>
      </button>
      {open ? (
        <div className="process-turn__content">
          {truncatedItemCount > 0 ? <p className="process-turn__truncated">较早的 {truncatedItemCount} 个原生步骤已折叠</p> : null}
          <button className="process-turn__expand-all" onClick={toggleAll}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 3 3 3-3M5 13l3-3 3 3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3"/></svg>
            {expanded.size === model.steps.length ? '收起全部' : '展开全部'}
          </button>
          <ol className="process-turn__steps">
            {model.steps.map((step) => {
              const stepOpen = expanded.has(step.id)
              const pendingQuestion = step.question?.status === 'pending'
              const hasDetails = Boolean(step.body || step.details.length || step.todos?.length || step.diff?.lines.length || (step.question && !pendingQuestion))
              return (
                <li key={step.id} className={`process-turn-step is-${step.kind} is-${step.status}`} data-step-id={step.id}>
                  <span className="process-turn-step__node"><StepIcon kind={step.kind} /></span>
                  <div className="process-turn-step__body">
                    <button
                      className="process-turn-step__head"
                      disabled={!hasDetails}
                      onClick={() => setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(step.id)) next.delete(step.id)
                        else next.add(step.id)
                        return next
                      })}
                      aria-expanded={hasDetails ? stepOpen : undefined}
                    >
                      <strong>{step.action}</strong>
                      {step.verb ? <em className="process-turn-step__verb">{step.verb}</em> : null}
                      {step.target ? <code title={step.target}>{step.target}</code> : null}
                      {step.hint ? <span className="process-turn-step__hint">{step.hint}</span> : null}
                      {stepDuration(step) ? <time>{stepDuration(step)}</time> : null}
                      <span className="process-turn-step__status">{step.stateText}</span>
                      {hasDetails ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d={stepOpen ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg> : null}
                    </button>
                    <ImageBody step={step} />
                    {pendingQuestion && step.question ? <QuestionCard question={step.question} actions={questionActions} /> : null}
                    {stepOpen && hasDetails ? <StepDetails step={step} questionActions={questionActions} /> : null}
                  </div>
                </li>
              )
            })}
          </ol>
          <button className="process-turn__collapse" onClick={() => setOpen(false)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/> </svg>
            收起
          </button>
        </div>
      ) : null}
    </section>
  )
}
