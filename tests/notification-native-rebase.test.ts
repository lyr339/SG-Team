import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { TaskPoolService } from '../src/application/task-pool-service'
import { transactTaskPool } from '../src/application/task-pool-transaction'
import { connectTaskNotifications } from '../src/application/notifications/task-notifications'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { vacuumDatabaseInto } from '../src/infrastructure/app-update/update-backup'
import { connectGroupTopologyNotifications } from '../src/application/notifications/group-topology-notifications'
import { connectMemoryIssueNotifications } from '../src/application/notifications/memory-issue-notifications'
import { notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import type { NotificationPush } from '../src/domain/notification'
import type { TeamMemoryReadObservation } from '../src/domain/team-memory'
import { NativeReadOrder } from '../src/application/notifications/native-read-order'
import { readMemoryIssueState } from '../src/domain/memory-issue-notification'
import { readGroupTopologyState } from '../src/domain/group-topology-notification'

const bridgeFrame: DesktopSnapshot = {
  connection: { state: 'connected', endpoint: 'fixture', attempt: 0, lastError: '' },
  sessions: [],
  conversations: {},
  protocolIssues: [],
  updatedAt: 1
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sg-native-rebase-')),
    path = join(directory, 'business.sqlite'),
    ledgerPath = join(directory, 'notifications.sqlite')
  const bridge = { getSnapshot: () => bridgeFrame, subscribe: () => () => {}, sendMessage: vi.fn(() => ({ commandId: 'fixture' })) }
  const start = () => {
    const repository = new SqliteTeamControlRepository(path),
      memoryRepository = new SqliteTeamMemoryRepository(path),
      control = new TeamControlService(repository, bridge)
    const memory = new TeamMemoryService(memoryRepository, control),
      h = notificationSourceHarness(ledgerPath),
      events: NotificationPush[] = []
    h.owner.subscribe((value) => events.push(value))
    const groups = connectGroupTopologyNotifications(control, h.owner),
      memorySource = connectMemoryIssueNotifications(
        memory,
        () => {
          throw Error('observer must not query another source')
        },
        h.owner
      )
    const flush = async () => {
      await groups.source.flush()
      await memorySource.source.flush()
      await h.owner.flush()
    }
    const close = async () => {
      await groups.close()
      await memorySource.close()
      await h.owner.close()
      memory.dispose()
      control.dispose()
      memoryRepository.close()
      repository.close()
    }
    return { repository, memoryRepository, control, memory, h, events, groups, memorySource, flush, close }
  }
  return { directory, path, ledgerPath, start, bridge }
}
describe('real business backup restoration with a preserved private notification ledger', () => {
  it('reprojects lower native revisions from the current service reads, preserves old facts, reopens restored actionable conflict quietly, and never runs a business replay', async () => {
    const f = fixture()
    let active = f.start()
    try {
      const team = active.control.createSessionPool({
        workspaceId: 'restore-workspace',
        workspaceName: 'restore-test',
        workspacePath: '/fixture-no-cursor',
        members: ['1', '2'].map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true }))
      })
      const runId = team.activeRun!.id,
        slots = team.members.map((member) => member.slot.id)
      const created = active.repository.createGroup({
        runId,
        name: '原组',
        members: slots.map((slotId) => ({ slotId, roleTemplateKey: 'builder' })),
        leadSlotId: slots[0],
        at: 10
      })
      active.control.getSnapshot()
      await active.flush()
      const propose = (title: string, supersedesId?: string) =>
        active.memoryRepository.propose({
          workspaceId: 'restore-workspace',
          runId,
          scope: 'run',
          kind: 'decision',
          title,
          content: 'private restored original body',
          proposedBy: { type: 'operator' },
          sources: [{ type: 'file', ref: 'src/fixture.ts', label: 'fixture' }],
          clientProposalId: `restore-${title}`,
          ...(supersedesId ? { supersedesId } : {})
        })
      const parent = propose('parent')
      active.memoryRepository.review({ memoryId: parent.id, decision: 'accept', reviewer: { type: 'operator' } })
      const first = propose('first', parent.id),
        second = propose('second', parent.id)
      active.memoryRepository.review({ memoryId: first.id, decision: 'accept', reviewer: { type: 'operator' } })
      active.memory.getSnapshot()
      await active.flush()
      expect(active.h.ledger.page({ memoryId: second.id }).summary.pending).toBe(1)
      const backup = join(f.directory, 'before.sqlite')
      vacuumDatabaseInto(f.path, backup)
      active.memory.review(second.id, 'reject')
      await active.flush()
      const oldRecord = active.h.ledger.page({ memoryId: second.id }).records[0]!
      expect(oldRecord.subjectState).toBe('rejected')
      await active.h.owner.read(oldRecord.id, oldRecord.revision)
      await active.h.owner.clearRead({ key: oldRecord.key })
      active.repository.setGroupLead({ groupId: created.group.id, slotId: slots[1]!, at: 20 })
      active.control.getSnapshot()
      await active.flush()
      active.repository.dissolveGroup({ groupId: created.group.id, at: 30 })
      const newer = active.repository.createGroup({
        runId,
        name: '回滚后不在原数据的组',
        members: [{ slotId: slots[0]!, roleTemplateKey: 'builder' }],
        at: 40
      })
      active.control.getSnapshot()
      await active.flush()
      const head = active.control.getSnapshot().revision,
        nativeRevision = active.memoryRepository.revision()
      const deliveriesBefore = active.events.filter((event) => event.announcement).length
      await active.close()
      copyFileSync(backup, f.path)
      active = f.start()
      const restored = active.control.getSnapshot()
      expect(restored.revision).toBeLessThan(head)
      expect(active.memoryRepository.revision()).toBeLessThan(nativeRevision)
      active.memory.getSnapshot()
      await active.flush()
      const restoredIssue = active.h.ledger.page({ memoryId: second.id }).records[0]!
      expect(restoredIssue).toMatchObject({ subjectState: 'conflict', attention: 'action', state: 'active' })
      expect(restoredIssue.detail).toContain('先前提醒状态：已驳回')
      expect(active.h.ledger.page({ eventType: 'memory.rebase' }).summary.total).toBe(1)
      const groups = active.h.ledger.page({ eventType: 'group.topology' }).records
      expect(groups.find((row) => row.scope.groupId === created.group.id)).toMatchObject({ subjectState: 'active', state: 'resolved' })
      expect(groups.find((row) => row.scope.groupId === newer.group.id)).toMatchObject({ subjectState: 'prior-data', state: 'expired' })
      expect(active.events.some((event) => event.announcement)).toBe(false)
      expect(deliveriesBefore).toBeGreaterThan(0)
      expect(f.bridge.sendMessage).not.toHaveBeenCalled()
      expect(active.memory.getSnapshot().items[second.id]?.status).toBe('proposed')
      const commits = vi.mocked(active.h.port.commitSource).mock.calls.length
      for (let i = 0; i < 20; i++) {
        active.control.getSnapshot()
        active.memory.getSnapshot()
      }
      await active.flush()
      expect(vi.mocked(active.h.port.commitSource).mock.calls.length).toBe(commits)
      active.memory.review(second.id, 'reject')
      await active.flush()
      expect(active.h.ledger.page({ memoryId: second.id }).summary.pending).toBe(0)
    } finally {
      await active.close()
      rmSync(f.directory, { recursive: true, force: true })
    }
  })
})
describe('read provenance is ordered evidence, not a larger revision assumption', () => {
  it('accepts only the selected main service owner and increasing read sequence, allowing a lower native revision after a newer real read', () => {
    const order = new NativeReadOrder('expected')
    expect(order.accept({ owner: 'wrong', sequence: 100 })).toBe('stale')
    expect(order.accept({ owner: 'expected', sequence: 1 })).toBe('current')
    expect(order.version('source', 100, true)).toMatchObject({ epoch: 0 })
    expect(order.accept({ owner: 'expected', sequence: 2 })).toBe('current')
    expect(order.version('source', 40, true)).toMatchObject({ epoch: 1, rebaseFrom: 100 })
    expect(order.accept({ owner: 'expected', sequence: 1 })).toBe('stale')
    expect(order.accept({ owner: 'expected', sequence: 2 })).toBe('stale')
    expect(order.accept(undefined)).toBe('stale')
    expect(new NativeReadOrder(undefined).accept(undefined)).toBe('legacy')
  })
  it('an out-of-order memory read cannot revert a later current observation; unverified lower snapshots still do not authorize rebase', async () => {
    const h = notificationSourceHarness(),
      team = notificationTeam()
    let observer!: (value: TeamMemoryReadObservation) => void
    const source = connectMemoryIssueNotifications(
      {
        getReadOwnerId: () => 'fixture-owner',
        subscribeReadObservation: (fn) => {
          observer = fn
          return () => {}
        }
      },
      () => team,
      h.owner
    )
    const input = (revision: number, status: 'rejected' | 'proposed', sequence: number): TeamMemoryReadObservation => ({
      kind: 'snapshot',
      context: team,
      stamp: { owner: 'fixture-owner', sequence },
      snapshot: {
        schemaVersion: 1,
        revision,
        seq: revision,
        workspaceId: 'workspace-a',
        runId: 'run-a',
        items: {
          proposal: {
            id: 'proposal',
            workspaceId: 'workspace-a',
            runId: 'run-a',
            scope: 'run',
            kind: 'decision',
            version: 2,
            title: 'title',
            content: 'not stored',
            status,
            supersedesId: 'prior',
            proposedBy: { type: 'operator' },
            sources: [],
            createdAt: 1,
            updatedAt: 1
          },
          prior: {
            id: 'prior',
            workspaceId: 'workspace-a',
            runId: 'run-a',
            scope: 'run',
            kind: 'decision',
            version: 1,
            title: 'prior',
            content: 'not stored',
            status: 'superseded',
            supersededById: 'other',
            proposedBy: { type: 'operator' },
            sources: [],
            createdAt: 1,
            updatedAt: 1
          }
        },
        itemOrder: ['proposal', 'prior'],
        events: [],
        updatedAt: 1
      }
    })
    try {
      observer(input(20, 'proposed', 1))
      await source.source.flush()
      observer(input(21, 'rejected', 2))
      await source.source.flush()
      observer(input(20, 'proposed', 1))
      await source.source.flush()
      expect(h.ledger.page({ memoryId: 'proposal' }).records[0]?.subjectState).toBe('rejected')
      observer(input(15, 'proposed', 3))
      await source.source.flush()
      expect(h.ledger.page({ memoryId: 'proposal' }).summary.pending).toBe(1)
      expect(h.ledger.page({ eventType: 'memory.rebase' }).summary.total).toBe(1)
      expect(() => readMemoryIssueState({ version: 1, key: 'x', revision: 1, rows: { bad: {} } }, 'x')).toThrow()
      expect(() => readGroupTopologyState({ version: 1, key: 'x', revision: 1, groups: 'bad' }, 'x')).toThrow()
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
})

describe('task results follow the actual restored native repository, not the newer private history', () => {
  it('an earlier queued task supersedes a later cancelled result; absent newer tasks become prior-data, never cancelled or replayed', async () => {
    const f = fixture()
    let active = f.start()
    let repository = new SqliteTaskPoolRepository(f.path),
      tasks = new TaskPoolService(repository, active.control),
      source = connectTaskNotifications(tasks, () => active.control.getSnapshot(), active.h.owner)
    try {
      active.control.createSessionPool({
        workspaceId: 'restore-task',
        workspaceName: 'test',
        workspacePath: '/fixture-no-cursor',
        members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true }]
      })
      const task = tasks.createTask({ title: '备份前任务' })
      await source.source.flush()
      const backup = join(f.directory, 'task-before.sqlite')
      vacuumDatabaseInto(f.path, backup)
      tasks.cancelTask(task.id, 'fixture cancelled later')
      await source.source.flush()
      const later = tasks.createTask({ title: '之后新建的任务', maxAttempts: 1 })
      const runId = active.control.getActiveRunId()!
      const lease = transactTaskPool(repository, (pool) => pool.leaseTask(later.id, { runId, agentSessionId: 'fixture-agent', capabilities: [] }))
      transactTaskPool(repository, (pool) => pool.failAttempt(lease.attempt.id, lease.leaseToken, 'fixture final failure'))
      tasks.getSnapshot()
      await source.source.flush()
      expect(active.h.ledger.page({ key: `task:${later.id}` }).records[0]?.subjectState).toBe('failed')
      const originalLoad = vi.spyOn(repository, 'load'),
        count = originalLoad.mock.calls.length
      tasks.getSnapshot()
      await source.source.flush()
      expect(originalLoad.mock.calls.length).toBe(count + 1)
      await source.close()
      tasks.stopWatcher()
      tasks.stopSweeper()
      repository.close()
      await active.close()
      copyFileSync(backup, f.path)
      active = f.start()
      repository = new SqliteTaskPoolRepository(f.path)
      tasks = new TaskPoolService(repository, active.control)
      source = connectTaskNotifications(tasks, () => active.control.getSnapshot(), active.h.owner)
      const restored = tasks.getSnapshot()
      expect(restored.tasks[task.id]?.status).toBe('queued')
      expect(restored.tasks[later.id]).toBeUndefined()
      await source.source.flush()
      await active.h.owner.flush()
      expect(active.h.ledger.page({ key: `task:${task.id}` }).records[0]?.subjectState).toBe('queued')
      expect(active.h.ledger.page({ key: `task:${later.id}` }).records[0]).toMatchObject({ subjectState: 'prior-data', state: 'expired' })
      expect(active.h.ledger.page({ eventType: 'task.rebase' }).summary.total).toBe(1)
      expect(active.events.some((event) => event.announcement)).toBe(false)
      expect(f.bridge.sendMessage).not.toHaveBeenCalled()
      expect(repository.load().attempts).toEqual({})
      const reads = vi.spyOn(repository, 'load'),
        commits = vi.mocked(active.h.port.commitSource).mock.calls.length
      for (let i = 0; i < 10; i++) tasks.getSnapshot()
      await source.source.flush()
      expect(reads).toHaveBeenCalledTimes(10)
      expect(vi.mocked(active.h.port.commitSource).mock.calls.length).toBe(commits)
    } finally {
      await source.close()
      tasks.stopWatcher()
      tasks.stopSweeper()
      repository.close()
      await active.close()
      rmSync(f.directory, { recursive: true, force: true })
    }
  })
})

describe('bounded rebase progress and negative boundary evidence', () => {
  it('rebase of hundreds of absent prior memory issues and groups stays atomic in 100-row batches without mutating the old checkpoint', async () => {
    const { reduceMemoryIssueNotifications } = await import('../src/domain/memory-issue-notification')
    const { reduceGroupTopologyNotifications } = await import('../src/domain/group-topology-notification')
    const ids = Array.from({ length: 240 }, (_, i) => i.toString(16).padStart(64, '0'))
    let memory: ReturnType<typeof reduceMemoryIssueNotifications>['state'] | undefined,
      groups: ReturnType<typeof reduceGroupTopologyNotifications>['state'] | undefined
    const memoryInput = {
      key: 'memory-issues:' + 'a'.repeat(64),
      revision: 100,
      currentRead: true,
      readOwner: 'before',
      readEpoch: 0,
      now: 1000,
      facts: ids.map((identity) => ({
        identity,
        id: identity,
        version: 1,
        title: 'thin fact',
        state: 'conflict' as const,
        scope: { workspaceId: 'w', runId: 'r' },
        ceased: false
      }))
    }
    const groupInput = {
      key: 'group-topology:' + 'b'.repeat(64),
      revision: 100,
      currentRead: true,
      readOwner: 'before',
      readEpoch: 0,
      workspaceId: 'w',
      runId: 'r',
      now: 1000,
      facts: ids.map((identity) => ({ id: identity, identity, name: '原组', status: 'active' as const, planning: 'members' as const, members: [] }))
    }
    for (let pass = 0; pass < 4; pass++) {
      const m = reduceMemoryIssueNotifications(memory, memoryInput, false, pass + 1)
      memory = m.state
      const g = reduceGroupTopologyNotifications(groups, groupInput, false, pass + 1)
      groups = g.state
      if (m.complete && g.complete) break
    }
    let memoryCount = 0,
      groupCount = 0,
      passes = 0
    for (;;) {
      const oldM = JSON.stringify(memory),
        oldG = JSON.stringify(groups)
      const m = reduceMemoryIssueNotifications(memory, { ...memoryInput, revision: 50, readOwner: 'after', facts: [] }, true, 10 + passes)
      const g = reduceGroupTopologyNotifications(groups, { ...groupInput, revision: 50, readOwner: 'after', facts: [] }, true, 10 + passes)
      expect(JSON.stringify(memory)).toBe(oldM)
      expect(JSON.stringify(groups)).toBe(oldG)
      expect(m.drafts.length).toBeLessThanOrEqual(100)
      expect(g.drafts.length).toBeLessThanOrEqual(100)
      expect(m.drafts.every((draft) => !draft.announce)).toBe(true)
      expect(g.drafts.every((draft) => !draft.announce)).toBe(true)
      memoryCount += m.drafts.filter((draft) => draft.eventType === 'memory.issue').length
      groupCount += g.drafts.filter((draft) => draft.eventType === 'group.topology').length
      memory = m.state
      groups = g.state
      passes++
      expect(passes).toBeLessThan(10)
      if (m.complete && g.complete) break
    }
    expect(memoryCount).toBe(240)
    expect(groupCount).toBe(240)
    expect(passes).toBe(3)
    expect(memory!.rebases).toBe(1)
    expect(groups!.rebases).toBe(1)
    expect(memory!.pendingRebase).toBeUndefined()
    expect(groups!.pendingRebase).toBeUndefined()
    expect(Object.values(memory!.rows).every((row) => row.priorData)).toBe(true)
    expect(() => readMemoryIssueState({ ...memory, pendingRebase: { from: 100, to: 50, missing: ['unknown'] } }, memory!.key)).toThrow('进度')
    expect(() => readGroupTopologyState({ ...groups, priorData: ['unknown'] }, groups!.key)).toThrow('标记')
  })
  it('ordinary metadata growth with equal semantic facts does not persist per-heartbeat native versions; only a proven later regression wakes rebase', async () => {
    const h = notificationSourceHarness(),
      team = notificationTeam()
    let observe!: (value: TeamMemoryReadObservation) => void
    const source = connectMemoryIssueNotifications(
      {
        getReadOwnerId: () => 'metadata-owner',
        subscribeReadObservation: (fn) => {
          observe = fn
          return () => {}
        }
      },
      () => team,
      h.owner
    )
    const snapshot = {
      schemaVersion: 1 as const,
      revision: 1,
      seq: 1,
      workspaceId: 'workspace-a',
      runId: 'run-a',
      items: {},
      itemOrder: [],
      events: [],
      updatedAt: 1
    }
    try {
      observe({ kind: 'snapshot', snapshot, context: team, stamp: { owner: 'metadata-owner', sequence: 1 } })
      await source.source.flush()
      const commits = vi.mocked(h.port.commitSource).mock.calls.length
      for (let i = 2; i <= 101; i++)
        observe({ kind: 'snapshot', snapshot: { ...snapshot, revision: i, seq: i }, context: team, stamp: { owner: 'metadata-owner', sequence: i } })
      await source.source.flush()
      expect(vi.mocked(h.port.commitSource).mock.calls.length).toBe(commits)
      observe({
        kind: 'snapshot',
        snapshot: { ...snapshot, revision: 50, seq: 50 },
        context: team,
        stamp: { owner: 'metadata-owner', sequence: 102 }
      })
      await source.source.flush()
      expect(h.ledger.page({ eventType: 'memory.rebase' }).summary.total).toBe(1)
      expect(h.ledger.page({ eventType: 'memory.rebase' }).records[0]?.detail).toContain('101 → 50')
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
})

describe('rebase uncertainty and progress durability', () => {
  it('a lost private acknowledgement after a confirmed native reset is audited from its CAS checkpoint, not duplicated or replayed', async () => {
    const h = notificationSourceHarness(),
      team = notificationTeam()
    let observe!: (value: TeamMemoryReadObservation) => void
    const source = connectMemoryIssueNotifications(
      {
        getReadOwnerId: () => 'ack-owner',
        subscribeReadObservation: (fn) => {
          observe = fn
          return () => {}
        }
      },
      () => team,
      h.owner
    )
    const snapshot = {
      schemaVersion: 1 as const,
      revision: 1,
      seq: 1,
      workspaceId: 'workspace-a',
      runId: 'run-a',
      items: {},
      itemOrder: [],
      events: [],
      updatedAt: 1
    }
    try {
      observe({ kind: 'snapshot', snapshot, context: team, stamp: { owner: 'ack-owner', sequence: 1 } })
      await source.source.flush()
      observe({ kind: 'snapshot', snapshot: { ...snapshot, revision: 101 }, context: team, stamp: { owner: 'ack-owner', sequence: 2 } })
      await source.source.flush()
      const original = vi.mocked(h.port.commitSource).getMockImplementation()!
      vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => {
        await original(...args)
        throw Error('ack lost after rebase CAS committed')
      })
      observe({ kind: 'snapshot', snapshot: { ...snapshot, revision: 40 }, context: team, stamp: { owner: 'ack-owner', sequence: 3 } })
      await source.source.flush()
      expect(h.ledger.page({ eventType: 'memory.rebase' }).summary.total).toBe(1)
      observe({ kind: 'snapshot', snapshot: { ...snapshot, revision: 200 }, context: team, stamp: { owner: 'ack-owner', sequence: 4 } })
      await source.source.flush()
      await h.owner.flush()
      expect(h.ledger.page({ eventType: 'memory.rebase' }).summary.total).toBe(1)
      expect(h.ledger.page({ eventType: 'memory.rebase' }).records[0]?.detail).toContain('101 → 40')
      const committed = vi.mocked(h.port.commitSource).mock.calls.filter((call) => call[3].some((draft) => draft.eventType === 'memory.rebase'))
      expect(committed).toHaveLength(1)
      expect(h.owner.status().historyIncomplete).toBe(true)
    } finally {
      await source.close()
      await h.owner.close()
    }
  })
})
