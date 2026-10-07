// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, webcrypto } from 'node:crypto'
import { TurnResponseText } from '../src/renderer/src/TurnResponseText'
import { replyBodyMaterial } from '../src/domain/reply-body-proof'
import { replyBodyTargetElement } from '../src/renderer/src/notifications/reply-body-result-element'
import { revealInViewport } from '../src/renderer/src/inspector/reveal-bus'
import { useReplyNotificationRead } from '../src/renderer/src/notifications/use-reply-notification-read'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { NotificationTarget } from '../src/domain/notification'
const scope = { sessionId: 'session', channelId: '1', generation: '0', composerId: 'composer', bindingGeneration: 'binding', workspaceId: 'workspace', runId: 'run', slotId: 'slot' }
const original: ConversationEntry = { id: 'reply:source', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', text: '最终正文\n\n```python\n  return 1\n```', timestamp: 1000 }
const target = (entry = original): Extract<NotificationTarget, { kind: 'session' }> => ({ kind: 'session', scope, entryId: entry.id,
  replyBody: { version: 1, status: entry.status === 'failed' ? 'failed' : 'complete', digest: createHash('sha256').update(replyBodyMaterial(entry.text, scope)!).digest('hex') } })
describe('actual final-body DOM proof without altering playback or Markdown', () => {
  let host: HTMLDivElement, root: Root, cryptoBefore: PropertyDescriptor | undefined, scrollBefore: PropertyDescriptor | undefined
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    cryptoBefore = Object.getOwnPropertyDescriptor(window, 'crypto')
    Object.defineProperty(window, 'crypto', { configurable: true, value: webcrypto })
    Object.assign(window, { sgDesktop: { getNotificationPage: vi.fn(), onNotificationChanged: vi.fn() } })
    scrollBefore = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); if (cryptoBefore) Object.defineProperty(window, 'crypto', cryptoBefore)
    if (scrollBefore) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollBefore)
    else delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
    delete (window as unknown as { sgDesktop?: unknown }).sgDesktop; vi.restoreAllMocks(); vi.useRealTimers() })
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
  it('Node/WebCrypto identities agree and the exact final body can be revealed; same ID with another text cannot', async () => {
    await act(async () => root.render(<TurnResponseText turnKey="turn" reply={original} notificationScope={scope} />)); await settle()
    const body = replyBodyTargetElement(host, target())!
    expect(body).toBeDefined(); expect(body.textContent).toContain('return 1')
    expect(revealInViewport(host, { entryId: original.id, replyBody: target().replyBody, sessionScope: scope })).toBe(true)
    await act(async () => root.render(<TurnResponseText turnKey="turn" reply={{ ...original, text: '另一段正文' }} notificationScope={scope} />)); await settle()
    expect(replyBodyTargetElement(host, target())).toBeUndefined()
    expect(revealInViewport(host, { entryId: original.id, replyBody: target().replyBody, sessionScope: scope })).toBe(false)
  })
  it('does not compute or expose a final body proof while the player still has an unseen tail, then exposes it when playback finishes', async () => {
    vi.useFakeTimers(); const hashing = vi.spyOn(webcrypto.subtle, 'digest')
    await act(async () => root.render(<TurnResponseText turnKey="turn" live={{ id: 'live', channelId: '1', text: '', status: 'streaming', source: 'native', startedAt: 1000, updatedAt: 1000 }} notificationScope={scope} />))
    await act(async () => root.render(<TurnResponseText turnKey="turn" reply={original} notificationScope={scope} />))
    expect(hashing).not.toHaveBeenCalled(); expect(host.querySelector('[data-notification-reply-digest]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(hashing).toHaveBeenCalledOnce()
  })
  it('rejects late digests after the body changes and keeps hashing/render attributes stable across unchanged rerenders', async () => {
    const resolvers: Array<() => void> = [], hash = vi.fn(async (_algorithm: unknown, input: BufferSource) => new Promise<ArrayBuffer>(resolve => {
      const bytes = createHash('sha256').update(new Uint8Array(input as Uint8Array)).digest()
      resolvers.push(() => resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
    }))
    Object.defineProperty(window, 'crypto', { configurable: true, value: { subtle: { digest: hash } } })
    await act(async () => root.render(<TurnResponseText turnKey="turn" reply={original} notificationScope={scope} />))
    const newer = { ...original, text: 'new final' }
    await act(async () => root.render(<TurnResponseText turnKey="turn" reply={newer} notificationScope={scope} />))
    await act(async () => resolvers[0]!()); expect(host.querySelector('[data-notification-reply-digest]')).toBeNull()
    await act(async () => resolvers[1]!()); expect(replyBodyTargetElement(host, target(newer))).toBeDefined()
    for (let i = 0; i < 50; i++) await act(async () => root.render(<TurnResponseText turnKey="turn" reply={newer} notificationScope={{ ...scope }} />))
    expect(hash).toHaveBeenCalledTimes(2)
  })
  it('the one workspace read observer discovers the real body that gains its digest AFTER observer initialization', async () => {
    const read = vi.fn(async () => ({ changed: true })), query = vi.fn(async () => ({ records: [{ id: 'body-notice', key: 'reply:fixture', eventType: 'session.reply', subjectState: 'complete', state: 'resolved',
      scope, target: target(), category: 'sessions', attention: 'notice', revision: 1, attentionRevision: 1, readRevision: 0 }],
      summary: { revision: 1, total: 1, unread: 1, pending: 0, clearable: 0 }, reset: false }))
    Object.assign(window, { sgDesktop: { getNotificationPage: query, readNotification: read, onNotificationChanged: () => () => {} } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, top: 10, left: 10, right: 310, bottom: 90, width: 300, height: 80, toJSON: () => ({}) })
    const entries = [original]
    function Workspace() { const ref = useRef<HTMLDivElement>(null); useReplyNotificationRead(ref, scope, entries)
      return <div ref={ref}><TurnResponseText turnKey="turn" reply={original} notificationScope={scope} /></div> }
    await act(async () => root.render(<Workspace />)); await settle()
    // The real observer deliberately inspects mutations on the next paint,
    // not in the Crypto promise. Wait for that exact scheduled UI boundary.
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); await Promise.resolve() })
    expect(query).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledWith({ id: 'body-notice', revision: 1 })
  })
  it('never stamps a foreign-channel body with the current viewport identity even if ID and text coincide', async () => {
    const hashing = vi.spyOn(webcrypto.subtle, 'digest')
    await act(async () => root.render(<TurnResponseText turnKey="turn" reply={{ ...original, channelId: '2' }} notificationScope={scope} />)); await settle()
    expect(hashing).not.toHaveBeenCalled(); expect(host.querySelector('[data-notification-reply]')).toBeNull()
  })
})
