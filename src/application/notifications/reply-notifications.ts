import { createHash } from 'node:crypto'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import { nativeAssistantEntry } from '../../domain/native-assistant-entry'
import { readReplyNotificationState, reduceReplyNotifications, type NotificationReplyFact, type ReplyNotificationInput, type ReplyNotificationState } from '../../domain/reply-notification'
import { sessionNotificationObservation } from './session-lifecycle-notifications'
import { NotificationProjectionSource } from './projection-source'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class ReplyNotifications {
  private readonly source: NotificationProjectionSource<ReplyNotificationInput, ReplyNotificationState>
  private readonly extracted = new Map<string, { reference: unknown; facts: NotificationReplyFact[]; signature: string }>()
  private stopped = false
  private readonly startedAt: number
  constructor(private readonly owner: NotificationService, private readonly now: () => number = Date.now) {
    this.startedAt = now()
    this.source = new NotificationProjectionSource(owner, readReplyNotificationState, reduceReplyNotifications, input => input.signature!)
  }
  observe(snapshot: DesktopSnapshot, team: TeamControlSnapshot): void {
    if (this.stopped || snapshot.runtimeScope && (snapshot.runtimeScope.workspaceId !== team.activeWorkspaceId || snapshot.runtimeScope.runId !== team.activeRun?.id || snapshot.runtimeScope.teamRevision !== team.revision)) return
    try {
      const observation = sessionNotificationObservation(snapshot, team, this.now(), this.startedAt)
      for (const session of observation.facts) {
        const entries = snapshot.conversations[session.scope.channelId!]
        if (!entries) continue
        let extracted = this.extracted.get(session.identity)
        if (!extracted || extracted.reference !== entries) {
          const facts: NotificationReplyFact[] = []
          for (const entry of entries) {
            if (entry.silent || !nativeAssistantEntry(entry, session.scope.channelId!) || entry.status !== 'complete' && entry.status !== 'failed') continue
            const logical = entry.replyToEntryId ?? entry.streamId ?? entry.turn ?? entry.id
            const key = hash([session.identity, logical])
            // A stable association, not text identity: equal words in different turns remain different replies.
            const aliases = [['entry', entry.id], ['anchor', entry.replyToEntryId], ['stream', entry.streamId], ['turn', entry.turn]]
              .filter(([, value]) => value).map(([kind, value]) => hash([session.identity, kind, value]))
            facts.push({ key, aliases, entryId: entry.id, at: entry.timestamp, name: session.name, scope: { ...session.scope, groupId: undefined }, failed: entry.status === 'failed' })
          }
          extracted = { reference: entries, facts, signature: hash(facts) }; this.extracted.set(session.identity, extracted)
        }
        const key = `reply-source:${session.identity}`
        // Extraction cache is not a durability receipt. Feed even the same array
        // after a store failure; the transport skips only successfully committed facts.
        this.source.observe(key, { key, facts: extracted.facts, signature: extracted.signature, now: this.now(), monitorStartedAt: this.startedAt })
      }
      if (this.extracted.size > 256) this.extracted.delete(this.extracted.keys().next().value!)
    } catch { this.owner.reportHistoryGap() }
  }
  async flush(): Promise<void> { await this.source.flush() }
  async close(): Promise<void> { this.stopped = true; await this.source.close(); this.extracted.clear() }
  suspend(): void { this.stopped = true; this.source.quietNextObservation() }
  resume(): void { this.stopped = false; this.source.quietNextObservation() }
  stop(): void { this.stopped = true; this.source.stop(); this.extracted.clear() }
}
