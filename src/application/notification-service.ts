import type { NotificationChange, NotificationDraft, NotificationGroupPresentation, NotificationMarker, NotificationPage, NotificationPreferences, NotificationPush, NotificationQuery, NotificationSourceResult, NotificationSourceState } from '../domain/notification'
import { normalizeNotificationPreferences, notificationContentSignature, notificationIsUnread, notificationSafeText, NotificationActionError, validateNotificationDraft } from '../domain/notification'
import type { NotificationRepository } from './notification-repository'

/** One asynchronous owner, independent from business transaction locks or renderer route lifetimes. */
export class NotificationService {
  private readonly listeners = new Set<(event: NotificationPush) => void>()
  private readonly queued = new Map<string, NotificationDraft>()
  private readonly orderedKeys = new Set<string>()
  private readonly markers = new Map<string, NotificationMarker>()
  private pumping?: Promise<void>
  private closed = false
  private health: NotificationPush['health'] = 'ready'
  private historyIncomplete = false
  private closing?: Promise<void>
  private readonly sourceTasks = new Set<Promise<unknown>>()

  constructor(private readonly repository: NotificationRepository, private readonly now: () => number = Date.now) {}

  subscribe(listener: (event: NotificationPush) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(event: Omit<NotificationPush, 'health' | 'historyIncomplete'> = {}): void {
    for (const listener of this.listeners) {
      try { listener({ ...event, health: this.health, historyIncomplete: this.historyIncomplete }) } catch { /* A broken presentation must not fail a completed business operation. */ }
    }
  }
  private degraded(historyLost = false): void {
    const changed = this.health !== 'degraded' || historyLost && !this.historyIncomplete
    this.historyIncomplete ||= historyLost
    this.health = 'degraded'
    if (changed) this.emit()
  }
  private recovered(): void {
    if (this.health !== 'ready') { this.health = 'ready'; this.emit() }
  }
  reportHistoryGap(): void { this.degraded(true) }
  private tracked<T>(task: Promise<T>): Promise<T> {
    this.sourceTasks.add(task)
    return task.finally(() => { this.sourceTasks.delete(task) })
  }
  sourceState(key: string): Promise<NotificationSourceState> {
    return this.tracked((async () => {
      try { const source = await this.repository.sourceState(key); this.recovered(); return source }
      catch (error) { this.degraded(); throw error }
    })())
  }
  commitSource(key: string, expectedRevision: number, data: unknown, drafts: NotificationDraft[], group?: NotificationGroupPresentation): Promise<NotificationSourceResult> {
    if (this.closed || this.closing) return Promise.reject(new Error('通知来源已停止'))
    return this.tracked((async () => { try {
      const result = await this.repository.commitSource(key, expectedRevision, data, drafts, this.now())
      this.recovered()
      const announced = result.applied ? result.changes.filter(change => {
        const draft = drafts.find(value => value.key === change.record?.key)
        return change.changed && draft?.announce && change.record && notificationIsUnread(change.record) && change.record.attentionRevision === change.record.revision
      }) : []
      const grouped = group ? announced.filter(change => group.keys.includes(change.record!.key)) : []
      const combine = group !== undefined && grouped.length > 1
      if (result.applied) for (const change of result.changes) {
        if (!change.changed || !change.record) continue
        this.markers.set(change.record.key, { sourceRevision: change.record.sourceRevision, signature: notificationContentSignature(change.record) })
        const draft = drafts.find(value => value.key === change.record?.key)
        this.emit({ change, ...(draft?.announce && (!combine || !group!.keys.includes(change.record.key)) && notificationIsUnread(change.record) && change.record.attentionRevision === change.record.revision
          ? { announcement: { id: `${change.record.id}:${change.record.attentionRevision}`, expiresAt: draft.occurredAt + 60_000 } } : {}) })
      }
      if (combine) {
        const last = grouped.at(-1)!
        const finalSummary = result.changes.at(-1)?.summary ?? last.summary
        const mostRecent = Math.max(...grouped.map(change => change.record!.occurredAt))
        this.emit({ change: { ...last, summary: finalSummary }, announcement: { id: `group:${key}:${result.source.revision}`, expiresAt: mostRecent + 60_000,
          group: { source: notificationSafeText(group!.source).slice(0, 120), title: `${grouped.length} ${notificationSafeText(group!.titleSuffix)}`.slice(0, 160),
            detail: grouped.map(change => notificationSafeText(change.record!.title)).join('\n').slice(0, 1_000),
            ...(group!.target ? { target: group!.target } : {}), ...(group!.tone ? { tone: group!.tone } : {}), recordIds: grouped.map(change => change.record!.id) } } })
      }
      while (this.markers.size > 512) this.markers.delete(this.markers.keys().next().value!)
      return result
    } catch (error) { this.degraded(true); throw error } })())
  }

  /** Fire-and-forget intake. A service subscriber can call this without awaiting or catching anything. */
  offer(draft: NotificationDraft): void {
    if (this.closed || this.closing) return
    try {
      validateNotificationDraft(draft)
      const old = this.queued.get(draft.key)
      if (old && draft.sourceRevision <= old.sourceRevision) return
      if (old && notificationContentSignature(old) === notificationContentSignature(draft)) {
        this.queued.set(draft.key, structuredClone(draft)); return
      }
      if (!old && this.queued.size >= 256) {
        const quiet = [...this.queued].find(([, value]) => value.attention === 'activity')
        if (quiet && draft.attention !== 'activity') { this.queued.delete(quiet[0]); this.orderedKeys.delete(quiet[0]) }
        else { this.degraded(true); return }
        this.degraded(true)
      }
      this.queued.set(draft.key, structuredClone(draft))
      this.startPump()
    } catch { this.degraded(true) }
  }
  /** For ordered main-service current-state callbacks without their own durable sequence. Not for unverified/stale frames. */
  offerCurrent(input: Omit<NotificationDraft, 'sourceRevision'>): void {
    if (this.closed || this.closing) return
    const draft = { ...input, title: notificationSafeText(input.title), source: notificationSafeText(input.source),
      ...(input.detail !== undefined ? { detail: notificationSafeText(input.detail) } : {}), sourceRevision: 0 }
    try {
      validateNotificationDraft(draft)
      if (!this.queued.has(draft.key) && this.queued.size >= 256) { this.degraded(true); return }
      this.orderedKeys.add(draft.key); this.queued.set(draft.key, structuredClone(draft)); this.startPump()
    } catch { this.degraded(true) }
  }
  private startPump(): void {
    if (this.pumping || this.closed) return
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined
      if (this.queued.size && !this.closed) this.startPump()
    })
  }
  private async pump(): Promise<void> {
    while (this.queued.size && !this.closed) {
      let [key, draft] = this.queued.entries().next().value!
      this.queued.delete(key)
      try {
        if (this.orderedKeys.delete(key)) {
          const marker = this.markers.get(key) ?? await this.repository.marker(key)
          // A newer state may arrive while the first marker is loading; do not write the stale captured state.
          const latest = this.queued.get(key)
          if (latest && this.orderedKeys.delete(key)) { draft = latest; this.queued.delete(key) }
          if (marker.cleared && marker.signature === undefined) { this.markers.set(key, { ...marker, signature: notificationContentSignature(draft) }); continue }
          if (marker.signature === notificationContentSignature(draft)) continue
          draft.sourceRevision = marker.sourceRevision + 1
        }
        const change = await this.repository.put(draft, this.now())
        if (change.record) this.markers.set(key, { sourceRevision: change.record.sourceRevision, signature: notificationContentSignature(change.record) })
        if (this.markers.size > 512) this.markers.delete(this.markers.keys().next().value!)
        this.recovered()
        if (change.changed) this.emit({ change,
          ...(draft.announce && change.record && notificationIsUnread(change.record) && change.record.revision === change.record.attentionRevision
            ? { announcement: { id: `${change.record.id}:${change.record.attentionRevision}`, expiresAt: draft.occurredAt + 60_000 } } : {}) })
      } catch {
        this.markers.delete(key)
        // Explicitly signal possible historical loss, not another notification that recursively hits the same broken store.
        this.degraded(true)
      }
    }
  }
  async flush(): Promise<void> { while (this.pumping) await this.pumping }
  async page(query?: NotificationQuery): Promise<NotificationPage> {
    try { const page = await this.repository.page(query); this.recovered(); return { ...page, health: this.health, historyIncomplete: this.historyIncomplete } }
    catch (error) { if (!(error instanceof NotificationActionError || error && typeof error === 'object' && 'code' in error && error.code === 'notification_action_invalid')) this.degraded(); throw error }
  }
  private async mutation(run: () => Promise<NotificationChange>): Promise<NotificationChange> {
    try { const change = await run(); this.recovered(); if (change.changed) this.emit({ change }); return change }
    catch (error) { if (!(error instanceof NotificationActionError || error && typeof error === 'object' && 'code' in error && error.code === 'notification_action_invalid')) this.degraded(); throw error }
  }
  read(id: string, revision: number): Promise<NotificationChange> { return this.mutation(() => this.repository.read(id, revision, this.now())) }
  readAll(query: NotificationQuery, revision: number): Promise<NotificationChange> { return this.mutation(() => this.repository.readAll(query, revision, this.now())) }
  archive(id: string): Promise<NotificationChange> { return this.mutation(() => this.repository.archive(id, this.now())) }
  clearRead(query: NotificationQuery): Promise<NotificationChange> { return this.mutation(() => this.repository.clearRead(query, this.now())) }
  preferences(): Promise<NotificationPreferences> { return this.repository.preferences() }
  async savePreferences(value: unknown): Promise<NotificationPreferences> {
    const preferences = await this.repository.savePreferences(normalizeNotificationPreferences(value))
    this.emit({ preferences }); return preferences
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      await this.flush()
      await Promise.allSettled([...this.sourceTasks])
      this.closed = true; this.listeners.clear()
      await this.repository.close()
    })()
    return this.closing
  }
}
