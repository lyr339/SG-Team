import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamControlService } from '../src/application/team-control-service'
import { TaskPoolService, type ActiveTaskScope } from '../src/application/task-pool-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { InMemoryTaskPoolRepository } from '../src/infrastructure/task-pool/in-memory-task-pool-repository'
import { connectTaskNotifications } from '../src/application/notifications/task-notifications'
import { notificationFrame, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
import { emptyTaskPoolSnapshot, type TaskPoolReadObservation } from '../src/domain/task-pool'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sg-task-context-')), path = join(directory, 'business.sqlite')
  const repository = new SqliteTeamControlRepository(path), tasksRepository = new SqliteTaskPoolRepository(path)
  const frame = notificationFrame({ sessions: [], conversations: {} })
  const control = new TeamControlService(repository, { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: () => ({ commandId: 'fixture' }) })
  control.createSessionPool({ workspaceId: 'context-workspace', workspaceName: 'fixture', workspacePath: directory,
    members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true }] })
  const tasks = new TaskPoolService(tasksRepository, control), h = notificationSourceHarness()
  const teamRead = vi.fn(() => { throw Error('second team snapshot prohibited') })
  const source = connectTaskNotifications(tasks, teamRead, h.owner)
  return { directory, repository, tasksRepository, control, tasks, h, source, teamRead,
    close: async () => { await source.close(); await h.owner.close(); tasks.stopWatcher(); tasks.stopSweeper(); control.dispose(); repository.close(); tasksRepository.close(); rmSync(directory, { recursive: true, force: true }) } }
}

it('notification uses the original atomic scope context: no second team/runtime read, same pool/scope query count and original public snapshot', async () => {
  const f = fixture()
  try {
    const publicBefore = f.tasks.getSnapshot(); await f.source.source.flush()
    const load = vi.spyOn(f.tasksRepository, 'load'), scope = vi.spyOn(f.control, 'getActiveTaskScope'), snapshot = vi.spyOn(f.control, 'getSnapshot')
    const result = f.tasks.getSnapshot(); await f.source.source.flush()
    expect(result).toEqual(publicBefore); expect(result).not.toHaveProperty('context'); expect(result).not.toHaveProperty('runStatus')
    expect(load).toHaveBeenCalledOnce(); expect(scope).toHaveBeenCalledOnce(); expect(snapshot).not.toHaveBeenCalled(); expect(f.teamRead).not.toHaveBeenCalled()
    expect(f.h.owner.status().historyIncomplete).toBe(false)
    const task = f.tasks.createTask({ title: 'Original task' }); await f.source.source.flush()
    f.tasks.cancelTask(task.id, 'fixture'); await f.source.source.flush()
    expect(f.h.ledger.page({ key: `task:${task.id}` }).records[0]?.subjectState).toBe('cancelled')
    f.control.endActiveRun(); const ended = f.tasks.getSnapshot(); await f.source.source.flush()
    expect(ended.runId).toBe(publicBefore.runId); expect(f.teamRead).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('preserves original pool-load then active-scope ordering, frozen thin context and original return even when metadata/subscribers throw', () => {
  const repository = new InMemoryTaskPoolRepository(), calls: string[] = []
  let supplied: ActiveTaskScope = { workspaceId: 'workspace', runId: 'run', scopeRevision: 4, runStatus: 'running' }
  const provider = { getActiveRunId: () => 'run', getActiveTaskScope: () => { calls.push('scope'); return supplied } }
  const service = new TaskPoolService(repository, provider), original = repository.load.bind(repository)
  const load = vi.spyOn(repository, 'load').mockImplementation(() => { calls.push('pool'); return original() })
  const observations: TaskPoolReadObservation[] = []
  const stop = service.subscribeReadObservation(value => { observations.push(value); throw Error('observer') })
  try {
    const snapshot = service.getSnapshot()
    expect(calls).toEqual(['pool', 'scope']); expect(observations[0]?.context).toEqual(supplied)
    expect(Object.isFrozen(observations[0]?.context)).toBe(true)
    expect(observations[0]?.snapshot).toBe(snapshot)
    const state: ActiveTaskScope = { workspaceId: 'workspace', runId: 'run', scopeRevision: 4 }
    Object.defineProperty(state, 'runStatus', { get: () => { throw Error('metadata only') } }); supplied = state
    expect(service.getSnapshot()).toEqual(snapshot)
    expect(observations.at(-1)?.context).toBeUndefined()
    stop(); const count = observations.length; service.getSnapshot(); expect(observations).toHaveLength(count)
  } finally { stop(); load.mockRestore() }
})

it('context is evidence only with ordered owned provenance and matching scope; malformed or stale context does not query a fallback or manufacture an ended run', async () => {
  const h = notificationSourceHarness(), getTeam = vi.fn(() => notificationTeam())
  let receive!: (value: TaskPoolReadObservation) => void
  const tasks = { subscribe: () => () => {}, getReadOwnerId: () => 'context-owner', subscribeReadObservation: (fn: typeof receive) => { receive = fn; return () => {} } }
  const source = connectTaskNotifications(tasks, getTeam, h.owner)
  const snapshot = { ...emptyTaskPoolSnapshot(), workspaceId: 'workspace-a', runId: 'run-a', scopeRevision: 4 }
  try {
    receive({ snapshot, stamp: { owner: 'context-owner', sequence: 1 }, context: { workspaceId: 'workspace-a', runId: 'run-a', scopeRevision: 3, runStatus: 'running' } })
    receive({ snapshot, stamp: { owner: 'context-owner', sequence: 2 }, context: { workspaceId: 'foreign', runId: 'run-a', scopeRevision: 4, runStatus: 'running' } })
    receive({ snapshot, stamp: { owner: 'foreign-owner', sequence: 3 }, context: { workspaceId: 'workspace-a', runId: 'run-a', scopeRevision: 4, runStatus: 'completed' } })
    await source.source.flush()
    expect(getTeam).not.toHaveBeenCalled(); expect(h.ledger.page().summary.total).toBe(0)
    expect(h.owner.status().historyIncomplete).toBe(true)
    receive({ snapshot: { ...emptyTaskPoolSnapshot(), scopeRevision: 0 }, stamp: { owner: 'context-owner', sequence: 4 }, context: { scopeRevision: 0, runStatus: undefined } })
    await source.source.flush(); expect(getTeam).not.toHaveBeenCalled(); expect(h.ledger.page().summary.total).toBe(0)
  } finally { await source.close(); await h.owner.close() }
})

it('older providers without original read context retain their existing explicit fallback contract', async () => {
  const h = notificationSourceHarness(), getTeam = vi.fn(() => notificationTeam())
  let receive!: (value: TaskPoolReadObservation) => void
  const source = connectTaskNotifications({ subscribe: () => () => {}, getReadOwnerId: () => 'legacy-owner', subscribeReadObservation: fn => { receive = fn; return () => {} } }, getTeam, h.owner)
  try {
    receive({ snapshot: { ...emptyTaskPoolSnapshot(), workspaceId: 'workspace-a', runId: 'run-a' }, stamp: { owner: 'legacy-owner', sequence: 1 } })
    await source.source.flush(); expect(getTeam).toHaveBeenCalledOnce()
  } finally { await source.close(); await h.owner.close() }
})
