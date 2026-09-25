// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { LiveAgentResponseState, LiveProcessState } from '../src/shared/desktop-api'
import { SessionWorkspace } from '../src/renderer/src/SessionWorkspace'

const session: AgentSession = {
  id: 'session-1', channelId: '1', generation: 1, displayName: 'CH-1', roleName: '独立席',
  status: 'running', currentTask: '', queueDepth: 0, connectionPhase: 'processing',
  online: true, connected: true, waiting: false, deliveryMode: 'queued', workingFiles: [], healthEvidence: []
}

const user: ConversationEntry = {
  id: 'outbox:u1', channelId: '1', role: 'user', source: 'desktop', text: '请解释这段代码',
  timestamp: 1_000_000, deliveredAt: 1_000_050, status: 'complete'
}

const finalText = '这段代码把消息按投递时间切成回合，再把过程块锚定到对应回合上。'

function render(root: Root, props: {
  entries: ConversationEntry[]
  liveProcess?: LiveProcessState
  liveAgentResponse?: LiveAgentResponseState
  session?: Partial<AgentSession>
}): void {
  act(() => {
    root.render(
      <SessionWorkspace
        session={{ ...session, ...props.session }}
        entries={props.entries}
        onSend={async () => {}}
        onBack={() => {}}
        draft=""
        onDraftChange={() => {}}
        attachments={[]}
        onAttachmentsChange={() => {}}
        liveProcess={props.liveProcess}
        liveAgentResponse={props.liveAgentResponse}
      />
    )
  })
}

