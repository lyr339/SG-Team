// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamMemoryInspectionDialog } from '../src/renderer/src/notifications/TeamMemoryInspectionDialog'
import { notificationSourceHarness } from './notification-source-fixtures'
import type { TeamMemoryInspection } from '../src/domain/team-memory-inspection'
import { memoryInspectionMatches } from '../src/domain/team-memory-inspection'
const request = { workspaceId: 'w', runId: 'r', memoryId: 'm', version: 2, groupId: 'g' }
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
        scope: { workspaceId: 'w', runId: 'r', groupId: 'g', memoryId: 'm', memoryVersion: '2' },
        occurredAt: 1,
        sourceRevision: 1
      },
      1
    )
    const read = vi.fn(async (value: { id: string; revision: number }) => h.owner.read(value.id, value.revision)),
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
      await act(async () => root.render(<TeamMemoryInspectionDialog request={request} initial={initial} onClose={() => {}} />))
      expect(read).toHaveBeenCalledOnce()
      expect(h.ledger.page().summary.pending).toBe(1)
      expect(review).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.memory-inspection button')].map((button) => button.textContent)
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
      fetch = vi.fn(async () => ({ ...initial, item: { ...initial.item, workspaceId: 'other' } }))
    ;(window as unknown as { sgDesktop: unknown }).sgDesktop = { getTeamMemoryInspection: fetch }
    await act(async () => root.render(<TeamMemoryInspectionDialog request={request} initial={initial} onClose={onClose} />))
    const refresh = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '重新读取')!
    await act(async () => refresh.click())
    expect(fetch).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('保留上次内容')
    expect(document.body.textContent).toContain('原记忆标题')
    expect(memoryInspectionMatches(request, { ...initial, item: { ...initial.item, version: 3 } })).toBe(false)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
