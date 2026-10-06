import type { SgDesktopApi } from '../../../shared/desktop-api'
import { DEFAULT_NOTIFICATION_PREFERENCES, notificationIsUnread, type NotificationDeliveryStatus, type NotificationOpenRequest, type NotificationPreferences, type NotificationPush, type NotificationRecord, type NotificationSummary } from '../../../domain/notification'
import { notificationIsQuiet, notificationSessionMode } from '../../../domain/notification-delivery-policy'
import type { NotificationHistoryIntegrity } from '../../../domain/notification-history'

export type NotificationApi = Pick<SgDesktopApi, 'getNotificationPage' | 'readNotification' | 'readAllNotifications' | 'archiveNotification' | 'clearReadNotifications' | 'getNotificationPreferences' | 'saveNotificationPreferences' | 'onNotificationChanged' | 'acknowledgeNotificationHistory'>
export interface ToastCandidate { key: string; record: NotificationRecord; expiresAt: number; grouped?: boolean; sourceRecords?: NotificationRecord[] }
interface StoreSnapshot {
  storageEpoch?: number
  summary: NotificationSummary
  preferences: NotificationPreferences
  available: boolean
  loaded: boolean
  preferencesReady: boolean
  health: 'ready' | 'degraded'
  historyIncomplete: boolean
  historyIntegrity?: NotificationHistoryIntegrity
  historyGapUnconfirmed?: boolean
  error?: string
  preferencesError?: string
  delivery?: NotificationDeliveryStatus
  openRequested?: NotificationOpenRequest
  toasts: ToastCandidate[]
}

