import { useEffect, useRef, useState } from 'react'
import type { NotificationRecord } from '../../../domain/notification'
import { useNotificationResultRead } from './use-notification-result-read'
import './usage-storage-notice.css'

const LOCAL_SOURCES = {
  'usage-storage': { events: ['usage.storage-write', 'usage.storage-history'], section: 'stats', key: /^usage-storage:(write|history):[a-f0-9]{64}$/ },
  'model-catalog': { events: ['cursor.model-catalog'], section: 'maintenance', key: /^model-catalog:[a-f0-9]{64}$/ },
  'usage-runtime': { events: ['usage.runtime-source'], section: 'stats', key: /^usage-runtime:[a-f0-9]{64}$/ },
  'composer-context': { events: ['cursor.context-source'], section: 'maintenance', key: /^composer-context:[a-f0-9]{64}$/ }
} as const
type LocalSource = keyof typeof LOCAL_SOURCES

function Issue({ record }: { record: NotificationRecord }) {
  const ref = useRef<HTMLParagraphElement>(null)
  useNotificationResultRead(ref, record.key, record.eventId)
  return <details className="usage-storage-notice">
    <summary><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6v5m0 3v.1"/></svg><span>{record.title}</span><span className="usage-storage-notice__more">详情</span></summary>
    <p ref={ref} data-notification-result data-notification-key={record.key} data-notification-event={record.eventId}>{record.detail}</p>
  </details>
}
/** Private history only. Does not poll business data, retry an operation, or clear an Agent receipt. */
export function LocalSourceNotice({ active = true, source }: { active?: boolean; source: LocalSource }): React.JSX.Element | null {
  const model = source === 'model-catalog'
  const { events, section, key } = LOCAL_SOURCES[source]
  const [snapshot, setSnapshot] = useState<{ source: LocalSource; epoch: number; records: NotificationRecord[] }>({ source, epoch: 0, records: [] })
  useEffect(() => {
    const api = window.sgDesktop
    if (!active) { setSnapshot({ source, epoch: 0, records: [] }); return }
    if (!api?.getNotificationPage || !api.onNotificationChanged) return
    let alive = true, version = 0, epoch = 0, sequence = 0
    type Row = { record: NotificationRecord; sequence: number; historyRevision: number }
    let rows = new Map<string, Row>()
    const valid = (r: NotificationRecord) => (events as readonly string[]).includes(r.eventType ?? '') && key.test(r.key)
      && Object.values(r.scope).every(value => value === undefined) && r.target?.kind === 'settings' && r.target.section === section
    const accept = (into: Map<string, Row>, r: NotificationRecord, at: number, historyRevision: number) => {
      if (!valid(r)) return
      const old = into.get(r.eventType!)
      // Read/archive mutations advance the private ledger revision, not the
      // content revision. Do not reject a real archive as an unchanged body.
      if (old && (old.historyRevision > historyRevision || old.record.revision > r.revision
        || old.record.revision === r.revision && old.historyRevision === historyRevision)) return
      into.set(r.eventType!, { record: r, sequence: at, historyRevision })
    }
    const publish = () => { if (alive) setSnapshot({ source, epoch, records: [...rows.values()].map(row => row.record)
      .filter(r => r.state === 'active' && r.archivedAt === undefined) }) }
    const pull = async () => {
      const request = ++version, since = sequence
      try {
        const pages = await Promise.all(events.map(eventType => api.getNotificationPage({ eventType, limit: 1 })))
        if (!alive || request !== version) return
        const next = new Map<string, Row>()
        pages.forEach(page => page.records.forEach(r => accept(next, r, 0, page.summary.revision)))
        for (const [eventType, row] of rows) {
          // Authoritative empties remove cleared/archived history, except for a
          // newer push received during this pull. Older pulls never undo it.
          if (row.sequence > since || next.has(eventType)) accept(next, row.record, row.sequence, row.historyRevision)
        }
        rows = next; publish()
      } catch { /* The notification center retains its own explicit availability feedback. */ }
    }
    const stop = api.onNotificationChanged(event => {
      if (!alive) return
      if (event.historyReload) {
        ++epoch; rows.clear(); publish(); void pull(); return
      }
      const r = event.change?.record
      if (r && valid(r)) { accept(rows, r, ++sequence, event.change!.summary.revision); publish() }
      else if (event.change?.changed && !r) void pull()
    })
    void pull()
    return () => { alive = false; stop() }
  }, [active, source])
  if (!active || snapshot.source !== source || snapshot.records.length === 0) return null
  return <div className="usage-storage-notices" data-notification-page={`account:${section}`} aria-label={model ? '本机模型目录说明' : source === 'composer-context' ? '本机上下文详情说明' : source === 'usage-runtime' ? '原生运行时用量说明' : '本机用量记录说明'}>
    {snapshot.records.map(record => <Issue key={`${snapshot.epoch}:${record.id}`} record={record} />)}
  </div>
}
