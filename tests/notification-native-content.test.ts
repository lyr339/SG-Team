import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { TaskPoolService } from '../src/application/task-pool-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { connectGroupTopologyNotifications } from '../src/application/notifications/group-topology-notifications'
import { connectMemoryIssueNotifications } from '../src/application/notifications/memory-issue-notifications'
import { connectTaskNotifications } from '../src/application/notifications/task-notifications'
import { notificationFrame, notificationSourceHarness } from './notification-source-fixtures'
import { NativeReadOrder } from '../src/application/notifications/native-read-order'
import type { TeamControlReadObservation, TeamControlSnapshot } from '../src/domain/team-control'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sg-native-content-')), path = join(directory, 'business.sqlite')
  const controlRepository = new SqliteTeamControlRepository(path), memoryRepository = new SqliteTeamMemoryRepository(path), tasksRepository = new SqliteTaskPoolRepository(path)
  const frame = notificationFrame({ sessions: [], conversations: {} }), bridge = { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: vi.fn(() => ({ commandId: 'fixture' })) }
  const control = new TeamControlService(controlRepository, bridge), memory = new TeamMemoryService(memoryRepository, control), tasks = new TaskPoolService(tasksRepository, control)
  const h = notificationSourceHarness(join(directory, 'notifications.sqlite')), events: any[] = []; h.owner.subscribe(event => events.push(event))
  const memorySource = connectMemoryIssueNotifications(memory, () => { throw Error('must reuse original memory read context') }, h.owner)
  const groups = connectGroupTopologyNotifications(control, h.owner), taskSource = connectTaskNotifications(tasks, () => control.getSnapshot(), h.owner)
  const flush = async () => { await groups.source.flush(); await memorySource.source.flush(); await taskSource.source.flush(); await h.owner.flush() }
  return { directory, path, controlRepository, memoryRepository, tasksRepository, control, memory, tasks, h, events, memorySource, groups, taskSource, flush,
    close: async () => { await Promise.all([groups.close(), memorySource.close(), taskSource.close()]); await h.owner.close(); memory.dispose(); control.dispose(); tasks.stopWatcher(); tasks.stopSweeper();
      memoryRepository.close(); controlRepository.close(); tasksRepository.close(); rmSync(directory, { recursive: true, force: true }) } }
}
function pool(f: ReturnType<typeof fixture>) {
  return f.control.createSessionPool({ workspaceId: 'content-workspace', workspaceName: 'fixture', workspacePath: '/fixture-no-cursor',
    members: ['1', '2'].map(channelId => ({ channelId, roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true })) })
}

it('original memory reads with equal revision but different actual SQLite rows bypass old revision caches, quietly rebase missing facts and never replay a review', async () => {
  const f = fixture(); let database: DatabaseSync | undefined
  try {
    const team = pool(f), runId = team.activeRun!.id
    const propose = (title: string, supersedesId?: string) => f.memoryRepository.propose({ workspaceId: 'content-workspace', runId, scope: 'run', kind: 'decision', title,
      content: 'PRIVATE full memory body not copied to checkpoint', proposedBy: { type: 'operator' }, sources: [{ type: 'file', ref: 'src/fixture', label: 'fixture' }], clientProposalId: `content-${title}`,
      ...(supersedesId ? { supersedesId } : {}) })
    const parent = propose('parent'); f.memoryRepository.review({ memoryId: parent.id, decision: 'accept', reviewer: { type: 'operator' } })
    const first = propose('first', parent.id), second = propose('second', parent.id)
    f.memoryRepository.review({ memoryId: first.id, decision: 'accept', reviewer: { type: 'operator' } })
    const before = f.memory.getSnapshot(); await f.flush()
    const original = f.h.ledger.page({ memoryId: second.id }).records[0]!
    expect(original.subjectState).toBe('conflict')
    database = new DatabaseSync(f.path)
    database.prepare("UPDATE team_memory_items SET status='rejected',updated_at=updated_at+1 WHERE id=?").run(second.id)
    const load = vi.spyOn(f.memoryRepository, 'load'), review = vi.spyOn(f.memoryRepository, 'review')
    const changed = f.memory.getSnapshot(); await f.flush()
    expect(changed.revision).toBe(before.revision); expect(load).toHaveBeenCalledOnce(); expect(review).not.toHaveBeenCalled()
    expect(f.h.ledger.page({ memoryId: second.id }).records[0]).toMatchObject({ id: original.id, subjectState: 'rejected', state: 'resolved' })
    const summary = f.h.ledger.page({ eventType: 'memory.rebase' }).records[0]!
    expect(summary.title).toBe('相同修订号下的记忆数据已变化'); expect(summary.detail).toContain('先前')
    const total = f.h.ledger.page().summary.total, announced = f.events.filter(event => event.announcement).length
    f.memory.getSnapshot(); await f.flush(); expect(f.h.ledger.page().summary.total).toBe(total); expect(f.events.filter(event => event.announcement)).toHaveLength(announced)
    database.prepare('DELETE FROM team_memory_items WHERE id=?').run(second.id)
    f.memory.getSnapshot(); await f.flush()
    expect(f.h.ledger.page({ memoryId: second.id }).records[0]).toMatchObject({ subjectState: 'prior-data', state: 'expired' })
    expect(JSON.stringify(f.h.ledger.page())).not.toContain('PRIVATE full memory body')
  } finally { database?.close(); vi.restoreAllMocks(); await f.close() }
})

