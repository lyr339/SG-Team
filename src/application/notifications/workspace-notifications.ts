import type { CursorWorkspaceDetection } from '../../domain/cursor-workspace'
import type { NotificationService } from '../notification-service'
import { notificationSafeText } from '../../domain/notification'
import {
  readWorkspaceNotificationState,
  reduceWorkspaceNotifications,
  type WorkspaceNotificationInput,
  type WorkspaceNotificationState
} from '../../domain/workspace-notification'
import { NotificationProjectionSource } from './projection-source'
export interface WorkspaceDetectionObserver {
  begin(): { complete(value: CursorWorkspaceDetection): void }
}
/** Observe the original probe once. Latest-started request owns presentation; no probe/selection/run mutation is added. */
export class WorkspaceNotifications implements WorkspaceDetectionObserver {
  private latest = 0
  private failure?: { cause: CursorWorkspaceDetection['cause']; since: number; count: number }
  private readonly source: NotificationProjectionSource<WorkspaceNotificationInput, WorkspaceNotificationState>
  private stopped = false
  constructor(private readonly owner: NotificationService) {
    this.source = new NotificationProjectionSource(owner, readWorkspaceNotificationState, reduceWorkspaceNotifications, (input) =>
      JSON.stringify([input.detected, input.cause, input.persistent])
    )
  }
  begin(): { complete(value: CursorWorkspaceDetection): void } {
    const sequence = ++this.latest
    let complete = false
    return {
      complete: (value) => {
        if (complete || this.stopped || sequence !== this.latest) return
        complete = true
        try {
          if (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0) return
          const detected =
            value.state === 'detected' && value.workspace
              ? { id: value.workspace.id, name: notificationSafeText(value.workspace.name).slice(0, 80) }
              : undefined
          const cause =
            value.cause &&
            ['no-window', 'multiple-windows', 'no-folder', 'remote', 'multi-root', 'unconfirmed', 'connection-unavailable'].includes(value.cause)
              ? value.cause
              : value.state === 'ambiguous'
                ? 'multiple-windows'
                : 'unconfirmed'
          if (detected) this.failure = undefined
          else if (this.failure?.cause === cause) this.failure.count++
          else this.failure = { cause, since: value.observedAt, count: 1 }
          const persistent = Boolean(this.failure && this.failure.count >= 2 && value.observedAt - this.failure.since >= 3000)
          this.source.observe('workspace-detection:v1', { key: 'workspace-detection:v1', detected, cause, persistent, observedAt: value.observedAt })
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
    this.stopped = true
    ++this.latest
    return this.source.close()
  }
  stop(): void {
    this.stopped = true
    ++this.latest
    this.source.stop()
  }
}