/** Only the bell, center and toast subscribe; incoming notifications cannot invalidate the conversation tree. */
export class NotificationStore {
  private readonly recentRecords = new Map<string, NotificationRecord>()
  private state: StoreSnapshot = {
    summary: { revision: -1, total: 0, unread: 0, pending: 0, clearable: 0 }, preferences: structuredClone(DEFAULT_NOTIFICATION_PREFERENCES),
    available: false, loaded: false, preferencesReady: false, health: 'ready', historyIncomplete: false, toasts: []
  }
  private readonly listeners = new Set<(event?: NotificationPush) => void>()
  private unsubscribe?: () => void
  private users = 0
  private epoch = 0
  private preferencesEpoch = 0
  private historyEpoch = 0
  private storageVersion = 0
  private summaryStorageEpoch?: number
  private readonly announced = new Set<string>()
  constructor(readonly api: NotificationApi, private readonly now: () => number = Date.now) {}
  snapshot = (): StoreSnapshot => this.state
  subscribe = (listener: (event?: NotificationPush) => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(update: Partial<StoreSnapshot>, event?: NotificationPush): void {
    this.state = { ...this.state, ...update }
    for (const listener of this.listeners) { try { listener(event) } catch { /* One view must not prevent another from observing the state. */ } }
  }
  private storage(epoch: number | undefined): boolean {
    if (epoch === undefined) return true // Legacy status-only/fake providers keep the monotone-revision contract.
    if (!Number.isSafeInteger(epoch) || epoch < 0 || this.state.storageEpoch !== undefined && epoch < this.state.storageEpoch) return false
    if (epoch !== this.state.storageEpoch) {
      if (this.state.storageEpoch !== undefined || epoch > 0) { ++this.storageVersion; ++this.preferencesEpoch }
      this.state = { ...this.state, storageEpoch: epoch, toasts: [], ...(this.state.storageEpoch !== undefined || epoch > 0 ? { historyIntegrity: undefined, historyGapUnconfirmed: true, preferencesReady: false } : {}) }
      this.recentRecords.clear(); this.announced.clear()
    }
    return true
  }
  private currentSummary(revision: number, epoch: number | undefined): boolean {
    return epoch !== undefined && epoch !== this.summaryStorageEpoch || revision >= this.state.summary.revision
  }
  private historyUpdate(integrity?: NotificationHistoryIntegrity, unconfirmed?: boolean): Partial<StoreSnapshot> {
    const current = this.state.historyIntegrity
    const newer = integrity && (!current || integrity.revision > current.revision || integrity.revision === current.revision && integrity.acknowledgedRevision >= current.acknowledgedRevision)
    return { ...(newer ? { historyIntegrity: integrity, ...(integrity.revision > 0 ? { historyIncomplete: true } : {}) } : {}),
      ...(unconfirmed !== undefined ? { historyGapUnconfirmed: unconfirmed } : {}) }
  }
  private applyPreferences(preferences: NotificationPreferences): void {
    this.patch({ preferences, preferencesReady: true, preferencesError: undefined,
      toasts: notificationIsQuiet(preferences, this.now()) ? [] : this.state.toasts.filter(item => !preferences.mutedCategories.includes(item.record.category)
        && !preferences.inAppMutedCategories?.includes(item.record.category) && notificationSessionMode(item.record, preferences) !== 'quiet') })
  }
  private async pullPreferences(epoch: number): Promise<void> {
    const version = this.preferencesEpoch
    try {
      const preferences = await this.api.getNotificationPreferences()
      if (epoch === this.epoch && version === this.preferencesEpoch) this.applyPreferences(preferences)
    } catch { if (epoch === this.epoch && version === this.preferencesEpoch) this.patch({ preferencesError: '提醒设置暂不可读取；本次不会弹出新的提醒。' }) }
  }
  acquire(): () => void {
    if (++this.users === 1) {
      const epoch = ++this.epoch
      const historyEpoch = this.historyEpoch
      const storageVersion = this.storageVersion
      this.patch({ preferencesReady: false })
      this.unsubscribe = this.api.onNotificationChanged(event => { if (epoch === this.epoch) this.accept(event) })
      // Subscribe before pulling; a later stale pull may not rewind a live change.
      void this.api.getNotificationPage({ limit: 1 }).then(page => {
        if (epoch !== this.epoch) return
        if (!this.storage(page.storageEpoch)) return
        const current = this.currentSummary(page.summary.revision, page.storageEpoch)
        if (current) this.summaryStorageEpoch = page.storageEpoch
        this.patch({ loaded: true, available: true, error: undefined,
          ...(current ? { summary: page.summary } : {}),
          health: this.state.health === 'degraded' ? this.state.health : page.health ?? 'ready',
          ...(page.delivery && this.state.delivery === undefined ? { delivery: page.delivery } : {}), ...(page.openRequested && !this.state.openRequested ? { openRequested: page.openRequested } : {}),
          historyIncomplete: this.state.historyIncomplete || page.historyIncomplete === true,
          ...(current ? this.historyUpdate(page.historyIntegrity, historyEpoch === this.historyEpoch ? page.historyGapUnconfirmed : undefined) : {}) })
      }).catch(() => { if (epoch === this.epoch && storageVersion === this.storageVersion) this.patch({ loaded: true, error: '通知历史暂不可读取，原有功能仍可使用。', health: 'degraded' }) })
      void this.pullPreferences(epoch)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.users === 0) { ++this.epoch; this.unsubscribe?.(); this.unsubscribe = undefined; this.patch({ toasts: [] }) }
    }
  }
  accept(event: NotificationPush): void {
    if (!this.storage(event.storageEpoch ?? event.change?.storageEpoch)) return
    const change = event.change
    const fresh = !change || this.currentSummary(change.summary.revision, event.storageEpoch ?? change.storageEpoch)
    if (event.historyReload && !fresh) event = { ...event, historyReload: undefined, historyIntegrity: undefined, historyGapUnconfirmed: undefined }
    if (event.historyIntegrity || event.historyGapUnconfirmed !== undefined) ++this.historyEpoch
    if (event.preferences) { ++this.preferencesEpoch; this.applyPreferences(event.preferences) }
    const update: Partial<StoreSnapshot> = { health: event.health, historyIncomplete: this.state.historyIncomplete || event.historyIncomplete,
      ...this.historyUpdate(event.historyIntegrity, event.historyGapUnconfirmed),
      ...(event.delivery ? { delivery: event.delivery } : {}), ...(event.openRequested ? { openRequested: event.openRequested } : {}) }
    if (change && event.announcement && !this.state.preferencesReady) void this.pullPreferences(this.epoch)
    if (fresh && change?.record) {
      this.recentRecords.set(change.record.id, change.record)
      while (this.recentRecords.size > 256) this.recentRecords.delete(this.recentRecords.keys().next().value!)
    }
    if (change && fresh) { this.summaryStorageEpoch = event.storageEpoch ?? change.storageEpoch; update.summary = change.summary; update.available = true; update.loaded = true; update.error = undefined }
    if (change?.record && fresh && (!notificationIsUnread(change.record) || change.record.state === 'expired')) {
      update.toasts = this.state.toasts.filter(item => item.record.id !== change.record!.id)
    }
    this.patch(update, fresh ? event : { ...event, change: undefined, announcement: undefined, historyReload: undefined })
    const record = change?.record; const announcement = event.announcement
    if (!change || !fresh || !record || !announcement || announcement.expiresAt <= this.now()
      || announcement.signal || !notificationIsUnread(record) || record.attention === 'activity' || this.announced.has(announcement.id)) return
    this.announced.add(announcement.id)
    if (this.announced.size > 256) this.announced.delete(this.announced.values().next().value!)
    const preferences = this.state.preferences
    if (notificationIsQuiet(preferences, this.now()) || preferences.mutedCategories.includes(record.category)
      || preferences.inAppMutedCategories?.includes(record.category) || notificationSessionMode(record, preferences) === 'quiet') return
    const candidates = this.state.toasts.filter(item => item.expiresAt > this.now() && item.record.id !== record.id)
    const group = announcement.group
    const displayed = group ? { ...record, source: group.source, title: group.title, detail: group.detail, target: group.target, tone: group.tone ?? record.tone } : record
    const sourceRecords = group?.recordIds.map(id => this.recentRecords.get(id))
    this.patch({ toasts: [...candidates, { key: announcement.id, record: displayed, expiresAt: announcement.expiresAt,
      ...(group ? { grouped: true } : {}), ...(sourceRecords?.length && sourceRecords.every(value => value !== undefined) ? { sourceRecords: sourceRecords as NotificationRecord[] } : {}) }].slice(-8) })
  }
  dismissToast(key: string): void { this.patch({ toasts: this.state.toasts.filter(item => item.key !== key) }) }
  async refresh(): Promise<void> {
    const epoch = this.epoch
    const historyEpoch = this.historyEpoch
    const storageVersion = this.storageVersion
    try {
      const page = await this.api.getNotificationPage({ limit: 1 })
      if (epoch === this.epoch && this.storage(page.storageEpoch) && this.currentSummary(page.summary.revision, page.storageEpoch)) {
        this.summaryStorageEpoch = page.storageEpoch
        this.patch({ summary: page.summary, available: true, loaded: true, error: undefined,
        ...(page.delivery ? { delivery: page.delivery } : {}),
        health: page.health ?? 'ready', historyIncomplete: this.state.historyIncomplete || page.historyIncomplete === true, ...this.historyUpdate(page.historyIntegrity, historyEpoch === this.historyEpoch ? page.historyGapUnconfirmed : undefined) })
      }
      if (epoch === this.epoch && !this.state.preferencesReady) await this.pullPreferences(epoch)
    } catch { if (epoch === this.epoch && storageVersion === this.storageVersion) this.patch({ error: '通知历史暂不可读取，原有功能仍可使用。', health: 'degraded' }) }
  }
  async savePreferences(preferences: NotificationPreferences): Promise<void> {
    const epoch = ++this.preferencesEpoch
    const saved = await this.api.saveNotificationPreferences(preferences)
    if (epoch === this.preferencesEpoch) this.applyPreferences(saved)
  }
  read(record: NotificationRecord): Promise<void> {
    return this.api.readNotification({ id: record.id, revision: record.revision, ...(record.storageEpoch !== undefined ? { storageEpoch: record.storageEpoch } : {}) }).then(change => {
      this.accept({ change, ...(change.storageEpoch !== undefined ? { storageEpoch: change.storageEpoch } : {}), health: 'ready', historyIncomplete: this.state.historyIncomplete })
    })
  }
  async acknowledgeHistory(revision: number): Promise<void> {
    if (!this.api.acknowledgeNotificationHistory) throw Error('历史说明暂不可确认，请重新读取')
    const epoch = this.state.storageEpoch
    const integrity = await this.api.acknowledgeNotificationHistory(revision, epoch)
    if (epoch !== this.state.storageEpoch) throw Error('通知存储已换代，请重新读取历史说明')
    this.patch(this.historyUpdate(integrity))
  }
}
