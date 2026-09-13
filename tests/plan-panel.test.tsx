// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlanPanel, todoContentSegments, type CursorTodoSnapshot } from '../src/renderer/src/inspector/PlanPanel'
import { todoTone } from '../src/renderer/src/TodoIndicator'

const snapshot = (items: CursorTodoSnapshot['items'], overrides: Partial<CursorTodoSnapshot> = {}): CursorTodoSnapshot => ({
  items,
  blockId: 'block-todo-1',
  live: true,
  ...overrides
})

describe('todoTone', () => {
  it('passes through the four native statuses and aliases running to in_progress', () => {
    expect(todoTone('completed')).toBe('completed')
    expect(todoTone('in_progress')).toBe('in_progress')
    expect(todoTone('pending')).toBe('pending')
    expect(todoTone('cancelled')).toBe('cancelled')
    expect(todoTone('running')).toBe('in_progress')
  })

  it('buckets unknown statuses into cancelled instead of leaking raw strings', () => {
    expect(todoTone('weird status with spaces')).toBe('cancelled')
    expect(todoTone('')).toBe('cancelled')
  })
})

describe('todoContentSegments', () => {
  it('marks ASCII paths and known file extensions as code, leaving Chinese prose alone', () => {
    const segments = todoContentSegments('domain/seat-rotation.ts：设置类型/默认/归一化 + 纯决策函数')
    expect(segments[0]).toEqual({ text: 'domain/seat-rotation.ts', code: true })
    // 中文叙述里的顿号式斜杠不是路径
    expect(segments.slice(1).every((segment) => !segment.code)).toBe(true)
    expect(segments.map((segment) => segment.text).join('')).toBe('domain/seat-rotation.ts：设置类型/默认/归一化 + 纯决策函数')
  })

  it('unwraps backtick spans and keeps plain text as a single segment', () => {
    expect(todoContentSegments('检查 `record_reply` 的回执')).toEqual([
      { text: '检查 ', code: false },
      { text: 'record_reply', code: true },
      { text: ' 的回执', code: false }
    ])
    expect(todoContentSegments('纯中文描述不含代码')).toEqual([{ text: '纯中文描述不含代码', code: false }])
  })

  it('recognizes bare filenames but not spaced slashes', () => {
    expect(todoContentSegments('主进程装配（index.ts）')[1]).toEqual({ text: 'index.ts', code: true })
    expect(todoContentSegments('typecheck / vitest 全量 / knip').every((segment) => !segment.code)).toBe(true)
  })
})

describe('PlanPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async (todos: CursorTodoSnapshot): Promise<void> => {
    await act(async () => {
      root.render(<PlanPanel todos={todos} />)
    })
  }

  it('renders a segmented progress bar and shared todo indicators, current row marked exactly once', async () => {
    await render(snapshot([
      { content: '已完成项', status: 'completed' },
      { content: '进行中项', status: 'in_progress' },
      { content: '待办项', status: 'pending' },
      { content: '取消项', status: 'cancelled' }
    ]))
    const progress = container.querySelector('.inspector-plan__progress .todo-progress')!
    expect(progress.getAttribute('aria-valuenow')).toBe('1')
    expect(progress.getAttribute('aria-valuemax')).toBe('4')
    expect(Array.from(progress.querySelectorAll('i')).map((segment) => segment.className))
      .toEqual(['is-completed', 'is-in_progress', 'is-pending', 'is-cancelled'])

    const rows = Array.from(container.querySelectorAll('.inspector-plan__list li'))
    expect(rows.map((row) => row.className)).toEqual(['is-completed', 'is-in_progress', 'is-pending', 'is-cancelled'])
    // 图元与时间线同源：描边勾 / 实心圆 spinner / 空心圆 / 斜杠圈
    expect(rows[0]!.querySelector('.todo-indicator svg path')).toBeTruthy()
    expect(rows[1]!.querySelector('.todo-spinner')).toBeTruthy()
    expect(rows[3]!.querySelector('.todo-indicator svg path')).toBeTruthy()
    // 当前项标注一次：aria-current 在行上，不再有「进行中」文字标签
    expect(rows[1]!.getAttribute('aria-current')).toBe('step')
    expect(container.textContent).not.toContain('进行中项进行中')
    expect(container.querySelector('.inspector-plan__list em')).toBeNull()
    // 头部不再复读当前项全文
    expect(container.querySelector('.inspector-section__header span')!.textContent).toBe('来自当前 Composer 的实时任务状态')
    expect(container.querySelector('.inspector-plan__ratio')!.textContent).toBe('1/4')
  })

  it('gives settled rows a full-text tooltip and renders path tokens as code', async () => {
    const long = '恢复上下文：确认 domain/seat-rotation.ts 已完成步骤（围栏逐轮复核、bubbleCount、prepareComposerRelaunch allowIdleOnline）'
    await render(snapshot([
      { content: long, status: 'completed' },
      { content: 'application/seat-rotation-service.ts：订阅快照→待命计时→交接', status: 'in_progress' }
    ]))
    const rows = Array.from(container.querySelectorAll('.inspector-plan__list li'))
    expect(rows[0]!.querySelector('.inspector-plan__text')!.getAttribute('title')).toBe(long)
    expect(rows[1]!.querySelector('.inspector-plan__text')!.getAttribute('title')).toBeNull()
    expect(rows[1]!.querySelector('.inspector-plan__text code')!.textContent).toBe('application/seat-rotation-service.ts')
  })

  it('marks status flips with one-shot animation classes, without replaying on mount or unrelated updates', async () => {
    const before = snapshot([
      { content: '任务 A', status: 'pending' },
      { content: '任务 B', status: 'in_progress' }
    ])
    await render(before)
    expect(container.querySelector('.is-just-completed')).toBeNull()
    expect(container.querySelector('.is-just-started')).toBeNull()

    // B 完成、A 开始：两条各得到一次性标记
    await render(snapshot([
      { content: '任务 A', status: 'in_progress' },
      { content: '任务 B', status: 'completed' }
    ]))
    const rows = Array.from(container.querySelectorAll('.inspector-plan__list li'))
    expect(rows[0]!.className).toContain('is-just-started')
    expect(rows[1]!.className).toContain('is-just-completed')

    // 相同内容的新快照（无状态变化）：标记清除，动画不重播
    await render(snapshot([
      { content: '任务 A', status: 'in_progress' },
      { content: '任务 B', status: 'completed' }
    ]))
    expect(container.querySelector('.is-just-completed')).toBeNull()
    expect(container.querySelector('.is-just-started')).toBeNull()
  })

  it('keeps the empty state actionable', async () => {
    await render(snapshot([], { blockId: undefined, live: false }))
    expect(container.textContent).toContain('暂无任务清单')
    expect(container.querySelector('.inspector-plan__list')).toBeNull()
  })
})
