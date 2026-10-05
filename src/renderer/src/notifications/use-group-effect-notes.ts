import { useEffect, useState } from 'react'
import type { NotificationRecord, NotificationPush } from '../../../domain/notification'
/** One private query per visible run, not a business poll or one query per card. */
export function useGroupEffectNotes(workspaceId?: string, runId?: string): Map<string, NotificationRecord> {
  const [state, setState] = useState<{ scope: string; records: Map<string, NotificationRecord> }>({
    scope: '',
    records: new Map()
  })
  const scope = JSON.stringify([workspaceId, runId])
  useEffect(() => {
    const api = window.sgDesktop
    if (!workspaceId || !runId || !api?.getNotificationPage || !api.onNotificationChanged) return
    let active = true,
      reading = false,
      again = false,
      epoch = 0
    const rows = new Map<string, NotificationRecord>()
    const valid = (record: NotificationRecord) =>
      record.eventType === 'group.effects' &&
      record.scope.workspaceId === workspaceId &&
      record.scope.runId === runId &&
      Boolean(record.scope.groupId)
    const publish = () => {
      if (active) setState({ scope, records: new Map(rows) })
    }
    const accept = (record: NotificationRecord) => {
      if (!valid(record)) return
      const group = record.scope.groupId!,
        old = rows.get(group)
      if (
        old &&
        (old.updatedAt > record.updatedAt ||
          (old.updatedAt === record.updatedAt && old.revision > record.revision))
      )
        return
      if (record.archivedAt !== undefined) rows.delete(group)
      else rows.set(group, record)
    }
    const pull = async () => {
      if (!active) return
      if (reading) {
        again = true
        return
      }
      reading = true
      const version = epoch
      try {
        let cursor: { revision: number; offset: number } | undefined,
          resets = 0
        const fetched = new Map<string, NotificationRecord>()
        do {
          const page = await api.getNotificationPage({
            eventType: 'group.effects',
            workspaceId,
            runId,
            limit: 100,
            ...(cursor ? { cursor } : {})
          })
          if (!active) return
          if (page.reset) {
            fetched.clear()
            if (++resets > 2) break
          }
          for (const record of page.records)
            if (valid(record) && !fetched.has(record.scope.groupId!))
              fetched.set(record.scope.groupId!, record)
          cursor = page.nextCursor
        } while (cursor)
        if (!active) return
        if (version === epoch) rows.clear()
        for (const row of fetched.values()) accept(row)
        publish()
      } catch {
        /* History failure never initiates an original group action or another warning. */
      } finally {
        reading = false
        if (active && again) {
          again = false
          void pull()
        }
      }
    }
    const stop = api.onNotificationChanged((event: NotificationPush) => {
      if (!active) return
      if (event.change?.record && valid(event.change.record)) {
        ++epoch
        accept(event.change.record)
        publish()
      } else if (event.change?.changed && !event.change.record) {
        ++epoch
        void pull()
      }
    })
    void pull()
    return () => {
      active = false
      stop()
    }
  }, [workspaceId, runId, scope])
  return state.scope === scope ? state.records : new Map()
}
