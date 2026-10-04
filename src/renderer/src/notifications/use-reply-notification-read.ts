import { useEffect, type RefObject } from 'react'
import { notificationIsUnread, type NotificationRecord, type NotificationScope } from '../../../domain/notification'
import type { ConversationEntry } from '../../../domain/conversation-entry'
import { notificationElementVisible } from './notification-visible'
import { notificationSessionScopeMatches } from './notification-session-scope'

/** One workspace observer, not a notification subscription per historical message. No rendered state is updated. */
export function useReplyNotificationRead(ref: RefObject<HTMLElement | null>, scope: NotificationScope, entries: readonly ConversationEntry[]): void {
  const { sessionId, channelId, generation, composerId, bindingGeneration } = scope
  useEffect(() => {
    const viewport = ref.current, api = window.sgDesktop
    if (!viewport || !sessionId || typeof api?.getNotificationPage !== 'function' || typeof api.onNotificationChanged !== 'function') return
    const current = { sessionId, channelId, generation, composerId, bindingGeneration }
    const statuses = new Map(entries.filter(entry => !entry.silent && entry.role === 'assistant' && (entry.status === 'complete' || entry.status === 'failed')).map(entry => [entry.id, entry.status]))
    const elements = new Map<string, HTMLElement>()
    for (const element of viewport.querySelectorAll<HTMLElement>('[data-notification-reply]')) if (statuses.has(element.dataset.notificationReply!)) elements.set(element.dataset.notificationReply!, element)
    const queried = new Set<string>(), fetching = new Set<string>(), reading = new Set<string>(), acknowledged = new Map<string, number>()
    const records = new Map<string, NotificationRecord>()
    let active = true, frame: number | undefined
    const matches = (record: NotificationRecord) => (record.eventType === 'session.reply' || record.eventType === 'queue.state' && record.subjectState === 'replied') && record.target?.kind === 'session'
      && notificationSessionScopeMatches(record.scope, current) && statuses.get(record.target.entryId ?? '') === (record.eventType === 'queue.state' ? 'complete' : record.subjectState)
    const read = async (record: NotificationRecord): Promise<void> => {
      if (!active || !matches(record) || !notificationIsUnread(record) || reading.has(record.id) || (acknowledged.get(record.id) ?? -1) >= record.attentionRevision) return
      const element = elements.get(record.target!.kind === 'session' ? record.target!.entryId ?? '' : '')
      if (!element || !notificationElementVisible(element)) return
      reading.add(record.id)
      try {
        const result = await api.readNotification({ id: record.id, revision: record.revision })
        if (active) {
          if (result.changed || result.record && result.record.readRevision >= record.attentionRevision) acknowledged.set(record.id, record.attentionRevision)
          if (!result.record && !result.changed) records.delete(record.id)
          if (result.record && result.record.revision > (records.get(record.id)?.revision ?? -1)) records.set(record.id, result.record)
        }
      } catch { /* Retain unread on failure; another real source event/focus can retry. */ }
      finally {
        reading.delete(record.id)
        const latest = records.get(record.id)
        if (active && latest && latest.revision > record.revision) void read(latest)
      }
    }
    const accept = (record: NotificationRecord): void => {
      if (!matches(record) || (records.get(record.id)?.revision ?? -1) > record.revision) return
      records.set(record.id, record); void read(record)
    }
    const inspect = (): void => {
      if (!active) return
      for (const record of records.values()) void read(record)
      for (const [entryId, element] of elements) {
        if (queried.has(entryId) || fetching.has(entryId) || !notificationElementVisible(element)) continue
        fetching.add(entryId)
        void api.getNotificationPage({ sessionId, entryId, category: 'sessions', limit: 5 }).then(page => {
          if (!active) return
          queried.add(entryId); page.records.forEach(accept)
        }).catch(() => {}).finally(() => fetching.delete(entryId))
      }
    }
    const schedule = (): void => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; inspect() }) }
    const stop = api.onNotificationChanged(event => { if (event.change?.record) accept(event.change.record) })
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(schedule, { root: viewport, threshold: [0, .5, 1] }) : undefined
    for (const element of elements.values()) observer?.observe(element)
    viewport.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('focus', schedule); inspect()
    return () => { active = false; stop(); observer?.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); viewport.removeEventListener('scroll', schedule); window.removeEventListener('focus', schedule) }
  }, [ref, sessionId, channelId, generation, composerId, bindingGeneration, entries])
}
