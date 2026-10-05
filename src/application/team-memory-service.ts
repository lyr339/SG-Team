import type { TeamControlSnapshot } from '../domain/team-control'
import { randomUUID } from 'node:crypto'
import type {
  TeamMemoryItem,
  TeamMemorySnapshot,
  TeamMemoryReadObservation,
  ReviewTeamMemoryInput
} from '../domain/team-memory'
import { emptyTeamMemorySnapshot } from '../domain/team-memory'
import type { TeamMemoryRepository } from './team-memory-repository'
import { TaskPoolError } from '../domain/task-pool'

export interface TeamMemoryTeamSource {
  getSnapshot(): TeamControlSnapshot
  subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void
}

type Listener = (snapshot: TeamMemorySnapshot) => void

export class TeamMemoryService {
  private readonly listeners = new Set<Listener>()
  private readonly readObservers = new Set<(value: TeamMemoryReadObservation) => void>()
  private readonly readOwner = randomUUID()
  private readSequence = 0
  private readonly unsubscribeTeam: () => void
  private watchTimer?: ReturnType<typeof setInterval>
  private lastRevision: number

  constructor(
    private readonly repository: TeamMemoryRepository,
    private readonly team: TeamMemoryTeamSource
  ) {
    this.lastRevision = repository.revision()
    this.unsubscribeTeam = team.subscribe(() => this.emit())
  }

  getSnapshot(): TeamMemorySnapshot {
    const team = this.team.getSnapshot()
    const run = team.activeRun
    const workspaceId = team.activeWorkspaceId
    try {
      const snapshot =
        run && workspaceId
          ? this.repository.load(workspaceId, run.id)
          : emptyTeamMemorySnapshot(workspaceId, run?.id)
      this.observeRead({
        kind: 'snapshot',
        snapshot,
        context: team,
        stamp: { owner: this.readOwner, sequence: ++this.readSequence }
      })
      return snapshot
    } catch (error) {
      this.observeRead({ kind: 'unavailable', workspaceId, runId: run?.id, context: team })
      throw error
    }
  }
  subscribeReadObservation(listener: (value: TeamMemoryReadObservation) => void): () => void {
    this.readObservers.add(listener)
    return () => {
      this.readObservers.delete(listener)
    }
  }
  getReadOwnerId(): string {
    return this.readOwner
  }
  private observeRead(value: TeamMemoryReadObservation): void {
    for (const listener of this.readObservers) {
      try {
        listener(value)
      } catch {
        /* Original read consumers remain authoritative. */
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  /**
   * 操作员（人类监督者）审核记忆提案。与 Agent 侧审核不同：
   * 操作员拥有最高审核权限，不受角色/自审/项目级限制——提案均来自 Agent，
   * 人的裁决天然独立。状态与取代链校验由 repository.review 保证。
   */
  review(
    memoryId: string,
    decision: 'accept' | 'reject',
    note?: string,
    expectedVersion?: number,
    expectedScope?: ReviewTeamMemoryInput['expectedScope']
  ): TeamMemoryItem {
    const current = this.getSnapshot().items[memoryId.trim()]
    if (expectedVersion !== undefined && current?.version !== expectedVersion)
      throw new TaskPoolError('memory_version_changed', '原记忆版本已变化，请重新读取后审查')
    const completedStatus = decision === 'accept' ? 'accepted' : 'rejected'
    if (
      !expectedScope &&
      current?.status === completedStatus &&
      current.reviewedBy?.type === 'operator' &&
      (current.reviewNote ?? '') === (note?.trim() ?? '')
    ) {
      return structuredClone(current)
    }
    const item = this.repository.review({
      memoryId,
      decision,
      reviewer: { type: 'operator' },
      note,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      ...(expectedScope ? { expectedScope } : {})
    })
    if (expectedScope) {
      // The explicitly confirmed human command already committed in the original
      // repository. A subsequent observation failure must not erase that known
      // conclusion; its IPC boundary separately reports a pending refresh.
      try {
        this.emit()
      } catch {
        /* No retry of the original review. */
      }
    } else {
      this.emit()
    }
    return item
  }

  startWatcher(intervalMs = 750): void {
    this.stopWatcher()
    this.watchTimer = setInterval(
      () => {
        const revision = this.repository.revision()
        if (revision !== this.lastRevision) this.emit()
      },
      Math.max(250, intervalMs)
    )
    this.watchTimer.unref?.()
  }

  stopWatcher(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = undefined
  }

  dispose(): void {
    this.stopWatcher()
    this.unsubscribeTeam()
    this.listeners.clear()
    this.readObservers.clear()
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    this.lastRevision = snapshot.revision
    for (const listener of this.listeners) listener(snapshot)
  }
}
