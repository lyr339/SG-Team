import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../../src/domain/team-control'
import type { AgentSession } from '../../src/domain/agent-session'
import type { DesktopSnapshot } from '../../src/shared/desktop-api'

/** Pure fixture data shared by unit and built-worker checks; no Vitest or live desktop dependency. */
export function notificationTeam(): TeamControlSnapshot {
  const team = emptyTeamControlSnapshot(); team.activeWorkspaceId = 'workspace-a'
  const run = { id: 'run-a', workspaceId: 'workspace-a', name: 'test', goal: '', templateId: 'independent-session-v1', status: 'running' as const, createdAt: 1, updatedAt: 1 }
  const binding = { id: 'binding-a', workspaceId: 'workspace-a', runId: run.id, slotId: 'slot-a', channelId: '1', agentSessionId: 'sg-channel:1', generation: 'bind-a',
    installedAt: 1, launchDetail: '', lastCheckInNote: '', composerBindingKey: 'test-key', composerId: 'composer-a', composerBoundAt: 10 }
  team.activeRun = run; team.runs = [run]; team.bindings = [binding]
  team.members = [{ slot: { id: 'slot-a', runId: run.id, roleId: 'role-a', order: 0, name: '独立执行', avatarId: 'lead', channelId: '1', solo: true, createdAt: 1, updatedAt: 1 },
    role: { id: 'role-a', runId: run.id, key: 'solo-a', templateKey: 'solo', name: '独立执行', mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: 0 }, binding, readiness: 'active' }]
  return team
}
export const notificationSession = (patch: Partial<AgentSession> = {}): AgentSession => ({ id: 'sg-channel:1', channelId: '1', generation: 0, displayName: 'CH-1', roleName: '独立执行', composerId: 'composer-a',
  status: 'waiting', currentTask: '', queueDepth: 0, connectionPhase: 'waiting', online: true, connected: true, waiting: true, workingFiles: [], healthEvidence: [], runtimeEvidence: 'active', lastSeenAt: 1_000, ...patch })
export const notificationFrame = (patch: Partial<DesktopSnapshot> = {}): DesktopSnapshot => ({ connection: { state: 'connected', endpoint: 'test-only', attempt: 0, lastError: '' },
  sessions: [notificationSession()], conversations: { '1': [] }, protocolIssues: [], updatedAt: 1_000, ...patch })
