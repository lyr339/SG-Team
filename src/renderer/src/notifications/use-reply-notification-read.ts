import { useEffect, type RefObject } from 'react'
import type { NotificationScope } from '../../../domain/notification'
import type { ConversationEntry } from '../../../domain/conversation-entry'
import { notificationElementVisible } from './notification-visible'
import { notificationSessionScopeMatches } from './notification-session-scope'
import { observeSourceNotificationRead } from './observe-source-read'

/** One workspace source observer, not one query/subscription per historical message. */
export function useReplyNotificationRead(ref: RefObject<HTMLElement | null>, scope: NotificationScope, entries: readonly ConversationEntry[]): void {
  const { sessionId, channelId, generation, composerId, bindingGeneration } = scope
  useEffect(() => {
    const viewport = ref.current, api = window.sgDesktop
    if (!viewport || !sessionId || typeof api?.getNotificationPage !== 'function' || typeof api.onNotificationChanged !== 'function') return
    const current = { sessionId, channelId, generation, composerId, bindingGeneration }
    const statuses = new Map(entries.filter(entry => !entry.silent && entry.role === 'assistant' && (entry.status === 'complete' || entry.status === 'failed')).map(entry => [entry.id, entry.status]))
    const elements = new Map<string, HTMLElement>()
    for (const element of viewport.querySelectorAll<HTMLElement>('[data-notification-reply]')) if (statuses.has(element.dataset.notificationReply!)) elements.set(element.dataset.notificationReply!, element)
    return observeSourceNotificationRead(viewport, api, { sessionId, category: 'sessions', filter: 'unread', limit: 100 }, record =>
      (record.eventType === 'session.reply' || record.eventType === 'queue.state' && record.subjectState === 'replied') && record.target?.kind === 'session'
      && notificationSessionScopeMatches(record.scope, current) && statuses.get(record.target.entryId ?? '') === (record.eventType === 'queue.state' ? 'complete' : record.subjectState),
      () => [...elements.values()].some(notificationElementVisible),
      { selector: '[data-notification-reply]', attributes: ['data-notification-reply'],
        locate: record => record.target?.kind === 'session' ? elements.get(record.target.entryId ?? '') : undefined })
  }, [ref, sessionId, channelId, generation, composerId, bindingGeneration, entries])
}
