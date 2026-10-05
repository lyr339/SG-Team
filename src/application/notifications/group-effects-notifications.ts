import type { NotificationService } from '../notification-service'
import type { GroupEffectsFrame, GroupEffectsObserver } from '../../domain/group-effects'
import { validateGroupEffects } from '../../domain/group-effects'
import {
  GROUP_EFFECTS_SOURCE_KEY,
  readGroupEffectsState,
  reduceGroupEffects,
  type GroupEffectsState,
  type GroupEffectsInput
} from '../../domain/group-effects-notification'
import type { NotificationReference } from '../../domain/notification-reference'
import { NotificationProjectionSource } from './projection-source'
/** Desktop-only observation; all waits/queries here belong to the private ledger. */
export class GroupEffectsNotifications implements GroupEffectsObserver {
  readonly source: NotificationProjectionSource<GroupEffectsInput, GroupEffectsState>
  private readonly frames = new Map<string, GroupEffectsFrame>()
  private readonly links = new Set<Promise<void>>()
  private stopped = false
  private accepting = true
  private closing?: Promise<void>
  constructor(
    private readonly owner: NotificationService,
    private readonly originalOwner: string
  ) {
    this.source = new NotificationProjectionSource(
      owner,
      readGroupEffectsState,
      reduceGroupEffects,
      (input) => JSON.stringify(input)
    )
    this.source.observe(GROUP_EFFECTS_SOURCE_KEY, { kind: 'recover', owner: originalOwner, now: Date.now() })
  }
  observe(frame: GroupEffectsFrame): void {
    if (!this.accepting) return
    try {
      validateGroupEffects(frame)
      if (frame.owner !== this.originalOwner) return
      const copy = {
        ...frame,
        scope: { ...frame.scope },
        effects: frame.effects.map((effect) => ({ ...effect }))
      }
      this.frames.set(frame.id, copy)
      if (this.frames.size > 64) this.frames.delete(this.frames.keys().next().value!)
      this.source.observe(GROUP_EFFECTS_SOURCE_KEY, { kind: 'observe', frame: copy })
    } catch {
      this.owner.reportHistoryGap()
    }
  }
  unavailable(): void {
    this.owner.reportHistoryGap()
  }
  /** A returned navigation ref is not proof its warning persisted. Verify an
   * actually stored matching parent after its notification source settles. */
  linkTransfer(
    id: string,
    reference: NotificationReference,
    settled: Promise<void> = Promise.resolve()
  ): void {
    if (!this.accepting) return
    const frame = this.frames.get(id)
    if (!frame || frame.kind !== 'transfer') return
    const work = (async () => {
      await settled
      await this.owner.flush()
      if (this.stopped) return
      const parent = (await this.owner.page({ key: reference.key, limit: 1 })).records[0]
      if (
        this.stopped ||
        !parent ||
        parent.scope.groupOperationId !== id ||
        parent.scope.runId !== frame.scope.runId ||
        parent.scope.groupId !== frame.scope.groupId ||
        parent.scope.workspaceId !== frame.scope.workspaceId
      )
        return
      this.source.observe(GROUP_EFFECTS_SOURCE_KEY, {
        kind: 'observe',
        frame,
        parent: { key: parent.key, eventId: parent.eventId }
      })
    })().catch(() => this.owner.reportHistoryGap())
    this.links.add(work)
    void work.finally(() => this.links.delete(work))
  }
  async flush(): Promise<void> {
    while (this.links.size) await Promise.allSettled([...this.links])
    await this.source.flush()
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.accepting = false
    this.closing = this.flush()
      .finally(() => {
        this.stopped = true
        this.frames.clear()
      })
      .then(() => this.source.close())
    return this.closing
  }
}
