import { groupEffectsDigest, groupEffectsProblem } from '../../domain/group-effects'
import { createHash, randomUUID } from 'node:crypto'
import type { ChannelQueueFact } from '../../domain/channel-queue-fact'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { SessionHandoffResult } from '../../domain/session-handoff'
import type { NotificationReference } from '../../domain/notification-reference'
import type { MembershipTransferOutcome } from '../../domain/team-handoff'
import type { NotificationScope } from '../../domain/notification'
import { queueNotificationEvent, readQueueNotificationState, reduceQueueNotifications, type QueueHandoffAnnotation, type QueueNotificationFact, type QueueNotificationInput, type QueueNotificationState } from '../../domain/queue-notification'
import type { NotificationService } from '../notification-service'
import { NotificationProjectionSource } from './projection-source'
import { sessionNotificationObservation } from './session-lifecycle-notifications'
import { nativeAssistantEntry } from '../../domain/native-assistant-entry'

export const queueNotificationIdentity = (entryId: string) => createHash('sha256').update(entryId).digest('hex').slice(0, 32)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const keyFor = (runId?: string) => `queue-source:${hash([runId ?? null])}`

/** One shared cached fact reader; never queries the business DB, runs a timer or modifies delivery. */
export class QueueNotifications {
  private readonly source: NotificationProjectionSource<QueueNotificationInput, QueueNotificationState>
  private snapshot?: DesktopSnapshot
  private team?: TeamControlSnapshot
  private stopped = false
  private annotationRevision = 0
  private readonly startedAt: number
  private cache?: { facts: readonly ChannelQueueFact[]; scope: string; references: unknown[]; groups: Map<string, QueueNotificationInput> }
  private readonly annotations = new Map<string, { runId?: string; value: QueueHandoffAnnotation }>()
  constructor(private readonly owner: NotificationService, private readonly getQueue: () => { facts: readonly ChannelQueueFact[]; historyIncomplete: boolean; inspectionId?: string }, private readonly now: () => number = Date.now,
    private readonly watchQueue?: (fact: ChannelQueueFact) => void) {
    this.startedAt = now()
    this.source = new NotificationProjectionSource(owner, (value, key) => {
      const state = readQueueNotificationState(value, key)
      for (const annotation of Object.values(state?.handoffs ?? {})) {
        const code = state?.rows[annotation.id]?.[0]
        if (code === 'q' || code === 'h' || code === 'u' || code === 'd' || code === 'b') this.watch({ entryId: annotation.entryId, channelId: annotation.channelId, runId: state?.runId,
          createdAt: annotation.issuedAt, held: code === 'h' })
      }
      return state
    }, (old, input, baseline, revision) => {
      const current = this.getQueue()
      if (input.inspectionId && current.inspectionId !== input.inspectionId) {
        this.owner.reportHistoryGap()
        return { state: old ?? { version: 2 as const, key: input.key, rows: {}, handoffs: {} }, drafts: [] }
      }
      const byId = new Map(current.facts.map(fact => [fact.entryId, fact]))
      const facts = input.facts.map(fact => {
        const latest = byId.get(fact.entryId)
        const currentInspection = Boolean(fact.inspection && fact.inspection.id === current.inspectionId && latest?.inspection?.id === fact.inspection.id
          && latest.inspection.sequence === fact.inspection.sequence && latest.channelId === fact.channelId && latest.runId === input.runId)
        return { ...fact, currentInspection }
      })
      return reduceQueueNotifications(old, { ...input, facts }, baseline, revision)
    }, input => input.signature!)
  }
  private watch(fact: ChannelQueueFact): void { try { this.watchQueue?.(fact) } catch { this.owner.reportHistoryGap() } }
  observe(snapshot: DesktopSnapshot, team: TeamControlSnapshot): void {
    if (this.stopped || snapshot.runtimeScope && (snapshot.runtimeScope.workspaceId !== team.activeWorkspaceId || snapshot.runtimeScope.runId !== team.activeRun?.id || snapshot.runtimeScope.teamRevision !== team.revision)) return
    this.snapshot = snapshot; this.team = team
    try {
      const queue = this.getQueue()
      if (queue.historyIncomplete) this.owner.reportHistoryGap()
      const sessions = sessionNotificationObservation(snapshot, team, this.now(), 0).facts
      const scope = hash([team.activeWorkspaceId, team.activeRun?.id, sessions.map(value => value.scope), team.runs.map(run => [run.id, run.workspaceId])])
      const timelines = Object.entries(snapshot.conversations), references = timelines.flatMap(([channelId, entries]) => [channelId, entries])
      if (!this.cache || queue.facts !== this.cache.facts || scope !== this.cache.scope || references.length !== this.cache.references.length || references.some((value, index) => value !== this.cache!.references[index])) {
        const replies = new Map<string, { id: string; at: number }>()
        const replyKey = (channelId: string, entryId: string) => JSON.stringify([channelId, entryId])
        for (const [channelId, entries] of timelines) for (const entry of entries) if (!entry.silent && nativeAssistantEntry(entry, channelId)
          && entry.status === 'complete' && entry.replyToEntryId?.startsWith('outbox:')) replies.set(replyKey(channelId, entry.replyToEntryId), { id: entry.id, at: entry.timestamp })
        const groups = new Map<string, QueueNotificationInput>()
        if (team.activeRun) groups.set(keyFor(team.activeRun.id), { key: keyFor(team.activeRun.id), runId: team.activeRun.id, workspaceId: team.activeRun.workspaceId, now: this.now(), facts: [], annotations: [] })
        const runWorkspaces = new Map(team.runs.map(run => [run.id, run.workspaceId])), sessionScopes = new Map(sessions.map(value => [value.scope.channelId, value.scope]))
        if (team.activeRun) runWorkspaces.set(team.activeRun.id, team.activeRun.workspaceId)
        for (const raw of queue.facts) {
          const key = keyFor(raw.runId), workspaceId = raw.runId ? runWorkspaces.get(raw.runId) : undefined
          let group = groups.get(key)
          if (!group) { group = { key, runId: raw.runId, workspaceId, now: this.now(), facts: [], annotations: [] }; groups.set(key, group) }
          const current = sessionScopes.get(raw.channelId)
          const scope: NotificationScope = raw.runId ? current?.runId === raw.runId ? { ...current, groupId: undefined } : { runId: raw.runId, workspaceId, channelId: raw.channelId }
            : current ? { sessionId: current.sessionId, channelId: current.channelId, composerId: current.composerId, generation: current.generation, bindingGeneration: current.bindingGeneration } : { channelId: raw.channelId }
          // beginScope and listPendingOutbound use exact run_id, including NULL.
          // A current-window echo cannot close another run or an unsent retired row.
          const compatible = raw.runId === team.activeRun?.id && (raw.deliveredAt !== undefined || raw.withdrawnAt === undefined && raw.retiredAt === undefined)
          const reply = compatible ? replies.get(replyKey(raw.channelId, raw.entryId)) : undefined
          const phase = reply ? 'replied' : raw.deliveredAt !== undefined ? 'delivered' : raw.withdrawnAt !== undefined ? 'withdrawn' : raw.retiredAt !== undefined ? 'retired' : raw.unconfirmed ? 'unconfirmed' : raw.held ? 'held' : 'queued'
          group.facts.push({ id: queueNotificationIdentity(raw.entryId), entryId: raw.entryId, channelId: raw.channelId, phase,
            at: reply?.at ?? raw.deliveredAt ?? raw.withdrawnAt ?? raw.retiredAt ?? raw.unconfirmedAt ?? raw.createdAt, scope,
            inspection: raw.inspection, rowConfirmed: raw.deliveredAt !== undefined || raw.withdrawnAt !== undefined || raw.retiredAt !== undefined, takenAt: raw.deliveredAt, ...(reply ? { replyEntryId: reply.id } : {}) })
        }
        for (const group of groups.values()) group.signature = hash([group.key, group.workspaceId, group.facts])
        this.cache = { facts: queue.facts, scope, references, groups }
      }
      for (const [key, group] of this.cache.groups) {
        const annotations = [...this.annotations.values()].filter(value => keyFor(value.runId) === key).map(value => value.value)
        this.source.observe(key, { ...group, now: this.now(), monitorStartedAt: this.startedAt, inspectionId: queue.inspectionId, annotations, signature: `${group.signature}:${this.annotationRevision}:${queue.inspectionId ?? "legacy"}` })
      }
    } catch { this.owner.reportHistoryGap() }
  }
  registerHandoff(result: SessionHandoffResult, sourceChannelId: string): NotificationReference | undefined {
    if (this.stopped) return undefined
    try {
      if (!result.entryId) {
        const key = `handoff:untracked:${randomUUID()}`, eventId = `${key}:accepted`
        this.owner.offerCurrent({ key, eventId, eventType: 'handoff.accepted-untracked', category: 'sessions', source: '上下文交接', title: '交接已受理，后续取走状态未确认',
          detail: '当前传输没有提供稳定出站消息身份。不把 commandId 当成实际取走或回复，不自动重复投递。', tone: 'info', attention: 'notice', state: 'active', scope: {}, occurredAt: result.issuedAt, announce: false })
        return { key, eventId }
      }
      const raw = this.getQueue().facts.find(value => value.entryId === result.entryId && value.channelId === result.targetChannelId)
      if (!raw) { this.owner.reportHistoryGap(); return undefined }
      const id = queueNotificationIdentity(raw.entryId), previous = this.annotations.get(id)?.value
      const value: QueueHandoffAnnotation = { id, entryId: raw.entryId, channelId: raw.channelId, sourceChannelId, issuedAt: result.issuedAt,
        transcript: result.transcriptState ?? 'unverified', recordWritten: Boolean(result.recordPath), scope: previous?.scope ?? { runId: raw.runId, channelId: raw.channelId } }
      this.annotations.set(id, { runId: raw.runId, value })
      this.watch(raw)
      ++this.annotationRevision
      if (this.annotations.size > 512) this.annotations.delete(this.annotations.keys().next().value!)
      if (this.snapshot && this.team) this.observe(this.snapshot, this.team)
      return { key: `queue:${id}`, eventId: queueNotificationEvent(id, raw.deliveredAt !== undefined ? 'delivered' : raw.held ? 'held' : 'queued') }
    } catch { this.owner.reportHistoryGap(); return undefined }
  }
  registerTransfer(outcome: MembershipTransferOutcome): NotificationReference | undefined {
    const result = outcome.contextHandoff?.ok ? outcome.contextHandoff.result : undefined
    if (!result?.entryId) return undefined
    const id = queueNotificationIdentity(result.entryId), annotation = this.annotations.get(id)
    if (!annotation) return undefined
    annotation.value = { ...annotation.value, transfer: { groupId: outcome.transfer.groupId, roleName: outcome.transfer.roleName, released: outcome.transfer.releasedTaskIds.length, lead: outcome.transfer.transferredLead,...(outcome.transfer.groupEffects&&groupEffectsProblem(outcome.transfer.groupEffects)?{effects:groupEffectsDigest(outcome.transfer.groupEffects)}:{}) } }
    ++this.annotationRevision
    if (this.snapshot && this.team) this.observe(this.snapshot, this.team)
    return result.notification
  }
  suspend(): void { this.stopped = true; this.source.quietNextObservation() }
  reportHandoffFailure(channelId: string, error: unknown): void {
    if (this.stopped) return
    const key = `handoff-failed:${randomUUID()}`
    const scope = this.snapshot && this.team ? sessionNotificationObservation(this.snapshot, this.team, this.now(), 0).facts.find(value => value.scope.channelId === channelId)?.scope ?? {} : {}
    this.owner.offerCurrent({ key, eventId: `${key}:failed`, eventType: 'handoff.failed', category: 'sessions', source: '上下文交接', title: '本次上下文交接未完成',
      detail: `原操作报告异常：${error instanceof Error ? error.message.slice(0, 1_000) : '结果未确认'}。未据此推测已写的文件或消息一定没有执行，不会自动重试。`,
      tone: 'warning', attention: 'notice', state: 'active', scope, origin: { module: 'sessions', sessionId: scope.sessionId }, occurredAt: this.now(), announce: false })
  }
  resume(): void { this.stopped = false; this.source.quietNextObservation() }
  flush(): Promise<void> { return this.source.flush() }
  close(): Promise<void> { this.stopped = true; return this.source.close() }
  stop(): void { this.stopped = true; this.source.stop() }
}