it('original complete task reads detect equal-revision content replacement, preserve prior reminders and do not execute a task transition', async () => {
  const f = fixture(); let database: DatabaseSync | undefined
  try {
    pool(f)
    const task = f.tasks.createTask({ title: 'Original task' }); f.tasks.cancelTask(task.id, 'fixture cancellation')
    const before = f.tasks.getSnapshot(); await f.flush()
    const original = f.h.ledger.page({ key: `task:${task.id}` }).records[0]!
    database = new DatabaseSync(f.path)
    database.prepare("UPDATE tasks SET status='failed',failure_reason='restored fixture result',updated_at=updated_at+1 WHERE id=?").run(task.id)
    const load = vi.spyOn(f.tasksRepository, 'load'), cancel = vi.spyOn(f.tasks, 'cancelTask')
    const changed = f.tasks.getSnapshot(); await f.flush()
    expect(changed.revision).toBe(before.revision); expect(load).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled()
    expect(f.h.ledger.page({ key: `task:${task.id}` }).records[0]).toMatchObject({ id: original.id, subjectState: 'failed', state: 'active' })
    expect(f.h.ledger.page({ eventType: 'task.rebase' }).records[0]?.title).toBe('相同修订号下的任务数据已变化')
    const firstFailure = f.h.ledger.page({ key: `task:${task.id}` }).records[0]!
    database.prepare("UPDATE tasks SET failure_reason='a different current failure',updated_at=updated_at+1 WHERE id=?").run(task.id)
    f.tasks.getSnapshot(); await f.flush()
    const secondFailure = f.h.ledger.page({ key: `task:${task.id}` }).records[0]!
    expect(secondFailure.eventId).not.toBe(firstFailure.eventId)
    expect(secondFailure.detail).toContain('a different current failure')
    await f.h.owner.read(secondFailure.id, firstFailure.revision)
    expect(f.h.ledger.page({ key: `task:${task.id}` }).summary.unread).toBe(1)
    database.prepare('DELETE FROM tasks WHERE id=?').run(task.id)
    f.tasks.getSnapshot(); await f.flush()
    expect(f.h.ledger.page({ key: `task:${task.id}` }).records[0]).toMatchObject({ subjectState: 'prior-data', state: 'expired' })
    expect(f.events.filter(event => event.announcement)).toHaveLength(0)
  } finally { database?.close(); vi.restoreAllMocks(); await f.close() }
})

it('returned same-revision topology projections are compared by actual contents, while runtime-only effective lead changes are not native data restore evidence', async () => {
  const f = fixture()
  let subscription!: (value: TeamControlReadObservation) => void
  const native = { getReadOwnerId: () => 'fixture-owner', subscribe: () => () => {}, subscribeReadObservation: (listener: typeof subscription) => { subscription = listener; return () => {} } }
  const source = connectGroupTopologyNotifications(native, f.h.owner)
  try {
    const initial = pool(f), runId = initial.activeRun!.id
    const group = f.controlRepository.createGroup({ runId, name: 'Native group', members: initial.members.map(member => ({ slotId: member.slot.id, roleTemplateKey: 'builder' })), leadSlotId: initial.members[0]!.slot.id, at: 1 }).group
    const snapshot = f.control.getSnapshot()
    const emit = (value: TeamControlSnapshot, sequence: number) => subscription({ snapshot: value, stamp: { owner: 'fixture-owner', sequence } })
    emit(snapshot, 1); await source.source.flush()
    const runtimeOnly = structuredClone(snapshot); runtimeOnly.groups[0]!.effectiveLeadSlotId = undefined
    emit(runtimeOnly, 2); await source.source.flush()
    expect(f.h.ledger.page({ eventType: 'group.rebase' }).summary.total).toBe(0)
    const changed = structuredClone(runtimeOnly); changed.groups[0]!.group.name = 'Native group returned differently'
    emit(changed, 3); await source.source.flush()
    expect(changed.revision).toBe(snapshot.revision)
    const record = f.h.ledger.page({ eventType: 'group.topology' }).records.find(record => record.scope.groupId === group.id)!
    expect(record.source).toContain('returned differently')
    expect(f.h.ledger.page({ eventType: 'group.rebase' }).records[0]?.title).toBe('相同修订号下的组关系数据已变化')
    const absent = { ...changed, groups: [] }; emit(absent, 4); await source.source.flush()
    expect(f.h.ledger.page({ eventType: 'group.topology' }).records.find(record => record.scope.groupId === group.id)?.subjectState).toBe('prior-data')
    const total = f.h.ledger.page().summary.total; emit(absent, 5); await source.source.flush(); expect(f.h.ledger.page().summary.total).toBe(total)
  } finally { await source.close(); await f.close() }
})

it('an ordered actual content fingerprint can invalidate equal native revisions; stale/legacy reads and observation-time echoes cannot', () => {
  const order = new NativeReadOrder('source-owner'), first = '1'.repeat(64), second = '2'.repeat(64)
  expect(order.accept({ owner: 'source-owner', sequence: 1 })).toBe('current')
  expect(order.version('source', 5, true, first)).toMatchObject({ epoch: 0 })
  expect(order.accept({ owner: 'source-owner', sequence: 2 })).toBe('current')
  expect(order.version('source', 5, true, second)).toMatchObject({ epoch: 1, rebaseFrom: 5, rebaseTo: 5 })
  expect(order.version('source', 5, true, second)).toMatchObject({ epoch: 1 })
  expect(order.accept({ owner: 'source-owner', sequence: 1 })).toBe('stale')
  expect(order.version('legacy', 5, false, second)).toEqual({ epoch: 0 })
  expect(() => order.version('source', 5, true, 'PRIVATE invalid fingerprint')).toThrow()
})
