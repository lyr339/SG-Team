// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useQuestionNotificationRead } from '../src/renderer/src/notifications/use-question-notification-read'
import type { NotificationRecord } from '../src/domain/notification'

it('visible raw question content does not auto-read a separate original/history comparison as if it proved the business status', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const scope = { sessionId: 'session', channelId: '1', generation: '0', composerId: 'composer', bindingGeneration: 'binding', workspaceId: 'workspace', runId: 'run' }
  const record: NotificationRecord = { id: 'comparison', key: 'question-recheck:original', eventType: 'question.original-recheck', subjectState: 'original-pending',
    category: 'sessions', scope, target: { kind: 'session', scope, toolCallId: 'tool', blockId: 'block' }, source: '问卷', title: '原问卷状态需要核对', attention: 'action', state: 'active', tone: 'warning',
    occurredAt: 100, createdAt: 100, updatedAt: 100, sourceRevision: 1, revision: 1, attentionRevision: 1, readRevision: 0 }
  const read = vi.fn(async () => ({})), query = vi.fn(async () => ({ records: [record], summary: { revision: 1, unread: 1, total: 1, pending: 1, clearable: 0 }, reset: false }))
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, top: 10, left: 10, right: 310, bottom: 90, width: 300, height: 80, toJSON: () => ({}) })
  Object.assign(window, { sgDesktop: { getNotificationPage: query, readNotification: read, onNotificationChanged: () => () => {} } })
  function Question() { const ref = useRef<HTMLDivElement>(null); useQuestionNotificationRead(ref, scope, 'tool', 'pending'); return <div ref={ref}>原生待回答内容</div> }
  try { await act(async () => root.render(<Question />)); expect(query).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled() }
  finally { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); delete (window as unknown as { sgDesktop?: unknown }).sgDesktop }
})
