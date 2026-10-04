import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import { SessionLifecycleNotifications } from './session-lifecycle-notifications'
import { QuestionNotifications } from './question-notifications'
import { ReplyNotifications } from './reply-notifications'
import { QueueNotifications } from './queue-notifications'
import type { ChannelQueueFact } from '../../domain/channel-queue-fact'

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
  const queue = input.queue ? new QueueNotifications(input.notifications, input.queue, Date.now, input.watchQueue) : undefined
  let team = input.team.getSnapshot()
  let desktop = input.desktop.getSnapshot()
  const stopTeam = input.team.subscribe(next => { team = next; lifecycle.observe(desktop, team); questions.observe(desktop, team); replies.observe(desktop, team); queue?.observe(desktop, team) })
  const stopDesktop = input.desktop.subscribe(next => { desktop = next; lifecycle.observe(desktop, team); questions.observe(desktop, team); replies.observe(desktop, team); queue?.observe(desktop, team) })
  const suspend = () => { lifecycle.suspend(); questions.suspend(); replies.suspend(); queue?.suspend() }
  const resume = () => { lifecycle.resume(); questions.resume(); replies.resume(); queue?.resume() } // Wait for the existing next source event, not a new network/telemetry probe.
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
    queue,
    currentTeam: (): TeamControlSnapshot => team,
    close: async (): Promise<void> => { detach(); await Promise.all([lifecycle.close(), questions.close(), replies.close(), queue?.close()]) },
    dispose: (): void => { detach(); lifecycle.stop(); questions.stop(); replies.stop(); queue?.stop() }
  }
}
