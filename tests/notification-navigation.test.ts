import { describe, expect, it } from 'vitest'
import { notificationTargetAvailable } from '../src/renderer/src/notifications/notification-navigation'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import type { AgentSession } from '../src/domain/agent-session'

const session = { id: 'session-new', channelId: '3', generation: 2, composerId: 'composer-new' } as AgentSession
describe('notification navigation ownership', () => {
  it('does not trust a channel alone or let old session/generation references jump to its replacement', () => {
    const team = emptyTeamControlSnapshot()
    expect(notificationTargetAvailable({ kind: 'session', scope: { channelId: '3' } }, [session], team)).toBe(false)
    expect(notificationTargetAvailable({ kind: 'session', scope: { channelId: '3', sessionId: 'session-old' } }, [session], team)).toBe(false)
    expect(notificationTargetAvailable({ kind: 'session', scope: { channelId: '3', sessionId: session.id, generation: '1' } }, [session], team)).toBe(false)
    expect(notificationTargetAvailable({ kind: 'session', scope: { channelId: '3', sessionId: session.id, generation: '2', composerId: session.composerId } }, [session], team)).toBe(true)
  })
  it('does not switch workspaces or invent an old run just to satisfy a stale notification', () => {
    const team = emptyTeamControlSnapshot(); team.activeWorkspaceId = 'new-workspace'
    expect(notificationTargetAvailable({ kind: 'session', scope: { channelId: '3', sessionId: session.id, workspaceId: 'old-workspace' } }, [session], team)).toBe(false)
    expect(notificationTargetAvailable({ kind: 'run', runId: 'old-run' }, [session], team)).toBe(false)
    expect(notificationTargetAvailable({ kind: 'settings', section: 'accounts' }, [session], team)).toBe(true)
  })
})
