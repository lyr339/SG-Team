import { useEffect, type RefObject } from 'react'
import type { NotificationScope } from '../../../domain/notification'
import { notificationSessionScopeMatches } from './notification-session-scope'
import { observeSourceNotificationRead } from './observe-source-read'

export function useQuestionNotificationRead(ref: RefObject<HTMLElement | null>, scope: NotificationScope | undefined, toolCallId: string, status: string): void {
  const sessionId = scope?.sessionId, channelId = scope?.channelId, generation = scope?.generation, composerId = scope?.composerId, bindingGeneration = scope?.bindingGeneration
  useEffect(() => {
    const element = ref.current, api = window.sgDesktop
    if (!element || !sessionId || typeof api?.getNotificationPage !== 'function' || typeof api.onNotificationChanged !== 'function') return
    return observeSourceNotificationRead(element, api, { sessionId, toolCallId, category: 'sessions', limit: 5 }, record =>
      record.eventType === 'question.state' && record.subjectState === status && record.target?.kind === 'session' && record.target.toolCallId === toolCallId
      && notificationSessionScopeMatches(record.scope, { sessionId, channelId, generation, composerId, bindingGeneration }))
  }, [ref, sessionId, channelId, generation, composerId, bindingGeneration, toolCallId, status])
}
