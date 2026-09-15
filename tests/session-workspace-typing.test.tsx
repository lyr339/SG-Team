// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { SessionWorkspace } from '../src/renderer/src/SessionWorkspace'

// 计数真实 ClampedMessage 内部的 Markdown 渲染，保留生产 memo/折叠边界。
const clampedRenderCount = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/MessageContent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/MessageContent')>()
  return { ...actual, MessageContent: (props: Parameters<typeof actual.MessageContent>[0]) => {
    clampedRenderCount(props.text)
    return <actual.MessageContent {...props} />
  } }
})

const baseSession: AgentSession = {
  id: 'session-5',
  channelId: '5',
  generation: 1,
  displayName: '前端开发 · CH-5',
  roleName: '前端席',
  status: 'waiting',
  currentTask: '',
  queueDepth: 0,
  connectionPhase: 'waiting',
  online: true,
  connected: true,
  waiting: true,
  workingFiles: [],
  healthEvidence: []
}

function entry(partial: Partial<ConversationEntry>): ConversationEntry {
  return {
    id: partial.id ?? 'e1',
    channelId: '5',
    role: partial.role ?? 'assistant',
    text: partial.text ?? '',
    timestamp: partial.timestamp ?? 1_000_000,
    status: partial.status ?? 'complete',
    source: partial.source ?? 'cursor',
    ...partial
  }
}

// 回调引用稳定——与 App 层的契约一致（useCallback/useMemo 化）；每次新建会打穿时间线 memo 边界。
const stableProps = {
  onSend: async () => {},
  onBack: () => {},
  onDraftChange: () => {},
  onAttachmentsChange: () => {}
}

function workspaceProps(draft: string, entries: ConversationEntry[]) {
  return {
    session: baseSession,
    entries,
    ...stableProps,
    draft,
    attachments: []
  }
}

describe('SessionWorkspace 打字渲染隔离', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    clampedRenderCount.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('draft 每次变化（打字）不触发时间线消息重渲染；时间线内容变化仍正常渲染', async () => {
    const entries = [
      entry({ id: 'u1', role: 'user', source: 'desktop', text: '第一个问题' }),
      entry({ id: 'a1', role: 'assistant', text: '第一个回答' })
    ]
    await act(async () => root.render(<SessionWorkspace {...workspaceProps('', entries)} />))
    expect(clampedRenderCount).toHaveBeenCalledTimes(2)

    // 连续打字：draft 从空到长文本，逐键推进
    for (const draft of ['正', '正在', '正在输', '正在输入']) {
      await act(async () => root.render(<SessionWorkspace {...workspaceProps(draft, entries)} />))
    }
    // 时间线消息零重渲染（draft 不在时间线依赖内）
    expect(clampedRenderCount).toHaveBeenCalledTimes(2)

    // 时间线内容真的变了（新回复到达）时照常渲染
    await act(async () => root.render(
      <SessionWorkspace {...workspaceProps('正在输入', [...entries, entry({ id: 'a2', role: 'assistant', text: '第二个回答' })])} />
    ))
    expect(clampedRenderCount).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('第二个回答')
  })

  it('引用读取最新草稿；回调替换后重试走新 onSend，收藏仍正常更新', async () => {
    const entries = [
      entry({ id: 'u1', role: 'user', source: 'desktop', text: '原始请求' }),
      entry({ id: 'a1', text: '有效回答' })
    ]
    const onDraftChange = vi.fn(), oldSend = vi.fn(async () => {}), newSend = vi.fn(async () => {})
    await act(async () => root.render(<SessionWorkspace {...workspaceProps('旧草稿', entries)} onDraftChange={onDraftChange} onSend={oldSend} />))
    await act(async () => root.render(<SessionWorkspace {...workspaceProps('最新草稿', entries)} onDraftChange={onDraftChange} onSend={newSend} />))
    await act(async () => { container.querySelector<HTMLButtonElement>('[title="引用这条消息回复"]')!.click() })
    expect(onDraftChange).toHaveBeenLastCalledWith('最新草稿\n\n> 有效回答\n\n')
    await act(async () => { container.querySelector<HTMLButtonElement>('[title="重新生成这条回答"]')!.click() })
    expect(oldSend).not.toHaveBeenCalled()
    expect(newSend).toHaveBeenCalledWith(expect.stringContaining('原始请求'))
    await act(async () => { container.querySelector<HTMLButtonElement>('[title="收藏回答"]')!.click() })
    expect(container.querySelector('[title="取消收藏"]')).not.toBeNull()
  })

  it('草稿更新保持历史 DOM 和展开状态；修改旧回复文本仍会更新', async () => {
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(600)
    const reply = entry({ id: 'answer', text: '一段历史回答' })
    const entries = [reply]
    await act(async () => root.render(<SessionWorkspace {...workspaceProps('', entries)} />))
    const bubble = container.querySelector('.clamped-message')!
    expect(bubble.classList.contains('is-clamped')).toBe(true)
    await act(async () => { bubble.querySelector<HTMLButtonElement>('button')!.click() })
    for (const draft of ['一', '一二', '一二三']) {
      await act(async () => root.render(<SessionWorkspace {...workspaceProps(draft, entries)} />))
    }
    expect(container.querySelector('.clamped-message')).toBe(bubble)
    expect(bubble.classList.contains('is-clamped')).toBe(false)
    const rendersAfterExpand = clampedRenderCount.mock.calls.length
    await act(async () => root.render(<SessionWorkspace {...workspaceProps('继续打字', entries)} />))
    expect(clampedRenderCount).toHaveBeenCalledTimes(rendersAfterExpand)
    await act(async () => root.render(<SessionWorkspace {...workspaceProps('一二三', [{ ...reply, text: '修正后的回答' }])} />))
    expect(bubble.textContent).toContain('修正后的回答')
  })
})
