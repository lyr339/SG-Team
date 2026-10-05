import { notificationIsUnread, type NotificationQuery, type NotificationRecord } from '../../../domain/notification'
import type { SgDesktopApi } from '../../../shared/desktop-api'
import { notificationElementVisible } from './notification-visible'

/** Exact-result read receipts; visibility changes reuse cached facts rather than polling IPC while scrolling. */
export function observeSourceNotificationRead(element: HTMLElement, api: Pick<SgDesktopApi, 'getNotificationPage' | 'readNotification' | 'onNotificationChanged'>,
  query: NotificationQuery, matches: (record: NotificationRecord) => boolean, identityVisible: () => boolean = () => true,
  resultElement?: { selector: string; attributes: string[]; locate(record: NotificationRecord): HTMLElement | undefined }): () => void {
  let active = true, queried = false, fetching = false, frame: number | undefined
  const candidates = new Map<string, NotificationRecord>(), pending = new Set<string>(), acknowledged = new Map<string, number>()
  const visible = () => active && identityVisible() && notificationElementVisible(element)
  const read = async (record: NotificationRecord): Promise<void> => {
    if (!matches(record) || !visible() || !notificationIsUnread(record) || pending.has(record.id) || (acknowledged.get(record.id) ?? -1) >= record.attentionRevision) return
    if (resultElement) { const result = resultElement.locate(record); if (!result || !notificationElementVisible(result)) return }
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
  // Opt-in for native results mounted by expansion. No per-step subscription,
  // business polling, or read merely because a collapsed header is visible.
  const mutations = resultElement && typeof MutationObserver === 'function' ? new MutationObserver(changes => {
    if (changes.some(change => change.type === 'attributes' || [...change.addedNodes, ...change.removedNodes].some(node =>
      node instanceof Element && (node.matches(resultElement.selector) || node.querySelector(resultElement.selector))))) schedule()
  }) : undefined
  if (resultElement) mutations?.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: resultElement.attributes })
  observer?.observe(element); window.addEventListener('focus', focus); document.addEventListener('scroll', schedule, true); document.addEventListener('toggle', schedule, true); inspect()
  return () => { active = false; stop(); observer?.disconnect(); mutations?.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); window.removeEventListener('focus', focus); document.removeEventListener('scroll', schedule, true); document.removeEventListener('toggle', schedule, true) }
}
