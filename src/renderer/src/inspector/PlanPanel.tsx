import { Fragment, useEffect, useMemo, useRef } from 'react'
import { conversationEntryProcessBlocks, type ConversationEntry, type ProcessBlock } from '../../../domain/conversation-entry'
import type { LiveProcessState } from '../../../shared/desktop-api'
import { TodoIndicator, todoTone, type TodoTone } from '../TodoIndicator'
import { PlanIcon, TargetGlyph } from './InspectorIcons'
import type { InspectorTabId } from './InspectorShell'
import { InspectorSectionHeader, InspectorState, InspectorToast, useTransientFeedback } from './InspectorState'
import { useWorkspaceFileActions } from './use-workspace-file-actions'

export interface CursorTodoItem {
  content: string
  status: string
}

export interface CursorTodoSnapshot {
  items: CursorTodoItem[]
  /** 产生这份清单的过程块（点击跳回时间线）。 */
  blockId?: string
  live: boolean
}

function latestTodoBlock(blocks: readonly ProcessBlock[] | undefined): { items: CursorTodoItem[]; blockId: string } | undefined {
  if (!blocks?.length) return undefined
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.kind === 'tool' && block.toolKind === 'todo' && block.todos?.length) {
      return { items: block.todos.map((todo) => ({ ...todo })), blockId: block.id }
    }
  }
  return undefined
}

/** 最新 Cursor 原生 Todo：直播帧优先，回合结束后回落到最近一条持久化过程。 */
export function currentCursorTodos(
  entries: readonly ConversationEntry[],
  liveProcess?: LiveProcessState
): CursorTodoSnapshot {
  if (liveProcess) {
    const live = latestTodoBlock(liveProcess.blocks)
    return { items: live?.items ?? [], blockId: live?.blockId, live: true }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const historical = entry ? latestTodoBlock(conversationEntryProcessBlocks(entry)) : undefined
    if (historical) return { items: historical.items, blockId: historical.blockId, live: false }
  }
  return { items: [], live: false }
}

export interface TodoContentSegment {
  text: string
  code: boolean
}

/**
 * todo 正文里的代码样 token（反引号包裹、ASCII 路径、带常见扩展名的文件名）以 mono 呈现。
 * 字符类只收 ASCII：中文叙述里的顿号式斜杠（「设置/默认/归一化」）不会被误判为路径。
 */
