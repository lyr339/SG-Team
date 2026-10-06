import { createHash } from 'node:crypto'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { ProcessBlock } from '../../domain/conversation-entry'
import { conversationEntryProcessBlocks } from '../../domain/conversation-entry'
import { nativeAssistantEntry } from '../../domain/native-assistant-entry'
import { QUESTION_TERMINAL_BATCH_LIMIT } from '../../domain/question-terminal-receipt'
import { sessionNotificationObservation } from './session-lifecycle-notifications'
import { readQuestionNotificationState, reduceQuestionNotifications, questionTerminalSlice, type NotificationQuestionFact, type QuestionNotificationInput, type QuestionNotificationState } from '../../domain/question-notification'
import type { NotificationService } from '../notification-service'
import { NotificationProjectionSource } from './projection-source'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class QuestionNotifications {
  private readonly source: NotificationProjectionSource<QuestionNotificationInput, QuestionNotificationState>
  private readonly history = new Map<string, { reference: unknown; questions: Map<string, NotificationQuestionFact> }>()
  private activeScope?: { key: string; runId?: string }
  private stopped = false
  constructor(private readonly owner: NotificationService, private readonly now: () => number = Date.now) {
    this.source = new NotificationProjectionSource(owner, readQuestionNotificationState, async (old, input, baseline, revision) => {
      if (old && !old.indexed) return reduceQuestionNotifications(old, input, baseline, revision)
      const pending = input.facts.filter(fact => fact.status === 'pending').map(fact => fact.identity)
      const pendingReceipts = [] as Awaited<ReturnType<NotificationService['questionTerminals']>>
      for (let start = 0; start < pending.length; start += QUESTION_TERMINAL_BATCH_LIMIT) pendingReceipts.push(...await owner.questionTerminals(input.scopeKey, pending.slice(start, start + QUESTION_TERMINAL_BATCH_LIMIT)))
      let working = old
      for (let batch = 0; batch < 1024; batch++) {
        const slice = questionTerminalSlice(working, input)
        const receipts = slice.facts.length ? await owner.questionTerminals(input.scopeKey, slice.facts.map(fact => fact.identity)) : []
        const projection = reduceQuestionNotifications(working, input, baseline, revision, [...pendingReceipts, ...receipts])
        if (projection.drafts.length || projection.questionTerminals || projection.complete !== false) return projection
        working = projection.state // Known receipt pages need no temporary-offset SQLite writes.
      }
      throw Error('问卷终态核对超过本次有界容量，历史保留')
    }, input => input.signature, undefined, 1024)
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
          awaitingUserEvidence: session.awaitingUserEvidence ?? 'unknown',
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
              actionable: question.status === 'pending' && session.awaitingUser === true, terminated: fact.retired || fact.evidence === 'stopped' })
          }
        }
        const entries = snapshot.conversations[session.channelId]
        let history = this.history.get(fact.identity)
        if (entries && (!history || history.reference !== entries)) {
          const known = new Map<string, NotificationQuestionFact>()
          for (const entry of entries) if (nativeAssistantEntry(entry, session.channelId)) collect(conversationEntryProcessBlocks(entry), known, entry.id)
          history = { reference: entries, questions: known }; this.history.set(fact.identity, history)
        }
        for (const old of history?.questions.values() ?? []) questions.set(old.identity, { ...old, actionable: old.status === 'pending' && session.awaitingUser === true,
          terminated: fact.retired || fact.evidence === 'stopped' })
        collect(snapshot.liveProcess?.[session.channelId]?.blocks ?? [], questions)
      }
      if (this.history.size > 256) this.history.delete(this.history.keys().next().value!)
      const input: QuestionNotificationInput = { signature: '', scopeKey: `questions:${hash([observed.workspaceId, observed.runId])}`, runCompleted: observed.runCompleted, now: this.now(), facts: [...questions.values()], sessions }
      input.signature = hash([input.scopeKey, input.runCompleted, input.facts, input.sessions])
      if (this.activeScope && this.activeScope.key !== input.scopeKey && this.activeScope.runId
        && team.runs.some(run => run.id === this.activeScope!.runId && run.status === 'completed')) {
        this.source.observe(this.activeScope.key, { scopeKey: this.activeScope.key, runCompleted: true, now: input.now, facts: [], sessions: [], signature: hash([this.activeScope.key, 'completed']) })
      }
      this.activeScope = { key: input.scopeKey, runId: observed.runId }
      this.source.observe(input.scopeKey, input)
    } catch { this.owner.reportHistoryGap() }
  }
  suspend(): void { this.stopped = true; this.source.quietNextObservation() }
  resume(): void { this.stopped = false; this.source.quietNextObservation() }
  async flush(): Promise<void> { await this.source.flush() }
  async close(): Promise<void> { this.stopped = true; await this.source.close(); this.history.clear() }
  stop(): void { this.stopped = true; this.source.stop(); this.history.clear() }
}
