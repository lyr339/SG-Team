// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReplyNotificationRead } from '../src/renderer/src/notifications/use-reply-notification-read'
import type { NotificationPage, NotificationPush, NotificationRecord, NotificationScope } from '../src/domain/notification'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { createHash } from 'node:crypto'
import { replyBodyMaterial } from '../src/domain/reply-body-proof'

const scope: NotificationScope = { sessionId: 'session-a', channelId: '1', generation: '0', composerId: 'composer-a', bindingGeneration: 'bind-a' }
const entry: ConversationEntry = { id: 'reply:a', channelId: '1', role: 'assistant', status: 'complete', text: '最终回答', source: 'cursor', timestamp: 100 }
const digest = (body: ConversationEntry, current = scope) => createHash('sha256').update(replyBodyMaterial(body.text, current)!).digest('hex')
const record: NotificationRecord = { id: 'n1', key: 'reply:logical-a', eventId: 'reply:logical-a:complete', eventType: 'session.reply', subjectState: 'complete', category: 'sessions', source: '会话', title: '有新回复',
  scope, target: { kind: 'session', scope, entryId: entry.id, replyBody: { version: 1, status: 'complete', digest: digest(entry) } }, attention: 'notice', state: 'resolved', tone: 'info', sourceRevision: 1, occurredAt: 100, createdAt: 100, updatedAt: 100, revision: 1, attentionRevision: 1, readRevision: 0 }
const page = (records = [record]): NotificationPage => ({ records, summary: { revision: 1, total: records.length, pending: 0, unread: records.length, clearable: 0 }, reset: false })
const entries = [entry]
function Workspace({ current = scope, body = entry }: { current?: NotificationScope; body?: ConversationEntry }) {
  const ref = useRef<HTMLDivElement>(null)
  useReplyNotificationRead(ref, current, body === entry ? entries : [body])
  return <div ref={ref} style={{ overflow: 'auto' }}><div data-entry-id={body.id}>过程步骤</div><div data-notification-reply={body.id} data-notification-reply-digest={digest(body, current)}
    data-notification-reply-status={body.status} data-notification-reply-source={body.source} data-notification-reply-channel={current.channelId} data-notification-reply-session={current.sessionId}
    data-notification-reply-generation={current.generation} data-notification-reply-composer={current.composerId} data-notification-reply-binding={current.bindingGeneration}>{body.text}</div></div>
}
describe('exact reply-body reading, without per-message store subscriptions', () => {
  let host: HTMLDivElement, root: Root, push: (value: NotificationPush) => void
  let api: { getNotificationPage: ReturnType<typeof vi.fn>; readNotification: ReturnType<typeof vi.fn>; onNotificationChanged: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 70, top: 100, bottom: 170, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) })
    api = { getNotificationPage: vi.fn(async () => page()), readNotification: vi.fn(async () => ({ changed: true })), onNotificationChanged: vi.fn(callback => { push = callback; return () => {} }) }
    window.sgDesktop = api as never
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); delete (window as unknown as { sgDesktop?: unknown }).sgDesktop })
  it('acknowledges the exact visible body and does not change conversation state', async () => {
    await act(async () => root.render(<Workspace />))
    expect(api.onNotificationChanged).toHaveBeenCalledOnce()
    expect(api.getNotificationPage).toHaveBeenCalledWith({ sessionId: scope.sessionId, category: 'sessions', filter: 'unread', limit: 100, readCursor: 'start' })
    expect(api.readNotification).toHaveBeenCalledWith({ id: 'n1', revision: 1 })
    expect(entry.status).toBe('complete')
  })
  it('the process card being visible while its final reply is below the scrollport does not consume unread', async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.notificationReply ? 1_000 : 100
      return { width: 300, height: 70, top, bottom: top + 70, left: 10, right: 310, x: 10, y: top, toJSON: () => ({}) }
    })
    await act(async () => root.render(<Workspace />))
    expect(api.getNotificationPage).not.toHaveBeenCalled(); expect(api.readNotification).not.toHaveBeenCalled()
    await act(async () => push({ health: 'ready', historyIncomplete: false, change: { changed: true, record, summary: page().summary } }))
    expect(api.readNotification).not.toHaveBeenCalled()
  })
  it('an old Composer/binding on the same channel cannot acknowledge a replacement session result', async () => {
    await act(async () => root.render(<Workspace current={{ ...scope, composerId: 'composer-b', bindingGeneration: 'bind-b' }} />))
    expect(api.readNotification).not.toHaveBeenCalled()
  })
  it('a late old query never overwrites the newly pushed version', async () => {
    let resolve!: (value: NotificationPage) => void
    api.getNotificationPage.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await act(async () => root.render(<Workspace />))
    const latest = { ...record, revision: 2, attentionRevision: 2 }
    await act(async () => push({ health: 'ready', historyIncomplete: false, change: { changed: true, record: latest, summary: { ...page().summary, revision: 2 } } }))
    await act(async () => resolve(page()))
    expect(api.readNotification).toHaveBeenCalledOnce(); expect(api.readNotification).toHaveBeenCalledWith({ id: 'n1', revision: 2 })
  })
  it('the same native ID and complete status with a replaced body cannot acknowledge the old result', async () => {
    await act(async () => root.render(<Workspace body={{ ...entry, text: '这是恢复或修改后另一段正文，不能算阅读旧结果。' }} />))
    expect(api.readNotification).not.toHaveBeenCalled()
  })
  it('legacy/no-proof records and recovery imports are not silently read from a matching ID', async () => {
    api.getNotificationPage.mockResolvedValue(page([{ ...record, target: { kind: 'session', scope, entryId: entry.id } }]))
    await act(async () => root.render(<Workspace />)); expect(api.readNotification).not.toHaveBeenCalled()
    await act(async () => root.render(null)); api.getNotificationPage.mockResolvedValue(page())
    await act(async () => root.render(<Workspace body={{ ...entry, source: 'recovery' }} />)); expect(api.readNotification).not.toHaveBeenCalled()
  })
  it('a legacy current comparison still requires explicit center reading even when its current digest is visible', async () => {
    api.getNotificationPage.mockResolvedValue(page([{ ...record, subjectState: 'legacy-comparison' }]))
    await act(async () => root.render(<Workspace />)); expect(api.readNotification).not.toHaveBeenCalled()
  })
  it('the companion queue acknowledgement needs the exact original outbox association, not just a reused reply ID', async () => {
    const target = { kind: 'session' as const, scope, entryId: entry.id, queueEntryId: 'outbox:expected' }
    const queue = { ...record, eventType: 'queue.state', subjectState: 'replied', target }
    api.getNotificationPage.mockResolvedValue(page([queue]))
    await act(async () => root.render(<Workspace body={{ ...entry, replyToEntryId: 'outbox:other' }} />)); expect(api.readNotification).not.toHaveBeenCalled()
    await act(async () => root.render(<Workspace body={{ ...entry, replyToEntryId: 'outbox:expected' }} />)); expect(api.readNotification).toHaveBeenCalledOnce()
  })
})
