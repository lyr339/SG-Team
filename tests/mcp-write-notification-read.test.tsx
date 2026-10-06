// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessTurnCard } from '../src/renderer/src/ProcessTurnCard'
import { useMcpWriteNotificationRead } from '../src/renderer/src/notifications/use-mcp-write-notification-read'
import { mcpWriteResultElement } from '../src/renderer/src/notifications/mcp-write-result-element'
import type { NotificationPage, NotificationPush, NotificationRecord, NotificationScope } from '../src/domain/notification'
import type { ProcessBlockTool } from '../src/domain/conversation-entry'
import { observedMcpWrite } from '../src/domain/mcp-write-observation'

const scope: NotificationScope = { sessionId: 'desktop-session', channelId: '1', generation: '0', composerId: 'composer-a', bindingGeneration: 'bind-a', workspaceId: 'workspace', runId: 'run', slotId: 'slot' }
const block: ProcessBlockTool = { kind: 'tool', id: 'cursor:tool', toolKind: 'mcp', toolName: 'mcp-SG Team-team_memory', status: 'done', input: { action: 'review', channel_id: '1', memoryId: 'm' },
  output: JSON.stringify({ ok: false, agentSessionId: 'runtime-agent', code: 'internal_error', sgWriteFailure: { version: 1, reason: 'storage' }, message: 'original native result' }) }
const record: NotificationRecord = { id: 'n1', key: 'mcp-write:tool', eventId: 'mcp-write:tool', eventType: 'mcp.write-result', subjectState: 'unconfirmed', category: 'team', source: '协作工具', title: '记忆写入结果待核对',
  scope, target: { kind: 'session', scope, blockId: block.id, mcpWrite: observedMcpWrite(block.toolName, block.input, block.output)! }, attention: 'notice', state: 'active', tone: 'warning', sourceRevision: 1, occurredAt: 100, createdAt: 100, updatedAt: 100, revision: 1, attentionRevision: 1, readRevision: 0 }
