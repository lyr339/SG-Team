import type { NotificationSourceListPage, NotificationSourceListQuery } from '../domain/native-scope-availability'
import type { NotificationChange, NotificationDraft, NotificationGroupPresentation, NotificationMarker, NotificationPage, NotificationPreferences, NotificationPush, NotificationQuery, NotificationRecord, NotificationSourceResult, NotificationSourceState } from '../domain/notification'
import { normalizeNotificationPreferences, notificationContentSignature, notificationIsUnread, notificationSafeText, NotificationActionError, validateNotificationDraft } from '../domain/notification'
import type { NotificationRepository, NotificationRepositoryLifecycle } from './notification-repository'
import { NotificationHistoryController, notificationHistoryPort } from './notifications/history-controller'
import type { NotificationHistoryIntegrity } from '../domain/notification-history'
import { notificationFingerprint } from './notification-fingerprint'

/** One asynchronous owner, independent from business transaction locks or renderer route lifetimes. */
export class NotificationService {
  private readonly listeners = new Set<(event: NotificationPush) => void>()
  private readonly queued = new Map<string, NotificationDraft>()
  private readonly orderedKeys = new Set<string>()
  private readonly markers = new Map<string, NotificationMarker>()
  private pumping?: Promise<void>
  private closed = false
  private shuttingDown = false
  private shutdownFailed = false
  private closeConfirmed = false
  private health: NotificationPush['health'] = 'ready'
  private historyIncomplete = false
  private closing?: Promise<void>
  private readonly sourceTasks = new Set<Promise<unknown>>()
  private readonly detachStorage?: () => void
  private storageEpoch = 0
  private sourceEpoch = 0
  private storageGeneration?: number
  private storageUnavailable = false
  private preferencesEpoch = 0
  private recovering?: Promise<void>
  private readonly history?: NotificationHistoryController

  constructor(private readonly repository: NotificationRepository, private readonly now: () => number = Date.now) {
    const historyPort = notificationHistoryPort(repository)
    if (historyPort) this.history = new NotificationHistoryController(historyPort, {
      state: value => { this.historyIncomplete ||= (value.integrity?.revision ?? 0) > 0 || value.unconfirmed; this.emit() },
      changed: change => { this.markers.clear(); this.emit({ change }) },
      failed: () => this.degraded()
    }, now)
    this.detachStorage = repository.subscribeLifecycle?.(event => this.storageLifecycle(event))
  }

  private storageLifecycle(event: NotificationRepositoryLifecycle): void {
    // Pending requests sent after unavailable may legitimately wait for the
    // next worker's first ready. Invalidate at loss, not twice at that ready.
    // The first-ever ready is initialization, not a lost storage generation.
    if (event.state === 'unavailable') {
      if (!this.storageUnavailable || this.storageGeneration !== event.generation) ++this.sourceEpoch
      this.storageUnavailable = true
    } else {
      if (this.storageGeneration !== undefined && this.storageGeneration !== event.generation && !this.storageUnavailable) ++this.sourceEpoch
      this.storageUnavailable = false
    }
    this.storageGeneration = event.generation
    const epoch = ++this.storageEpoch
    // An interrupted put may already have committed. Never retain pre-exit
    // content markers or infer rollback from the missing acknowledgement.
    this.markers.clear()
    if (event.state === 'unavailable') { this.degraded(true); return }
    if (this.closed || this.shuttingDown) return
    const preferencesEpoch = this.preferencesEpoch
    const task = this.tracked(Promise.all([this.repository.page({ limit: 1 }), this.repository.preferences()]).then(([page, preferences]) => {
      if (epoch !== this.storageEpoch || this.closed || this.shuttingDown) return
      if (page.historyIntegrity) this.history?.absorb(page.historyIntegrity)
      this.recovered(false)
      this.history?.retry(true)
      // Read persisted facts and controls, not business sources. No announcement
      // is reconstructed, even if a pre-exit write really reached the ledger.
      this.emit({ historyReload: true, change: { changed: false, summary: page.summary }, ...(preferencesEpoch === this.preferencesEpoch ? { preferences } : {}) })
    }).catch(() => { if (epoch === this.storageEpoch) this.degraded(true) }))
    this.recovering = task
    void task.finally(() => { if (this.recovering === task) this.recovering = undefined })
  }

