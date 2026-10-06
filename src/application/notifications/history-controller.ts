import { randomUUID } from 'node:crypto'
import { NotificationActionError, type NotificationChange } from '../../domain/notification'
import { validateNotificationIntegrity, validateNotificationGapId, type NotificationHistoryIntegrity, type NotificationHistoryStatus } from '../../domain/notification-history'
import type { NotificationRepository } from '../notification-repository'

type HistoryPort = Required<Pick<NotificationRepository, 'historyGap' | 'recordHistoryGap' | 'acknowledgeHistoryGap' | 'pruneRoutine'>>
interface HistoryState { integrity?: NotificationHistoryIntegrity; unconfirmed: boolean }
export function notificationHistoryPort(repository: NotificationRepository, storageEpoch?: () => number): HistoryPort | undefined {
  if (!repository.historyGap || !repository.recordHistoryGap || !repository.acknowledgeHistoryGap || !repository.pruneRoutine) return undefined
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    const epoch = storageEpoch?.(), result = await run()
    if (epoch !== storageEpoch?.()) throw Error('私有通知历史确认跨越存储代次')
    return result
  }
  return { historyGap: id => guarded(() => repository.historyGap!(id)), recordHistoryGap: (id, now) => guarded(() => repository.recordHistoryGap!(id, now)),
    acknowledgeHistoryGap: (revision, now) => guarded(() => repository.acknowledgeHistoryGap!(revision, now)), pruneRoutine: now => guarded(() => repository.pruneRoutine!(now)) }
}

/** Private ledger upkeep only. No business probes, source replays or OS delivery. */
export class NotificationHistoryController {
  private integrity?: NotificationHistoryIntegrity
  private readonly pending = new Map<string, number>()
  private readonly known = new Set<string>()
  private episode?: string
  private processing?: Promise<void>
  private readonly hydration: Promise<void>
  private maintaining?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private nextAttemptAt = 0
  private published = ''
  private sealed = false
  constructor(private readonly port: HistoryPort, private readonly callbacks: {
    state(value: HistoryState): void; changed(value: NotificationChange): void; failed(): void
  }, private readonly now: () => number = Date.now) {
    this.hydration = Promise.resolve().then(() => port.historyGap()).then(value => this.absorb(value.integrity)).catch(() => callbacks.failed())
    this.schedule(30_000)
  }
  state(): HistoryState { return { integrity: this.integrity, unconfirmed: this.pending.size > 0 } }
  journalGapId(): string | undefined { return [...this.pending.keys()].at(-1) ?? this.integrity?.latestGapId }
  invalidateStorage(): void {
    // Preserve the known latest gap fact, not the old revision/ack counter.
    // A restored ledger must re-confirm its own exact dedupe key before reuse.
    const latest = this.integrity
    if (latest?.latestGapId && !this.pending.has(latest.latestGapId) && this.pending.size < 64)
      this.pending.set(latest.latestGapId, latest.observedAt ?? this.now())
    this.integrity = undefined; this.known.clear(); this.episode = undefined; this.nextAttemptAt = 0; this.published = ''; this.publish()
  }
  private publish(): void {
    const state = this.state(), signature = JSON.stringify(state)
    if (this.published === signature) return
    if (!this.published && state.integrity?.revision === 0 && !state.unconfirmed) { this.published = signature; return }
    this.published = signature; this.callbacks.state(state)
  }
  absorb(value: NotificationHistoryIntegrity): void {
    validateNotificationIntegrity(value)
    if (!this.integrity || value.revision > this.integrity.revision || value.revision === this.integrity.revision && value.acknowledgedRevision >= this.integrity.acknowledgedRevision) this.integrity = value
    if (value.latestGapId) { this.remember(value.latestGapId); this.pending.delete(value.latestGapId) }
    this.publish()
  }
  report(id?: string): void {
    if (this.sealed) return
    const key = id ?? this.episode ?? randomUUID(); validateNotificationGapId(key)
    if (!id) this.episode = key
    if (this.known.has(key)) return
    if (!this.pending.has(key)) {
      if (this.pending.size >= 64) { this.callbacks.failed(); return }
      this.pending.set(key, this.now()); this.publish()
    }
    this.retry()
  }
  retry(force = false): void {
    if (this.sealed || this.processing || !this.pending.size || !force && this.now() < this.nextAttemptAt) return
    this.processing = this.drain().finally(() => { this.processing = undefined })
  }
  private async drain(): Promise<void> {
    for (const [id, at] of this.pending) {
      try {
        // A lost acknowledgement is unknown. First read the exact durable key;
        // only a verified missing key can be submitted as a new fact.
        const proof: NotificationHistoryStatus = await this.port.historyGap(id)
        const value = proof.known ? proof.integrity : await this.port.recordHistoryGap(id, at)
        this.pending.delete(id); this.remember(id); this.absorb(value)
      } catch {
        this.nextAttemptAt = this.now() + 5_000; this.callbacks.failed(); this.publish(); return
      }
    }
    this.nextAttemptAt = 0; this.publish()
  }
  private remember(id: string): void { this.known.add(id); if (this.known.size > 64) this.known.delete(this.known.values().next().value!) }
  async acknowledge(revision: number): Promise<NotificationHistoryIntegrity> {
    if (!Number.isSafeInteger(revision) || revision < 1 || this.integrity && revision > this.integrity.revision) throw new NotificationActionError('历史说明版本不可用，请重新读取')
    // Establish a boundary before awaiting. A later loss cannot be folded into
    // the old episode being acknowledged, including while its reply is delayed.
    this.episode = undefined
    const result = await this.port.acknowledgeHistoryGap(revision, this.now()); this.absorb(result)
    return this.integrity!
  }
  private schedule(delay: number): void {
    if (this.sealed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.maintain() }, delay)
    this.timer.unref?.()
  }
  private maintain(): Promise<void> {
    if (this.sealed || this.maintaining) return this.maintaining ?? Promise.resolve()
    this.retry()
    this.maintaining = this.port.pruneRoutine(this.now()).then(result => {
      if (!this.sealed && result.changed) this.callbacks.changed(result)
      // Each 100-row transaction yields to existing source/reading RPCs.
      this.schedule(result.more ? 250 : 24 * 60 * 60 * 1_000)
    }).catch(() => { this.callbacks.failed(); this.schedule(5 * 60 * 1_000) }).finally(() => { this.maintaining = undefined })
    return this.maintaining
  }
  async flush(): Promise<void> { await this.hydration; while (this.processing) await this.processing }
  seal(): void { this.sealed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined }
  async close(): Promise<void> { this.seal(); await this.flush(); if (this.maintaining) await this.maintaining }
}