const page = (records = [record]): NotificationPage => ({ records, summary: { revision: 1, total: records.length, pending: 0, unread: records.length, clearable: 0 }, reset: false })
function Workspace({ current = scope, original = block }: { current?: NotificationScope; original?: ProcessBlockTool }) {
  const ref = useRef<HTMLDivElement>(null)
  useMcpWriteNotificationRead(ref, current)
  return <div ref={ref} style={{ overflow: 'auto' }} data-notification-mcp-scope="" data-notification-session={current.sessionId} data-notification-channel={current.channelId}
    data-notification-generation={current.generation} data-notification-composer={current.composerId} data-notification-binding={current.bindingGeneration}
    data-notification-workspace={current.workspaceId} data-notification-run={current.runId} data-notification-slot={current.slotId}>
    <ProcessTurnCard id="native" blocks={[original]} compact defaultOpen />
  </div>
}
describe('one scoped native output read observer, not one subscription per process block', () => {
  let host: HTMLDivElement, root: Root, push: (value: NotificationPush) => void
  let api: { getNotificationPage: ReturnType<typeof vi.fn>; readNotification: ReturnType<typeof vi.fn>; onNotificationChanged: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers(); vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 70, top: 100, bottom: 170, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) })
    api = { getNotificationPage: vi.fn(async () => page()), readNotification: vi.fn(async () => ({ changed: true, summary: page().summary, record: { ...record, readRevision: 1 } })),
      onNotificationChanged: vi.fn(listener => { push = listener; return () => {} }) }
    Object.assign(window, { sgDesktop: api })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
  const expand = async () => {
    await act(async () => (host.querySelector('[data-step-id] button') as HTMLButtonElement).click())
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(30) })
  }
  it('does not query/read a collapsed header or input; actual native output expansion queries once and reads its exact result', async () => {
    await act(async () => root.render(<Workspace />))
    expect(api.getNotificationPage).not.toHaveBeenCalled(); expect(api.readNotification).not.toHaveBeenCalled()
    expect(mcpWriteResultElement(host, record)).toBeUndefined()
    await expand()
    expect(api.onNotificationChanged).toHaveBeenCalledOnce()
    expect(api.getNotificationPage).toHaveBeenCalledOnce()
    expect(api.getNotificationPage).toHaveBeenCalledWith({ sessionId: scope.sessionId, eventType: 'mcp.write-result', filter: 'unread', limit: 100, readCursor: 'start' })
    expect(api.readNotification).toHaveBeenCalledWith({ id: 'n1', revision: 1 })
    const element = mcpWriteResultElement(host, record)!
    expect(element.tagName).toBe('PRE'); expect(element.textContent).toContain('original native result')
    await act(async () => { for (let i = 0; i < 50; i++) document.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(30) })
    expect(api.getNotificationPage).toHaveBeenCalledOnce(); expect(api.readNotification).toHaveBeenCalledOnce()
  })
  it('cached results are read only after expansion, never while clipped, inside a background viewport, or below a different modal', async () => {
    await act(async () => root.render(<Workspace />))
    await act(async () => push({ health: 'ready', historyIncomplete: false, change: { changed: true, record, summary: page().summary } }))
    expect(api.readNotification).not.toHaveBeenCalled()
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function(this: HTMLElement) {
      const top = this.hasAttribute('data-notification-mcp-block') ? 1500 : 100
      return { width: 300, height: 70, top, bottom: top + 70, left: 10, right: 310, x: 10, y: top, toJSON: () => ({}) }
    })
    await expand(); expect(api.readNotification).not.toHaveBeenCalled()
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 300, height: 70, top: 100, bottom: 170, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) })
    const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
    try { await act(async () => window.dispatchEvent(new Event('focus'))); expect(api.readNotification).not.toHaveBeenCalled() } finally { modal.remove() }
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(api.readNotification).toHaveBeenCalledOnce()
  })
  it('neither another binding nor a newly successful native output can consume an old unconfirmed attempt', async () => {
    await act(async () => root.render(<Workspace current={{ ...scope, composerId: 'new-composer', bindingGeneration: 'new-binding' }} />))
    await expand(); expect(api.readNotification).not.toHaveBeenCalled(); expect(mcpWriteResultElement(host, record)).toBeUndefined()
    await act(async () => root.render(<Workspace original={{ ...block, output: JSON.stringify({ ok: true, agentSessionId: 'runtime-agent', action: 'review', memory: { id: 'm' } }) }} />))
    expect(mcpWriteResultElement(host, record)).toBeUndefined()
    await act(async () => push({ health: 'ready', historyIncomplete: false, change: { changed: true, record, summary: page().summary } }))
    expect(api.readNotification).not.toHaveBeenCalled()
  })
  it('late old private queries cannot read after scope switch; raw assistant prose never becomes an MCP result marker', async () => {
    let resolve!: (value: NotificationPage) => void
    api.getNotificationPage.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await act(async () => root.render(<Workspace />)); await expand()
    await act(async () => root.render(<Workspace current={{ ...scope, runId: 'new-run' }} />))
    await act(async () => resolve(page()))
    expect(api.readNotification).not.toHaveBeenCalled()
    await act(async () => root.render(<Workspace original={{ ...block, toolKind: 'command', toolName: 'run_terminal_command' }} />))
    expect(mcpWriteResultElement(host, record)).toBeUndefined()
  })
  it('derives receipt metadata from original JSON even when the display formatter expands escaped error newlines', async () => {
    const original = { ...block, output: JSON.stringify({ ...JSON.parse(block.output!), message: 'original line one\noriginal line two' }) }
    await act(async () => root.render(<Workspace original={original} />)); await expand()
    expect(mcpWriteResultElement(host, record)?.textContent).toContain('original line two')
    expect(api.readNotification).toHaveBeenCalledWith({ id: 'n1', revision: 1 })
  })
  it('same block/status but a different native failure reason, actor or entity is not the visible original receipt', async () => {
    for (const patch of [{ reason: 'permission' as const }, { agentSessionId: 'another-agent' }, { entity: { kind: 'memory' as const, id: 'different-memory' } }]) {
      await act(async () => root.render(null)); api.readNotification.mockClear()
      api.getNotificationPage.mockResolvedValue(page([{ ...record, target: { ...record.target as Extract<NotificationRecord['target'], { kind: 'session' }>, mcpWrite: { ...observedMcpWrite(block.toolName, block.input, block.output)!, ...patch } } }]))
      await act(async () => root.render(<Workspace />)); await expand()
      expect(api.readNotification).not.toHaveBeenCalled()
    }
  })
  it('legacy diagnostics without native proof are still readable explicitly in the center, not automatically by a same-status original output', async () => {
    api.getNotificationPage.mockResolvedValue(page([{ ...record, target: { kind: 'session', scope, blockId: block.id } }]))
    await act(async () => root.render(<Workspace />)); await expand()
    expect(api.readNotification).not.toHaveBeenCalled()
  })
})
