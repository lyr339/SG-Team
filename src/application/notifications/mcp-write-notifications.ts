import { createHash } from 'node:crypto'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import { conversationEntryProcessBlocks, type ProcessBlock } from '../../domain/conversation-entry'
import { observedMcpWrite } from '../../domain/mcp-write-observation'
import { nativeAssistantEntry } from '../../domain/native-assistant-entry'
import {
  readMcpWriteState,
  reduceMcpWriteNotifications,
  legacyMcpWriteCandidates,
  type McpWriteFact,
  type McpWriteState,
  type McpWriteInput
} from '../../domain/mcp-write-notification'
import { sessionNotificationObservation } from './session-lifecycle-notifications'
import { NotificationProjectionSource } from './projection-source'
import type { NotificationService } from '../notification-service'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
interface ExtractedWrites { reference: unknown; facts: McpWriteFact[]; signature: string; turn?: string }
/** Existing sealed/live native process facts only. No service call, poll, reply or retry. */
export class McpWriteNotifications {
  readonly source: NotificationProjectionSource<McpWriteInput, McpWriteState>
  private readonly startedAt: number
  private stopped = false
  private readonly cached = new Map<
    string,
    { history: ExtractedWrites; live: ExtractedWrites; authority: string; facts: McpWriteFact[]; signature: string }
  >()
  constructor(
    private readonly owner: NotificationService,
    private readonly now: () => number = Date.now
  ) {
    this.startedAt = now()
    this.source = new NotificationProjectionSource(
      owner,
      readMcpWriteState,
      (previous, input, baseline, revision) => {
        const candidates = legacyMcpWriteCandidates(previous, input)
        if (!candidates.length) return reduceMcpWriteNotifications(previous, input, baseline, revision)
        return owner.mcpWriteRecords(candidates.map(f => `mcp-write:${f.identity}`))
          .then(rows => reduceMcpWriteNotifications(previous, input, baseline, revision, rows))
      },
      (input) => input.signature,
      undefined,
      256 // 20,000 old identities can be inspected in <=200 private 100-item transactions.
    )
  }
  observe(snapshot: DesktopSnapshot, team: TeamControlSnapshot): void {
    if (
      this.stopped ||
      (snapshot.runtimeScope &&
        (snapshot.runtimeScope.workspaceId !== team.activeWorkspaceId ||
          snapshot.runtimeScope.runId !== team.activeRun?.id ||
          snapshot.runtimeScope.teamRevision !== team.revision))
    )
      return
    try {
      const observation = sessionNotificationObservation(snapshot, team, this.now(), this.startedAt)
      for (const session of observation.facts) {
        const member = team.members.find((member) => member.slot.id === session.scope.slotId),
          agent = member?.binding?.agentSessionId
        if (!agent || !session.scope.composerId || !session.scope.bindingGeneration ||
          member.binding?.composerId !== session.scope.composerId || member.binding.channelId !== session.scope.channelId) continue
        const history = snapshot.conversations[session.scope.channelId!],
          liveProcess = snapshot.liveProcess?.[session.scope.channelId!], live = liveProcess?.blocks,
          authority = hash([session.scope, session.name, agent, member.binding.installedAt, member.binding.composerBoundAt])
        let cache = this.cached.get(session.identity)
        const prior = cache?.authority === authority ? cache : undefined
        if (!prior || prior.history.reference !== history || prior.live.reference !== live || prior.live.turn !== liveProcess?.turn) {
          const read = (block: ProcessBlock, at: number, entryId?: string, turnId?: string): McpWriteFact | undefined => {
            if (block.kind !== 'tool' || block.status === 'running' || block.toolKind && block.toolKind !== 'mcp') return
            const fact = observedMcpWrite(block.toolName, block.input, block.output)
            if (!fact || fact.status === 'returned' || fact.agentSessionId !== agent || fact.channelId !== session.scope.channelId) return
            const observedAt = block.completedAt ?? block.startedAt ?? at
            // Native blocks carry no installation generation. Old results must
            // not be attached to a later installation using the same channel ID.
            if (!Number.isSafeInteger(observedAt) || observedAt < Math.max(member.binding?.installedAt ?? 0, member.binding?.composerBoundAt ?? 0)) return
            return { ...fact, identity: hash([session.identity, block.id, fact.tool, fact.action]),
              attentionKey: hash([session.identity, typeof turnId === 'string' && turnId.length > 0 && turnId.length <= 300 ? turnId : null,
                fact.tool, fact.action, fact.reason]), blockId: block.id,
              // These receipts prove an installed session, not the group at
              // invocation time. A current membership must not rewrite history.
              ...(entryId ? { entryId } : {}), at: observedAt, name: session.name, scope: { ...session.scope, groupId: undefined } }
          }
          let sealed = prior?.history
          if (!sealed || sealed.reference !== history) {
            const facts: McpWriteFact[] = []
            for (const entry of history ?? [])
              if (nativeAssistantEntry(entry, session.scope.channelId!))
                for (const block of conversationEntryProcessBlocks(entry)) { const fact = read(block, entry.timestamp, entry.id, entry.turn ?? entry.replyToEntryId); if (fact) facts.push(fact) }
            sealed = { reference: history, facts, signature: hash(facts) }
          }
          let current = prior?.live
          if (!current || current.reference !== live || current.turn !== liveProcess?.turn) {
            const facts = (live ?? []).flatMap(block => { const fact = read(block, liveProcess?.startedAt ?? this.now(), undefined, liveProcess?.turn); return fact ? [fact] : [] })
            current = { reference: live, facts, signature: hash(facts), turn: liveProcess?.turn }
          }
          const signature = hash([sealed.signature, current.signature])
          // Do not rescan or stringify sealed history on each new live token.
          const facts = prior?.signature === signature ? prior.facts
            : [...new Map([...sealed.facts, ...current.facts].map(fact => [fact.identity, fact])).values()]
          cache = { history: sealed, live: current, authority, facts, signature }
          this.cached.set(session.identity, cache)
        }
        if (!cache) throw Error('MCP 写观察缺少提取结果')
        const key = `mcp-write-source:${session.identity}`
        this.source.observe(key, {
          key,
          facts: cache.facts,
          signature: cache.signature,
          now: this.now(),
          monitorStartedAt: this.startedAt
        })
      }
      while (this.cached.size > 256) this.cached.delete(this.cached.keys().next().value!)
    } catch {
      this.owner.reportHistoryGap()
    }
  }
  suspend(): void {
    this.stopped = true
    this.source.quietNextObservation()
  }
  resume(): void {
    this.stopped = false
    this.source.quietNextObservation()
  }
  stop(): void {
    this.stopped = true
    this.source.stop()
    this.cached.clear()
  }
  async close(): Promise<void> {
    this.stopped = true
    await this.source.close()
    this.cached.clear()
  }
}
