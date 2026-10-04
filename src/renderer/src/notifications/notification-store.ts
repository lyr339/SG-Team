import type { SgDesktopApi } from '../../../shared/desktop-api'
import { DEFAULT_NOTIFICATION_PREFERENCES, notificationIsUnread, type NotificationPreferences, type NotificationPush, type NotificationRecord, type NotificationSummary } from '../../../domain/notification'

export type NotificationApi = Pick<SgDesktopApi, 'getNotificationPage' | 'readNotification' | 'readAllNotifications' | 'archiveNotification' | 'clearReadNotifications' | 'getNotificationPreferences' | 'saveNotificationPreferences' | 'onNotificationChanged'>
export interface ToastCandidate { key: string; record: NotificationRecord; expiresAt: number }
interface StoreSnapshot {
  summary: NotificationSummary
  preferences: NotificationPreferences
  available: boolean
  loaded: boolean
  preferencesReady: boolean
  health: 'ready' | 'degraded'
  historyIncomplete: boolean
  error?: string
  preferencesError?: string
  toasts: ToastCandidate[]
}

/** Only the bell, center and toast subscribe; incoming notifications cannot invalidate the conversation tree. */
export class NotificationStore {
  private state: StoreSnapshot = {
    summary: { revision: -1, total: 0, unread: 0, pending: 0, clearable: 0 }, preferences: structuredClone(DEFAULT_NOTIFICATION_PREFERENCES),
    available: false, loaded: false, preferencesReady: false, health: 'ready', historyIncomplete: false, toasts: []
  }
  private readonly listeners = new Set<(event?: NotificationPush) => void>()
  private unsubscribe?: () => void
  private users = 0
  private epoch = 0
  private preferencesEpoch = 0
  private readonly announced = new Set<string>()
  constructor(readonly api: NotificationApi, private readonly now: () => number = Date.now) {}
  snapshot = (): StoreSnapshot => this.state
  subscribe = (listener: (event?: NotificationPush) => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(update: Partial<StoreSnapshot>, event?: NotificationPush): void {
    this.state = { ...this.state, ...update }
    for (const listener of this.listeners) { try { listener(event) } catch { /* One view must not prevent another from observing the state. */ } }
  }
  private applyPreferences(preferences: NotificationPreferences): void {
    this.patch({ preferences, preferencesReady: true, preferencesError: undefined,
      toasts: !preferences.enabled || preferences.quiet ? [] : this.state.toasts.filter(item => !preferences.mutedCategories.includes(item.record.category)) })
  }
  private async pullPreferences(epoch: number): Promise<void> {
    const version = this.preferencesEpoch
    try {
      const preferences = await this.api.getNotificationPreferences()
      if (epoch === this.epoch && version === this.preferencesEpoch) this.applyPreferences(preferences)
    } catch { if (epoch === this.epoch) this.patch({ preferencesError: '提醒设置暂不可读取；本次不会弹出新的提醒。' }) }
  }
  acquire(): () => void {
    if (++this.users === 1) {
      const epoch = ++this.epoch
      this.patch({ preferencesReady: false })
      this.unsubscribe = this.api.onNotificationChanged(event => { if (epoch === this.epoch) this.accept(event) })
      // Subscribe before pulling; a later stale pull may not rewind a live change.
      void this.api.getNotificationPage({ limit: 1 }).then(page => {
        if (epoch !== this.epoch) return
        this.patch({ loaded: true, available: true, error: undefined,
          ...(page.summary.revision >= this.state.summary.revision ? { summary: page.summary } : {}),
          health: this.state.health === 'degraded' ? this.state.health : page.health ?? 'ready',
          historyIncomplete: this.state.historyIncomplete || page.historyIncomplete === true })
      }).catch(() => { if (epoch === this.epoch) this.patch({ loaded: true, error: '通知历史暂不可读取，原有功能仍可使用。', health: 'degraded' }) })
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
    if (event.preferences) { ++this.preferencesEpoch; this.applyPreferences(event.preferences) }
    const update: Partial<StoreSnapshot> = { health: event.health, historyIncomplete: this.state.historyIncomplete || event.historyIncomplete }
    const change = event.change
    if (change && event.announcement && !this.state.preferencesReady) void this.pullPreferences(this.epoch)
    const fresh = !change || change.summary.revision >= this.state.summary.revision
    if (change && change.summary.revision >= this.state.summary.revision) { update.summary = change.summary; update.available = true; update.loaded = true; update.error = undefined }
    if (change?.record && change.summary.revision >= this.state.summary.revision && (!notificationIsUnread(change.record) || change.record.state === 'expired')) {
      update.toasts = this.state.toasts.filter(item => item.record.id !== change.record!.id)
    }
    this.patch(update, fresh ? event : { ...event, change: undefined, announcement: undefined })
    const record = change?.record; const announcement = event.announcement
    if (!change || change.summary.revision < this.state.summary.revision || !record || !announcement || announcement.expiresAt <= this.now()
      || !notificationIsUnread(record) || record.attention === 'activity' || this.announced.has(announcement.id)) return
    this.announced.add(announcement.id)
    if (this.announced.size > 256) this.announced.delete(this.announced.values().next().value!)
    const preferences = this.state.preferences
    if (!preferences.enabled || preferences.quiet || preferences.mutedCategories.includes(record.category)) return
    const candidates = this.state.toasts.filter(item => item.expiresAt > this.now() && item.record.id !== record.id)
    this.patch({ toasts: [...candidates, { key: announcement.id, record, expiresAt: announcement.expiresAt }].slice(-8) })
  }
  dismissToast(key: string): void { this.patch({ toasts: this.state.toasts.filter(item => item.key !== key) }) }
  async refresh(): Promise<void> {
    const epoch = this.epoch
    try {
      const page = await this.api.getNotificationPage({ limit: 1 })
      if (epoch === this.epoch && page.summary.revision >= this.state.summary.revision) this.patch({ summary: page.summary, available: true, loaded: true, error: undefined,
        health: page.health ?? 'ready', historyIncomplete: this.state.historyIncomplete || page.historyIncomplete === true })
      if (epoch === this.epoch && !this.state.preferencesReady) await this.pullPreferences(epoch)
    } catch { if (epoch === this.epoch) this.patch({ error: '通知历史暂不可读取，原有功能仍可使用。', health: 'degraded' }) }
  }
  async savePreferences(preferences: NotificationPreferences): Promise<void> {
    const epoch = ++this.preferencesEpoch
    const saved = await this.api.saveNotificationPreferences(preferences)
    if (epoch === this.preferencesEpoch) this.applyPreferences(saved)
  }
  read(record: NotificationRecord): Promise<void> {
    return this.api.readNotification({ id: record.id, revision: record.revision }).then(change => {
      this.accept({ change, health: 'ready', historyIncomplete: this.state.historyIncomplete })
    })
  }
}
