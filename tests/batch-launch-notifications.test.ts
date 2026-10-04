import { describe, expect, it, vi } from 'vitest'
import { connectBatchLaunchNotifications } from '../src/application/notifications/batch-launch-notifications'
import type { AgentLaunchPlan } from '../src/domain/agent-launch'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'

describe('batch source ownership', () => {
  it('freezes the starting scope rather than attributing a late terminal result to the newly selected workspace', () => {
    let callback!: (plan: AgentLaunchPlan) => void; const dispose = vi.fn()
    const team = emptyTeamControlSnapshot(); team.activeWorkspaceId = 'old-workspace'
    team.activeRun = { id: 'old-run', workspaceId: 'old-workspace', name: 'run', goal: '', status: 'running', templateId: 'independent-session-v1', createdAt: 1, updatedAt: 1 }
    const notifications = { offerCurrent: vi.fn() }
    const stop = connectBatchLaunchNotifications({ subscribe: listener => { callback = listener; return dispose } }, () => team, notifications, () => 200)
    const plan: AgentLaunchPlan = { id: 'real-operation', state: 'running', startedAt: 100, items: [{ channelId: '1', stage: 'trigger', message: 'starting' }] }
    callback(plan); team.activeWorkspaceId = 'new-workspace'; team.activeRun = undefined
    callback({ ...plan, state: 'done', finishedAt: 150, items: [{ channelId: '1', stage: 'done', message: 'done', creation: 'new', submitted: true }] })
    expect(notifications.offerCurrent).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { workspaceId: 'old-workspace', runId: 'old-run' }, target: { kind: 'run', runId: 'old-run' }, announce: true }))
    stop(); expect(dispose).toHaveBeenCalledOnce()
  })
  it('a terminal plan observed only on initial subscription remains historical and has no fabricated current-workspace target', () => {
    const notifications = { offerCurrent: vi.fn() }; const team = emptyTeamControlSnapshot(); team.activeWorkspaceId = 'new-workspace'
    connectBatchLaunchNotifications({ subscribe: callback => { callback({ id: 'old-plan', state: 'done', startedAt: 1, finishedAt: 2, items: [] }); return () => {} } }, () => team, notifications, () => 300)
    expect(notifications.offerCurrent).toHaveBeenCalledWith(expect.objectContaining({ scope: {}, announce: false }))
    expect(notifications.offerCurrent.mock.calls[0]![0].target).toBeUndefined()
  })
})
