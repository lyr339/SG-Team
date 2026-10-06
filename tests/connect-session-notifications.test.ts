import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { connectSessionNotifications } from '../src/application/notifications/connect-session-notifications'
import { NotificationService } from '../src/application/notification-service'
import type { NotificationRepository } from '../src/application/notification-repository'
import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

describe('session notification source connection', () => {
  it('uses existing subscriptions, fences topology pairs and unregisters power events without a new probe on wake', async () => {
    const team = emptyTeamControlSnapshot()
    const frame: DesktopSnapshot = { runtimeScope: { teamRevision: team.revision }, connection: { state: 'connected', endpoint: 'test', attempt: 0, lastError: '' }, sessions: [], conversations: {}, protocolIssues: [], updatedAt: 1 }
    const stopTeam = vi.fn(); const stopDesktop = vi.fn(); const power = new EventEmitter()
    let emitTeam!: (value: TeamControlSnapshot) => void; let emitDesktop!: (value: DesktopSnapshot) => void
    const sourceState = vi.fn(async () => ({ revision: 0 }))
    const commitSource = vi.fn(async (_key, expected, data) => ({ applied: true, source: { revision: expected + 1, data }, changes: [] }))
    const owner = new NotificationService({ sourceState, commitSource } as unknown as NotificationRepository)
    const desktop = { getSnapshot: vi.fn(() => frame), subscribe: (callback: typeof emitDesktop) => { emitDesktop = callback; callback(frame); return stopDesktop } }
    const topology = { getSnapshot: vi.fn(() => team), subscribe: (callback: typeof emitTeam) => { emitTeam = callback; callback(team); return stopTeam } }
    const modelCatalog = { suspend: vi.fn(), resume: vi.fn() }
    const runtimeUsage = { suspend: vi.fn(), resume: vi.fn() }
    const composerContext = { suspend: vi.fn(), resume: vi.fn() }
    const usageBinding = { suspend: vi.fn(), resume: vi.fn() }
    const connection = connectSessionNotifications({ notifications: owner, desktop, team: topology, power, modelCatalog, runtimeUsage, composerContext, usageBinding })
    await connection.lifecycle.flush(); const count = commitSource.mock.calls.length
    emitTeam({ ...team, revision: team.revision + 1 }); await connection.lifecycle.flush()
    expect(commitSource.mock.calls.length).toBe(count)
    emitDesktop({ ...frame, runtimeScope: { teamRevision: team.revision + 1 } }); await connection.lifecycle.flush()
    power.emit('suspend'); power.emit('resume')
    expect(modelCatalog.suspend).toHaveBeenCalledOnce(); expect(modelCatalog.resume).toHaveBeenCalledOnce()
    expect(runtimeUsage.suspend).toHaveBeenCalledOnce(); expect(runtimeUsage.resume).toHaveBeenCalledOnce()
    expect(composerContext.suspend).toHaveBeenCalledOnce(); expect(composerContext.resume).toHaveBeenCalledOnce()
    expect(usageBinding.suspend).toHaveBeenCalledOnce(); expect(usageBinding.resume).toHaveBeenCalledOnce()
    expect(desktop.getSnapshot).toHaveBeenCalledOnce(); expect(topology.getSnapshot).toHaveBeenCalledOnce()
    connection.dispose(); expect(stopTeam).toHaveBeenCalledOnce(); expect(stopDesktop).toHaveBeenCalledOnce()
    expect(power.listenerCount('resume')).toBe(0); expect(power.listenerCount('suspend')).toBe(0)
    power.emit('suspend'); power.emit('resume')
    expect(modelCatalog.suspend).toHaveBeenCalledOnce(); expect(modelCatalog.resume).toHaveBeenCalledOnce()
    expect(runtimeUsage.suspend).toHaveBeenCalledOnce(); expect(runtimeUsage.resume).toHaveBeenCalledOnce()
    expect(composerContext.suspend).toHaveBeenCalledOnce(); expect(composerContext.resume).toHaveBeenCalledOnce()
    expect(usageBinding.suspend).toHaveBeenCalledOnce(); expect(usageBinding.resume).toHaveBeenCalledOnce()
  })
})
