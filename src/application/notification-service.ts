import type { NotificationChange, NotificationDraft, NotificationPage, NotificationPreferences, NotificationPush, NotificationQuery } from '../domain/notification'
import { normalizeNotificationPreferences, notificationContentSignature, NotificationActionError, validateNotificationDraft } from '../domain/notification'
import type { NotificationRepository } from './notification-repository'

/** One asynchronous owner, independent from business transaction locks or renderer route lifetimes. */
export class NotificationService {
  private readonly listeners = new Set<(event: NotificationPush) => void>()
  private readonly queued = new Map<string, NotificationDraft>()
  private pumping?: Promise<void>
  private closed = false
  private health: NotificationPush['health'] = 'ready'
  private historyIncomplete = false
  private closing?: Promise<void>

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
        if (quiet && draft.attention !== 'activity') this.queued.delete(quiet[0])
        else { this.degraded(true); return }
        this.degraded(true)
      }
      this.queued.set(draft.key, structuredClone(draft))
      this.startPump()
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
      const [key, draft] = this.queued.entries().next().value!
      this.queued.delete(key)
      try {
        const change = await this.repository.put(draft, this.now())
        this.recovered()
        if (change.changed) this.emit({ change })
      } catch {
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
      this.closed = true; this.listeners.clear()
      await this.repository.close()
    })()
    return this.closing
  }
}
