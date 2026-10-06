// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalSourceNotice } from '../src/renderer/src/notifications/LocalSourceNotice'
import type { NotificationPage, NotificationPush, NotificationRecord } from '../src/domain/notification'

const model: NotificationRecord = {
  id: 'model-incident', key: 'model-catalog:' + '1'.repeat(64), eventId: 'model-failed-1', eventType: 'cursor.model-catalog',
  subjectState: 'unconfirmed', scope: {}, category: 'maintenance', source: 'Cursor · 模型目录', title: '本机模型目录持续读取异常',
  detail: '原目录无法验证；不会切换模型或重跑读取。', target: { kind: 'settings', section: 'maintenance' },
  state: 'active', tone: 'warning', attention: 'notice', revision: 10, attentionRevision: 10, readRevision: 0,
  sourceRevision: 1, occurredAt: 100, createdAt: 100, updatedAt: 100
}
const usage: NotificationRecord = { ...model, id: 'usage-incident', key: 'usage-storage:write:' + '2'.repeat(64),
  eventId: 'usage-failed', eventType: 'usage.storage-write', category: 'storage', source: '统计 · 本机用量记录',
  title: '用量记录保存未确认', detail: '新的保存未确认，不代表模型目录有问题。', target: { kind: 'settings', section: 'stats' }, revision: 11 }
const runtime: NotificationRecord = { ...usage, id: 'runtime-incident', key: 'usage-runtime:' + '3'.repeat(64),
  eventId: 'runtime-read-failed', eventType: 'usage.runtime-source', category: 'maintenance', source: '统计 · 原生运行时入口',
  title: '用量补位读数尚未确认', detail: '正常没有精确回合结算不算异常。这里仅记录原读取持续异常。' }
function page(...records: NotificationRecord[]): NotificationPage {
  return { records, summary: { revision: Math.max(0, ...records.map(record => record.revision)), total: records.length, unread: records.length, pending: 0, clearable: 0 }, reset: false }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let host: HTMLDivElement, root: Root, listeners: Set<(event: NotificationPush) => void>, api: any
const push = (record: NotificationRecord, historyRevision = record.revision) => listeners.forEach(listener => listener({ health: 'ready', historyIncomplete: false,
  change: { changed: true, record, summary: { ...page(record).summary, revision: historyRevision } } }))
const reload = () => listeners.forEach(listener => listener({ health: 'ready', historyIncomplete: true, historyReload: true }))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); listeners = new Set()
  api = { getNotificationPage: vi.fn(async (query: any) => query.eventType === model.eventType || query.key === model.key ? page(model)
      : query.eventType === usage.eventType || query.key === usage.key ? page(usage)
      : query.eventType === runtime.eventType || query.key === runtime.key ? page(runtime) : page()),
    onNotificationChanged: vi.fn((listener: any) => { listeners.add(listener); return () => listeners.delete(listener) }),
    readNotification: vi.fn(async () => ({ changed: true, record: { ...model, readRevision: 10 }, summary: page(model).summary })) }
  Object.assign(window, { sgDesktop: api })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 90, top: 100, bottom: 190, left: 10, right: 310, x: 10, y: 100, toJSON: () => ({}) })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

it('uses one private query on the active maintenance page, leaves collapsed text unread and acknowledges only an actually expanded exact body', async () => {
  await act(async () => root.render(<LocalSourceNotice active={false} source="model-catalog" />))
  expect(api.getNotificationPage).not.toHaveBeenCalled()
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  expect(api.getNotificationPage).toHaveBeenCalledExactlyOnceWith({ eventType: 'cursor.model-catalog', limit: 1 })
  expect(host.querySelector('[data-notification-page]')?.getAttribute('data-notification-page')).toBe('account:maintenance')
  expect(host.textContent).toContain(model.title); expect(api.readNotification).not.toHaveBeenCalled()
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  expect(api.getNotificationPage).toHaveBeenCalledOnce()
  const details = host.querySelector('details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); await new Promise(requestAnimationFrame) })
  expect(api.readNotification).toHaveBeenCalledExactlyOnceWith({ id: model.id, revision: model.revision })
})

it('never carries one source body/read target into another section, including a delayed old pull', async () => {
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  const old = deferred<NotificationPage>(), current = deferred<NotificationPage>()
  api.getNotificationPage.mockImplementationOnce(() => old.promise)
  await act(async () => reload())
  api.getNotificationPage.mockImplementationOnce(() => current.promise)
  await act(async () => root.render(<LocalSourceNotice source="usage-storage" />))
  expect(host.textContent).not.toContain(model.title)
  await act(async () => old.resolve(page(model)))
  expect(host.textContent).not.toContain(model.title)
  await act(async () => current.resolve(page(usage)))
  expect(host.textContent).toContain(usage.title); expect(host.textContent).not.toContain(model.title)
  expect(api.readNotification).not.toHaveBeenCalled()
})

it('merges newer cause/recovery pushes ahead of a late older private snapshot without consuming unread', async () => {
  const old = deferred<NotificationPage>(); api.getNotificationPage.mockImplementationOnce(() => old.promise)
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  const changed = { ...model, revision: 12, eventId: 'model-new-cause', detail: '原目录超过读取上限。' }
  await act(async () => push(changed)); await act(async () => old.resolve(page(model)))
  expect(host.textContent).toContain(changed.detail); expect(api.readNotification).not.toHaveBeenCalled()
  await act(async () => push({ ...changed, revision: 13, state: 'resolved' }))
  expect(host.querySelector('details')).toBeNull()
})

it('rebases lower-revision restored private history and fences multiple reloads, without claiming business recovery or replaying a read', async () => {
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  const stale = deferred<NotificationPage>(), restored = deferred<NotificationPage>()
  api.getNotificationPage.mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => restored.promise)
  await act(async () => reload()); expect(host.querySelector('details')).toBeNull()
  await act(async () => reload())
  const lower = { ...model, revision: 2, eventId: 'restored-unknown', detail: '恢复的私有历史仅记录未确认状态。' }
  await act(async () => restored.resolve(page(lower)))
  await act(async () => stale.resolve(page(model)))
  expect(host.textContent).toContain(lower.detail); expect(host.textContent).not.toContain('已恢复')
  expect(api.readNotification).not.toHaveBeenCalled()
})

