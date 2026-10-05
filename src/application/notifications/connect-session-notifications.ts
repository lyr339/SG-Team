import { McpWriteNotifications } from './mcp-write-notifications'
import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import { SessionLifecycleNotifications } from './session-lifecycle-notifications'
import { QuestionNotifications } from './question-notifications'
import { ReplyNotifications } from './reply-notifications'
import { QueueNotifications } from './queue-notifications'
import type { ChannelQueueFact } from '../../domain/channel-queue-fact'
import { conversationEntryProcessBlocks } from '../../domain/conversation-entry'
import { sessionNotificationObservation } from './session-lifecycle-notifications'
import { ContextThresholdNotifications } from './context-threshold-notifications'

interface PowerEvents {
  on(name: 'suspend' | 'resume', listener: () => void): unknown
  removeListener(name: 'suspend' | 'resume', listener: () => void): unknown
}
export function connectSessionNotifications(input: {
  notifications: NotificationService
  desktop: { getSnapshot(): DesktopSnapshot; subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void }
  team: { getSnapshot(): TeamControlSnapshot; subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void }
  power: PowerEvents
  queue?: () => { facts: readonly ChannelQueueFact[]; historyIncomplete: boolean }
  watchQueue?: (fact: ChannelQueueFact) => void
}) {
  const lifecycle = new SessionLifecycleNotifications(input.notifications)
  const questions = new QuestionNotifications(input.notifications)
  const replies = new ReplyNotifications(input.notifications)
  const context = new ContextThresholdNotifications(input.notifications)
  const mcp = new McpWriteNotifications(input.notifications)
  const queue = input.queue ? new QueueNotifications(input.notifications, input.queue, Date.now, input.watchQueue) : undefined
  let team = input.team.getSnapshot()
  let desktop = input.desktop.getSnapshot()
  const stopTeam = input.team.subscribe(next => { team = next; lifecycle.observe(desktop, team); questions.observe(desktop, team); replies.observe(desktop, team); queue?.observe(desktop, team); context.observe(desktop, team); mcp.observe(desktop, team) })
  const stopDesktop = input.desktop.subscribe(next => { desktop = next; lifecycle.observe(desktop, team); questions.observe(desktop, team); replies.observe(desktop, team); queue?.observe(desktop, team); context.observe(desktop, team); mcp.observe(desktop, team) })
  const suspend = () => { lifecycle.suspend(); questions.suspend(); replies.suspend(); queue?.suspend(); context.suspend(); mcp.suspend() }
  const resume = () => { lifecycle.resume(); questions.resume(); replies.resume(); queue?.resume(); context.resume(); mcp.resume() } // Wait for the existing next source event, not a new network/telemetry probe.
  input.power.on('suspend', suspend); input.power.on('resume', resume)
  let detached = false
  const detach = (): void => {
    if (detached) return
    detached = true; stopTeam(); stopDesktop(); input.power.removeListener('suspend', suspend); input.power.removeListener('resume', resume)
  }
  return {
    lifecycle,
    questions,
    replies,
    context,
    mcp,
    queue,
    currentTeam: (): TeamControlSnapshot => team,
    questionTarget: (channelId: string, toolCallId: string) => {
      if (desktop.runtimeScope && (desktop.runtimeScope.workspaceId !== team.activeWorkspaceId || desktop.runtimeScope.runId !== team.activeRun?.id || desktop.runtimeScope.teamRevision !== team.revision)) return { scope: {} }
      const fact = sessionNotificationObservation(desktop, team, Date.now(), 0).facts.find(value => value.scope.channelId === channelId)
      if (!fact) return { scope: {} }
      for (const entry of desktop.conversations[channelId] ?? []) {
        const block = conversationEntryProcessBlocks(entry).find(block => block.kind === 'tool' && block.question?.toolCallId === toolCallId)
        if (block) return { scope: fact.scope, target: { kind: 'session' as const, scope: fact.scope, toolCallId, entryId: entry.id, blockId: block.id } }
      }
      const block = desktop.liveProcess?.[channelId]?.blocks.find(block => block.kind === 'tool' && block.question?.toolCallId === toolCallId)
      return { scope: fact.scope, target: { kind: 'session' as const, scope: fact.scope, toolCallId, ...(block ? { blockId: block.id } : {}) } }
    },
    close: async (): Promise<void> => { detach(); await Promise.all([lifecycle.close(), questions.close(), replies.close(), queue?.close(), context.close(), mcp.close()]) },
    dispose: (): void => { detach(); lifecycle.stop(); questions.stop(); replies.stop(); queue?.stop(); context.stop(); mcp.stop() }
  }
}
