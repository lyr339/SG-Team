import type { AppUpdateService } from '../app-update-service'
import type { NotificationService } from '../notification-service'
import { appUpdateNotification, appUpdateReceiptNotification } from '../../domain/app-update-notification'
import { isNewerAppVersion, parseAppVersion } from '../../domain/app-update'
import type { NotificationDraft, NotificationRecord } from '../../domain/notification'
import { notificationContentSignature } from '../../domain/notification'
import type { AppUpdateStatus } from '../../domain/app-update'

export function connectAppUpdateNotifications(updates: AppUpdateService, notifications: NotificationService): () => void {
  let stopped = false
  let previous: Omit<NotificationDraft, 'sourceRevision'> | undefined
  let receiptSignature: string | undefined
  let milestoneSignature: string | undefined
  let reconciliationSequence = 0
  let previousNewest = ''
  let scheduleReconcile: () => void = () => {}
  // The main service is authoritative and its callbacks ordered. No added update check or network request.
  const publish = (status: AppUpdateStatus, live: boolean): void => {
    const newest = status.currentVersion + ':' + ('release' in status.state ? status.state.release?.version ?? '' : '')
    if (newest !== previousNewest) { previousNewest = newest; scheduleReconcile() }
    const draft = appUpdateNotification(status, live)
    const receipt = appUpdateReceiptNotification(status)
    if (receipt) {
      const signature = notificationContentSignature({ ...receipt, sourceRevision: 0 })
      if (receiptSignature !== signature) { notifications.offerCurrent(receipt); receiptSignature = signature }
    }
    if (draft) {
      const signature = notificationContentSignature({ ...draft, sourceRevision: 0 })
      if (milestoneSignature !== signature) { notifications.offerCurrent(draft); milestoneSignature = signature }
      previous = draft
    }
    else if (status.state.phase === 'up_to_date' && previous?.tone === 'warning') {
      notifications.offerCurrent({ ...previous, title: '更新检查已恢复', detail: '当前版本状态已重新确认。', tone: 'info', attention: 'activity', state: 'resolved', announce: false, renewAttention: false })
      previous = undefined
      milestoneSignature = undefined
    }
  }
  const stop = updates.onChange(status => publish(status, true))
  let storageReady = true
  const stopHealth = notifications.subscribe(event => {
    const recovered = !storageReady && event.health === 'ready'
    storageReady = event.health === 'ready'
    if (recovered && !stopped) { receiptSignature = undefined; milestoneSignature = undefined; publish(updates.getStatus(), false) }
  })
  publish(updates.getStatus(), false)
  // Reconcile old versions on startup or a new release, without added network checks or percent-driven scans.
  scheduleReconcile = () => {
    const sequence = ++reconciliationSequence
    void (async () => {
    let cursor: { revision: number; offset: number } | undefined
    let resets = 0
    const records = new Map<string, NotificationRecord>()
    do {
      const page = await notifications.page({ category: 'updates', limit: 100, ...(cursor ? { cursor } : {}) })
      if (stopped || sequence !== reconciliationSequence) return
      if (page.reset) { records.clear(); if (++resets > 1) return }
      for (const record of page.records) records.set(record.id, record)
      cursor = page.nextCursor
    } while (cursor)
    const status = updates.getStatus()
    const newest = 'release' in status.state ? status.state.release?.version : undefined
    for (const record of records.values()) {
      if (!record.key.startsWith('app-update:') || record.state !== 'active') continue
      const version = record.key.slice('app-update:'.length)
      if (!parseAppVersion(version) || isNewerAppVersion(version, status.currentVersion) && (!newest || !isNewerAppVersion(newest, version))) continue
      notifications.offerCurrent({ ...record, title: `拾光 ${version} 的旧提醒已结束`, detail: '已确认安装更新或存在更高版本，可到软件更新查看当前状态。',
        eventId: `update:expired:${version}`, attention: 'activity', state: 'expired', announce: false, renewAttention: false })
    }
    })().catch(() => { /* NotificationService exposes storage health; no recursive error or new network request. */ })
  }
  scheduleReconcile()
  return () => { stopped = true; ++reconciliationSequence; stop(); stopHealth() }
}
