import { createHash, randomUUID } from 'node:crypto'
import type { NotificationService } from '../notification-service'
import type { UsageStorageObservation } from '../../domain/usage-storage-observation'
import { readUsageStorageState, reduceUsageStorageNotifications, type UsageStorageInput, type UsageStorageState } from '../../domain/usage-storage-notification'
import { NotificationProjectionSource } from './projection-source'

/** One logical usage store in the app's private profile; no business callbacks, file reads or retry commands. */
export class UsageStorageNotifications {
  private readonly ownerId = randomUUID()
  private sequence = 0
  readonly source: NotificationProjectionSource<UsageStorageInput, UsageStorageState>
  constructor(private readonly owner: NotificationService, private readonly now: () => number = Date.now) {
    this.source = new NotificationProjectionSource(owner, readUsageStorageState, reduceUsageStorageNotifications, input => JSON.stringify(input.fact))
  }
  observe(fact: UsageStorageObservation): void {
    try {
      const id = createHash('sha256').update(JSON.stringify([this.ownerId, ++this.sequence])).digest('hex')
      this.source.observe('usage-storage-health', { key: 'usage-storage-health', id, fact: { ...fact }, at: this.now() })
    } catch { this.owner.reportHistoryGap() }
  }
  unavailable(): void { this.owner.reportHistoryGap() }
  close(): Promise<void> { return this.source.close() }
  stop(): void { this.source.stop() }
}
