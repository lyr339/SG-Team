import { createHash, randomUUID } from 'node:crypto'
import type { NotificationService } from '../notification-service'
import type { ModelCatalogObservation, ModelCatalogObserver } from '../../domain/model-catalog-observation'
import { readModelCatalogState, reduceModelCatalogNotifications, type ModelCatalogInput, type ModelCatalogState } from '../../domain/model-catalog-notification'
import { NotificationProjectionSource } from './projection-source'
/** Evidence from original calls only: two consecutive failures spanning five seconds, never a new timer/poll. */
export class ModelCatalogNotifications implements ModelCatalogObserver {
  private readonly ownerId = randomUUID()
  private sequence = 0
  private suspended = false
  private candidate?: { reason: 'read'|'record'|'size'; firstAt: number; lastAt: number; count: number; id: string }
  readonly source: NotificationProjectionSource<ModelCatalogInput, ModelCatalogState>
  constructor(private readonly owner: NotificationService) {
    this.source = new NotificationProjectionSource(owner, readModelCatalogState, reduceModelCatalogNotifications, i => JSON.stringify([i.fact.state, i.fact.state === 'failed' ? i.fact.reason : null]))
  }
  observe(fact: ModelCatalogObservation): void {
    if (this.suspended) return
    try {
      if (!Number.isSafeInteger(fact.at) || fact.at < 0) return
      const id = createHash('sha256').update(JSON.stringify([this.ownerId, ++this.sequence])).digest('hex')
      if (fact.state === 'failed') {
        const old = this.candidate
        if (!old || old.reason !== fact.reason || fact.at < old.lastAt || fact.at - old.lastAt > 60000) {
          this.candidate = { reason: fact.reason, firstAt: fact.at, lastAt: fact.at, count: 1, id }; return
        }
        if (fact.at === old.lastAt) return // Cached snapshot/time echo is not a second read proof.
        old.lastAt = fact.at; old.count = Math.min(2, old.count + 1)
        if (old.count < 2 || fact.at - old.firstAt < 5000) return
        this.source.observe('cursor-model-catalog-health', { key: 'cursor-model-catalog-health', id: old.id, fact: { ...fact } }); return
      }
      this.candidate = undefined
      this.source.observe('cursor-model-catalog-health', { key: 'cursor-model-catalog-health', id, fact: { ...fact } })
    } catch { this.owner.reportHistoryGap() }
  }
  unavailable(): void { this.owner.reportHistoryGap() }
  suspend(): void { this.suspended = true; this.candidate = undefined; this.source.quietNextObservation() }
  resume(): void { this.suspended = false; this.candidate = undefined; this.source.quietNextObservation() }
  close(): Promise<void> { return this.source.close() }
  stop(): void { this.source.stop() }
}
