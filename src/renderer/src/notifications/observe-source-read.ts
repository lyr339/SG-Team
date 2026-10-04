import { notificationIsUnread, type NotificationQuery, type NotificationRecord } from '../../../domain/notification'
import type { SgDesktopApi } from '../../../shared/desktop-api'
import { notificationElementVisible } from './notification-visible'

/** Exact-result read receipts; visibility changes reuse cached facts rather than polling IPC while scrolling. */
export function observeSourceNotificationRead(element: HTMLElement, api: Pick<SgDesktopApi, 'getNotificationPage' | 'readNotification' | 'onNotificationChanged'>,
  query: NotificationQuery, matches: (record: NotificationRecord) => boolean, identityVisible: () => boolean = () => true): () => void {
  let active = true, queried = false, fetching = false, frame: number | undefined
  const candidates = new Map<string, NotificationRecord>(), pending = new Set<string>(), acknowledged = new Map<string, number>()
  const visible = () => active && identityVisible() && notificationElementVisible(element)
  const read = async (record: NotificationRecord): Promise<void> => {
    if (!matches(record) || !visible() || !notificationIsUnread(record) || pending.has(record.id) || (acknowledged.get(record.id) ?? -1) >= record.attentionRevision) return
    pending.add(record.id)
    try {
      const result = await api.readNotification({ id: record.id, revision: record.revision })
      if (active) {
        if (result.changed || result.record && result.record.readRevision >= record.attentionRevision) acknowledged.set(record.id, record.attentionRevision)
        if (!result.record && !result.changed) candidates.delete(record.id)
        if (result.record && matches(result.record) && result.record.revision > (candidates.get(record.id)?.revision ?? -1)) candidates.set(record.id, result.record)
      }
    } catch { /* Failed human read remains unread; it never turns into a business retry or another toast. */ }
    finally {
      pending.delete(record.id)
      const latest = candidates.get(record.id)
      if (active && latest && latest.revision > record.revision) void read(latest)
    }
  }
  const accept = (record: NotificationRecord): void => {
    if (!active || !matches(record) || (candidates.get(record.id)?.revision ?? -1) > record.revision) return
    candidates.set(record.id, record); void read(record)
  }
  const inspect = (): void => {
    if (!visible()) return
    for (const record of candidates.values()) void read(record)
    if (queried || fetching) return
    fetching = true
    void api.getNotificationPage(query).then(page => { if (active) { queried = true; page.records.forEach(accept) } }).catch(() => {}).finally(() => { fetching = false })
  }
  const schedule = (): void => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; inspect() }) }
  const focus = (): void => { queried = false; inspect() }
  const stop = api.onNotificationChanged(event => { if (event.change?.record) accept(event.change.record) })
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(schedule, { threshold: [0, .01, .1, .5, 1] }) : undefined
  observer?.observe(element); window.addEventListener('focus', focus); document.addEventListener('scroll', schedule, true); inspect()
  return () => { active = false; stop(); observer?.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); window.removeEventListener('focus', focus); document.removeEventListener('scroll', schedule, true) }
}
