// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProcessQuestion } from '../src/domain/conversation-entry'
import { QuestionCard, type QuestionActions } from '../src/renderer/src/QuestionCard'

const pending: ProcessQuestion = {
  toolCallId: 'tc-1',
  title: '设置页改造方向',
  status: 'pending',
  questions: [
    { id: 'direction', prompt: '改造方向：', allowMultiple: false, options: [{ id: 'a', label: '方案 A' }, { id: 'b', label: '方案 B' }] },
    { id: 'extras', prompt: '同时处理？', allowMultiple: true, options: [{ id: 'card', label: '卡片' }, { id: 'presence', label: '在线保持' }] }
  ]
}

describe('QuestionCard', () => {
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

  it('renders every option as a real control and disables submit until each question has an answer', () => {
    const html = renderToStaticMarkup(<QuestionCard question={pending} actions={{ answer: async () => ({ ok: true, status: 'submitted' }), skip: async () => ({ ok: true, status: 'cancelled' }) }} />)
    expect(html).toContain('方案 A')
    expect(html).toContain('方案 B')
    expect(html).toContain('role="radio"')
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('可多选')
    expect(html).toMatch(/<button[^>]*class="cursor-question__confirm"[^>]*disabled=""/)
    expect(html).toContain('跳过')
  })

  it('collects single / multi selections plus the note and hands them to the answer action', async () => {
    const calls: Array<{ toolCallId: string; draft: unknown }> = []
    const actions: QuestionActions = {
      answer: async (toolCallId, draft) => { calls.push({ toolCallId, draft }); return { ok: true, status: 'submitted' } },
      skip: async () => ({ ok: true, status: 'cancelled' })
    }
    await act(async () => { root.render(<QuestionCard question={pending} actions={actions} />) })
    const options = () => [...container.querySelectorAll<HTMLButtonElement>('.cursor-question__option')]
    const click = async (label: string): Promise<void> => {
      const button = options().find((candidate) => candidate.textContent?.includes(label))
      if (!button) throw new Error(`option ${label} not rendered`)
      await act(async () => { button.click() })
    }
    const confirm = () => container.querySelector<HTMLButtonElement>('.cursor-question__confirm')!
    await click('方案 A')
    expect(confirm().disabled).toBe(true)
    await click('卡片')
    await click('在线保持')
    expect(confirm().disabled).toBe(false)
    expect(options().filter((button) => button.classList.contains('is-active')).map((button) => button.textContent)).toEqual(['方案 A', '卡片', '在线保持'])
    // 单选再点另一项会替换，不会累加。
    await click('方案 B')
    expect(options().filter((button) => button.classList.contains('is-active')).map((button) => button.textContent)).toEqual(['方案 B', '卡片', '在线保持'])
    // 原生 radio 语义：再次点击已选项仍保持选择。
    await click('方案 B')
    expect(options().filter((button) => button.classList.contains('is-active')).map((button) => button.textContent)).toEqual(['方案 B', '卡片', '在线保持'])
    const note = container.querySelector<HTMLTextAreaElement>('.cursor-question__note-input')!
    expect(note.maxLength).toBe(4_000)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(note, '先做 B')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { confirm().click() })
    expect(calls).toEqual([{
      toolCallId: 'tc-1',
      draft: { selections: { direction: ['b'], extras: ['card', 'presence'] }, freeformTexts: {}, note: '先做 B' }
    }])
  })

  it('shows the failure hint from Cursor instead of pretending the answer went through', async () => {
    const actions: QuestionActions = {
      answer: async () => ({ ok: false, code: 'question_not_pending', message: 'x' }),
      skip: async () => ({ ok: false, code: 'cdp_unavailable', message: 'y' })
    }
    await act(async () => { root.render(<QuestionCard question={{ ...pending, questions: [pending.questions[0]!] }} actions={actions} />) })
    await act(async () => { container.querySelector<HTMLButtonElement>('.cursor-question__skip')!.click() })
    expect(container.querySelector('.cursor-question__error')?.textContent).toContain('Cursor 调试连接不可用')
  })

  it('renders resolved questionnaires as read-only answers or the skip reason', () => {
    const submitted = renderToStaticMarkup(<QuestionCard question={{
      ...pending, status: 'submitted', note: '外观后续再说',
      answers: [{ questionId: 'direction', selectedOptionIds: ['a'] }, { questionId: 'extras', selectedOptionIds: ['card'], freeformText: '顺带修 hint' }]
    }} />)
    expect(submitted).toContain('is-submitted')
    expect(submitted).toContain('<span class="cursor-question__answer">方案 A</span>')
    expect(submitted).toContain('<span class="cursor-question__answer">卡片；其他：顺带修 hint</span>')
    expect(submitted).toContain('附言：外观后续再说')
    expect(submitted).not.toContain('cursor-question__confirm')

    const hydrating = renderToStaticMarkup(<QuestionCard question={{ ...pending, status: 'submitted' }} />)
    expect(hydrating).toContain('cursor-question__answer is-pending')
    expect(hydrating).toContain('答案同步中')

    const timedOut = renderToStaticMarkup(<QuestionCard question={{ ...pending, status: 'cancelled', skipReason: 'timeout' }} />)
    expect(timedOut).toContain('提问已超时')
    const readOnly = renderToStaticMarkup(<QuestionCard question={pending} readOnly />)
    expect(readOnly).toContain('请在 Cursor 中回答这组提问')
    expect(readOnly).not.toContain('cursor-question__confirm')
  })
})
