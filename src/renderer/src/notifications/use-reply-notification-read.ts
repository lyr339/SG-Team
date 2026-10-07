import { useEffect, type RefObject } from 'react'
import type { NotificationScope } from '../../../domain/notification'
import type { ConversationEntry } from '../../../domain/conversation-entry'
import { notificationElementVisible } from './notification-visible'
import { notificationSessionScopeMatches } from './notification-session-scope'
import { observeSourceNotificationRead } from './observe-source-read'
import { replyBodyResultElement } from './reply-body-result-element'
import { nativeAssistantEntry } from '../../../domain/native-assistant-entry'

/** One workspace source observer, not one query/subscription per historical message. */
export function useReplyNotificationRead(ref: RefObject<HTMLElement | null>, scope: NotificationScope, entries: readonly ConversationEntry[]): void {
  const { sessionId, channelId, generation, composerId, bindingGeneration } = scope
  useEffect(() => {
    const viewport = ref.current, api = window.sgDesktop
    if (!viewport || !sessionId || typeof api?.getNotificationPage !== 'function' || typeof api.onNotificationChanged !== 'function') return
    const current = { sessionId, channelId, generation, composerId, bindingGeneration }
    const statuses = new Map(entries.filter(entry => !entry.silent && nativeAssistantEntry(entry, channelId ?? '') && (entry.status === 'complete' || entry.status === 'failed')).map(entry => [entry.id, entry.status]))
    const anchors = new Map(entries.filter(entry => nativeAssistantEntry(entry, channelId ?? '')).map(entry => [entry.id, entry.replyToEntryId]))
    // Crypto readiness changes attributes after this observer mounts. Keep the
    // single workspace observer, but never freeze its initial empty DOM list.
    const elements = () => [...viewport.querySelectorAll<HTMLElement>('[data-notification-reply]')].filter(element => statuses.has(element.dataset.notificationReply!))
    return observeSourceNotificationRead(viewport, api, { sessionId, category: 'sessions', filter: 'unread', limit: 100 }, record =>
      (record.eventType === 'session.reply' || record.eventType === 'queue.state' && record.subjectState === 'replied') && record.target?.kind === 'session'
      && notificationSessionScopeMatches(record.scope, current) && statuses.get(record.target.entryId ?? '') === (record.eventType === 'queue.state' ? 'complete' : record.target.replyBody?.status)
      && (record.eventType !== 'queue.state' || Boolean(record.target.queueEntryId && anchors.get(record.target.entryId ?? '') === record.target.queueEntryId)),
      () => elements().some(notificationElementVisible),
      { selector: '[data-notification-reply]', attributes: ['data-notification-reply', 'data-notification-reply-digest', 'data-notification-reply-status'],
        locate: record => { const target = record.target
          return record.eventType === 'session.reply' ? replyBodyResultElement(viewport, record)
            : target?.kind === 'session' ? elements().find(element => element.dataset.notificationReply === target.entryId) : undefined } })
  }, [ref, sessionId, channelId, generation, composerId, bindingGeneration, entries])
}
