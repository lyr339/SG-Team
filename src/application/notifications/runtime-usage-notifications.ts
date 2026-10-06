import { createHash, randomUUID } from 'node:crypto'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { RuntimeUsageReadObserver, RuntimeUsageReadReceipt, RuntimeUsageReadResult } from '../../domain/runtime-usage-observation'
import { LOCAL_READ_SOURCES, readRuntimeUsageState, reduceRuntimeUsageNotifications, type LocalReadKind, type RuntimeUsageInput, type RuntimeUsageState } from '../../domain/runtime-usage-notification'
import type { NotificationService } from '../notification-service'
import { NotificationProjectionSource } from './projection-source'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function runtimeScope(team: TeamControlSnapshot, kind: LocalReadKind) {
  const run = team.activeRun, workspace = team.workspaces.find(value => value.id === team.activeWorkspaceId)
  if (!workspace || !run || run.status !== 'running' || run.workspaceId !== workspace.id) return
  const bindings = team.bindings.filter(binding => binding.workspaceId === workspace.id && binding.runId === run.id && binding.composerId)
  const ids = bindings.map(binding => binding.composerId!)
  if (!ids.length || new Set(ids).size !== ids.length) return
  const expectedIds = (kind === 'runtime' ? ids.slice(0, 16) : ids).sort()
  return { path: workspace.path, ids: expectedIds, key: hash([workspace.id, workspace.path, run.id, expectedIds,
    bindings.map(binding => [binding.id, binding.slotId, binding.channelId, binding.agentSessionId, binding.generation, binding.composerId])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]) }
}

/** Cached original team frames + original read receipts only, never a probe or an extra business snapshot read. */
class ScopedLocalReadNotifications implements RuntimeUsageReadObserver {
  readonly source: NotificationProjectionSource<RuntimeUsageInput, RuntimeUsageState>
  private readonly ownerId = randomUUID()
  private sequence = 0
  private epoch = 0
  private completedAttempt = 0
  private suspended = false
  private closed = false
  private baselinePending = true
  private initialized = false
  private scope?: ReturnType<typeof runtimeScope>
  private candidate?: { reason: 'read' | 'record'; firstAt: number; lastAt: number; id: string }
  constructor(private readonly owner: NotificationService, private readonly now: () => number, private readonly kind: LocalReadKind) {
    this.source = new NotificationProjectionSource(owner, (value, key) => readRuntimeUsageState(value, key, kind),
      (previous, input, baseline, revision) => reduceRuntimeUsageNotifications(previous, input, baseline, revision, kind),
      input => JSON.stringify([input.scope ?? null, input.result.state, input.result.state === 'failed' ? input.result.reason : null]))
  }
  private input(result: RuntimeUsageInput['result'], at: number, id = hash([this.ownerId, ++this.sequence])): RuntimeUsageInput {
    return { key: LOCAL_READ_SOURCES[this.kind].key, scope: this.scope?.key, id, at, result }
  }
  setTeam(team: TeamControlSnapshot): void {
    if (this.closed) return
    try {
      const scope = runtimeScope(team, this.kind)
      if (this.initialized && scope?.key === this.scope?.key && scope?.path === this.scope?.path) return
      this.initialized = true
      this.scope = scope; ++this.epoch; this.candidate = undefined; this.baselinePending = true
      if (!this.suspended) this.source.observe(LOCAL_READ_SOURCES[this.kind].key, this.input({ state: 'scope' }, this.now()))
    } catch { this.scope = undefined; this.initialized = false; this.unavailable() }
  }
  begin(input: { workspacePath?: string; composerIds: readonly string[] }): RuntimeUsageReadReceipt | undefined {
    const scope = this.scope
    if (this.closed || this.suspended || !scope || input.workspacePath !== scope.path
      || input.composerIds.length !== scope.ids.length || new Set(input.composerIds).size !== input.composerIds.length
      || !input.composerIds.every(id => scope.ids.includes(id))) return
    const epoch = this.epoch, sequence = ++this.sequence
    let done = false
    return { composerIds: Object.freeze([...scope.ids]), unavailable: () => this.unavailable(), complete: result => {
      if (done) return
      done = true
      if (this.closed || this.suspended || epoch !== this.epoch || scope !== this.scope || sequence < this.completedAttempt) return
      this.completedAttempt = sequence
      try {
        if (this.baselinePending) { this.source.quietNextObservation(); this.baselinePending = false }
        const at = this.now()
        if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) { this.unavailable(); return }
        if (result.state === 'failed') {
          const old = this.candidate
          if (!old || old.reason !== result.reason || at < old.lastAt || at - old.lastAt > 60000) {
            this.candidate = { reason: result.reason, firstAt: at, lastAt: at, id: hash([this.ownerId, sequence]) }; return
          }
          if (at === old.lastAt) return
          old.lastAt = at
          if (at - old.firstAt < 5000) return
          this.source.observe(LOCAL_READ_SOURCES[this.kind].key, this.input(result, at, old.id))
        } else {
          this.candidate = undefined
          this.source.observe(LOCAL_READ_SOURCES[this.kind].key, this.input(result, at))
        }
      } catch { this.unavailable() }
    } }
  }
  unavailable(): void {
    ++this.epoch; this.candidate = undefined; this.baselinePending = true; this.source.quietNextObservation()
    try { this.owner.reportHistoryGap() } catch { /* Diagnosis cannot fail the original reader or team publisher. */ }
  }
  suspend(): void { this.suspended = true; ++this.epoch; this.candidate = undefined; this.baselinePending = true; this.source.quietNextObservation() }
  resume(): void {
    this.suspended = false; ++this.epoch; this.candidate = undefined; this.baselinePending = true; this.source.quietNextObservation()
    try { if (!this.closed) this.source.observe(LOCAL_READ_SOURCES[this.kind].key, this.input({ state: 'scope' }, this.now())) } catch { this.unavailable() }
  }
  close(): Promise<void> { this.closed = true; ++this.epoch; return this.source.close() }
}

/** Runtime and SQLite details have independent checkpoints/episodes, sharing only attribution and delivery rules. */
export class RuntimeUsageNotifications extends ScopedLocalReadNotifications {
  constructor(owner: NotificationService, now: () => number = Date.now) { super(owner, now, 'runtime') }
}
export class ComposerContextNotifications extends ScopedLocalReadNotifications {
  constructor(owner: NotificationService, now: () => number = Date.now) { super(owner, now, 'context') }
}