describe('Agent 回合行身份贯穿 responding → sealed（阶段 F/G，§8.5-1 / §8.5-3）', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (window as { matchMedia?: unknown }).matchMedia
    vi.useRealTimers()
  })

  const agentRow = (): HTMLElement | null => container.querySelector('.chat-row--agent')
  const responseText = (): string => container.querySelector('.live-agent-response')?.textContent ?? ''

  const thoughtText = '先读懂分段边界：投递时间是开放边界，回复落库时间是关闭边界，两者之间的过程块归本回合，之后的属于传输空档。'
  const thoughtBody = (): string => container.querySelector('.cursor-native-thought__body')?.textContent ?? ''

  it('keeps the same DOM node and never shortens the visible text when record_reply lands', () => {
    const process: LiveProcessState = {
      turn: 'cursor:t1', startedAt: 1_000_100, updatedAt: 1_000_400, generating: true,
      blocks: [{ kind: 'thinking', id: 'cursor-th:1', text: thoughtText, status: 'done', startedAt: 1_000_100 }]
    }
    // 观看者先到：消息已投递、尚无产物（占位行）。之后到达的过程/正文才是"正在发生"。
    render(root, { entries: [user] })
    expect(agentRow()).not.toBeNull()
    // responding：正文流式到达一半
    render(root, {
      entries: [user],
      liveProcess: process,
      liveAgentResponse: {
        id: 'bubble-1', channelId: '1', text: finalText.slice(0, 12), status: 'streaming',
        startedAt: 1_000_300, updatedAt: 1_000_400
      }
    })
    const liveRow = agentRow()
    expect(liveRow).not.toBeNull()
    expect(liveRow?.className).toContain('live-process-row')
    const processCard = container.querySelector('.cursor-native-process')
    expect(processCard).not.toBeNull()
    act(() => { vi.advanceTimersByTime(300) })
    const midway = responseText()
    expect(midway.length).toBeGreaterThan(0)
    // 直播中的 Thinking 正文（新到即 done）同样在播放，且尚未播完。
    const thoughtMidway = thoughtBody()
    expect(thoughtMidway.length).toBeGreaterThan(0)
    expect(thoughtMidway.length).toBeLessThan(thoughtText.length)

    // sealed：回复落库（含封口过程），直播过程与正文流从快照撤下
    render(root, {
      entries: [user, {
        id: 'reply:r1', channelId: '1', role: 'assistant', source: 'cursor', text: finalText,
        timestamp: 1_000_900, status: 'complete', replyToEntryId: 'outbox:u1', turn: 'cursor:t1:virtual:outbox:u1',
        processBlocks: [{ kind: 'thinking', id: 'cursor-th:1', text: thoughtText, status: 'done', startedAt: 1_000_100, completedAt: 1_000_900 }]
      }],
      session: { status: 'waiting', waiting: true, connectionPhase: 'waiting' }
    })
    const sealedRow = agentRow()
    // 同一 DOM 节点：行、过程卡都没有被卸载重建。
    expect(sealedRow).toBe(liveRow)
    expect(container.querySelector('.cursor-native-process')).toBe(processCard)
    expect(sealedRow?.className).not.toContain('live-process-row')
    const flow = sealedRow?.querySelector<HTMLElement>('.cursor-native-process__flow')
    expect(flow?.hidden).toBe(true)
    expect(sealedRow?.querySelector('.cursor-native-process__summary')?.getAttribute('aria-expanded')).toBe('false')
    // Thinking 正文不因 live 翻 false 跳全文：播放模式在挂载时已锁定，尾部继续播完。
    const thoughtAtSeal = thoughtBody()
    expect(thoughtAtSeal.length).toBeGreaterThanOrEqual(thoughtMidway.length)
    expect(thoughtAtSeal.length).toBeLessThan(thoughtText.length)
    // 正文没有瞬间跳全文：落库那一帧可见文本 ≥ 之前，且仍短于全文，随后匀速播完。
    const atSeal = responseText()
    expect(atSeal.length).toBeGreaterThanOrEqual(midway.length)
    expect(atSeal.length).toBeLessThan(finalText.length)
    let previous = atSeal.length
    for (let round = 0; round < 40; round += 1) {
      act(() => { vi.advanceTimersByTime(50) })
      const current = responseText().length
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
      if (responseText() === finalText) break
    }
    expect(responseText()).toBe(finalText)
    expect(thoughtBody()).toBe(thoughtText)
    // 完成后的过程已收束；手动打开仍是同一个过程 DOM，回复始终保持可见。
    act(() => sealedRow?.querySelector<HTMLButtonElement>('.cursor-native-process__summary')?.click())
    expect(sealedRow?.querySelector('.cursor-native-process__flow')).toBe(flow)
    expect(flow?.hidden).toBe(false)
    expect(responseText()).toBe(finalText)
    // 播完后进入静止：无光标、无「实时」标记；操作栏（复制/引用）已出现。
    expect(container.querySelector('.live-agent-response__caret')).toBeNull()
    expect(container.textContent).toContain('复制')
    expect(container.textContent).toContain('引用')
    // 本会话内看着流出来的正文不再事后折叠（用户气泡的折叠容器不在此列）。
    expect(sealedRow?.querySelector('.clamped-message')).toBeNull()
  })

  it('hydrates an already sealed reply with the full text and clamp affordance at once', () => {
    render(root, {
      entries: [user, {
        id: 'reply:r1', channelId: '1', role: 'assistant', source: 'cursor', text: finalText,
        timestamp: 1_000_900, status: 'complete', replyToEntryId: 'outbox:u1'
      }],
      session: { status: 'waiting', waiting: true, connectionPhase: 'waiting' }
    })
    expect(agentRow()?.querySelector('.clamped-message')?.textContent).toBe(finalText)
    expect(container.querySelector('.live-agent-response')).toBeNull()
  })

  it('freezes a persisted continuation after restart instead of counting from its old start time', () => {
    const now = Date.parse('2026-09-24T20:00:00+08:00')
    vi.setSystemTime(now)
    render(root, {
      entries: [user, {
        id: 'reply:r1', channelId: '1', role: 'assistant', source: 'cursor', text: '已接手',
        timestamp: now - 2 * 60 * 60_000, status: 'complete', replyToEntryId: user.id,
        continuationBlocks: [{ kind: 'tool', id: 'follow-read', toolName: 'Read', toolKind: 'read', summary: 'notes.md',
          status: 'done', startedAt: now - 60 * 60_000, completedAt: now - 30 * 60_000 }]
      }],
      session: { status: 'waiting', waiting: true, connectionPhase: 'waiting' }
    })
    const row = container.querySelector<HTMLElement>('.chat-row--continuation')!
    const heading = row.querySelector<HTMLElement>('.cursor-native-process__summary')!
    expect(row.className).not.toContain('live-process-row')
    expect(heading.textContent).toBe('Worked for 30m 0s')
    expect(row.querySelector<HTMLElement>('.cursor-native-process__flow')?.hidden).toBe(true)
    act(() => { vi.advanceTimersByTime(2 * 60 * 60_000) })
    expect(heading.textContent).toBe('Worked for 30m 0s')
  })

  it('does not revive a legacy running continuation when the seat is busy with a different turn', () => {
    const now = Date.parse('2026-09-24T20:00:00+08:00')
    vi.setSystemTime(now)
    render(root, {
      entries: [user, {
        id: 'reply:r1', channelId: '1', role: 'assistant', source: 'cursor', text: '已接手',
        timestamp: now - 2 * 60 * 60_000, status: 'complete', replyToEntryId: user.id,
        continuationBlocks: [{ kind: 'tool', id: 'legacy-read', toolName: 'Read', toolKind: 'read', summary: 'notes.md',
          status: 'running', startedAt: now - 60 * 60_000 }]
      }],
      session: { online: true, status: 'running', waiting: false }
    })
    const row = container.querySelector<HTMLElement>('.chat-row--continuation')!
    expect(row.querySelector('.cursor-native-process__summary')?.textContent).toBe('Worked')
    expect(row.querySelector('.cursor-native-process')?.className).toContain('is-done')
    expect(row.querySelector<HTMLElement>('.cursor-native-process__flow')?.hidden).toBe(true)
    act(() => { vi.advanceTimersByTime(2 * 60 * 60_000) })
    expect(row.querySelector('.cursor-native-process__summary')?.textContent).toBe('Worked')
  })

  it('keeps the continuation row when live work settles into persisted blocks', () => {
    const now = Date.parse('2026-09-24T20:00:00+08:00')
    vi.setSystemTime(now)
    const reply: ConversationEntry = {
      id: 'reply:r1', channelId: '1', role: 'assistant', source: 'cursor', text: '已接手',
      timestamp: now - 2 * 60_000, status: 'complete', replyToEntryId: user.id,
      turn: 'cursor:native:virtual:outbox:u1'
    }
    const startedAt = now - 60_000
    render(root, {
      entries: [user, reply],
      liveProcess: { turn: 'cursor:native', startedAt, updatedAt: now, generating: true,
        blocks: [{ kind: 'tool', id: 'follow-read', toolName: 'Read', toolKind: 'read', summary: 'notes.md', status: 'running', startedAt }] }
    })
    const liveRow = container.querySelector<HTMLElement>('.chat-row--continuation')!
    const flow = liveRow.querySelector<HTMLElement>('.cursor-native-process__flow')!
    expect(liveRow.querySelector('.cursor-native-process__summary')?.textContent).toContain('Working for')
    expect(flow.hidden).toBe(false)

    render(root, {
      entries: [user, { ...reply, continuationBlocks: [
        { kind: 'tool', id: 'follow-read', toolName: 'Read', toolKind: 'read', summary: 'notes.md', status: 'done', startedAt, completedAt: now }
      ] }],
      session: { status: 'waiting', waiting: true, connectionPhase: 'waiting' }
    })
    const settledRow = container.querySelector<HTMLElement>('.chat-row--continuation')!
    expect(settledRow).toBe(liveRow)
    expect(settledRow.querySelector('.cursor-native-process__flow')).toBe(flow)
    expect(flow.hidden).toBe(true)
    expect(settledRow.querySelector('.cursor-native-process__summary')?.textContent).toBe('Worked for 1m 0s')
  })

  it('does not keep counting a continuation while the long-lived Cursor turn is waiting for messages', () => {
    const now = Date.parse('2026-09-25T12:00:00+08:00')
    vi.setSystemTime(now)
    const reply: ConversationEntry = {
      id: 'reply:r1', channelId: '1', role: 'assistant', source: 'cursor', text: '已接手',
      timestamp: now - 2 * 60_000, status: 'complete', replyToEntryId: user.id
    }
    // Cursor 的长期原生 turn 在 check_messages 待命时仍可能报告 generating。
    // 协议席位已经 waiting，旧过程不能因此被重新判成业务工作。
    render(root, {
      entries: [user, reply],
      session: { status: 'waiting', waiting: true, connectionPhase: 'waiting' },
      liveProcess: { turn: 'cursor:long', startedAt: now - 60_000, updatedAt: now,
        generating: true, blocks: [{ kind: 'tool', id: 'follow-read', toolName: 'Read', toolKind: 'read',
          summary: 'notes.md', status: 'done', startedAt: now - 60_000, completedAt: now }] }
    })
    const heading = container.querySelector<HTMLElement>('.chat-row--continuation .cursor-native-process__summary')!
    expect(heading.textContent).toBe('Worked for 1m 0s')
    act(() => { vi.advanceTimersByTime(2 * 60 * 60_000) })
    expect(heading.textContent).toBe('Worked for 1m 0s')
  })

  it('does not keep counting an explicitly stopped seat with a stale streaming process', () => {
    const now = Date.parse('2026-09-25T12:00:00+08:00')
    vi.setSystemTime(now)
    render(root, {
      entries: [user],
      session: { online: false, connected: false, status: 'offline', waiting: false, runtimeEvidence: 'stopped' },
      liveProcess: { turn: 'cursor:stale', startedAt: now - 60_000, updatedAt: now,
        generating: true, blocks: [{ kind: 'thinking', id: 'stale-thinking', text: '已结束的过程', status: 'running',
          startedAt: now - 60_000 }] }
    })
    const heading = container.querySelector<HTMLElement>('.cursor-native-process__summary')!
    expect(heading.textContent).toBe('Worked')
    expect(container.querySelector('.cursor-native-process')?.className).toContain('is-done')
    expect(container.querySelector('.cursor-native-thought.is-running')).toBeNull()
    act(() => { vi.advanceTimersByTime(2 * 60 * 60_000) })
    expect(heading.textContent).toBe('Worked')
  })

  it('keeps an older continuation settled when another message starts work in the same native turn', () => {
    const now = Date.parse('2026-09-25T12:00:00+08:00')
    vi.setSystemTime(now)
    const firstUser = { ...user, timestamp: now - 5 * 60_000, deliveredAt: now - 5 * 60_000 }
    const reply: ConversationEntry = {
      id: 'reply:r1', channelId: '1', role: 'assistant', source: 'cursor', text: '第一轮完成',
      timestamp: now - 4 * 60_000, status: 'complete', replyToEntryId: firstUser.id
    }
    const nextUser: ConversationEntry = {
      id: 'outbox:u2', channelId: '1', role: 'user', source: 'desktop', text: '第二轮开始',
      timestamp: now - 60_000, deliveredAt: now - 60_000, status: 'complete'
    }
    render(root, {
      entries: [firstUser, reply, nextUser],
      liveProcess: { turn: 'cursor:long', startedAt: now - 5 * 60_000, updatedAt: now,
        generating: true, blocks: [
          { kind: 'tool', id: 'old-read', toolName: 'Read', toolKind: 'read', summary: 'old.md', status: 'done',
            startedAt: now - 3 * 60_000, completedAt: now - 2.5 * 60_000 },
          { kind: 'thinking', id: 'new-thought', text: '第二轮工作中', status: 'running', startedAt: now - 30_000 }
        ] }
    })
    const oldHeading = container.querySelector<HTMLElement>('.chat-row--continuation .cursor-native-process__summary')!
    expect(oldHeading.textContent).toBe('Worked for 30s')
    expect(container.querySelector<HTMLElement>('.chat-row--continuation .cursor-native-process__flow')?.hidden).toBe(true)
    expect(container.textContent).toContain('Working for 30s')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(oldHeading.textContent).toBe('Worked for 30s')
  })
})
