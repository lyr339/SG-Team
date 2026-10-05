// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamMemoryInspectionDialog } from '../src/renderer/src/notifications/TeamMemoryInspectionDialog'
import { notificationSourceHarness } from './notification-source-fixtures'
import type { TeamMemoryInspection } from '../src/domain/team-memory-inspection'
import type { NotificationPush } from '../src/domain/notification'
import { memoryInspectionMatches } from '../src/domain/team-memory-inspection'
const request = {
  workspaceId: 'w',
  runId: 'r',
  memoryId: 'm',
  version: 2,
  groupId: 'g'
}
const initial: TeamMemoryInspection = {
  revision: 4,
  observedAt: Date.now(),
  item: {
    id: 'm',
    workspaceId: 'w',
    runId: 'r',
    scope: 'run',
    kind: 'decision',
    title: '原记忆标题',
    content: '这一段完整正文只在原记录查看器中显示',
    version: 2,
    status: 'proposed',
    groupId: 'g',
    supersedesId: 'prior',
    proposedBy: { type: 'agent', slotId: 'a' },
    sources: [{ type: 'file', ref: 'src/example.ts', label: '原文件' }],
    createdAt: 1,
    updatedAt: 2
  },
  predecessor: {
    id: 'prior',
    groupId: 'g',
    workspaceId: 'w',
    runId: 'r',
    scope: 'run',
    kind: 'decision',
    title: '旧版本',
    content: '前置条目正文',
    version: 1,
    status: 'superseded',
    supersededById: 'other',
    proposedBy: { type: 'agent', slotId: 'b' },
    sources: [],
    createdAt: 1,
    updatedAt: 2
  }
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
    top: 0,
    left: 0,
    right: 500,
    bottom: 400,
    width: 500,
    height: 400,
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
describe('memory inspection reads exact original facts without review authority', () => {
  it('reading an actionable conflict only reads its human notification; no approve/reject/Agent receipt is exposed', async () => {
    const h = notificationSourceHarness(),
      key = 'memory-test'
    h.ledger.put(
      {
        key,
        eventType: 'memory.issue',
        subjectState: 'conflict',
        category: 'team',
        source: '共享记忆',
        title: '需要核对',
        tone: 'warning',
        attention: 'action',
        state: 'active',
        scope: {
          workspaceId: 'w',
          runId: 'r',
          groupId: 'g',
          memoryId: 'm',
          memoryVersion: '2'
        },
        occurredAt: 1,
        sourceRevision: 1
      },
      1
    )
    const read = vi.fn(async (value: { id: string; revision: number }) =>
        h.owner.read(value.id, value.revision)
      ),
      fetch = vi.fn(async () => initial),
      review = vi.fn()
    ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
      getTeamMemoryInspection: fetch,
      getNotificationPage: async () => h.owner.page(),
      readNotification: read,
      onNotificationChanged: () => () => {},
      reviewMemory: review
    }
    try {
      await act(async () =>
        root.render(<TeamMemoryInspectionDialog request={request} initial={initial} onClose={() => {}} />)
      )
      expect(read).toHaveBeenCalledOnce()
      expect(h.ledger.page().summary.pending).toBe(1)
      expect(review).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.memory-inspection button')].map(
        (button) => button.textContent
      )
      expect(buttons.some((label) => label === '采纳' || label === '驳回')).toBe(false)
      expect(document.body.textContent).toContain('这一段完整正文')
      expect(JSON.stringify(h.ledger.page())).not.toContain('这一段完整正文')
    } finally {
      await h.owner.close()
    }
  })
  it('explicit rereading cannot replace the pinned original with a wrong version/workspace, and Escape/focus restore remain local', async () => {
    const opener = document.createElement('button')
    host.append(opener)
    opener.focus()
    const onClose = vi.fn(),
      fetch = vi.fn(async () => ({
        ...initial,
        item: { ...initial.item, workspaceId: 'other' }
      }))
    ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
      getTeamMemoryInspection: fetch
    }
    await act(async () =>
      root.render(<TeamMemoryInspectionDialog request={request} initial={initial} onClose={onClose} />)
    )
    const refresh = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '重新读取'
    )!
    await act(async () => refresh.click())
    expect(fetch).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('保留上次内容')
    expect(document.body.textContent).toContain('原记忆标题')
    expect(
      memoryInspectionMatches(request, {
        ...initial,
        item: { ...initial.item, version: 3 }
      })
    ).toBe(false)
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(onClose).toHaveBeenCalledOnce()
  })
})

