import type { DesktopSnapshot } from '../../shared/desktop-api'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import { SessionLifecycleNotifications } from './session-lifecycle-notifications'

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
  let team = input.team.getSnapshot()
  let desktop = input.desktop.getSnapshot()
  const stopTeam = input.team.subscribe(next => { team = next; lifecycle.observe(desktop, team) })
  const stopDesktop = input.desktop.subscribe(next => { desktop = next; lifecycle.observe(desktop, team) })
  const suspend = () => lifecycle.suspend()
  const resume = () => lifecycle.resume() // Wait for the existing next source event, not a new network/telemetry probe.
  input.power.on('suspend', suspend); input.power.on('resume', resume)
  return {
    lifecycle,
    currentTeam: (): TeamControlSnapshot => team,
    dispose: (): void => { stopTeam(); stopDesktop(); input.power.removeListener('suspend', suspend); input.power.removeListener('resume', resume); lifecycle.stop() }
  }
}
