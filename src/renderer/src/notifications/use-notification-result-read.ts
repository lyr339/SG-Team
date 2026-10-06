import { useEffect, type RefObject } from 'react'
import { observeSourceNotificationRead } from './observe-source-read'
import type { NotificationRecord } from '../../../domain/notification'

/** Source pages acknowledge only the exact rendered milestone, never every record in a route. */
export function useNotificationResultRead(ref: RefObject<HTMLElement | null>, key?: string, eventId?: string, displayed?: Pick<NotificationRecord, 'revision' | 'storageEpoch'>): void {
  const revision = displayed?.revision, storageEpoch = displayed?.storageEpoch
  useEffect(() => {
    const element = ref.current, api = window.sgDesktop
    if (!element || !key || !eventId || typeof api?.getNotificationPage !== 'function' || typeof api.onNotificationChanged !== 'function') return
    return observeSourceNotificationRead(element, api, { key, limit: 1 }, record => record.key === key && record.eventId === eventId
      && (revision === undefined || record.revision === revision && (record.storageEpoch ?? 0) === (storageEpoch ?? 0)),
      () => element.dataset.notificationKey === key && element.dataset.notificationEvent === eventId)
  }, [ref, key, eventId, revision, storageEpoch])
}
