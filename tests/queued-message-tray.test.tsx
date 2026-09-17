// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { QUEUE_TRAY_COLLAPSED_KEY, QueuedMessageTray, queuePreview, queueTrayState } from '../src/renderer/src/QueuedMessageTray'

const session: AgentSession = {
  id: 'session-2', channelId: '2', generation: 1, displayName: '架构实现', roleName: '实现席',
  status: 'running', currentTask: '', queueDepth: 0, connectionPhase: 'processing',
  online: true, connected: true, waiting: false, deliveryMode: 'queued', workingFiles: [], healthEvidence: []
}

const plain: ConversationEntry = {
  id: 'outbox:a', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
  timestamp: new Date(2026, 8, 4, 20, 5).getTime(), text: '先把队列托盘收尾'
}
const held: ConversationEntry = {
  id: 'outbox:b', channelId: '2', role: 'user', source: 'desktop', status: 'complete',
  timestamp: new Date(2026, 8, 4, 20, 6).getTime(), text: '【会话交接】来自 CH-1', heldForNextSession: true,
  attachments: [{ id: 'att', name: 'a.png', mimeType: 'image/png', size: 10 }]
}

describe('QueuedMessageTray（待投递托盘）', () => {
  it('renders nothing when there is nothing waiting to be delivered', () => {
    expect(renderToStaticMarkup(<QueuedMessageTray session={session} entries={[]} />)).toBe('')
  })

  it('lists queued messages with count, state, held marker and per-item actions', () => {
    const html = renderToStaticMarkup(
      <QueuedMessageTray
        session={{ ...session, queueDepth: 3 }}
        entries={[plain, held]}
        onWithdraw={() => {}}
        onRelease={() => {}}
      />
    )
    // 数字口径 = 服务端计数（含 1 条内部静默消息），列表口径 = 用户可见条目，差值如实注明。
    expect(html).toContain('待投递 <b>3</b>')
    expect(html).toContain('另有 1 条系统内部消息在队列中')
    expect(html).toContain('queue-tray is-busy is-open')
    expect(html).toContain('Agent 正在处理当前任务：新消息按顺序等待')
    expect(html).toContain('先把队列托盘收尾')
    expect(html).toContain('1 个附件')
    expect(html).toContain('queue-tray__item is-held')
    expect(html).toContain('1 条等待新会话')
    expect(html).toContain('data-entry-id="outbox:b"')
    // 撤回对每条可用，放行只对保持位消息出现。
    expect(html.match(/>撤回</g)?.length).toBe(2)
    expect(html.match(/>放行</g)?.length).toBe(1)
    expect(html).toContain('aria-expanded="true"')
  })

  it('keeps a one-line note when only internal silent messages are queued', () => {
    const html = renderToStaticMarkup(<QueuedMessageTray session={{ ...session, queueDepth: 2 }} entries={[]} />)
    expect(html).toContain('待投递 <b>2</b>')
    expect(html).toContain('2 条系统内部消息在队列中，不显示正文。')
    expect(html).not.toContain('queue-tray__list')
    // 没有可展开的列表：头部不是开合控件。
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('aria-expanded')
  })

  it('describes the delivery state from presence, not from the transport', () => {
    expect(queueTrayState({ online: false, waiting: false })).toEqual({ tone: 'offline', text: 'Agent 离线：消息保留在本地队列，恢复轮询后按顺序送达' })
    expect(queueTrayState({ online: true, waiting: true })).toEqual({ tone: 'waiting', text: 'Agent 正在监听：下一条消息会立即投递' })
    expect(queueTrayState({ online: true, waiting: false })).toEqual({ tone: 'busy', text: 'Agent 正在处理当前任务：新消息按顺序等待' })
  })

  it('collapses whitespace and clips long previews, naming attachment-only messages', () => {
    expect(queuePreview('  多行\n\n文本   合并  ')).toBe('多行 文本 合并')
    expect(queuePreview('')).toBe('（仅附件）')
    const long = 'x'.repeat(200)
    expect(queuePreview(long)).toHaveLength(161)
    expect(queuePreview(long).endsWith('…')).toBe(true)
  })

  describe('interaction', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      localStorage.clear()
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    })

    afterEach(async () => {
      await act(async () => root.unmount())
      container.remove()
      localStorage.clear()
    })

    it('toggles the list from the header and keeps the header while collapsed', () => {
      act(() => { root.render(<QueuedMessageTray session={{ ...session, queueDepth: 1 }} entries={[plain]} />) })
      const head = container.querySelector<HTMLButtonElement>('.queue-tray__head')!
      const wrap = container.querySelector<HTMLDivElement>('.queue-tray__listwrap')!
      expect(wrap.hasAttribute('inert')).toBe(false)
      act(() => { head.click() })
      // 列表常驻（收起走高度过渡动画），交互与读屏由 inert 挡掉。
      expect(container.querySelector('.queue-tray__list')).not.toBeNull()
      expect(wrap.hasAttribute('inert')).toBe(true)
      expect(container.querySelector('.queue-tray')?.className).toContain('is-collapsed')
      expect(head.getAttribute('aria-expanded')).toBe('false')
      expect(container.textContent).toContain('待投递')
      act(() => { head.click() })
      expect(wrap.hasAttribute('inert')).toBe(false)
      expect(container.querySelector('.queue-tray')?.className).toContain('is-open')
    })

    it('persists the collapse preference like the turn-files bar below it', async () => {
      act(() => { root.render(<QueuedMessageTray session={{ ...session, queueDepth: 1 }} entries={[plain]} />) })
      act(() => { container.querySelector<HTMLButtonElement>('.queue-tray__head')!.click() })
      expect(localStorage.getItem(QUEUE_TRAY_COLLAPSED_KEY)).toBe('1')
      await act(async () => root.unmount())
      root = createRoot(container)
      act(() => { root.render(<QueuedMessageTray session={{ ...session, queueDepth: 1 }} entries={[plain]} />) })
      expect(container.querySelector('.queue-tray')?.className).toContain('is-collapsed')
      act(() => { container.querySelector<HTMLButtonElement>('.queue-tray__head')!.click() })
      expect(localStorage.getItem(QUEUE_TRAY_COLLAPSED_KEY)).toBe('0')
    })

    it('routes withdraw and release to the right entry', () => {
      const onWithdraw = vi.fn()
      const onRelease = vi.fn()
      act(() => {
        root.render(<QueuedMessageTray session={{ ...session, queueDepth: 2 }} entries={[plain, held]} onWithdraw={onWithdraw} onRelease={onRelease} />)
      })
      const heldItem = container.querySelector('[data-entry-id="outbox:b"]')!
      act(() => { heldItem.querySelector<HTMLButtonElement>('button:not(.is-danger)')!.click() })
      expect(onRelease).toHaveBeenCalledWith('outbox:b')
      act(() => { container.querySelector<HTMLButtonElement>('[data-entry-id="outbox:a"] button.is-danger')!.click() })
      expect(onWithdraw).toHaveBeenCalledWith('outbox:a')
      expect(onWithdraw).toHaveBeenCalledTimes(1)
    })
  })
})
