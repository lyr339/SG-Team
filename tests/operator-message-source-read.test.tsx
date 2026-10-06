// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import { TextEncoder } from 'node:util'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { operatorMessageNativeFields, operatorMessageNotificationDigest } from '../src/domain/operator-message-read'
import { useOperatorMessageNotificationRead } from '../src/renderer/src/notifications/use-operator-message-notification-read'
import { operatorMessageResultElement } from '../src/renderer/src/notifications/operator-message-result-element'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { reduceOperatorMessages } from '../src/domain/team-message-notification'
import type { TeamMessage } from '../src/domain/team-collaboration'
import type { NotificationPage, NotificationPush, NotificationRecord } from '../src/domain/notification'
const notificationScope = { workspaceId: 'workspace-a', runId: 'run-a', groupId: 'group-a' }
const scope = { ...notificationScope, scoped: true }
const message: TeamMessage = { id: 'native-message', runId: scope.runId, groupId: scope.groupId, threadId: 'native-thread', clientMessageId: 'original-client-message', createdAt: 1,
  kind: 'question', sender: { type: 'agent', slotId: 'original-slot' }, recipient: { type: 'operator' }, content: 'Original rendered body. Not copied into the private digest or receipt.',
  receipt: { notificationState: 'not_required', notificationDetail: 'original receipt', updatedAt: 1 } }
