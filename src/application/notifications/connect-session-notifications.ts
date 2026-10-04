import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import { SessionLifecycleNotifications } from './session-lifecycle-notifications'
import { QuestionNotifications } from './question-notifications'
import { ReplyNotifications } from './reply-notifications'

interface PowerEvents {
  on(name: 'suspend' | 'resume', listener: () => void): unknown
  removeListener(name: 'suspend' | 'resume', listener: () => void): unknown
}
export function connectSessionNotifications(input: {
  notifications: NotificationService
  desktop: { getSnapshot(): DesktopSnapshot; subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void }
  team: { getSnapshot(): TeamControlSnapshot; subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void }
  power: PowerEvents
}) {
  const lifecycle = new SessionLifecycleNotifications(input.notifications)
  const questions = new QuestionNotifications(input.notifications)
  const replies = new ReplyNotifications(input.notifications)
  let team = input.team.getSnapshot()
  let desktop = input.desktop.getSnapshot()
  const stopTeam = input.team.subscribe(next => { team = next; lifecycle.observe(desktop, team); questions.observe(desktop, team); replies.observe(desktop, team) })
  const stopDesktop = input.desktop.subscribe(next => { desktop = next; lifecycle.observe(desktop, team); questions.observe(desktop, team); replies.observe(desktop, team) })
  const suspend = () => { lifecycle.suspend(); questions.suspend(); replies.suspend() }
  const resume = () => { lifecycle.resume(); questions.resume(); replies.resume() } // Wait for the existing next source event, not a new network/telemetry probe.
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
    currentTeam: (): TeamControlSnapshot => team,
    close: async (): Promise<void> => { detach(); await Promise.all([lifecycle.close(), questions.close(), replies.close()]) },
    dispose: (): void => { detach(); lifecycle.stop(); questions.stop(); replies.stop() }
  }
}
