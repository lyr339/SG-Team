import { randomUUID } from 'node:crypto'
import type { TeamControlSnapshot, TeamGroup } from '../domain/team-control'
import { notificationSafeText } from '../domain/notification'
import type {
  GroupEffectsObserver,
  GroupEffectsFrame,
  GroupEffectsSummary,
  GroupOperationKind,
  GroupEffectFact
} from '../domain/group-effects'

/** One synchronous original call. Observers receive immutable facts, never the operation callback. */
export class GroupEffectsObservation {
  private readonly frame: GroupEffectsFrame
  constructor(
    kind: GroupOperationKind,
    before: TeamControlSnapshot,
    group: TeamGroup,
    owner: string,
    private readonly observer: GroupEffectsObserver
  ) {
    const run =
      before.activeRun?.id === group.runId
        ? before.activeRun
        : before.runs?.find((run) => run.id === group.runId)
    this.frame = {
      version: 1,
      id: randomUUID(),
      owner,
      kind,
      scope: {
        runId: group.runId,
        groupId: group.id,
        ...(run?.workspaceId ? { workspaceId: run.workspaceId } : {})
      },
      name: notificationSafeText(group.name).slice(0, 120),
      primary: 'returned',
      projection: 'unconfirmed',
      phase: 'live',
      effects: [],
      observedAt: Date.now(),
      sequence: 0
    }
    this.publish()
  }
  project(after: TeamControlSnapshot): void {
    this.frame.projection =
      after.activeRun?.id === this.frame.scope.runId &&
      after.activeWorkspaceId === this.frame.scope.workspaceId &&
      Array.isArray(after.groups) &&
      after.groups.some(
        (view) => view.group.id === this.frame.scope.groupId && view.group.runId === this.frame.scope.runId
      )
        ? 'confirmed'
        : 'unconfirmed'
    this.publish()
  }
  effect(effect: GroupEffectFact): void {
    if (this.frame.effects.length < 64) this.frame.effects.push({ ...effect })
    else this.frame.truncated = true
    this.publish()
  }
  finish(phase: 'completed' | 'interrupted'): GroupEffectsSummary {
    this.frame.phase = phase
    this.publish()
    const { owner: _owner, ...summary } = this.copy()
    return summary
  }
  private copy(): GroupEffectsFrame {
    return {
      ...this.frame,
      scope: { ...this.frame.scope },
      effects: this.frame.effects.map((effect) => ({ ...effect }))
    }
  }
  private publish(): void {
    ++this.frame.sequence
    try {
      this.observer.observe(this.copy())
    } catch {
      /* Observation cannot alter the original call or logger outcome. */
    }
  }
  receipt(
    kind: GroupEffectFact['kind'],
    value: unknown
  ): Pick<GroupEffectFact, 'status' | 'count' | 'reason'> {
    if (kind === 'membership')
      return value &&
        typeof value === 'object' &&
        'commandId' in value &&
        typeof value.commandId === 'string' &&
        value.commandId
        ? { status: 'queued' }
        : { status: 'unconfirmed', reason: 'no-receipt' }
    if (['release', 'orphan', 'close-tasks'].includes(kind))
      return Array.isArray(value)
        ? { status: 'confirmed', count: value.length }
        : { status: 'unconfirmed', reason: 'no-receipt' }
    if (
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      value.id &&
      'runId' in value &&
      value.runId === this.frame.scope.runId
    )
      return { status: 'recorded', count: 1 }
    return { status: 'unconfirmed', reason: 'no-receipt' }
  }
}
export function groupEffectErrorReason(error: unknown): GroupEffectFact['reason'] {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return code === 'EACCES'
    ? 'permission'
    : typeof code === 'string' &&
        ['SQLITE_BUSY', 'SQLITE_LOCKED', 'ERR_SQLITE_ERROR', 'ENOSPC', 'EROFS'].includes(code)
      ? 'storage'
      : code === 'ETIMEDOUT'
        ? 'timeout'
        : 'unconfirmed'
}