it('authoritative empty/archived reloads remove only local private history; later original source evidence can show a new incident', async () => {
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  api.getNotificationPage.mockResolvedValueOnce(page())
  await act(async () => reload())
  expect(host.textContent).toBe(''); expect(api.readNotification).not.toHaveBeenCalled()
  await act(async () => push({ ...model, revision: 20, eventId: 'new-real-failure' }))
  expect(host.textContent).toContain(model.title)
  api.getNotificationPage.mockResolvedValueOnce(page({ ...model, revision: 21, archivedAt: 200 }))
  await act(async () => reload()); expect(host.querySelector('details')).toBeNull()
})

it('accepts a real archive/read mutation with unchanged content revision, and a late earlier page cannot resurrect it', async () => {
  const old = deferred<NotificationPage>(); api.getNotificationPage.mockImplementationOnce(() => old.promise)
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  await act(async () => push({ ...model, readRevision: model.attentionRevision }, 11))
  expect(host.textContent).toContain(model.title)
  await act(async () => push({ ...model, readRevision: model.attentionRevision, archivedAt: 200 }, 12))
  await act(async () => old.resolve(page(model)))
  expect(host.querySelector('details')).toBeNull()
  await act(async () => push(model, 10))
  expect(host.querySelector('details')).toBeNull()
  await act(async () => push({ ...model, revision: 11, eventId: 'older-ledger-push' }, 11))
  expect(host.querySelector('details')).toBeNull()
})

it('handles recordless cleanup and preserves a new push while its empty query is in flight', async () => {
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  const empty = deferred<NotificationPage>(); api.getNotificationPage.mockImplementationOnce(() => empty.promise)
  await act(async () => { listeners.forEach(listener => listener({ health: 'ready', historyIncomplete: false, change: { changed: true, summary: page().summary } })) })
  await act(async () => push({ ...model, revision: 22, eventId: 'later-real-failure', detail: '清理后发生的新读取异常。' }))
  await act(async () => empty.resolve(page()))
  expect(host.textContent).toContain('清理后发生的新读取异常')
  api.getNotificationPage.mockResolvedValueOnce(page())
  await act(async () => { listeners.forEach(listener => listener({ health: 'ready', historyIncomplete: false, change: { changed: true, summary: page().summary } })) })
  expect(host.querySelector('details')).toBeNull()
})

it('ignores foreign targets, malformed keys, non-global scopes and unrelated revisions; stopped sources do not query or publish', async () => {
  api.getNotificationPage.mockResolvedValueOnce(page())
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  for (const invalid of [usage, { ...model, key: 'model-catalog:wrong' }, { ...model, scope: { sessionId: 'private-session' } },
    { ...model, target: { kind: 'settings' as const, section: 'stats' as const } }, { ...model, eventType: 'session.reply' }]) {
    await act(async () => push(invalid))
  }
  expect(host.querySelector('details')).toBeNull(); expect(api.getNotificationPage).toHaveBeenCalledOnce()
  await act(async () => root.render(<LocalSourceNotice active={false} source="model-catalog" />))
  expect(listeners.size).toBe(0)
  await act(async () => push(model)); expect(host.querySelector('details')).toBeNull()
})

it('a private query rejection stays quiet and never falls back to a model request or an operation button', async () => {
  api.getNotificationPage.mockRejectedValueOnce(Error('private worker unavailable'))
  await act(async () => root.render(<LocalSourceNotice source="model-catalog" />))
  expect(host.textContent).toBe(''); expect(host.querySelector('button')).toBeNull()
  expect(api.getNotificationPage).toHaveBeenCalledOnce(); expect(api.readNotification).not.toHaveBeenCalled()
})

it('places native runtime diagnostics only on statistics, keeps the closed body unread and does not confuse monitoring loss with recovery', async () => {
  await act(async () => root.render(<LocalSourceNotice source="usage-runtime" />))
  expect(api.getNotificationPage).toHaveBeenCalledExactlyOnceWith({ eventType: 'usage.runtime-source', limit: 1 })
  expect(host.querySelector('[data-notification-page]')?.getAttribute('data-notification-page')).toBe('account:stats')
  expect(host.textContent).toContain(runtime.title); expect(api.readNotification).not.toHaveBeenCalled()
  await act(async () => push({ ...runtime, revision: 12, state: 'expired', subjectState: 'monitor-unconfirmed', title: '原监测范围已变化' }))
  expect(host.querySelector('details')).toBeNull(); expect(api.readNotification).not.toHaveBeenCalled()
})
