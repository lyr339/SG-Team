import type { NotificationService } from './notification-service'
import { randomUUID } from 'node:crypto'
import { notificationDeliveryRoute, notificationNativeContent, notificationQuietBoundary } from '../domain/notification-delivery-policy'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationDeliveryStatus, type NotificationOpenRequest, type NotificationPreferences, type NotificationPush, type NotificationRecord, type NotificationSummary } from '../domain/notification'

export type NativeNoticeCloseReason = 'dismissed' | 'programmatic' | 'timed-out' | 'unknown'
interface NativeCallbacks { clicked(): void; failed(): void; closed(reason?: NativeNoticeCloseReason): void; shown(): void }
export interface NotificationNativePort {
  supported(): boolean
  show(content: { title: string; body: string; silent: boolean }, callbacks: NativeCallbacks): { close(): void }
}
interface DeliveryLedger { version: 1; ids: string[] }

/** Delivery only: source facts are already durable. No business calls, polling or delivery-as-human-read shortcuts. */
export class NotificationDeliveryService {
  private preferences: NotificationPreferences = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES)
  private preferencesReady = false
  private preferencesVersion = 0
  private readonly listeners = new Set<(event: NotificationPush) => void>()
  private readonly pending: NotificationPush[] = []
  private readonly seen = new Set<string>()
  private readonly records = new Map<string, NotificationRecord>()
  private readonly groupVersions = new WeakMap<NotificationPush, Map<string, number>>()
  private summary?: NotificationSummary
  private readonly shown = new Map<string, { handle: { close(): void }; event: NotificationPush }>()
  private nativeState: NotificationDeliveryStatus['state'] = 'ready'
  private nativeFeedback?: NotificationDeliveryStatus['nativeFeedback']
  private latestNative?: object
  private failureKind?: 'storage' | 'native'
  private storageEpoch = 0
  private receivedStorageEpoch?: number
  private message?: string
  private processing?: Promise<void>
  private readonly initializing: Promise<void>
  private ledger?: { revision: number; data: DeliveryLedger }
  private stopped = false
  private lastHealth: NotificationPush['health'] = 'ready'
  private incomplete = false
  private openRequest?: NotificationOpenRequest
  private openSequence = 0
  private readonly openEpoch = randomUUID()
  private quietTimer?: ReturnType<typeof setTimeout>
  private readonly unsubscribeResume?: () => void
  private readonly unsubscribe: () => void
  constructor(private readonly owner: Pick<NotificationService, 'subscribe' | 'preferences' | 'page' | 'sourceState' | 'commitSource' | 'status'> & Partial<Pick<NotificationService, 'sourceStorageEpoch'>>, private readonly ports: {
    native: NotificationNativePort
    foreground(): boolean
    openWindow(): void
    now?: () => number
    subscribeResume?: (listener: () => void) => () => void
  }) {
    try { const epoch = owner.sourceStorageEpoch?.(); if (epoch !== undefined && Number.isSafeInteger(epoch) && epoch >= 0) this.receivedStorageEpoch = epoch } catch {}
    this.unsubscribe = owner.subscribe(event => this.accept(event))
    const version = this.preferencesVersion
    this.initializing = owner.preferences().then(preferences => {
      if (this.stopped || version !== this.preferencesVersion) return
      this.preferences = preferences; this.preferencesReady = true; this.scheduleQuietBoundary(); this.start()
    }).catch(() => { if (!this.stopped && version === this.preferencesVersion) this.fail('提醒设置暂不可读取；本次不会发送新的系统通知。', 'storage') })
    this.unsubscribeResume = ports.subscribeResume?.(() => {
      if (this.stopped || !this.preferencesReady) return
      this.closeMutedNative(); this.scheduleQuietBoundary()
      this.emit({ preferences: this.preferences, health: this.lastHealth, historyIncomplete: this.incomplete })
    })
  }
  private now(): number { return this.ports.now?.() ?? Date.now() }
  status(): NotificationDeliveryStatus {
    let nativeSupported = false
    try { nativeSupported = this.ports.native.supported() } catch {}
    return { nativeSupported, state: nativeSupported ? this.nativeState : 'unsupported', ...(this.message ? { message: this.message } : {}),
      ...(nativeSupported && this.nativeFeedback ? { nativeFeedback: this.nativeFeedback } : {}) }
  }
  openRequested(): NotificationOpenRequest | undefined { return this.openRequest }
  subscribe(listener: (event: NotificationPush) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(event: NotificationPush): void {
    if (this.stopped) return
    let epoch = event.storageEpoch ?? event.change?.storageEpoch ?? this.receivedStorageEpoch
    try { epoch ??= this.owner.sourceStorageEpoch?.() } catch {}
    for (const listener of this.listeners) { try { listener({ ...event, ...(epoch !== undefined ? { storageEpoch: epoch } : {}), delivery: this.status() }) } catch {} }
  }
  private fail(message: string, kind: 'storage' | 'native' = 'native'): void {
    // Reopening SQLite is not evidence that an OS permission/display failure was repaired.
    if (this.failureKind !== 'native' || kind === 'native') { this.nativeState = 'failed'; this.message = message; this.failureKind = kind }
    this.emit({ health: this.lastHealth, historyIncomplete: this.incomplete })
  }
  private accept(event: NotificationPush): void {
    if (this.stopped) return
    const epoch = event.storageEpoch ?? event.change?.storageEpoch
    if (epoch === undefined && (this.receivedStorageEpoch ?? 0) > 0) return // Legacy unbound frames cannot address a proven replacement ledger.
    if (epoch !== undefined) {
      if (!Number.isSafeInteger(epoch) || epoch < 0 || this.receivedStorageEpoch !== undefined && epoch < this.receivedStorageEpoch) return
      if (epoch !== this.receivedStorageEpoch && (this.receivedStorageEpoch !== undefined || epoch > 0)) {
        ++this.storageEpoch; this.ledger = undefined; this.pending.length = 0; this.records.clear(); this.summary = undefined; this.openRequest = undefined
        this.preferencesReady = false; ++this.preferencesVersion; this.closeAllNative()
      }
      this.receivedStorageEpoch = epoch
    }
    const previousHealth = this.lastHealth
    if (event.health === 'degraded' && previousHealth !== 'degraded') {
      ++this.storageEpoch; this.ledger = undefined; this.pending.length = 0
      this.closeAllNative()
    }
    // The exit already invalidated old opportunities. A delayed history refresh
    // must not discard a genuinely new result committed by the recovered worker.
    if (event.historyReload) this.ledger = undefined
    if ((event.historyReload || previousHealth === 'degraded' && event.health === 'ready') && this.failureKind === 'storage') {
      this.nativeState = 'ready'; this.message = undefined; this.failureKind = undefined
    }
    this.lastHealth = event.health; this.incomplete ||= event.historyIncomplete
    if (event.change && (!this.summary || event.change.summary.revision >= this.summary.revision)) this.summary = event.change.summary
    if (event.preferences) {
      if (!this.preferences.nativeEnabled && event.preferences.nativeEnabled) { this.nativeState = 'ready'; this.message = undefined; this.failureKind = undefined; this.nativeFeedback = undefined }
      ++this.preferencesVersion; this.preferences = event.preferences; this.preferencesReady = true
      this.closeMutedNative(); this.scheduleQuietBoundary()
    }
    const record = event.change?.record
    if (record) {
      const previous = this.records.get(record.id)
      if (!previous || previous.revision < record.revision || previous.revision === record.revision && previous.readRevision <= record.readRevision) this.records.set(record.id, record)
      while (this.records.size > 512) this.records.delete(this.records.keys().next().value!)
      if (record.archivedAt !== undefined || record.state === 'expired' || record.attention !== 'activity' && record.readRevision >= record.attentionRevision) {
        try { this.shown.get(record.id)?.handle.close() } catch {} this.shown.delete(record.id)
      }
      for (const [id, displayed] of this.shown) if (displayed.event.announcement?.group?.recordIds.includes(record.id)
        && (record.revision !== this.groupVersions.get(displayed.event)?.get(record.id) || record.readRevision >= record.attentionRevision || record.state === 'expired')) {
        try { displayed.handle.close() } catch {} this.shown.delete(id)
      }
    }
    if (event.change && !record && event.change.summary.unread === 0) { for (const value of this.shown.values()) { try { value.handle.close() } catch {} } this.shown.clear() }
    // History/preferences/read state is always forwarded, but only this owner elects a delivery channel.
    this.emit({ ...event, announcement: undefined })
    const signal = event.announcement
    if (!signal || !record || this.seen.has(signal.id)) { this.start(); return }
    this.seen.add(signal.id); while (this.seen.size > 1_024) this.seen.delete(this.seen.values().next().value!)
    if (this.pending.length >= 32) { this.fail('提醒较多，部分短暂提醒未送达；原记录仍在通知中心。'); return }
    if (signal.group) this.groupVersions.set(event, new Map(signal.group.recordIds.map(id => [id, this.records.get(id)?.revision ?? -1])))
    this.pending.push(event); this.start()
  }
  private closeMutedNative(): void {
    for (const [id, displayed] of this.shown) {
      const record = this.records.get(id)
      if (record && notificationDeliveryRoute(record, { ...displayed.event.announcement!, expiresAt: this.now() + 1 }, this.preferences,
        { foreground: false, nativeSupported: true, now: this.now() }) !== 'native') {
        try { displayed.handle.close() } catch {} this.shown.delete(id)
      }
    }
  }
  private scheduleQuietBoundary(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    const boundary = notificationQuietBoundary(this.preferences, this.now())
    if (!boundary || this.stopped) return
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined
      if (this.stopped) return
      this.closeMutedNative(); this.emit({ preferences: this.preferences, health: this.lastHealth, historyIncomplete: this.incomplete }); this.scheduleQuietBoundary()
    }, Math.max(1, boundary - this.now() + 10))
    this.quietTimer.unref?.()
  }
  private start(): void {
    if (this.processing || !this.preferencesReady || this.stopped) return
    this.processing = this.drain().finally(() => { this.processing = undefined; if (this.pending.length && !this.stopped) this.start() })
  }
  private async current(event: NotificationPush): Promise<NotificationPush | undefined> {
    const captured = event.change?.record, signal = event.announcement
    if (!captured || !signal || signal.expiresAt <= this.now()) return undefined
    const page = await this.owner.page({ key: captured.key, limit: 1 })
    if (page.storageEpoch !== undefined && page.storageEpoch !== (event.storageEpoch ?? event.change?.storageEpoch ?? captured.storageEpoch ?? 0)) return
    const record = page.records[0]
    if (!record || record.id !== captured.id || record.state === 'expired' || record.archivedAt !== undefined
      || (signal.signal ? record.revision !== captured.revision : record.attentionRevision !== captured.attentionRevision)) return undefined
    if (signal.group) {
      // Never repeat an aggregate whose captured members already changed or were read.
      for (const id of signal.group.recordIds) {
        const member = this.records.get(id)
        if (!member) return undefined
        const current = (await this.owner.page({ key: member.key, limit: 1 })).records[0]
        if (!current || current.id !== id || current.revision !== this.groupVersions.get(event)?.get(id) || current.readRevision >= current.attentionRevision) return undefined
      }
    }
    // A key-filtered page summary is NOT the app's unread badge. Use the verified
    // global source stream, otherwise a late delivery would reset 40 records to 1.
    const refreshed = { ...event, change: { ...event.change!, record, summary: this.summary ?? event.change!.summary } }
    const versions = this.groupVersions.get(event); if (versions) this.groupVersions.set(refreshed, versions)
    return refreshed
  }
  private async claim(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.ledger) {
        const stored = await this.owner.sourceState('notification-delivery:v1'), value = stored.data as DeliveryLedger | undefined
        if (value && (value.version !== 1 || !Array.isArray(value.ids) || value.ids.length > 1_024 || value.ids.some(id => typeof id !== 'string' || id.length > 700))) throw Error('送达去重记录异常')
        this.ledger = { revision: stored.revision, data: value ?? { version: 1, ids: [] } }
      }
      if (this.ledger.data.ids.includes(id)) return false
      const data: DeliveryLedger = { version: 1, ids: [...this.ledger.data.ids, id].slice(-1_024) }
      const result = await this.owner.commitSource('notification-delivery:v1', this.ledger.revision, data, [])
      if (result.applied) { this.ledger = { revision: result.source.revision, data }; return true }
      this.ledger = undefined
    }
    throw Error('送达去重记录未能确认，不重放未知提醒')
  }
  private route(event: NotificationPush): 'none' | 'in-app' | 'native' {
    if (this.stopped || !event.change?.record || !event.announcement || this.owner.status().health !== 'ready') return 'none'
    return notificationDeliveryRoute(event.change.record, event.announcement, this.preferences,
      { foreground: this.ports.foreground(), nativeSupported: this.nativeState !== 'failed' && this.status().nativeSupported, now: this.now() })
  }
  private async drain(): Promise<void> {
    while (this.pending.length && !this.stopped) {
      const captured = this.pending.shift()!
      const storageEpoch = this.storageEpoch
      try {
        let event = await this.current(captured)
        if (!event || storageEpoch !== this.storageEpoch || this.route(event) === 'none') continue
        if (!await this.claim(event.announcement!.id) || this.stopped) continue
        if (storageEpoch !== this.storageEpoch) continue
        // Settings/focus/reading can change during the private commit. Recheck, do not use the stale elected route.
        event = await this.current(event)
        if (!event || this.stopped || storageEpoch !== this.storageEpoch) continue
        const route = this.route(event)
        if (route === 'in-app') this.emit(event)
        else if (route === 'native') this.showNative(event)
      } catch {
        this.ledger = undefined
        // An unknown durable claim is not permission to resend. Keep the original result, disclose delivery locally.
        if (storageEpoch === this.storageEpoch || this.lastHealth === 'degraded') this.fail('部分提醒送达未确认。原结果仍保留，不会自动重发系统通知。', 'storage')
      }
    }
  }
  private showNative(event: NotificationPush): void {
    const record = event.change!.record!, group = event.announcement?.group
    const display = group ? { ...record, title: group.title, detail: group.detail } : record
    const content = notificationNativeContent(display, this.preferences.preview)
    const epoch = this.storageEpoch
    const ledgerEpoch = event.storageEpoch ?? event.change?.storageEpoch ?? record.storageEpoch ?? this.receivedStorageEpoch ?? 0
    // Register before calling Electron: show/failed/close/click may arrive
    // synchronously. A stale callback cannot address a replacement by ID alone.
    const previous = this.shown.get(record.id); this.shown.delete(record.id)
    try { previous?.handle.close() } catch {}
    const previousLatest = this.latestNative, previousFeedback = this.nativeFeedback
    let nativeHandle: { close(): void } | undefined, closeRequested = false, failed = false, reported = false
    const handle = { close: () => { if (closeRequested) return; closeRequested = true; try { nativeHandle?.close() } catch {} } }
    const owned = { handle, event }
    this.shown.set(record.id, owned); this.latestNative = owned; this.nativeFeedback = 'unconfirmed'
    const current = () => {
      if (this.stopped || closeRequested || epoch !== this.storageEpoch || this.shown.get(record.id) !== owned) return false
      try { return (this.owner.sourceStorageEpoch?.() ?? this.receivedStorageEpoch ?? 0) === ledgerEpoch } catch { return false }
    }
    this.emit({ health: this.lastHealth, historyIncomplete: this.incomplete })
    const elected = this.route(event)
    if (!current() || elected !== 'native') {
      if (this.shown.get(record.id) === owned) this.shown.delete(record.id)
      handle.close()
      if (this.latestNative === owned) { this.latestNative = previousLatest; this.nativeFeedback = previousFeedback; this.emit({ health: this.lastHealth, historyIncomplete: this.incomplete }) }
      if (elected === 'in-app') this.emit(event)
      return
    }
    const failure = () => {
      if (failed || !current()) return
      failed = true; this.shown.delete(record.id); handle.close()
      this.fail('系统通知未确认显示。请检查系统通知权限或勿扰；原结果仍在通知中心。')
      if (!reported && !event.announcement?.signal) void this.current(event).then(current => {
        if (current && epoch === this.storageEpoch && this.route(current) !== 'none') this.emit(current)
      }).catch(() => {})
    }
    try {
      nativeHandle = this.ports.native.show({ ...content, silent: !this.preferences.sound }, {
        clicked: () => {
          if (!current()) return
          this.openRequest = { token: `native-open:${this.openEpoch}:${++this.openSequence}`, key: record.key, recordId: record.id, revision: record.revision, storageEpoch: ledgerEpoch, ...(group ? { grouped: true } : {}) }
          try {
            this.ports.openWindow()
            this.emit({ health: this.lastHealth, historyIncomplete: this.incomplete, openRequested: this.openRequest })
          } catch { this.fail('未能打开拾光，原通知仍保留在通知中心。') }
        }, failed: failure,
        shown: () => { if (current()) { reported = true; if (this.latestNative === owned) { this.nativeFeedback = 'reported'; this.emit({ health: this.lastHealth, historyIncomplete: this.incomplete }) } } },
        closed: reason => {
          if (!current()) return
          // A Windows banner timeout can leave the object in Action Center.
          // Missing/unknown reason is not evidence that it became unclickable.
          if (reason === 'timed-out' || reason === 'unknown' || reason === undefined) return
          this.shown.delete(record.id); handle.close()
        }
      })
      if (closeRequested || failed || !current()) { try { nativeHandle.close() } catch {}; return }
      while (this.shown.size > 8) { const [id, first] = this.shown.entries().next().value!; this.shown.delete(id); try { first.handle.close() } catch {} }
    } catch { failure() }
  }
  private closeAllNative(): void {
    const handles = [...this.shown.values()]; this.shown.clear(); this.latestNative = undefined; this.nativeFeedback = undefined
    for (const value of handles) { try { value.handle.close() } catch {} }
  }
  async flush(): Promise<void> { await this.initializing; while (this.processing) await this.processing }
  dispose(): void {
    if (this.stopped) return
    this.stopped = true; this.unsubscribe(); this.pending.length = 0; this.listeners.clear()
    this.unsubscribeResume?.(); if (this.quietTimer) clearTimeout(this.quietTimer)
    this.closeAllNative()
  }
}
