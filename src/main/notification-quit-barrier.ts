import type { NotificationService } from '../application/notification-service'

/** Seal producers before disposing business snapshots; keep the ledger accepting their already captured facts until drained. */
export async function drainNotificationsForQuit(owner: NotificationService, sources: Array<() => Promise<void>>, stopDesktop: () => void): Promise<boolean> {
  owner.beginShutdown()
  const pending = sources.map(close => { try { return close() } catch (error) { return Promise.reject(error) } })
  try { stopDesktop() } catch { owner.reportHistoryGap() }
  const results = await Promise.allSettled(pending)
  if (results.some(result => result.status === 'rejected')) owner.reportHistoryGap()
  try { await owner.close() } catch { return false }
  return owner.status().shutdownConfirmed
}

export interface NotificationQuitResult {
  confirmed: boolean
  reason: 'drained' | 'unconfirmed' | 'failed' | 'timeout'
}

/** Only gates real app quitting. It never creates a window, calls an installer, or alters close-to-background behavior. */
export class NotificationQuitBarrier {
  private phase: 'idle' | 'draining' | 'ready' = 'idle'
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly options: {
    drain: () => Promise<boolean>
    settled: (result: NotificationQuitResult) => void
    resumeQuit: () => void
    timeoutMs?: number
  }) {}
  handle(event: { preventDefault(): void }): void {
    if (this.phase === 'ready') return
    event.preventDefault()
    if (this.phase === 'draining') return
    this.phase = 'draining'
    this.timer = setTimeout(() => this.finish({ confirmed: false, reason: 'timeout' }), this.options.timeoutMs ?? 2_000)
    try {
      void this.options.drain().then(confirmed => this.finish({ confirmed, reason: confirmed ? 'drained' : 'unconfirmed' }),
        () => this.finish({ confirmed: false, reason: 'failed' }))
    } catch { this.finish({ confirmed: false, reason: 'failed' }) }
  }
  private finish(result: NotificationQuitResult): void {
    if (this.phase !== 'draining') return
    this.phase = 'ready'; if (this.timer) clearTimeout(this.timer)
    try { this.options.settled(result) } catch { /* A diagnostic write must not trap the user inside a quitting application. */ }
    // A synchronous drain error must not recursively re-enter the original before-quit handler.
    queueMicrotask(this.options.resumeQuit)
  }
}
