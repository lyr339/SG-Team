import type { NotificationService } from './notification-service'
import { randomUUID } from 'node:crypto'
import { notificationDeliveryRoute, notificationNativeContent, notificationQuietBoundary } from '../domain/notification-delivery-policy'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationDeliveryStatus, type NotificationOpenRequest, type NotificationPreferences, type NotificationPush, type NotificationRecord, type NotificationSummary } from '../domain/notification'

interface NativeCallbacks { clicked(): void; failed(): void; closed(): void }
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
  constructor(private readonly owner: Pick<NotificationService, 'subscribe' | 'preferences' | 'page' | 'sourceState' | 'commitSource' | 'status'>, private readonly ports: {
    native: NotificationNativePort
    foreground(): boolean
    openWindow(): void
    now?: () => number
    subscribeResume?: (listener: () => void) => () => void
  }) {
    this.unsubscribe = owner.subscribe(event => this.accept(event))
    const version = this.preferencesVersion
    this.initializing = owner.preferences().then(preferences => {
      if (this.stopped || version !== this.preferencesVersion) return
      this.preferences = preferences; this.preferencesReady = true; this.scheduleQuietBoundary(); this.start()
    }).catch(() => { if (!this.stopped && version === this.preferencesVersion) this.fail('提醒设置暂不可读取；本次不会发送新的系统通知。') })
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
    return { nativeSupported, state: nativeSupported ? this.nativeState : 'unsupported', ...(this.message ? { message: this.message } : {}) }
  }
  openRequested(): NotificationOpenRequest | undefined { return this.openRequest }
  subscribe(listener: (event: NotificationPush) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(event: NotificationPush): void {
    if (this.stopped) return
    for (const listener of this.listeners) { try { listener({ ...event, delivery: this.status() }) } catch {} }
  }
  private fail(message: string): void {
    this.nativeState = 'failed'; this.message = message
    this.emit({ health: this.lastHealth, historyIncomplete: this.incomplete })
  }
  private accept(event: NotificationPush): void {
    if (this.stopped) return
    this.lastHealth = event.health; this.incomplete ||= event.historyIncomplete
    if (event.change && (!this.summary || event.change.summary.revision >= this.summary.revision)) this.summary = event.change.summary
    if (event.preferences) {
      if (!this.preferences.nativeEnabled && event.preferences.nativeEnabled) { this.nativeState = 'ready'; this.message = undefined }
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
      try {
        let event = await this.current(captured)
        if (!event || this.route(event) === 'none') continue
        if (!await this.claim(event.announcement!.id) || this.stopped) continue
        // Settings/focus/reading can change during the private commit. Recheck, do not use the stale elected route.
        event = await this.current(event)
        if (!event || this.stopped) continue
        const route = this.route(event)
        if (route === 'in-app') this.emit(event)
        else if (route === 'native') this.showNative(event)
      } catch {
        this.ledger = undefined
        // An unknown durable claim is not permission to resend. Keep the original result, disclose delivery locally.
        this.fail('部分提醒送达未确认。原结果仍保留，不会自动重发系统通知。')
      }
    }
  }
  private showNative(event: NotificationPush): void {
    const record = event.change!.record!, group = event.announcement?.group
    const display = group ? { ...record, title: group.title, detail: group.detail } : record
    const content = notificationNativeContent(display, this.preferences.preview)
    let failed = false
    const failure = () => {
      if (failed || this.stopped) return
      failed = true; this.shown.delete(record.id)
      this.fail('系统通知未确认显示。请检查系统通知权限或勿扰；原结果仍在通知中心。')
      if (!event.announcement?.signal) void this.current(event).then(current => {
        if (current && this.route(current) !== 'none') this.emit(current)
      }).catch(() => {})
    }
    try {
      const handle = this.ports.native.show({ ...content, silent: !this.preferences.sound }, {
        clicked: () => {
          if (this.stopped || this.shown.get(record.id)?.event.announcement?.id !== event.announcement?.id) return
          this.openRequest = { token: `native-open:${this.openEpoch}:${++this.openSequence}`, key: record.key, recordId: record.id, revision: record.revision, ...(group ? { grouped: true } : {}) }
          try {
            this.ports.openWindow()
            this.emit({ health: this.lastHealth, historyIncomplete: this.incomplete, openRequested: this.openRequest })
          } catch { this.fail('未能打开拾光，原通知仍保留在通知中心。') }
        }, failed: failure,
        closed: () => { if (this.shown.get(record.id)?.event.announcement?.id === event.announcement?.id) this.shown.delete(record.id) }
      })
      if (failed) { try { handle.close() } catch {} return }
      try { this.shown.get(record.id)?.handle.close() } catch {}
      this.shown.set(record.id, { handle, event })
      while (this.shown.size > 8) { const [id, first] = this.shown.entries().next().value!; try { first.handle.close() } catch {} this.shown.delete(id) }
      this.nativeState = 'ready'; this.message = undefined
    } catch { failure() }
  }
  async flush(): Promise<void> { await this.initializing; while (this.processing) await this.processing }
  dispose(): void {
    if (this.stopped) return
    this.stopped = true; this.unsubscribe(); this.pending.length = 0; this.listeners.clear()
    this.unsubscribeResume?.(); if (this.quietTimer) clearTimeout(this.quietTimer)
    for (const value of this.shown.values()) { try { value.handle.close() } catch {} }
    this.shown.clear()
  }
}