const subject = 'Original native subject'
const digest = (message: TeamMessage, subject?: string) => createHash('sha256').update(JSON.stringify(operatorMessageNativeFields(message, subject))).digest('hex')
function Workspace({ original = message, current = scope, topic = subject }: { original?: TeamMessage; current?: typeof scope; topic?: string }) {
  const ref = useRef<HTMLDivElement>(null), proof = useOperatorMessageNotificationRead(ref, original, current, topic)
  return <section role="dialog" aria-modal="true"><div ref={ref} data-notification-operator-message={original.id} data-notification-operator-kind={original.kind}
    data-notification-operator-workspace={current.workspaceId} data-notification-operator-run={current.runId} data-notification-operator-group={current.groupId}
    data-notification-operator-digest={proof}>Original message body.</div></section>
}
let host: HTMLDivElement, root: Root, ledger: SqliteNotificationRepository, record: NotificationRecord, push!: (event: NotificationPush) => void
let api: { getNotificationPage: ReturnType<typeof vi.fn>; readNotification: ReturnType<typeof vi.fn>; onNotificationChanged: ReturnType<typeof vi.fn> }
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('TextEncoder', TextEncoder); vi.spyOn(window, 'crypto', 'get').mockReturnValue(webcrypto as unknown as Crypto)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 70, top: 100, bottom: 170, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) })
  ledger = new SqliteNotificationRepository(':memory:')
  const projection = reduceOperatorMessages(undefined, { key: 'fixture', facts: [{ id: message.id, kind: message.kind, sender: 'original member', subject, scope: notificationScope, at: message.createdAt, digest: digest(message, subject) }], now: 1 }, true, 1)
  ledger.commitSource('fixture', 0, projection.state, projection.drafts, 1); record = ledger.page().records[0]!
  api = { getNotificationPage: vi.fn(async query => ledger.page(query)), readNotification: vi.fn(async input => ledger.read(input.id, input.revision, 2)),
    onNotificationChanged: vi.fn(listener => { push = listener; return vi.fn() }) }
  window.sgDesktop = api as never
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); ledger.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (window as unknown as { sgDesktop?: unknown }).sgDesktop })
async function settleProof() {
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 20)) })
}
it('reads the exact visible original message with the persisted native digest even when the event id has a rebase suffix', async () => {
  api.getNotificationPage.mockImplementation(async query => ({ ...ledger.page(query), records: [{ ...record, eventId: `${record.eventId}:data:7`, storageEpoch: 2 }], storageEpoch: 2 }))
  await act(async () => root.render(<Workspace />)); await settleProof()
  expect(api.getNotificationPage).toHaveBeenCalledWith({ key: record.key, eventType: 'team.operator-message', filter: 'unread', limit: 1, readCursor: 'start' })
  expect(api.readNotification).toHaveBeenCalledOnce(); expect(api.readNotification).toHaveBeenCalledWith({ id: record.id, revision: record.revision, storageEpoch: 2 })
  expect(operatorMessageResultElement(document, record)).toBe(host.querySelector('[data-notification-operator-message]'))
  expect(message.receipt.readAt).toBeUndefined(); expect(message.receipt.respondedAt).toBeUndefined()
})
it('a changed subject, same-CH/different scope, actor, kind or creation identity cannot acknowledge the stored older native fact', async () => {
  for (const props of [{ topic: 'changed native subject' }, { current: { ...scope, workspaceId: 'other-workspace' } }, { current: { ...scope, runId: 'other-run' } },
    { original: { ...message, kind: 'response' as const } }, { original: { ...message, sender: { type: 'agent' as const, slotId: 'other-slot' } } }, { original: { ...message, createdAt: 2 } }]) {
    await act(async () => root.render(<Workspace {...props} />)); await settleProof()
    expect(api.readNotification).not.toHaveBeenCalled(); expect(operatorMessageResultElement(document, record)).toBeUndefined()
  }
})
it('legacy/fixed event ids and expired missing-record notices are retained for explicit center reading, not guessed from a matching body id', async () => {
  for (const changed of [{ ...record, eventId: record.key }, { ...record, state: 'expired' as const, subjectState: 'prior-data' }, { ...record, eventId: `${record.eventId}:arbitrary` }]) {
    await act(async () => root.render(null)); api.getNotificationPage.mockResolvedValue({ ...ledger.page(), records: [changed] })
    await act(async () => root.render(<Workspace />)); await settleProof()
    expect(api.readNotification).not.toHaveBeenCalled()
  }
})
it('cryptographic thin metadata preparation never reads original body or Agent receipt getters and invalid/missing crypto leaves unread without a fallback probe', async () => {
  const original = { ...message }, body = vi.fn(() => { throw Error('body getter must not be inspected') }), receipt = vi.fn(() => { throw Error('receipt getter must not be inspected') })
  Object.defineProperty(original, 'content', { get: body }); Object.defineProperty(original, 'receipt', { get: receipt })
  await act(async () => root.render(<Workspace original={original} />)); await settleProof()
  expect(api.readNotification).toHaveBeenCalledOnce(); expect(body).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled()
  await act(async () => root.render(null)); api.readNotification.mockClear(); api.getNotificationPage.mockClear()
  vi.spyOn(window, 'crypto', 'get').mockReturnValue({} as Crypto)
  await act(async () => root.render(<Workspace />)); await settleProof()
  expect(api.getNotificationPage).not.toHaveBeenCalled(); expect(api.readNotification).not.toHaveBeenCalled()
})
it('actual visibility/focus and a covering newer modal remain required after the proof is ready', async () => {
  const focus = vi.mocked(document.hasFocus); focus.mockReturnValue(false)
  await act(async () => root.render(<Workspace />)); await settleProof()
  expect(api.getNotificationPage).not.toHaveBeenCalled()
  focus.mockReturnValue(true)
  const modal = document.createElement('section'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
  try { await act(async () => window.dispatchEvent(new Event('focus'))); expect(api.readNotification).not.toHaveBeenCalled() } finally { modal.remove() }
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(api.readNotification).toHaveBeenCalledOnce()
})
it('a pending old private lookup after selecting another native message cannot read either the old selection or the new unmatched result', async () => {
  let resolve!: (value: NotificationPage) => void
  api.getNotificationPage.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => root.render(<Workspace />)); await settleProof()
  await act(async () => root.render(<Workspace original={{ ...message, id: 'another-native' }} />)); await settleProof()
  await act(async () => resolve(ledger.page()))
  expect(api.readNotification).not.toHaveBeenCalled()
})
it.each(['workspace', 'run', 'group', 'kind'])('a committed DOM %s boundary blocks a late private page even before passive hook cleanup', async field => {
  let resolve!: (value: NotificationPage) => void
  api.getNotificationPage.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => root.render(<Workspace />)); await settleProof()
  const element = host.querySelector<HTMLElement>('[data-notification-operator-message]')!
  element.setAttribute(`data-notification-operator-${field}`, `other-${field}`)
  await act(async () => resolve(ledger.page()))
  expect(api.readNotification).not.toHaveBeenCalled()
})
it('a deferred WebCrypto proof after unmount cannot attach a reader or fetch private records', async () => {
  let resolve!: (value: ArrayBuffer) => void
  vi.spyOn(window.crypto.subtle, 'digest').mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => root.render(<Workspace />))
  await act(async () => root.render(null))
  await act(async () => resolve(new Uint8Array(32).buffer))
  expect(api.getNotificationPage).not.toHaveBeenCalled(); expect(api.readNotification).not.toHaveBeenCalled()
})
it('a notification committed after the original selected body was visible is read through the existing live push, without another original query or receipt mutation', async () => {
  api.getNotificationPage.mockResolvedValue({ ...ledger.page(), records: [] })
  await act(async () => root.render(<Workspace />)); await settleProof()
  expect(api.readNotification).not.toHaveBeenCalled()
  await act(async () => push({ health: 'ready', historyIncomplete: false, change: { changed: true, record, summary: ledger.page().summary } }))
  expect(api.readNotification).toHaveBeenCalledOnce(); expect(api.getNotificationPage).toHaveBeenCalledOnce()
  expect(operatorMessageNotificationDigest(record)).toBe(digest(message, subject))
})
