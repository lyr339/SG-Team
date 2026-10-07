import { createHash, randomUUID } from 'node:crypto'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { UsageBindingObserver, UsageBindingReceipt, UsageBindingFailureReason } from '../../domain/usage-binding-observation'
import { readUsageBindingState, reduceUsageBindingNotifications, type UsageBindingInput, type UsageBindingState } from '../../domain/usage-binding-notification'
import type { NotificationService } from '../notification-service'
import { NotificationProjectionSource } from './projection-source'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Original subscribed team frames and received binding payloads only; never reads a usage file or probes CDP. */
export class UsageBindingNotifications implements UsageBindingObserver {
  readonly source: NotificationProjectionSource<UsageBindingInput, UsageBindingState>
  private readonly ownerId = randomUUID()
  private sequence = 0
  private epoch = 0
  private document = 0
  private suspended = false
  private closed = false
  private initialized = false
  private baselinePending = true
  private gapReported = false
  private established = false
  private scope?: string
  private teamScope?: string
  private scopeRef: UsageBindingInput['scopeRef'] = {}
  private bindings = new Map<string, { identity: string; channel: string }>()
  private readonly candidates = new Map<string, { reason: UsageBindingFailureReason; firstAt: number; lastAt: number; id: string }>()
  private readonly affected = new Map<string, string>()
  constructor(private readonly owner: NotificationService, private readonly now: () => number = Date.now) {
    this.source = new NotificationProjectionSource(owner, readUsageBindingState, reduceUsageBindingNotifications, input => JSON.stringify([
      input.scope ?? null, input.fact.state, input.fact.state === 'scope' ? null : input.fact.identity, input.fact.state === 'failed' ? input.fact.reason : null
    ]), (input, state) => {
      // Only a proven PRIVATE projection releases the high-frequency recovery
      // watch. A lost ACK is reconciled on the next real payload, not a timer.
      const fact = input.fact
      if (input.scope === this.scope && fact.state === 'ready' && fact.confirmationFor === this.affected.get(fact.identity)
        && !state.episode?.causes.some(cause => cause.identity === fact.identity)) this.affected.delete(fact.identity)
    })
  }
  private input(fact: UsageBindingInput['fact'], id = hash([this.ownerId, ++this.sequence])): UsageBindingInput {
    return { key: 'usage-binding-health', scope: this.scope, scopeRef: { ...this.scopeRef }, id, at: this.now(), fact }
  }
  setTeam(team: TeamControlSnapshot): void {
    if (this.closed) return
    try {
      const run = team.activeRun, workspace = team.workspaces.find(workspace => workspace.id === team.activeWorkspaceId)
      const bindings = new Map<string, { identity: string; channel: string }>()
      if (workspace && run?.status === 'running' && run.workspaceId === workspace.id) for (const member of team.members) {
        const binding = member.binding
        if (!binding?.composerId || binding.slotId !== member.slot.id || binding.workspaceId !== workspace.id || binding.runId !== run.id
          || !/^\d{1,12}$/.test(binding.channelId) || !team.bindings.some(stored => stored.id === binding.id && stored.generation === binding.generation
            && stored.composerId === binding.composerId && stored.slotId === binding.slotId && stored.channelId === binding.channelId
            && stored.workspaceId === binding.workspaceId && stored.runId === binding.runId && stored.agentSessionId === binding.agentSessionId)) continue
        if (bindings.has(binding.composerId)) throw Error('用量绑定归属无法确认')
        bindings.set(binding.composerId, { identity: hash([workspace.id, workspace.path, run.id, binding.id, binding.slotId, binding.agentSessionId, binding.generation, binding.composerId]), channel: binding.channelId })
      }
      const teamScope = bindings.size ? hash([...bindings.values()].sort((a, b) => a.identity.localeCompare(b.identity))) : undefined
      if (this.initialized && this.teamScope === teamScope) return
      this.initialized = true; this.teamScope = teamScope; this.bindings = bindings
      this.scopeRef = teamScope ? { workspaceId: workspace!.id, runId: run!.id } : {}
      this.reset()
    } catch { this.bindings.clear(); this.teamScope = undefined; this.scope = undefined; this.initialized = false; this.unavailable() }
  }
  reset(): void {
    if (this.closed) return
    ++this.epoch; ++this.document; this.candidates.clear(); this.affected.clear(); this.baselinePending = true; this.established = false; this.gapReported = false
    this.scope = this.teamScope ? hash([this.ownerId, this.document, this.teamScope]) : undefined
    this.source.quietNextObservation()
    try { this.source.observe('usage-binding-health', this.input({ state: 'scope' })) } catch { this.unavailable() }
  }
  begin(composerId: string): UsageBindingReceipt | undefined {
    const binding = this.bindings.get(composerId), epoch = this.epoch
    if (this.closed || this.suspended || !this.scope || !binding) return
    let done = false
    return { unavailable: () => this.unavailable(), complete: result => {
      if (done) return
      done = true
      if (this.closed || this.suspended || epoch !== this.epoch) return
      try {
        const at = this.now()
        if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) { this.unavailable(); return }
        if (!['ready', 'waiting', 'failed'].includes(result.state) || result.state === 'failed' && !['record', 'callback', 'extract', 'emit'].includes(result.reason)) { this.unavailable(); return }
        if (this.baselinePending) { this.source.quietNextObservation(); this.baselinePending = false }
        if (result.state === 'failed') {
          const old = this.candidates.get(binding.identity)
          if (!old || old.reason !== result.reason || at < old.lastAt || at - old.lastAt > 60000) {
            this.candidates.set(binding.identity, { reason: result.reason, firstAt: at, lastAt: at, id: hash([this.ownerId, ++this.sequence]) }); return
          }
          if (at === old.lastAt) return
          old.lastAt = at
          if (at - old.firstAt < 5000) return
          this.affected.set(binding.identity, old.id)
          this.source.observe('usage-binding-health', this.input({ ...result, ...binding }, old.id))
        } else {
          this.candidates.delete(binding.identity)
          if (result.state === 'ready' && this.affected.has(binding.identity)) this.source.observe('usage-binding-health', this.input({ ...result, ...binding, confirmationFor: this.affected.get(binding.identity) }))
          else if (result.state === 'ready' && !this.established) this.source.observe('usage-binding-health', this.input({ state: 'scope' }))
        }
        if (result.state !== 'waiting') this.established = true
      } catch { this.unavailable() }
    } }
  }
  unattributed(): void {
    if (this.closed || this.suspended || this.gapReported) return
    this.gapReported = true; this.unavailable()
  }
  unavailable(): void {
    ++this.epoch; this.candidates.clear(); this.baselinePending = true; this.source.quietNextObservation()
    try { this.owner.reportHistoryGap() } catch { /* The original stream callback never depends on a diagnostic. */ }
  }
  suspend(): void { this.suspended = true; ++this.epoch; this.candidates.clear(); this.baselinePending = true; this.source.quietNextObservation() }
  resume(): void {
    this.suspended = false; ++this.epoch; this.candidates.clear(); this.baselinePending = true; this.source.quietNextObservation()
    // Waking is an observation gap, not evidence that the native document was
    // replaced. Actual document/transport events still call reset().
    try { if (!this.closed) this.source.observe('usage-binding-health', this.input({ state: 'scope' })) } catch { this.unavailable() }
  }
  close(): Promise<void> { this.closed = true; ++this.epoch; this.candidates.clear(); return this.source.close() }
}
