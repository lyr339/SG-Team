import type { NotificationService } from '../notification-service'
import {
  readCompatibilityNotificationState,
  reduceCompatibilityNotifications,
  type CompatibilityNotificationInput,
  type CompatibilityNotificationState,
  type CursorCompatibilityObserver
} from '../../domain/cursor-compatibility-notification'
import { NotificationProjectionSource } from './projection-source'

export class CompatibilityNotifications implements CursorCompatibilityObserver {
  private latest = 0
  private sealed = false
  private readonly source: NotificationProjectionSource<CompatibilityNotificationInput, CompatibilityNotificationState>
  constructor(
    private readonly owner: NotificationService,
    private readonly now: () => number = Date.now
  ) {
    this.source = new NotificationProjectionSource(owner, readCompatibilityNotificationState, reduceCompatibilityNotifications, (input) =>
      JSON.stringify(input.fact)
    )
  }
  begin(): ReturnType<CursorCompatibilityObserver['begin']> {
    const revision = ++this.latest
    let used = false
    return {
      complete: (fact) => {
        if (used || this.sealed || revision !== this.latest) return
        used = true
        try {
          this.source.observe('cursor-compatibility:v1', { key: 'cursor-compatibility:v1', fact: { ...fact }, now: this.now() })
        } catch {
          this.owner.reportHistoryGap()
        }
      }
    }
  }
  flush(): Promise<void> {
    return this.source.flush()
  }
  close(): Promise<void> {
    this.sealed = true
    ++this.latest
    return this.source.close()
  }
  stop(): void {
    this.sealed = true
    ++this.latest
    this.source.stop()
  }
}
