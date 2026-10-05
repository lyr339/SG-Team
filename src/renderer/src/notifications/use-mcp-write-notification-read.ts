import { useEffect, type RefObject } from 'react'
import type { NotificationScope } from '../../../domain/notification'
import { observeSourceNotificationRead } from './observe-source-read'
import { notificationSessionScopeMatches } from './notification-session-scope'
import { notificationElementVisible } from './notification-visible'
import { mcpWriteResultElement } from './mcp-write-result-element'

/** One viewport subscription, one private query after an actual output is expanded. */
export function useMcpWriteNotificationRead(ref: RefObject<HTMLElement | null>, scope: NotificationScope): void {
  const { sessionId, channelId, generation, composerId, bindingGeneration, workspaceId, runId, slotId, groupId } = scope
  useEffect(() => {
    const viewport = ref.current, api = window.sgDesktop
    if (!viewport || !sessionId || !composerId || !bindingGeneration || typeof api?.getNotificationPage !== 'function' || typeof api.onNotificationChanged !== 'function') return
    const current = { sessionId, channelId, generation, composerId, bindingGeneration }
    return observeSourceNotificationRead(viewport, api, { sessionId, eventType: 'mcp.write-result', filter: 'unread', limit: 100 },
      record => record.eventType === 'mcp.write-result' && record.target?.kind === 'session' && notificationSessionScopeMatches(record.scope, current)
        && (!record.scope.workspaceId || record.scope.workspaceId === workspaceId) && (!record.scope.runId || record.scope.runId === runId)
        && (!record.scope.slotId || record.scope.slotId === slotId) && (!record.scope.groupId || record.scope.groupId === groupId),
      () => [...viewport.querySelectorAll<HTMLElement>('[data-notification-mcp-block]')].some(notificationElementVisible),
      { selector: '[data-notification-mcp-block]', attributes: ['data-notification-mcp-block', 'data-notification-mcp-status'],
        locate: record => mcpWriteResultElement(viewport, record) })
  }, [ref, sessionId, channelId, generation, composerId, bindingGeneration, workspaceId, runId, slotId, groupId])
}
