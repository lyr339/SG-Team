import { createHash } from 'node:crypto'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import { isExplicitlyStoppedPhase } from '../../domain/channel-message'
import {
  contextThresholdZone,
  readContextThresholdState,
  reduceContextThresholdNotifications,
  type ContextThresholdFact,
  type ContextThresholdInput,
  type ContextThresholdState
} from '../../domain/context-threshold-notification'
import type { NotificationService } from '../notification-service'
import { NotificationProjectionSource } from './projection-source'
import { sessionNotificationObservation } from './session-lifecycle-notifications'
import { nativeContextReading } from '../../domain/context-reading'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Only exact native binding samples; estimates, channel fallback and retained display caches never cross a threshold. */
export function contextThresholdObservation(snapshot: DesktopSnapshot, team: TeamControlSnapshot, now: number): ContextThresholdInput | undefined {
  if (
    !team.activeRun ||
    !team.activeWorkspaceId ||
    (snapshot.runtimeScope &&
      (snapshot.runtimeScope.workspaceId !== team.activeWorkspaceId ||
        snapshot.runtimeScope.runId !== team.activeRun.id ||
        snapshot.runtimeScope.teamRevision !== team.revision))
  )
    return undefined
  const sessions = new Map(snapshot.sessions.map((session) => [session.id, session])),
    members = new Map(team.members.map((member) => [member.binding?.channelId ?? member.slot.channelId, member]))
  const facts: ContextThresholdFact[] = sessionNotificationObservation(snapshot, team, now, 0).facts.map((value) => {
    const session = sessions.get(value.scope.sessionId!),
      binding = members.get(value.scope.channelId)?.binding
    const sampledAt = snapshot.contextUsageSampledAt
    const reading = session ? nativeContextReading(session, sampledAt, now) : undefined
    const valid =
      reading &&
      binding?.composerId === session?.composerId &&
      (binding?.composerBoundAt === undefined || sampledAt! >= binding.composerBoundAt) &&
      snapshot.connection.state === 'connected' &&
      snapshot.nativeProcessStream?.state !== 'reconnecting'
    return {
      identity: value.identity,
      scope: value.scope,
      name: value.name,
      ended: value.retired || Boolean(session && isExplicitlyStoppedPhase(session.connectionPhase)) || session?.runtimeEvidence === 'stopped',
      ...(valid ? { domain: reading.domain, domainKey: hash(reading.domain), zone: contextThresholdZone(reading.ratio) } : {})
    }
  })
  return {
    key: 'context-threshold:' + hash([team.activeWorkspaceId, team.activeRun.id]),
    completed: team.activeRun.status === 'completed',
    now,
    facts
  }
}
export class ContextThresholdNotifications {
  private readonly source: NotificationProjectionSource<ContextThresholdInput, ContextThresholdState>
  private suspended = false
  private active?: { key: string; runId: string; workspaceId: string }
  constructor(
    private readonly owner: NotificationService,
    private readonly now: () => number = Date.now
  ) {
    this.source = new NotificationProjectionSource(owner, readContextThresholdState, reduceContextThresholdNotifications, (input) =>
      JSON.stringify([input.key, input.completed, input.facts])
    )
  }
  observe(snapshot: DesktopSnapshot, team: TeamControlSnapshot): void {
    if (this.suspended) return
    try {
      const input = contextThresholdObservation(snapshot, team, this.now())
      if (!input) return
      const old = this.active
      if (
        old &&
        old.key !== input.key &&
        team.runs.some((run) => run.id === old.runId && run.workspaceId === old.workspaceId && run.status === 'completed')
      )
        this.source.observe(old.key, { key: old.key, completed: true, facts: [], now: input.now })
      this.active = { key: input.key, runId: team.activeRun!.id, workspaceId: team.activeWorkspaceId! }
      this.source.observe(input.key, input)
    } catch {
      this.owner.reportHistoryGap()
    }
  }
  suspend(): void {
    this.suspended = true
    this.source.quietNextObservation()
  }
  resume(): void {
    this.suspended = false
    this.source.quietNextObservation()
  }
  flush(): Promise<void> {
    return this.source.flush()
  }
  close(): Promise<void> {
    return this.source.close()
  }
  stop(): void {
    this.source.stop()
  }
}
