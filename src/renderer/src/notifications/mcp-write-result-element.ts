import type { NotificationRecord, NotificationScope } from '../../../domain/notification'
import { notificationSessionScopeMatches } from './notification-session-scope'
import { mcpWriteReadIdentity } from '../../../domain/mcp-write-observation'

/** A visible header, another CH, or an old binding is not the original write result. */
export function mcpWriteResultElement(root: ParentNode, record: NotificationRecord): HTMLElement | undefined {
  if (record.eventType !== 'mcp.write-result' || record.subjectState === 'legacy-comparison' || record.target?.kind !== 'session' || !record.target.blockId || !record.target.mcpWrite) return
  for (const element of root.querySelectorAll<HTMLElement>('[data-notification-mcp-block]')) {
    if (element.dataset.notificationMcpBlock !== record.target.blockId || element.dataset.notificationMcpStatus !== record.subjectState
      || element.dataset.notificationMcpChannel !== record.scope.channelId || element.dataset.notificationMcpProof !== mcpWriteReadIdentity(record.target.mcpWrite)) continue
    const container = element.closest<HTMLElement>('[data-notification-mcp-scope]')
    if (!container) continue
    const d = container.dataset
    const current: NotificationScope = { sessionId: d.notificationSession, channelId: d.notificationChannel, generation: d.notificationGeneration,
      composerId: d.notificationComposer, bindingGeneration: d.notificationBinding }
    if (!notificationSessionScopeMatches(record.scope, current)) continue
    if (record.scope.workspaceId && record.scope.workspaceId !== d.notificationWorkspace || record.scope.runId && record.scope.runId !== d.notificationRun
      || record.scope.slotId && record.scope.slotId !== d.notificationSlot || record.scope.groupId && record.scope.groupId !== d.notificationGroup) continue
    return element
  }
}
