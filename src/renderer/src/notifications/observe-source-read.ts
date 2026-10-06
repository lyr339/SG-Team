import { notificationIsUnread, type NotificationQuery, type NotificationReadCursor, type NotificationRecord } from '../../../domain/notification'
import type { SgDesktopApi } from '../../../shared/desktop-api'
import { notificationElementVisible } from './notification-visible'

interface ResultElement {
  selector: string; attributes: string[]; locate(record: NotificationRecord): HTMLElement | undefined
}
const mergeReceipt = (old: NotificationRecord | undefined, incoming: NotificationRecord): NotificationRecord => {
  if (!old || incoming.revision > old.revision) return incoming
  if (incoming.revision < old.revision) return old
  return { ...incoming, readRevision: Math.max(old.readRevision, incoming.readRevision),
    ...(old.readAt !== undefined && (incoming.readAt === undefined || old.readAt > incoming.readAt) ? { readAt: old.readAt } : {}),
    ...(old.archivedAt !== undefined ? { archivedAt: old.archivedAt } : {}) }
}
/** One exact visible-source observer. Stable private keyset pages, bounded read RPCs/caches; never a business probe or polling timer. */
export function observeSourceNotificationRead(element: HTMLElement, api: Pick<SgDesktopApi, 'getNotificationPage' | 'readNotification' | 'onNotificationChanged'>,
  query: NotificationQuery, matches: (record: NotificationRecord) => boolean, identityVisible: () => boolean = () => true, resultElement?: ResultElement): () => void {
  let active = true, epoch = 0, frame: number | undefined, fetching = false, complete = false, failed = false
  let cursor: NotificationQuery['readCursor'] = 'start', visibleSignature: string | undefined, waitForSpace: (() => void) | undefined, needsSweep = false
  const candidates = new Map<string, NotificationRecord>(), queued = new Set<string>(), pending = new Map<string, number>()
  const acknowledged = new Map<string, number>(), attempted = new Map<string, number>()
  const visible = () => active && identityVisible() && notificationElementVisible(element)
  const readable = (record: NotificationRecord) => {
    if (!matches(record) || !visible()) return false
    const result = resultElement?.locate(record)
    return !resultElement || Boolean(result && notificationElementVisible(result))
  }
  const trim = () => {
    while (candidates.size > 256) {
      const oldest = [...candidates.keys()].find(id => !pending.has(id) && !queued.has(id))
      if (!oldest) break
      candidates.delete(oldest)
    }
    for (const map of [acknowledged, attempted]) while (map.size > 256) map.delete(map.keys().next().value!)
  }
  const queue = (record: NotificationRecord) => {
    if (!active || !notificationIsUnread(record) || !readable(record) || pending.has(record.id)
      || (acknowledged.get(record.id) ?? -1) >= record.attentionRevision || (attempted.get(record.id) ?? -1) >= record.revision) return
    if (queued.size >= 128 && !queued.has(record.id)) { needsSweep = true; return }
    queued.add(record.id); pump()
  }
  const accept = (record: NotificationRecord) => {
    if (!active) return
    const old = candidates.get(record.id)
    if (!matches(record)) {
      if (!old || record.revision >= old.revision) { candidates.delete(record.id); queued.delete(record.id) }
      return
    }
    const merged = mergeReceipt(old, record)
    candidates.set(record.id, merged); queue(merged); trim()
  }
  const pump = () => {
    while (active && pending.size < 4 && queued.size) {
      const id = queued.values().next().value!, record = candidates.get(id); queued.delete(id)
      if (!record || !notificationIsUnread(record) || !readable(record) || (acknowledged.get(id) ?? -1) >= record.attentionRevision) continue
      const version = epoch
      pending.set(id, version); attempted.set(id, record.revision)
      void api.readNotification({ id, revision: record.revision }).then(result => {
        if (!active || version !== epoch) return
        if (result.changed || result.record && result.record.readRevision >= record.attentionRevision) acknowledged.set(id, record.attentionRevision)
        if (!result.record && !result.changed) candidates.delete(id)
        if (result.record) accept(result.record)
        else if (result.changed) accept({ ...record, readRevision: Math.max(record.readRevision, record.attentionRevision) }) // Confirmed receipt only, not optimistic readAt/body data.
      }).catch(() => { /* Keep unread. Only real visibility/focus/source events may retry; no automatic business/read retry loop. */ }).finally(() => {
        if (pending.get(id) === version) pending.delete(id)
        const latest = candidates.get(id)
        if (active && latest && (version !== epoch || latest.revision > record.revision)) queue(latest)
        trim(); pump()
      })
    }
    if (queued.size < 28) { const release = waitForSpace; waitForSpace = undefined; release?.() } // Reserve room for the next <=100-record page in the 128-item queue.
    if (active && !pending.size && !queued.size && needsSweep) { needsSweep = false; reset(); scan() }
  }
  const signature = () => resultElement ? [...element.querySelectorAll<HTMLElement>(resultElement.selector)].filter(notificationElementVisible)
    .map(node => JSON.stringify(resultElement.attributes.map(name => node.getAttribute(name) ?? ''))).sort().join('\n') : 'visible'
  const reset = (storage = false) => {
    ++epoch; cursor = 'start'; complete = false; failed = false
    if (storage) { candidates.clear(); queued.clear(); acknowledged.clear(); attempted.clear() }
    const release = waitForSpace; waitForSpace = undefined; release?.()
  }
  const nextCursor = (value: NotificationReadCursor, previous: NotificationQuery['readCursor']) => {
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.ceiling) || value.ceiling < value.revision || typeof value.id !== 'string' || !value.id || value.id.length > 300) return false
    return previous === 'start' || previous === undefined || value.ceiling === previous.ceiling &&
      (value.revision < previous.revision || value.revision === previous.revision && value.id < previous.id)
  }
  const scan = () => {
    if (fetching || complete || failed || !visible()) return
    fetching = true
    const version = epoch
    void (async () => {
      while (active && version === epoch && visible() && !complete && !failed) {
        const current = cursor
        const page = await api.getNotificationPage({ ...query, filter: query.filter ?? 'unread', readCursor: current })
        if (!active || version !== epoch) return
        if (page.reset) { reset(true); return } // Private counter rewind/history reload is not a continuation of old receipts.
        page.records.forEach(accept)
        if (!page.nextReadCursor) { complete = true; break }
        if (!nextCursor(page.nextReadCursor, current)) { failed = true; break }
        cursor = page.nextReadCursor
        if (queued.size >= 28) await new Promise<void>(resolve => { waitForSpace = resolve }) // Backpressure is private-only, not a timer or extra original-source read.
      }
    })().catch(() => { if (version === epoch) failed = true }).finally(() => {
      fetching = false
      if (active && version !== epoch) scan()
    })
  }
  const inspect = () => {
    if (!visible()) return
    const next = signature()
    if (next !== visibleSignature) { visibleSignature = next; reset() }
    attempted.clear() // A real viewport/focus change can retry an unconfirmed human receipt, not a scrolling IPC poll.
    for (const record of candidates.values()) queue(record)
    scan()
  }
  const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; inspect() }) }
  const focus = () => { reset(); inspect() }
  const stop = api.onNotificationChanged(event => {
    if (event.historyReload) { reset(true); scan(); return }
    if (event.change?.record) { attempted.delete(event.change.record.id); accept(event.change.record) }
  })
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(schedule, { threshold: [0, .01, .1, .5, 1] }) : undefined
  const mutations = resultElement && typeof MutationObserver === 'function' ? new MutationObserver(changes => {
    if (changes.some(change => change.type === 'attributes' || [...change.addedNodes, ...change.removedNodes].some(node =>
      node instanceof Element && (node.matches(resultElement.selector) || node.querySelector(resultElement.selector))))) schedule()
  }) : undefined
  if (resultElement) mutations?.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: resultElement.attributes })
  observer?.observe(element); window.addEventListener('focus', focus); window.addEventListener('resize', schedule)
  document.addEventListener('scroll', schedule, true); document.addEventListener('toggle', schedule, true); document.addEventListener('focusin', schedule, true); inspect()
  return () => {
    active = false; ++epoch; stop(); queued.clear(); candidates.clear(); const release = waitForSpace; waitForSpace = undefined; release?.(); observer?.disconnect(); mutations?.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    window.removeEventListener('focus', focus); window.removeEventListener('resize', schedule)
    document.removeEventListener('scroll', schedule, true); document.removeEventListener('toggle', schedule, true); document.removeEventListener('focusin', schedule, true)
  }
}
