import type { NotificationDraft, NotificationGroupPresentation } from '../../domain/notification'
import type { NotificationService } from '../notification-service'

interface SourceObservation<T> { key: string; input: T; baseline: boolean; storageEpoch?: number; quietEpoch: number; invalidated?: boolean; reloads?: number }
class CheckpointInvalidated extends Error {}
export interface NotificationProjection<S> { state: S; drafts: NotificationDraft[]; group?: NotificationGroupPresentation; complete?: boolean }

/** Shared durability transport, not a workflow engine: domain reducers alone decide facts and presentation. */
export class NotificationProjectionSource<T, S> {
  private readonly pending: SourceObservation<T>[] = []
  private readonly cache = new Map<string, { revision: number; state?: S }>()
  private readonly seen = new Set<string>()
  private readonly committed = new Map<string, string>()
  private current?: SourceObservation<T>
  private processing?: Promise<void>
  private closed = false
  private accepting = true
  private closing?: Promise<void>
  private epoch = 0
  private storageEpoch?: number
  constructor(private readonly owner: Pick<NotificationService, 'sourceState' | 'commitSource' | 'reportHistoryGap'> & Partial<Pick<NotificationService, 'sourceStorageEpoch'>>,
    private readonly decode: (value: unknown, key: string) => S | undefined,
    private readonly reduce: (previous: S | undefined, input: T, baseline: boolean, revision: number) => NotificationProjection<S> | Promise<NotificationProjection<S>>,
    private readonly inputSignature: (input: T) => string,
    private readonly onProjected?: (input: T, state: Readonly<S>) => void,
    private readonly batchLimit = 64) {
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 1024) throw Error('通知来源分批上限无效')
  }
  private checkStorage(): void {
    const epoch = this.owner.sourceStorageEpoch?.()
    if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0)) throw Error('通知存储代次无效')
    if (epoch === this.storageEpoch) return
    this.storageEpoch = epoch
    this.cache.clear(); this.quietNextObservation()
    if (this.current) this.current.baseline = true
  }
  private projected(input: T, state: S): void {
    try { this.onProjected?.(input, state) }
    catch { try { this.owner.reportHistoryGap() } catch { /* A private observer does not invalidate a confirmed projection. */ } }
  }
  private remember(key: string): void {
    this.seen.add(key); if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!)
  }
  private completedObservation(observation: SourceObservation<T>, state: S): void {
    this.committed.set(observation.key, this.inputSignature(observation.input))
    // A proven reload consumes its own quiet repair, not a later wake/storage
    // baseline. Otherwise the following genuine change would be wrongly quiet.
    if (observation.reloads && observation.quietEpoch === this.epoch) this.remember(observation.key)
    this.projected(observation.input, state)
  }
  observe(key: string, input: T): void {
    if (this.closed || !this.accepting) return
    try {
      this.checkStorage()
      const signature = this.inputSignature(input)
      // Compare within one source, not just adjacent global frames. A/B/A transitions
      // in the same source still survive; interleaved heartbeats do not fill the queue.
      let last: SourceObservation<T> | undefined
      for (let index = this.pending.length - 1; index >= 0; index--) if (this.pending[index]!.key === key) { last = this.pending[index]; break }
      last ??= this.current?.key === key ? this.current : undefined
      if (last ? !last.invalidated && last.storageEpoch === this.storageEpoch && this.inputSignature(last.input) === signature : this.committed.get(key) === signature) return
      if (this.pending.length >= 128) { this.owner.reportHistoryGap(); return }
      const baseline = !this.seen.has(key)
      this.remember(key)
      this.pending.push({ key, input, baseline, storageEpoch: this.storageEpoch, quietEpoch: this.epoch }); this.start()
    } catch { this.owner.reportHistoryGap() }
  }
  private start(): void {
    if (this.processing || this.closed) return
    this.processing = this.drain().finally(() => { this.processing = undefined; if (this.pending.length && !this.closed) this.start() })
  }
  private async drain(): Promise<void> {
    while (this.pending.length && !this.closed) {
      const observation = this.pending.shift()!
      this.current = observation
      const epoch = this.epoch
      try {
        this.checkStorage()
        let cached = this.cache.get(observation.key)
        if (!cached) {
          const storageEpoch = this.storageEpoch
          const value = await this.owner.sourceState(observation.key)
          this.checkStorage()
          if (storageEpoch !== this.storageEpoch) throw Error('原私有检查点读取跨越了存储代次')
          if (observation.invalidated) throw new CheckpointInvalidated()
          cached = { revision: value.revision, state: this.decode(value.data, observation.key) }; this.cache.set(observation.key, cached)
        }
        if (this.closed) return
        let conflicts = 0, batches = 0
        while (!this.closed) {
          const reductionEpoch = this.epoch, reductionStorage = this.storageEpoch
          const resultOrPromise = this.reduce(cached.state, observation.input, observation.baseline || epoch !== this.epoch, cached.revision + 1)
          const projection = resultOrPromise instanceof Promise ? await resultOrPromise : resultOrPromise
          this.checkStorage()
          if (this.closed) return
          if (reductionStorage !== this.storageEpoch) throw Error('私有通知核对跨越了存储代次')
          if (observation.invalidated) throw new CheckpointInvalidated()
          if (reductionEpoch !== this.epoch) continue // Recompute quiet presentation; an async private read cannot bypass a newer wake baseline.
          if (!projection.drafts.length && JSON.stringify(cached.state) === JSON.stringify(projection.state)) {
            if (projection.complete === false) throw Error('通知来源分批未推进检查点')
            this.completedObservation(observation, projection.state); break
          }
          const storageEpoch = this.storageEpoch
          const result = await this.owner.commitSource(observation.key, cached.revision, projection.state, projection.drafts, projection.group)
          this.checkStorage()
          if (storageEpoch !== this.storageEpoch) throw Error('原私有投影确认跨越了存储代次')
          if (observation.invalidated) throw new CheckpointInvalidated()
          if (result.applied) {
            this.cache.set(observation.key, { revision: result.source.revision, state: projection.state })
            cached = { revision: result.source.revision, state: projection.state }; conflicts = 0
            if (projection.complete === false) {
              if (++batches >= this.batchLimit) throw Error('通知来源分批超出本次处理上限')
              continue
            }
            this.completedObservation(observation, projection.state); break
          }
          cached = { revision: result.source.revision, state: this.decode(result.source.data, observation.key) }; this.cache.set(observation.key, cached)
          if (++conflicts >= 3) { this.committed.delete(observation.key); this.owner.reportHistoryGap(); break }
        }
        if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!)
        if (this.committed.size > 256) this.committed.delete(this.committed.keys().next().value!)
      } catch (error) {
        // Unknown write outcomes are not replayed blindly. The next genuine source
        // frame reloads the atomic checkpoint; a failed write is never cached as seen.
        this.cache.delete(observation.key); this.committed.delete(observation.key)
        if (error instanceof CheckpointInvalidated && (observation.reloads ?? 0) < 3 && !this.closed)
          this.pending.unshift({ ...observation, invalidated: false, reloads: (observation.reloads ?? 0) + 1, baseline: true })
        else this.owner.reportHistoryGap()
      } finally { this.current = undefined }
    }
  }
  quietNextObservation(): void {
    ++this.epoch; this.seen.clear(); this.committed.clear()
    for (const observation of this.pending) observation.baseline = true
  }
  /** A known external private CAS update, not a business refresh or source replay. Next original frame reloads this key. */
  invalidateCheckpoint(key: string): void {
    this.cache.delete(key); this.committed.delete(key); this.seen.delete(key)
    if (this.current?.key === key) { this.current.baseline = true; this.current.invalidated = true }
    for (const observation of this.pending) if (observation.key === key) observation.baseline = true
  }
  async flush(): Promise<void> { while (this.processing) await this.processing }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.accepting = false
    this.start()
    this.closing = this.flush().finally(() => this.stop())
    return this.closing
  }
  /** Immediate abort for disposal/tests; a real app quit uses close to preserve accepted observations. */
  stop(): void { this.accepting = false; this.closed = true; this.pending.length = 0 }
}
