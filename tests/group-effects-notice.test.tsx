// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { GroupEffectsNotice } from '../src/renderer/src/notifications/GroupEffectsNotice'
import { useGroupEffectNotes } from '../src/renderer/src/notifications/use-group-effect-notes'
import type { NotificationRecord, NotificationPush } from '../src/domain/notification'
const record: NotificationRecord = {
  id: 'rec',
  key: 'group-effects:fixture',
  eventId: 'group-effects:fixture:result',
  eventType: 'group.effects',
  subjectState: 'partial',
  category: 'team',
  source: '组后续',
  title: '原关系已返回，释放未确认',
  detail: '原任务释放结果未确认。原调用不会自动重做。',
  tone: 'warning',
  attention: 'notice',
  state: 'active',
  scope: { workspaceId: 'w', runId: 'r', groupId: 'g' },
  occurredAt: 1,
  createdAt: 1,
  updatedAt: 1,
  sourceRevision: 1,
  revision: 1,
  attentionRevision: 1,
  readRevision: 0
}
let host: HTMLDivElement, root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    toJSON() {
      return {}
    }
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  delete (window as unknown as { sgDesktop?: unknown }).sgDesktop
})
it('a compact local diagnostic can be expanded and only reads the exact displayed milestone; it never offers replay or group actions', async () => {
  const read = vi.fn(async () => ({ changed: false, summary: {} })),
    retry = vi.fn()
  ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
    getNotificationPage: async () => ({ records: [record] }),
    readNotification: read,
    onNotificationChanged: () => () => {},
    retryGroup: retry
  }
  await act(async () => root.render(<GroupEffectsNotice record={record} />))
  expect(read).toHaveBeenCalledExactlyOnceWith({ id: 'rec', revision: 1 })
  expect(document.querySelector('details')?.open).toBe(false)
  expect(document.querySelectorAll('.group-effects-notice button')).toHaveLength(0)
  await act(async () => document.querySelector('summary')!.click())
  expect(document.querySelector('details')?.open).toBe(true)
  expect(document.body.textContent).toContain('不会自动重做')
  expect(retry).not.toHaveBeenCalled()
})
it('a one-run private pull cannot replace a newer pushed diagnostic with stale data or leak it into another run', async () => {
  let listener!: (event: NotificationPush) => void, resolve!: (v: unknown) => void
  const api = {
    getNotificationPage: vi.fn(
      () =>
        new Promise((r) => {
          resolve = r
        })
    ),
    onNotificationChanged: (fn: typeof listener) => {
      listener = fn
      return () => {}
    }
  }
  ;(window as unknown as { sgDesktop: unknown }).sgDesktop = api
  function View({ run }: { run: string }) {
    const notes = useGroupEffectNotes('w', run)
    return <span>{notes.get('g')?.title ?? 'no note'}</span>
  }
  await act(async () => root.render(<View run="r" />))
  await act(async () =>
    listener({
      health: 'ready',
      historyIncomplete: false,
      change: {
        changed: true,
        record: { ...record, revision: 3, updatedAt: 3, title: 'newest' },
        summary: { revision: 3, total: 1, unread: 1, pending: 0, clearable: 0 }
      }
    })
  )
  await act(async () => resolve({ records: [record], reset: false }))
  expect(host.textContent).toBe('newest')
  await act(async () => root.render(<View run="other" />))
  expect(host.textContent).toBe('no note')
  expect(api.getNotificationPage).toHaveBeenCalledTimes(2)
})
