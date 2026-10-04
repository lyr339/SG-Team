import { createHash, randomUUID } from 'node:crypto'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationScope, NotificationSourceState } from '../../domain/notification'
import { hasInFlightExecution, isExplicitlyStoppedPhase } from '../../domain/channel-message'
import { readSessionLifecycleCheckpoint, reduceSessionLifecycleNotifications, type NotificationSessionFact, type SessionLifecycleCheckpoint, type SessionLifecycleObservation, type SessionNotificationRestart } from '../../domain/session-lifecycle-notification'
import type { NotificationService } from '../notification-service'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Source = Pick<NotificationService, 'sourceState' | 'commitSource' | 'reportHistoryGap'>

/** Project ONLY final verified snapshots into small facts, never clone conversation text or reinterpret presence timeouts. */
export function sessionNotificationObservation(snapshot: DesktopSnapshot, team: TeamControlSnapshot, now: number, monitorStartedAt: number): SessionLifecycleObservation {
  const run = team.activeRun
  const scopeKey = `session-lifecycle:${hash([team.activeWorkspaceId ?? null, run?.id ?? null])}`
  const facts: NotificationSessionFact[] = []
  const byChannel = new Map(team.members.map(member => [member.binding?.channelId ?? member.slot.channelId, member]))
  for (const session of snapshot.sessions) {
    const member = byChannel.get(session.channelId)
    const binding = member?.binding
    if (binding && (binding.runId !== run?.id || binding.workspaceId !== team.activeWorkspaceId
      || binding.composerId && session.composerId && binding.composerId !== session.composerId)) continue
    if (!binding && !session.composerId && session.generation === 0) continue // Unknown transport identity is not a safe session target.
    const scope: NotificationScope = {
      sessionId: session.id, channelId: session.channelId, generation: String(session.generation),
      ...(session.composerId ? { composerId: session.composerId } : {}),
      ...(binding ? { workspaceId: binding.workspaceId, runId: binding.runId, slotId: binding.slotId, bindingGeneration: binding.generation,
        ...(member?.slot.groupId ? { groupId: member.slot.groupId } : {}) } : {})
    }
    const identity = hash([scope.workspaceId ?? null, scope.runId ?? null, scope.slotId ?? null, scope.bindingGeneration ?? null, scope.sessionId, scope.generation, scope.composerId ?? null])
    const online = session.online && session.connected
    const life = Math.max(session.lastSeenAt ?? 0, session.lastAgentActivityAt ?? 0)
    facts.push({ identity, scope, name: `${session.roleName.slice(0, 55)} · CH-${session.channelId}`,
      online, evidence: online ? 'active' : session.runtimeEvidence === 'stopped' || isExplicitlyStoppedPhase(session.connectionPhase) ? 'stopped' : 'suspected',
      retired: session.connectionPhase.toLowerCase() === 'retired',
      ...(life > 0 ? { liveAt: life } : {}),
      ...(binding?.composerBoundAt !== undefined || session.startedAt !== undefined ? { boundAt: binding?.composerBoundAt ?? session.startedAt } : {}),
      pendingWork: Boolean(session.pendingOutboundId || session.pendingReplySyncSince !== undefined || session.queueDepth > 0
        || hasInFlightExecution(session) || snapshot.liveProcess?.[session.channelId]?.generating || session.awaitingUser) })
  }
  return { scopeKey, workspaceId: team.activeWorkspaceId, runId: run?.id, runCompleted: run?.status === 'completed',
    healthy: snapshot.connection.state === 'connected' && snapshot.nativeProcessStream?.state !== 'reconnecting', baseline: false, monitorStartedAt, now, facts }
}

function checkpointSignature(checkpoint: SessionLifecycleCheckpoint): string {
  // Heartbeats and tick timestamps aren't semantic events; they cannot cause SQLite writes at telemetry frame rate.
  return JSON.stringify([checkpoint.scopeKey, checkpoint.runCompleted, checkpoint.restart, Object.values(checkpoint.rows).sort((a, b) => a.fact.identity.localeCompare(b.fact.identity)).map(row => [
    row.fact.identity, row.fact.name, row.fact.scope, row.fact.online, row.fact.evidence, row.fact.retired,
    row.fact.online ? null : row.fact.pendingWork, row.onlineObserved, row.incident, row.expectedRestartId
  ])])
}

function observationSignature(observation: SessionLifecycleObservation): string {
  return JSON.stringify([observation.scopeKey, observation.runCompleted, observation.healthy, observation.restart, observation.baseline, observation.baselineIdentities, observation.quietDelivery,
    observation.facts.map(fact => [fact.identity, fact.name, fact.scope, fact.online, fact.evidence, fact.retired, fact.online ? null : fact.pendingWork])])
}