const CODE_TOKEN = /`([^`]+)`|[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+|\b[\w.-]+\.(?:tsx|ts|mjs|cjs|jsx|css|json|md|py|rs|go|sh|yml|yaml|html|sqlite3|sqlite|vsix)\b/g

export function todoContentSegments(content: string): TodoContentSegment[] {
  const segments: TodoContentSegment[] = []
  let cursor = 0
  for (const match of content.matchAll(CODE_TOKEN)) {
    const index = match.index ?? 0
    if (index > cursor) segments.push({ text: content.slice(cursor, index), code: false })
    segments.push({ text: match[1] ?? match[0], code: true })
    cursor = index + match[0].length
  }
  if (cursor < content.length) segments.push({ text: content.slice(cursor), code: false })
  return segments.length ? segments : [{ text: content, code: false }]
}

const todoKey = (todo: CursorTodoItem, index: number): string => `${index}:${todo.content}`

/**
 * 状态微动效的记忆体：仅当同一条目（index+内容同键）的状态发生变化时打「刚刚完成 / 刚刚开始」标记，
 * 首次挂载与整单替换不重播。标记随 items 引用变化重算，期间保持稳定，动画只播一次。
 */
interface ToneMemory {
  source?: readonly CursorTodoItem[]
  memory: Map<string, TodoTone>
  just: Map<string, TodoTone>
}

function refreshToneMemory(state: ToneMemory, items: readonly CursorTodoItem[]): void {
  if (state.source === items) return
  const next = new Map<string, TodoTone>()
  const just = new Map<string, TodoTone>()
  items.forEach((todo, index) => {
    const key = todoKey(todo, index)
    const tone = todoTone(todo.status)
    next.set(key, tone)
    const before = state.source ? state.memory.get(key) : undefined
    if (before !== undefined && before !== tone) just.set(key, tone)
  })
  state.source = items
  state.memory = next
  state.just = just
}

export function PlanPanel({ todos, onOpenTab }: { todos: CursorTodoSnapshot; onOpenTab?: (tab: InspectorTabId) => void }): React.JSX.Element {
  const [feedback, flash] = useTransientFeedback()
  const actions = useWorkspaceFileActions(flash)
  const items = todos.items
  const tones = useMemo(() => items.map((todo) => todoTone(todo.status)), [items])
  const completed = tones.filter((tone) => tone === 'completed').length
  const cancelled = tones.filter((tone) => tone === 'cancelled').length
  const pending = tones.filter((tone) => tone === 'pending').length
  const running = tones.filter((tone) => tone === 'in_progress').length
  const runningIndex = tones.indexOf('in_progress')

  const toneMemory = useRef<ToneMemory>({ memory: new Map(), just: new Map() })
  refreshToneMemory(toneMemory.current, items)
  const justMarks = toneMemory.current.just

  // 长清单里当前项保持可见：进行中的条目换人时滚到最近可视位置。
  const runningRef = useRef<HTMLLIElement | null>(null)
  const runningKey = runningIndex >= 0 ? todoKey(items[runningIndex]!, runningIndex) : undefined
  useEffect(() => {
    if (!runningKey) return
    const node = runningRef.current
    if (!node || typeof node.scrollIntoView !== 'function') return
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }, [runningKey])

  // 小节头概览任务状态；当前项只在列表行以缺口环和正文对比度标注。
  const hint = todos.live ? '来自当前 Composer 的实时任务状态' : '来自最近一轮对话的任务清单'
  const statusLabel = running || pending
    ? `${running}进行中 · ${pending}待处理`
    : [completed && `${completed}已完成`, cancelled && `${cancelled}已取消`].filter(Boolean).join(' · ')
  return (
    <section className="inspector-plan" aria-label="Cursor 任务清单">
      <InspectorSectionHeader
        title={items.length ? <>任务 <small className="inspector-plan__count">{statusLabel}</small></> : '任务'}
        hint={hint}
        aside={(
          <>
            {todos.blockId ? (
              <button type="button" className="inspector-icon-button" title="在时间线中定位这份清单" aria-label="在时间线中定位这份清单" onClick={() => void actions.reveal({ blockId: todos.blockId })}>
                <TargetGlyph />
              </button>
            ) : null}
          </>
        )}
      />
      {items.length ? (
        <ol className="inspector-plan__list" aria-label={`任务清单，${completed}/${items.length} 已完成`}>
          {items.map((todo, index) => {
            const tone = tones[index]!
            const key = todoKey(todo, index)
            const just = justMarks.get(key)
            const settled = tone === 'completed' || tone === 'cancelled'
            const justClass = just === 'completed' ? ' is-just-completed' : just === 'in_progress' ? ' is-just-started' : ''
            return (
              <li
                key={key}
                className={`is-${tone}${justClass}`}
                aria-current={tone === 'in_progress' ? 'step' : undefined}
                ref={tone === 'in_progress' ? runningRef : undefined}
              >
                <TodoIndicator tone={tone} />
                <span className="inspector-plan__text" title={settled ? todo.content : undefined}>
                  {todoContentSegments(todo.content).map((segment, segmentIndex) => segment.code
                    ? <code key={segmentIndex}>{segment.text}</code>
                    : <Fragment key={segmentIndex}>{segment.text}</Fragment>)}
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <InspectorState
          icon={<PlanIcon />}
          title="暂无任务清单"
          hint="Cursor 创建 Todo 后会在这里实时出现；Agent 处理多步任务时通常会先列清单"
          action={onOpenTab ? <button type="button" className="inspector-link" onClick={() => onOpenTab('activity')}>查看本会话的活动</button> : undefined}
        />
      )}
      <InspectorToast message={feedback} />
    </section>
  )
}