  subscribe(listener: (event: NotificationPush) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(event: Omit<NotificationPush, 'health' | 'historyIncomplete'> = {}): void {
    // Quit draining is persistence work, not an opportunity to pop a late toast or OS alert.
    const delivered = this.shuttingDown ? { ...event, announcement: undefined } : event
    for (const listener of this.listeners) {
      try { listener({ ...delivered, health: this.health, historyIncomplete: this.historyIncomplete,
        historyIntegrity: this.history?.state().integrity, historyGapUnconfirmed: this.history?.state().unconfirmed }) } catch { /* A broken presentation must not fail a completed business operation. */ }
    }
  }
  private degraded(historyLost = false, gapId?: string): void {
    const changed = this.health !== 'degraded' || historyLost && !this.historyIncomplete
    this.historyIncomplete ||= historyLost
    if (this.shuttingDown && historyLost) this.shutdownFailed = true
    this.health = 'degraded'
    if (historyLost) this.history?.report(gapId)
    if (changed) this.emit()
  }
  private recovered(syncHistory=true): void {
    if (this.health !== 'ready') {
      this.health = 'ready'; this.emit(); this.history?.retry()
      // A live worker can commit before losing its acknowledgement. On the next
      // proven successful read/transaction, reload the PRIVATE global summary
      // once; source checkpoint recovery alone cannot update a stale bell.
      if(syncHistory&&this.historyIncomplete&&!this.recovering&&!this.closed&&!this.shuttingDown){
        const epoch=this.storageEpoch
        const task=this.tracked(Promise.resolve().then(()=>this.repository.page({limit:1})).then(page=>{
          if(epoch!==this.storageEpoch||this.closed||this.shuttingDown||this.health!=='ready')return
          if(page.historyIntegrity)this.history?.absorb(page.historyIntegrity)
          this.emit({historyReload:true,change:{changed:false,summary:page.summary}})
        }).catch(()=>{if(epoch===this.storageEpoch&&!this.closed)this.degraded()}))
        this.recovering=task
        void task.finally(()=>{if(this.recovering===task)this.recovering=undefined})
      }
    }
  }
  reportHistoryGap(id?: string): void { this.degraded(true, id) }
  /** In-process private storage identity; no business read, request, timer or IPC. */
  sourceStorageEpoch(): number { return this.sourceEpoch }
  status(): { health: NotificationPush['health']; historyIncomplete: boolean; shutdownConfirmed: boolean; historyGapId?: string } {
    return { health: this.health, historyIncomplete: this.historyIncomplete, shutdownConfirmed: this.closeConfirmed && !this.shutdownFailed && this.health === 'ready' && !this.history?.state().unconfirmed, historyGapId: this.history?.journalGapId() }
  }
  /** Source producers must seal and drain before close rejects their remaining commits. */
  beginShutdown(): void { this.shuttingDown = true; this.history?.seal() }
  private tracked<T>(task: Promise<T>): Promise<T> {
    this.sourceTasks.add(task)
    return task.finally(() => { this.sourceTasks.delete(task) })
  }
  private signal(draft: NotificationDraft | undefined, record: NotificationRecord | undefined): NotificationPush['announcement'] | undefined {
    if (!draft || !record) return undefined
    if (draft.announce && notificationIsUnread(record) && record.attentionRevision === record.revision) {
      return { id: `${record.id}:${record.attentionRevision}`, expiresAt: draft.occurredAt + 60_000 }
    }
    if (draft.liveSignal && record.archivedAt === undefined && record.state !== 'expired') {
      return { id: `${record.id}:${record.revision}:${draft.liveSignal}`, expiresAt: draft.occurredAt + 60_000, signal: draft.liveSignal }
    }
    return undefined
  }
  sourceState(key: string): Promise<NotificationSourceState> {
    const epoch = this.sourceEpoch
    return this.tracked((async () => {
      try {
        const source = await this.repository.sourceState(key)
        if (epoch !== this.sourceEpoch) throw Error('通知存储代次已变化，原检查点读取未确认')
        this.recovered(); return source
      }
      catch (error) { this.degraded(); throw error }
    })())
  }
  listNativeSources(query: NotificationSourceListQuery): Promise<NotificationSourceListPage> {
    const epoch = this.sourceEpoch
    return this.tracked((async () => {
      try {
        if (!this.repository.listNativeSources) throw Error('私有原来源目录不可用')
        const page = await this.repository.listNativeSources(query)
        if (epoch !== this.sourceEpoch) throw Error('私有原来源目录读取跨越存储代次')
        this.recovered(); return page
      } catch (error) { this.degraded(); throw error }
    })())
  }
  /** Reuses the existing private marker command, including archived/cleared records. No original-source or renderer query. */
  sourceMarker(key: string): Promise<NotificationMarker> {
    const epoch = this.sourceEpoch
    return this.tracked((async () => {
      const marker = await this.repository.marker(key)
      if (epoch !== this.sourceEpoch) throw Error('私有通知标记读取跨越存储代次')
      return marker
    })())
  }
  commitSource(key: string, expectedRevision: number, data: unknown, drafts: NotificationDraft[], group?: NotificationGroupPresentation): Promise<NotificationSourceResult> {
    if (this.closed || this.closing) return Promise.reject(new Error('通知来源已停止'))
    const epoch = this.sourceEpoch
    return this.tracked((async () => { try {
      const result = await this.repository.commitSource(key, expectedRevision, data, drafts, this.now())
      if (epoch !== this.sourceEpoch) throw Error('通知存储代次已变化，原投影回执未确认')
      this.recovered()
      const announced = result.applied ? result.changes.filter(change => {
        const draft = drafts.find(value => value.key === change.record?.key)
        return change.changed && draft?.announce && change.record && notificationIsUnread(change.record) && change.record.attentionRevision === change.record.revision
      }) : []
      const grouped = group ? announced.filter(change => group.keys.includes(change.record!.key)) : []
      const combine = group !== undefined && grouped.length > 1
      if (result.applied) for (const change of result.changes) {
        if (!change.changed || !change.record) continue
        this.markers.set(change.record.key, { sourceRevision: change.record.sourceRevision, signature: notificationFingerprint(change.record) })
        const draft = drafts.find(value => value.key === change.record?.key)
        const signal = combine && group!.keys.includes(change.record.key) ? undefined : this.signal(draft, change.record)
        this.emit({ change, ...(signal ? { announcement: signal } : {}) })
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
          if (marker.cleared && marker.signature === undefined) { this.markers.set(key, { ...marker, signature: notificationFingerprint(draft) }); continue }
          if (marker.signature === notificationFingerprint(draft)) continue
          draft.sourceRevision = marker.sourceRevision + 1
        }
        const change = await this.repository.put(draft, this.now())
        if (change.record) this.markers.set(key, { sourceRevision: change.record.sourceRevision, signature: notificationFingerprint(change.record) })
        if (this.markers.size > 512) this.markers.delete(this.markers.keys().next().value!)
        this.recovered()
        if (change.changed) { const signal = this.signal(draft, change.record); this.emit({ change, ...(signal ? { announcement: signal } : {}) }) }
      } catch {
        this.markers.delete(key)
        // Explicitly signal possible historical loss, not another notification that recursively hits the same broken store.
        this.degraded(true)
      }
    }
  }
  async flush(): Promise<void> { while (this.pumping || this.recovering) await Promise.allSettled([this.pumping, this.recovering]); await this.history?.flush() }
  async page(query?: NotificationQuery): Promise<NotificationPage> {
    try {
      const page = await this.repository.page(query)
      if (page.historyIntegrity) this.history?.absorb(page.historyIntegrity)
      this.recovered()
      return { ...page, health: this.health, historyIncomplete: this.historyIncomplete, historyGapUnconfirmed: this.history?.state().unconfirmed }
    }
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
  async acknowledgeHistoryGap(revision: number): Promise<NotificationHistoryIntegrity> {
    if (!this.history) throw new NotificationActionError('历史说明暂不可确认，请稍后重试')
    try { return await this.history.acknowledge(revision) }
    catch (error) { if (!(error instanceof NotificationActionError || error && typeof error === 'object' && 'code' in error && error.code === 'notification_action_invalid')) this.degraded(); throw error }
  }
  async savePreferences(value: unknown): Promise<NotificationPreferences> {
    ++this.preferencesEpoch
    const preferences = await this.repository.savePreferences(normalizeNotificationPreferences(value))
    this.emit({ preferences }); return preferences
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.beginShutdown()
    this.closing = (async () => {
      await this.flush()
      await this.history?.close()
      await Promise.allSettled([...this.sourceTasks])
      this.closed = true; this.detachStorage?.(); this.listeners.clear()
      try { await this.repository.close(); this.closeConfirmed = true }
      catch (error) { this.degraded(true); throw error }
    })()
    return this.closing
  }
}
