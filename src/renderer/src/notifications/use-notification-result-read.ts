import { useEffect, type RefObject } from 'react'
import { notificationIsUnread, type NotificationRecord } from '../../../domain/notification'

/** Source pages acknowledge only their exact visible result. Not a route-wide "mark everything read" shortcut. */
export function useNotificationResultRead(ref: RefObject<HTMLElement | null>, key?: string, eventId?: string): void {
  useEffect(() => {
    const api = window.sgDesktop
    const element = ref.current
    if (!element || !key || !eventId || typeof api?.getNotificationPage !== 'function' || typeof api.onNotificationChanged !== 'function') return
    let active = true; let pending = false; let acknowledged = -1
    const visible = (): boolean => {
      if (!active || !element.isConnected || !document.hasFocus() || element.dataset.notificationKey !== key || element.dataset.notificationEvent !== eventId
        || document.querySelector('[role="dialog"][aria-modal="true"]')) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0) >= Math.min(rect.height, 48)
    }
    const read = async (record: NotificationRecord): Promise<void> => {
      if (pending || !visible() || record.key !== key || record.eventId !== eventId || !notificationIsUnread(record) || record.attentionRevision <= acknowledged) return
      pending = true
      try { await api.readNotification({ id: record.id, revision: record.revision }); if (active) acknowledged = record.attentionRevision }
      catch { /* Failed background acknowledgement stays unread; it never creates another toast. */ }
      finally { pending = false }
    }
    const inspect = (): void => {
      if (!visible() || pending) return
      void api.getNotificationPage({ key, limit: 1 }).then(page => { const record = page.records[0]; if (record) return read(record) }).catch(() => {})
    }
    const stop = api.onNotificationChanged(event => { if (event.change?.record) void read(event.change.record) })
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(inspect, { threshold: [0, .5, 1] }) : undefined
    observer?.observe(element)
    window.addEventListener('focus', inspect); inspect()
    return () => { active = false; stop(); observer?.disconnect(); window.removeEventListener('focus', inspect) }
  }, [ref, key, eventId])
}
