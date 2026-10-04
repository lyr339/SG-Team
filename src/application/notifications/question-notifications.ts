import { createHash } from 'node:crypto'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { ProcessBlock } from '../../domain/conversation-entry'
import { conversationEntryProcessBlocks } from '../../domain/conversation-entry'
import { sessionNotificationObservation } from './session-lifecycle-notifications'
import { readQuestionNotificationState, reduceQuestionNotifications, type NotificationQuestionFact, type QuestionNotificationInput, type QuestionNotificationState } from '../../domain/question-notification'
import type { NotificationService } from '../notification-service'
import { NotificationProjectionSource } from './projection-source'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class QuestionNotifications {
  private readonly source: NotificationProjectionSource<QuestionNotificationInput, QuestionNotificationState>
  private readonly history = new Map<string, { reference: unknown; questions: Map<string, NotificationQuestionFact> }>()
  private activeScope?: { key: string; runId?: string }
  private stopped = false
  constructor(private readonly owner: NotificationService, private readonly now: () => number = Date.now) {
    this.source = new NotificationProjectionSource(owner, readQuestionNotificationState, (old, input, baseline, revision) => reduceQuestionNotifications(old, input, baseline, revision),
      input => JSON.stringify([input.scopeKey, input.runCompleted, input.facts, input.sessions]))
  }
  observe(snapshot: DesktopSnapshot, team: TeamControlSnapshot): void {
    if (this.stopped || snapshot.runtimeScope && (snapshot.runtimeScope.workspaceId !== team.activeWorkspaceId || snapshot.runtimeScope.runId !== team.activeRun?.id || snapshot.runtimeScope.teamRevision !== team.revision)) return
    try {
      const observed = sessionNotificationObservation(snapshot, team, this.now(), 0)
      const questions = new Map<string, NotificationQuestionFact>()
      const sessions: NonNullable<QuestionNotificationInput['sessions']> = []
      for (const fact of observed.facts) {
        const session = snapshot.sessions.find(session => session.channelId === fact.scope.channelId)!
        sessions.push({ scope: fact.scope, online: fact.online, ...(session.awaitingUser !== undefined ? { awaitingUser: session.awaitingUser } : {}),
          terminated: fact.retired || fact.evidence === 'stopped' })
        const collect = (blocks: ProcessBlock[], into: Map<string, NotificationQuestionFact>, entryId?: string) => {
          for (const block of blocks) {
            if (block.kind !== 'tool' || !block.question) continue
            const question = block.question
            const identity = hash([fact.identity, question.toolCallId])
            const known = into.get(identity)
            // A stale pending live block must not replace a persisted answer. Preserve
            // its real entry reference when only the live block is refreshed.
            if (known && known.status !== 'pending' && question.status === 'pending') continue
            into.set(identity, { identity, toolCallId: question.toolCallId, blockId: block.id, ...(entryId ?? known?.entryId ? { entryId: entryId ?? known?.entryId } : {}), name: fact.name,
              scope: { ...fact.scope, groupId: undefined }, status: question.status, count: question.questions.length,
              actionable: question.status === 'pending' && session.awaitingUser === true && fact.online, terminated: fact.retired || fact.evidence === 'stopped' })
          }
        }
        const entries = snapshot.conversations[session.channelId]
        let history = this.history.get(fact.identity)
        if (entries && (!history || history.reference !== entries)) {
          const known = new Map<string, NotificationQuestionFact>()
          for (const entry of entries) collect(conversationEntryProcessBlocks(entry), known, entry.id)
          history = { reference: entries, questions: known }; this.history.set(fact.identity, history)
        }
        for (const old of history?.questions.values() ?? []) questions.set(old.identity, { ...old, actionable: old.status === 'pending' && session.awaitingUser === true && fact.online,
          terminated: fact.retired || fact.evidence === 'stopped' })
        collect(snapshot.liveProcess?.[session.channelId]?.blocks ?? [], questions)
      }
      if (this.history.size > 256) this.history.delete(this.history.keys().next().value!)
      const input: QuestionNotificationInput = { scopeKey: `questions:${hash([observed.workspaceId, observed.runId])}`, runCompleted: observed.runCompleted, now: this.now(), facts: [...questions.values()], sessions }
      if (this.activeScope && this.activeScope.key !== input.scopeKey && this.activeScope.runId
        && team.runs.some(run => run.id === this.activeScope!.runId && run.status === 'completed')) {
        this.source.observe(this.activeScope.key, { scopeKey: this.activeScope.key, runCompleted: true, now: input.now, facts: [], sessions: [] })
      }
      this.activeScope = { key: input.scopeKey, runId: observed.runId }
      this.source.observe(input.scopeKey, input)
    } catch { this.owner.reportHistoryGap() }
  }
  suspend(): void { this.stopped = true; this.source.quietNextObservation() }
  resume(): void { this.stopped = false; this.source.quietNextObservation() }
  async flush(): Promise<void> { await this.source.flush() }
  stop(): void { this.stopped = true; this.source.stop(); this.history.clear() }
}