/** Bounded semantic FIFO: only heartbeat-equivalent observations coalesce; positive stop/recovery transitions must survive slow storage. */
export class SessionLifecycleNotifications {
  private readonly startedAt: number
  private readonly pending = new Map<string, SessionLifecycleObservation[]>()
  private readonly cache = new Map<string, { source: NotificationSourceState; checkpoint?: SessionLifecycleCheckpoint }>()
  private readonly observed = new Set<string>()
  private readonly seenIdentities = new Set<string>()
  private readonly latest = new Map<string, SessionLifecycleObservation>()
  private readonly restarts = new Map<string, SessionNotificationRestart>()
  private activeScope?: { key: string; runId?: string; workspaceId?: string }
  private processing?: Promise<void>
  private suspended = false
  private resetBaseline = false
  private epoch = 0
  private closed = false
  private accepting = true
  private closing?: Promise<void>
  private readonly conflicts = new Map<string, number>()
  constructor(private readonly notifications: Source, private readonly now: () => number = Date.now, private readonly newId: () => string = randomUUID) {
    this.startedAt = now()
  }
  observe(snapshot: DesktopSnapshot, team: TeamControlSnapshot): void {
    if (this.closed || !this.accepting || this.suspended) return
    if (snapshot.runtimeScope && (snapshot.runtimeScope.workspaceId !== team.activeWorkspaceId || snapshot.runtimeScope.runId !== team.activeRun?.id
      || snapshot.runtimeScope.teamRevision !== team.revision)) return
    try {
      const observation = sessionNotificationObservation(snapshot, team, this.now(), this.startedAt)
      const restart = this.restarts.get(observation.scopeKey)
      if (restart) observation.restart = restart
      const oldScope = this.activeScope
      if (oldScope && oldScope.key !== observation.scopeKey && oldScope.runId && team.runs.some(run => run.id === oldScope.runId && run.status === 'completed')) {
        this.enqueue({ ...observation, scopeKey: oldScope.key, runId: oldScope.runId, workspaceId: oldScope.workspaceId, runCompleted: true, facts: [], baseline: false,
          restart: this.restarts.get(oldScope.key) })
      }
      observation.baseline = !this.observed.has(observation.scopeKey) || this.resetBaseline
      observation.baselineIdentities = observation.facts.filter(fact => !this.seenIdentities.has(fact.identity) && (fact.boundAt === undefined || fact.boundAt < this.startedAt)).map(fact => fact.identity)
      this.activeScope = { key: observation.scopeKey, runId: observation.runId, workspaceId: observation.workspaceId }
      this.latest.set(observation.scopeKey, observation)
      if (this.latest.size > 8) this.latest.delete(this.latest.keys().next().value!)
      if (!this.enqueue(observation)) return
      this.receivedBaseline(observation)
      this.start()
    } catch { this.notifications.reportHistoryGap() }
  }
  suspend(): void {
    ++this.epoch; this.suspended = true; this.observed.clear(); this.resetBaseline = true
    // Preserve already observed transitions as history. Only live delivery is muted across the sleep boundary.
    for (const [key, queue] of this.pending) this.pending.set(key, queue.map(observation => ({ ...observation, quietDelivery: true })))
  }
  resume(): void { ++this.epoch; this.suspended = false; this.observed.clear(); this.resetBaseline = true; this.start() }
  beginRestart(label: string, section: 'accounts' | 'maintenance'): string | undefined {
    try { return this.registerRestart(label, section) } catch { this.notifications.reportHistoryGap(); return undefined }
  }
  private registerRestart(label: string, section: 'accounts' | 'maintenance'): string | undefined {
    const key = this.activeScope?.key; const observation = key ? this.latest.get(key) : undefined
    if (!key || !observation || this.closed || !this.accepting || this.suspended || this.restarts.get(key)?.status === 'running') return undefined
    const restart: SessionNotificationRestart = { id: this.newId(), label: label.slice(0, 80), section, status: 'running', startedAt: this.now(),
      targets: observation.facts.filter(fact => fact.online).map(({ identity, name, scope }) => ({ identity, name, scope })) }
    this.restarts.set(key, restart)
    if (this.restarts.size > 8) {
      const retired = [...this.restarts].find(([candidate, value]) => candidate !== key && value.status !== 'running')
      if (retired) this.restarts.delete(retired[0])
    }
    this.enqueue({ ...observation, baseline: false, restart, now: this.now() }); this.start()
    return restart.id
  }
  finishRestart(id: string | undefined, success: boolean): void {
    try { this.finishRestartInternal(id, success) } catch { this.notifications.reportHistoryGap() }
  }
  private finishRestartInternal(id: string | undefined, success: boolean): void {
    if (!id || this.closed || !this.accepting) return
    const entry = [...this.restarts].find(([, restart]) => restart.id === id)
    if (!entry) return
    const [key, old] = entry; const observation = this.latest.get(key)
    const restart = { ...old, status: success ? 'done' as const : 'failed' as const }
    this.restarts.set(key, restart)
    if (observation) { this.enqueue({ ...observation, baseline: false, restart, now: this.now() }); this.start() }
  }
  private enqueue(observation: SessionLifecycleObservation): boolean {
    const queue = this.pending.get(observation.scopeKey) ?? []
    const last = queue.at(-1)
    if (last && observationSignature(last) === observationSignature(observation)) {
      queue[queue.length - 1] = { ...observation, baseline: last.baseline, baselineIdentities: last.baselineIdentities }
      return true
    }
    if ((!this.pending.has(observation.scopeKey) && this.pending.size >= 8) || [...this.pending.values()].reduce((total, values) => total + values.length, 0) >= 128) {
      this.notifications.reportHistoryGap(); return false
    }
    queue.push(observation); this.pending.set(observation.scopeKey, queue)
    return true
  }
  private receivedBaseline(observation: SessionLifecycleObservation): void {
    const key = observation.scopeKey
    this.observed.add(key)
    if (this.observed.size > 512) this.observed.delete(this.observed.values().next().value!)
    for (const fact of observation.facts) this.seenIdentities.add(fact.identity)
    while (this.seenIdentities.size > 512) this.seenIdentities.delete(this.seenIdentities.values().next().value!)
    this.resetBaseline = false
  }
  private start(): void {
    if (this.processing || this.closed || this.suspended) return
    this.processing = this.drain().finally(() => { this.processing = undefined; if (this.pending.size && !this.closed && !this.suspended) this.start() })
  }
  private async drain(): Promise<void> {
    while (this.pending.size && !this.closed && !this.suspended) {
      const epoch = this.epoch
      const [key, queue] = this.pending.entries().next().value!
      const captured = queue.shift()!
      if (!queue.length) this.pending.delete(key)
      try {
        let old = this.cache.get(key)
        if (!old) {
          const source = await this.notifications.sourceState(key)
          old = { source, checkpoint: readSessionLifecycleCheckpoint(source.data, key) }
          this.cache.set(key, old)
        }
        if (this.closed) return
        const latest = captured
        const reduced = reduceSessionLifecycleNotifications(old.checkpoint, latest, old.source.revision + 1, this.newId)
        if (latest.quietDelivery || this.suspended || epoch !== this.epoch) for (const draft of reduced.drafts) { draft.announce = false; delete draft.liveSignal }
        if (old.checkpoint && reduced.drafts.every(draft => draft.key.startsWith('cursor-restart:')) && checkpointSignature(old.checkpoint) === checkpointSignature(reduced.checkpoint)) {
          // Keep current-life evidence in memory without turning every heartbeat into a disk write.
          old.checkpoint = reduced.checkpoint; continue
        }
        const signals = reduced.drafts.filter(draft => draft.category === 'sessions' && draft.announce)
        const group = signals.length > 1 ? { keys: signals.map(draft => draft.key), source: '会话连接',
          tone: signals.some(draft => draft.state === 'active') ? 'warning' as const : 'success' as const,
          titleSuffix: signals.every(draft => draft.state === 'active') ? '个会话已离线' : signals.every(draft => draft.state === 'resolved') ? '个会话已恢复连接' : '个会话连接状态有变化',
          ...(latest.runId && signals.every(draft => draft.scope.runId === latest.runId) ? { target: { kind: 'run' as const, runId: latest.runId } } : {}) } : undefined
        const result = await this.notifications.commitSource(key, old.source.revision, reduced.checkpoint, reduced.drafts, group)
        if (!result.applied) {
          this.cache.set(key, { source: result.source, checkpoint: readSessionLifecycleCheckpoint(result.source.data, key) })
          const count = (this.conflicts.get(key) ?? 0) + 1; this.conflicts.set(key, count)
          if (count <= 3) { const waiting = this.pending.get(key) ?? []; waiting.unshift(latest); this.pending.set(key, waiting) }
          else { this.pending.delete(key); this.observed.delete(key); this.notifications.reportHistoryGap() }
          continue
        }
        this.conflicts.delete(key)
        this.cache.set(key, { source: result.source, checkpoint: reduced.checkpoint })
        if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
      } catch {
        this.cache.delete(key); this.pending.delete(key); this.observed.delete(key)
        for (const fact of captured.facts) this.seenIdentities.delete(fact.identity)
        this.notifications.reportHistoryGap()
      }
    }
  }
  async flush(): Promise<void> { while (this.processing) await this.processing }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.accepting = false; ++this.epoch
    // Drain facts received before sleep as history; do not wait for another wake/source callback.
    this.suspended = false
    for (const queue of this.pending.values()) for (const observation of queue) observation.quietDelivery = true
    this.start()
    this.closing = this.flush().finally(() => this.stop())
    return this.closing
  }
  stop(): void { ++this.epoch; this.accepting = false; this.closed = true; this.pending.clear() }
}