const reviewable = (): TeamMemoryInspection => ({
  ...initial,
  canReview: true,
  predecessor: undefined,
  operatorReview: {
    messageId: 'original-request',
    createdAt: 1,
    reason: 'no-reviewer'
  },
  item: { ...initial.item, supersedesId: undefined }
})
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.memory-inspection button')].find(
    (value) => value.textContent === label
  )!
const typeNote = async (value: string) => {
  await act(async () => {
    const element = document.querySelector<HTMLTextAreaElement>('.memory-inspection textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('an explicit human review is not a notification read or an automatic action', () => {
  it('seeing a proposal cannot mark a different original operator request read while its exact private projection is still pending', async () => {
    const h = notificationSourceHarness(),
      value = reviewable(),
      read = vi.fn(async (ref: { id: string; revision: number }) => h.owner.read(ref.id, ref.revision))
    const draft = {
      key: 'memory-request-alignment',
      eventType: 'memory.issue',
      subjectState: 'operator-review',
      category: 'team' as const,
      source: '共享记忆',
      title: '真实原请求',
      tone: 'warning' as const,
      attention: 'action' as const,
      state: 'active' as const,
      scope: {
        workspaceId: request.workspaceId,
        runId: request.runId,
        groupId: request.groupId,
        memoryId: request.memoryId,
        memoryVersion: String(request.version),
        operatorRequestId: 'older-original-request'
      },
      occurredAt: 1,
      eventId: 'request:older'
    }
    h.ledger.put({ ...draft, sourceRevision: 1 }, 1)
    ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
      getNotificationPage: async () => h.owner.page(),
      readNotification: read,
      onNotificationChanged: (fn: (value: NotificationPush) => void) => h.owner.subscribe(fn)
    }
    try {
      await act(async () =>
        root.render(<TeamMemoryInspectionDialog request={request} initial={value} onClose={() => {}} />)
      )
      expect(read).not.toHaveBeenCalled()
      expect(h.ledger.page().summary.unread).toBe(1)
      await act(async () => {
        h.owner.offerCurrent({
          ...draft,
          eventId: 'request:current',
          scope: { ...draft.scope, operatorRequestId: value.operatorReview!.messageId }
        })
        await h.owner.flush()
      })
      expect(read).toHaveBeenCalledOnce()
      expect(h.ledger.page().summary).toMatchObject({ unread: 0, pending: 1 })
    } finally {
      await act(async () => root.render(null))
      await h.owner.close()
    }
  })
  it.each([
    ['采纳…', '确认采纳', 'accept', 'accepted'],
    ['驳回…', '确认驳回', 'reject', 'rejected']
  ] as const)(
    'requires separate confirmation for %s and issues only one original call during rapid repeat clicks',
    async (openLabel, confirmLabel, decision, status) => {
      const value = reviewable()
      let finish!: (result: import('../src/domain/team-memory-inspection').TeamMemoryReviewResult) => void
      const review = vi.fn(
        () =>
          new Promise<import('../src/domain/team-memory-inspection').TeamMemoryReviewResult>((resolve) => {
            finish = resolve
          })
      )
      ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
        reviewTeamMemory: review,
        getTeamMemoryInspection: vi.fn(async () => value)
      }
      await act(async () =>
        root.render(<TeamMemoryInspectionDialog request={request} initial={value} onClose={() => {}} />)
      )
      expect(review).not.toHaveBeenCalled()
      await act(async () => button(openLabel).click())
      expect(review).not.toHaveBeenCalled()
      expect(document.activeElement?.tagName).toBe('TEXTAREA')
      await typeNote('需要保留在原条目的审核附言')
      await act(async () => {
        const confirm = button(confirmLabel)
        confirm.click()
        confirm.click()
      })
      expect(review).toHaveBeenCalledOnce()
      expect(review.mock.calls[0]).toEqual([
        expect.objectContaining({
          ...request,
          confirmed: true,
          decision,
          note: '需要保留在原条目的审核附言',
          notificationId: expect.any(String)
        })
      ])
      expect(button('提交中…').disabled).toBe(true)
      await act(async () =>
        finish({
          inspection: {
            ...value,
            canReview: false,
            item: { ...value.item, status }
          },
          conclusion: status
        })
      )
      expect(document.body.textContent).toContain(status === 'accepted' ? '原记忆已采纳' : '原记忆已驳回')
      expect(document.querySelector('textarea')).toBeNull()
      expect(button('采纳…')).toBeUndefined()
      expect(button('驳回…')).toBeUndefined()
      expect(document.activeElement?.getAttribute('role')).toBe('status')
    }
  )
  it('cancel only closes the confirmation and preserves its note; an unknown result retains input, disables resubmission, and requires a fresh read', async () => {
    const value = reviewable(),
      review = vi.fn(async () => {
        throw Error('unknown transport result')
      }),
      fetch = vi.fn(async () => value)
    ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
      reviewTeamMemory: review,
      getTeamMemoryInspection: fetch
    }
    await act(async () =>
      root.render(<TeamMemoryInspectionDialog request={request} initial={value} onClose={() => {}} />)
    )
    await act(async () => button('采纳…').click())
    await typeNote('附言不能被迟到错误清空')
    await act(async () => button('先不审核').click())
    expect(review).not.toHaveBeenCalled()
    await act(async () => button('驳回…').click())
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('附言不能被迟到错误清空')
    await act(async () => button('确认驳回').click())
    expect(review).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('不会自动重试')
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('附言不能被迟到错误清空')
    expect(button('确认驳回').disabled).toBe(true)
    await act(async () => button('确认驳回').click())
    expect(review).toHaveBeenCalledOnce()
    await act(async () => button('重新读取').click())
    expect(fetch).toHaveBeenCalledOnce()
    expect(document.querySelector('textarea')).toBeNull()
    await act(async () => button('驳回…').click())
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('附言不能被迟到错误清空')
    expect(review).toHaveBeenCalledOnce()
  })
  it('a known committed conclusion with pending refresh is not described as a failed review and cannot be repeated', async () => {
    const value = reviewable(),
      review = vi.fn(async () => ({
        conclusion: 'accepted' as const,
        inspectionPending: true,
        inspection: {
          ...value,
          canReview: false,
          item: { ...value.item, status: 'accepted' as const }
        }
      }))
    ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
      reviewTeamMemory: review
    }
    await act(async () =>
      root.render(<TeamMemoryInspectionDialog request={request} initial={value} onClose={() => {}} />)
    )
    await act(async () => button('采纳…').click())
    await act(async () => button('确认采纳').click())
    expect(document.body.textContent).toContain('原记忆已采纳')
    expect(document.body.textContent).toContain('原记录刷新仍待核对')
    expect(button('采纳…')).toBeUndefined()
    expect(review).toHaveBeenCalledOnce()
  })
  it.each(['conflict', 'unconfirmed'] as const)(
    'does not expose adoption for a %s predecessor, while a separately confirmed rejection remains possible',
    async (state) => {
      const value = {
          ...initial,
          canReview: true,
          ...(state === 'unconfirmed' ? { predecessor: undefined } : {})
        },
        review = vi.fn(async () => ({
          inspection: {
            ...initial,
            canReview: false,
            item: { ...initial.item, status: 'rejected' as const }
          }
        }))
      ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
        reviewTeamMemory: review
      }
      await act(async () =>
        root.render(<TeamMemoryInspectionDialog request={request} initial={value} onClose={() => {}} />)
      )
      expect(button('采纳…').disabled).toBe(true)
      await act(async () => button('采纳…').click())
      expect(document.querySelector('textarea')).toBeNull()
      await act(async () => button('驳回…').click())
      await act(async () => button('确认驳回').click())
      expect(review).toHaveBeenCalledOnce()
    }
  )
  it('closing during a submitted review does not cancel or repeat the command; its late result cannot reopen the modal or steal focus', async () => {
    const value = reviewable()
    let finish!: (result: import('../src/domain/team-memory-inspection').TeamMemoryReviewResult) => void
    const review = vi.fn(
      () =>
        new Promise<import('../src/domain/team-memory-inspection').TeamMemoryReviewResult>((resolve) => {
          finish = resolve
        })
    )
    ;(window as unknown as { sgDesktop: unknown }).sgDesktop = {
      reviewTeamMemory: review
    }
    const onClose = vi.fn()
    await act(async () =>
      root.render(<TeamMemoryInspectionDialog request={request} initial={value} onClose={onClose} />)
    )
    await act(async () => button('采纳…').click())
    await act(async () => button('确认采纳').click())
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(onClose).toHaveBeenCalledOnce()
    await act(async () => root.render(null))
    const next = document.createElement('button')
    host.append(next)
    next.focus()
    await act(async () =>
      finish({
        inspection: {
          ...value,
          canReview: false,
          item: { ...value.item, status: 'accepted' }
        },
        conclusion: 'accepted'
      })
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(next)
    expect(review).toHaveBeenCalledOnce()
    expect(host.inert).toBeFalsy()
  })
})
