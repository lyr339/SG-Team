import { useEffect, useRef, useState } from 'react'
import type { NotificationRecord } from '../../../domain/notification'
import { useNotificationResultRead } from './use-notification-result-read'
import './usage-storage-notice.css'

function Issue({ record }: { record: NotificationRecord }) {
  const ref = useRef<HTMLParagraphElement>(null)
  useNotificationResultRead(ref, record.key, record.eventId)
  return <details className="usage-storage-notice">
    <summary><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6v5m0 3v.1"/></svg><span>{record.title}</span><span className="usage-storage-notice__more">详情</span></summary>
    <p ref={ref} data-notification-result data-notification-key={record.key} data-notification-event={record.eventId}>{record.detail}</p>
  </details>
}
/** Private health history only. Does not subscribe to token ticks, reprice, retry a save, or clear an Agent receipt. */
export function UsageStorageNotice({ active = true }: { active?: boolean }): React.JSX.Element | null {
  const [records, setRecords] = useState<NotificationRecord[]>([])
  useEffect(() => {
    const api = window.sgDesktop
    if (!active) { setRecords(previous => previous.length ? [] : previous); return }
    if (!api?.getNotificationPage || !api.onNotificationChanged) return
    let alive = true, version = 0
    const rows = new Map<string, NotificationRecord>()
    const valid = (r: NotificationRecord) => ['usage.storage-write','usage.storage-history'].includes(r.eventType ?? '') && r.key.startsWith('usage-storage:')
      && !r.scope.workspaceId && r.target?.kind === 'settings' && r.target.section === 'stats'
    const accept = (r: NotificationRecord) => {
      if (!valid(r)) return
      const old = rows.get(r.eventType!)
      if (old && old.revision > r.revision) return
      rows.set(r.eventType!, r)
    }
    const publish = () => { if (alive) setRecords([...rows.values()].filter(r => r.state === 'active' && r.archivedAt === undefined)) }
    const pull = async () => {
      const epoch = version
      try {
        const pages = await Promise.all(['usage.storage-write','usage.storage-history'].map(eventType => api.getNotificationPage({ eventType, limit: 1 })))
        if (!alive || epoch !== version) return
        pages.forEach(page => page.records.forEach(accept)); publish()
      } catch { /* The notification center retains its own explicit availability feedback. */ }
    }
    const stop = api.onNotificationChanged(event => {
      if (!alive) return
      if (event.historyReload) { ++version; void pull(); return }
      const r = event.change?.record
      if (r && valid(r)) { accept(r); publish() }
    })
    void pull()
    return () => { alive = false; stop() }
  }, [active])
  if (!active || records.length === 0) return null
  return <div className="usage-storage-notices" data-notification-page="account:stats" aria-label="本机用量记录说明">
    {records.map(record => <Issue key={record.key} record={record} />)}
  </div>
}
