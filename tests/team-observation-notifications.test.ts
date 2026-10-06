import { describe, expect, it, vi } from 'vitest'
import { connectGroupTopologyNotifications } from '../src/application/notifications/group-topology-notifications'
import { connectMemoryIssueNotifications } from '../src/application/notifications/memory-issue-notifications'
import { notificationTeam, notificationSourceHarness } from './notification-source-fixtures'
import { emptyTeamMemorySnapshot, type TeamMemoryItem, type TeamMemoryReadObservation } from '../src/domain/team-memory'
import type { TeamControlSnapshot } from '../src/domain/team-control'
import type { NotificationPush } from '../src/domain/notification'
import { TeamMemoryService } from '../src/application/team-memory-service'

const memoryItem = (patch: Partial<TeamMemoryItem> = {}): TeamMemoryItem => ({
  id: 'proposal',
  workspaceId: 'workspace-a',
  runId: 'run-a',
  scope: 'run',
  kind: 'decision',
  title: '接口边界约束',
  content: 'private full body never copied to ledger',
  status: 'proposed',
  version: 2,
  proposedBy: { type: 'agent', slotId: 'slot-a' },
  sources: [{ type: 'file', ref: 'private-source.ts', label: 'source' }],
  createdAt: 1,
  updatedAt: 2,
  ...patch
})
function memoryFixture() {
  const h = notificationSourceHarness(),
    team = notificationTeam(),
    listeners = new Set<(fact: TeamMemoryReadObservation) => void>()
  const source = connectMemoryIssueNotifications(
    {
      subscribeReadObservation: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
    },
    () => team,
    h.owner
  )
  const emit = (proposal: TeamMemoryItem, parent?: TeamMemoryItem, revision = 1) => {
    const snapshot = emptyTeamMemorySnapshot(team.activeWorkspaceId, team.activeRun?.id)
    snapshot.revision = revision
    snapshot.items = { proposal, ...(parent ? { [parent.id]: parent } : {}) }
    snapshot.itemOrder = Object.keys(snapshot.items)
    listeners.forEach((fn) => fn({ kind: 'snapshot', snapshot }))
  }
  return { h, team, listeners, source, emit }
}
describe('quiet group topology observes the actual relation, not guessed side effects', () => {
  it('captures create/membership/effective lead/planning/dissolve without runtime noise or extra queries', async () => {
    const h = notificationSourceHarness(),
      team = notificationTeam(),
      events: NotificationPush[] = []
    h.owner.subscribe((e) => events.push(e))
    let emit!: (value: TeamControlSnapshot) => void
    const detach = vi.fn()
    const connection = connectGroupTopologyNotifications(
      {
        subscribe: (fn) => {
          emit = fn
          fn(team)
          return detach
        }
      },
      h.owner
    )
    try {
      await connection.source.flush()
      const member = { ...team.members[0]!, slot: { ...team.members[0]!.slot, groupId: 'group-a', solo: false } }
      const group = {
        id: 'group-a',
        runId: 'run-a',
        name: '接口协作',
        goal: 'private goal never copied',
        status: 'active' as const,
        leadSlotId: member.slot.id,
        planPolicy: 'any_member' as const,
        createdAt: 1,
        updatedAt: 1
      }
      const updated = {
        ...team,
        revision: 2,
        members: [member],
        groups: [{ group, members: [member], effectiveLeadSlotId: member.slot.id, attention: false }]
      }
      emit(updated)
      await connection.source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 0 })
      const count = vi.mocked(h.port.commitSource).mock.calls.length
      emit({ ...updated, revision: 3 })
      await connection.source.flush()
      expect(vi.mocked(h.port.commitSource).mock.calls.length).toBe(count)
      const flat = {
        ...updated,
        revision: 4,
        groups: [{ ...updated.groups[0]!, group: { ...group, leadSlotId: undefined }, effectiveLeadSlotId: undefined }]
      }
      emit(flat)
      await connection.source.flush()
      expect(h.ledger.page().records[0]?.detail).toContain('组内成员可规划任务')
      const stale = { ...updated, revision: 3 }
      emit(stale)
      await connection.source.flush()
      expect(h.ledger.page().records[0]?.detail).toContain('组内成员可规划任务')
      emit({ ...flat, revision: 5, groups: [] })
      await connection.source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe('active')
      emit({ ...flat, revision: 6, groups: [{ ...flat.groups[0]!, group: { ...flat.groups[0]!.group, status: 'dissolved' }, members: [] }] })
      await connection.source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe('dissolved')
      expect(h.ledger.page().records[0]?.detail).toContain('不证明所有成员通知已投递')
      expect(events.some((e) => e.announcement)).toBe(false)
      expect(JSON.stringify(h.ledger.page())).not.toContain('private goal')
    } finally {
      await connection.close()
      expect(detach).toHaveBeenCalledOnce()
      await h.owner.close()
    }
  })
})
describe('shared memory conflict facts and source reads', () => {
  it('normal proposals/acceptance do not flood history; positive stale-predecessor conflict stays actionable until a real terminal result', async () => {
    const f = memoryFixture(),
      events: NotificationPush[] = []
    f.h.owner.subscribe((e) => events.push(e))
    try {
      f.emit(memoryItem())
      await f.source.source.flush()
      expect(f.h.ledger.page().summary.total).toBe(0)
      const parent = memoryItem({ id: 'prior', version: 1, status: 'accepted', supersedesId: undefined })
      f.emit(memoryItem({ supersedesId: 'prior' }), parent, 2)
      await f.source.source.flush()
      expect(f.h.ledger.page().summary.total).toBe(0)
      f.emit(memoryItem({ supersedesId: 'prior' }), { ...parent, status: 'superseded', supersededById: 'other-new' }, 3)
      await f.source.source.flush()
      expect(f.h.ledger.page().summary).toMatchObject({ total: 1, pending: 1, unread: 1 })
      const record = f.h.ledger.page().records[0]!
      expect(events.filter((e) => e.announcement)).toHaveLength(1)
      await f.h.owner.read(record.id, record.revision)
      expect(f.h.ledger.page().summary.pending).toBe(1)
      f.listeners.forEach((fn) => fn({ kind: 'unavailable', workspaceId: 'workspace-a', runId: 'run-a' }))
      await f.source.source.flush()
      expect(f.h.ledger.page().records[0]?.subjectState).toBe('unconfirmed')
      f.emit(memoryItem({ supersedesId: 'prior' }), { ...parent, status: 'superseded', supersededById: 'other-new' }, 3)
      await f.source.source.flush()
      expect(events.filter((e) => e.announcement)).toHaveLength(1)
      f.emit(memoryItem({ status: 'rejected', supersedesId: 'prior' }), { ...parent, status: 'superseded', supersededById: 'other-new' }, 4)
      await f.source.source.flush()
      expect(f.h.ledger.page().records[0]).toMatchObject({ id: record.id, subjectState: 'rejected', state: 'resolved' })
      expect(f.h.ledger.page().summary.pending).toBe(0)
      expect(JSON.stringify(f.h.ledger.page())).not.toContain('private full body')
      expect(JSON.stringify(f.h.ledger.page())).not.toContain('private-source.ts')
    } finally {
      await f.source.close()
      await f.h.owner.close()
    }
  })
  it('observer failure cannot repeat/replace an existing memory read or swallow its original storage failure', () => {
    const team = notificationTeam(),
      snapshot = emptyTeamMemorySnapshot('workspace-a', 'run-a'),
      load = vi.fn(() => snapshot)
    const service = new TeamMemoryService({ revision: () => 0, load } as never, { getSnapshot: () => team, subscribe: () => () => {} })
    const facts = vi.fn(() => {
      throw Error('broken observer')
    })
    service.subscribeReadObservation(facts)
    expect(service.getSnapshot()).toBe(snapshot)
    expect(load).toHaveBeenCalledOnce()
    expect(facts).toHaveBeenCalledOnce()
    const failure = Error('original database failure')
    load.mockImplementationOnce(() => {
      throw failure
    })
    expect(() => service.getSnapshot()).toThrow(failure)
    expect(load).toHaveBeenCalledTimes(2)
    expect(facts).toHaveBeenLastCalledWith({ kind: 'unavailable', workspaceId: 'workspace-a', runId: 'run-a', context:team })
    service.dispose()
  })
  it('a new run/workspace or missing item cannot resolve the old proposal; actual completed scope expires without claiming acceptance', async () => {
    const f = memoryFixture()
    try {
      f.emit(memoryItem({ supersedesId: 'prior' }), memoryItem({ id: 'prior', version: 1, status: 'superseded' }))
      await f.source.source.flush()
      const id = f.h.ledger.page().records[0]!.id
      f.emit(memoryItem({ workspaceId: 'elsewhere' }), undefined, 2)
      await f.source.source.flush()
      expect(f.h.ledger.page().records[0]?.state).toBe('active')
      f.team.activeRun!.status = 'completed'
      f.emit(memoryItem({ supersedesId: 'prior' }), memoryItem({ id: 'prior', version: 1, status: 'superseded' }), 3)
      await f.source.source.flush()
      expect(f.h.ledger.page().records[0]).toMatchObject({ id, state: 'expired', subjectState: 'expired' })
      expect(f.h.ledger.page().records[0]?.detail).toContain('不等于提案已采纳')
    } finally {
      await f.source.close()
      await f.h.owner.close()
    }
  })
})

describe('shared memory observation follows the real existing repository read path', () => {
  it('a competing revision becomes a real prerequisite conflict and closes only after the original reject commits, with one load per original read', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs'),
      { tmpdir } = await import('node:os'),
      { join } = await import('node:path')
    const { SqliteTeamControlRepository } = await import('../src/infrastructure/team-control/sqlite-team-control-repository')
    const { SqliteTeamMemoryRepository } = await import('../src/infrastructure/team-memory/sqlite-team-memory-repository')
    const { TeamControlService } = await import('../src/application/team-control-service')
    const root = mkdtempSync(join(tmpdir(), 'sg-memory-read-observation-')),
      path = join(root, 'business.sqlite')
    const repository = new SqliteTeamControlRepository(path),
      memory = new SqliteTeamMemoryRepository(path)
    const frame = {
      connection: { state: 'connected' as const, endpoint: 'fixture', attempt: 0, lastError: '' },
      sessions: [],
      conversations: {},
      protocolIssues: [],
      updatedAt: 1
    }
    const control = new TeamControlService(repository, {
      getSnapshot: () => frame,
      subscribe: () => () => {},
      sendMessage: () => ({ commandId: 'fixture' })
    })
    let team = control.createSessionPool({
      workspaceId: 'native-test',
      workspaceName: 'native-test',
      workspacePath: '/fixture-no-cursor',
      members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true }]
    })
    const stopTeam = control.subscribe((value) => {
        team = value
      }),
      service = new TeamMemoryService(memory, { getSnapshot: () => team, subscribe: () => () => {} })
    const h = notificationSourceHarness(),
      observer = connectMemoryIssueNotifications(service, () => { throw Error('must use the context already read by the original service') }, h.owner),
      load = vi.spyOn(memory, 'load')
    const propose = (title: string, supersedesId?: string) =>
      memory.propose({
        workspaceId: team.activeWorkspaceId!,
        runId: team.activeRun!.id,
        scope: 'run',
        kind: 'decision',
        title,
        content: 'this original body must remain outside notification history',
        proposedBy: { type: 'operator' },
        sources: [{ type: 'file', ref: 'src/source.ts', label: 'source' }],
        clientProposalId: `fixture-${title}`,
        ...(supersedesId ? { supersedesId } : {})
      })
    try {
      expect(load).not.toHaveBeenCalled()
      service.getSnapshot()
      await observer.source.flush()
      expect(load).toHaveBeenCalledOnce()
      const base = propose('base')
      memory.review({ memoryId: base.id, decision: 'accept', reviewer: { type: 'operator' } })
      const first = propose('first', base.id),
        second = propose('second', base.id)
      service.getSnapshot()
      await observer.source.flush()
      expect(h.ledger.page().summary.total).toBe(0)
      memory.review({ memoryId: first.id, decision: 'accept', reviewer: { type: 'operator' } })
      const count = load.mock.calls.length
      service.getSnapshot()
      await observer.source.flush()
      expect(load.mock.calls.length).toBe(count + 1)
      expect(h.ledger.page().summary.pending).toBe(1)
      expect(h.ledger.page().records[0]?.scope.memoryId).toBe(second.id)
      expect(() => memory.review({ memoryId: second.id, decision: 'accept', reviewer: { type: 'operator' } })).toThrow('状态已经变化')
      expect(h.ledger.page().summary.pending).toBe(1)
      service.review(second.id, 'reject')
      await observer.source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe('rejected')
      expect(h.ledger.page().summary.pending).toBe(0)
      expect(JSON.stringify(h.ledger.page())).not.toContain('this original body')
      expect(Object.keys(service.getSnapshot().items)).toHaveLength(3)
    } finally {
      await observer.close()
      await h.owner.close()
      service.dispose()
      stopTeam()
      control.dispose()
      memory.close()
      repository.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('unchanged native memory reads stay cheap without hiding unknown private commits',()=>{
  it('reuses thin facts across metadata-identical reads, but reloads an atomic checkpoint after a lost commit acknowledgement',async()=>{
    const f=memoryFixture(),snapshot=emptyTeamMemorySnapshot('workspace-a','run-a'),item=memoryItem({supersedesId:'prior'}),parent=memoryItem({id:'prior',version:1,status:'superseded'})
    snapshot.revision=3;snapshot.itemOrder=[item.id,parent.id];let reads=0
    Object.defineProperty(snapshot.items,item.id,{enumerable:true,get:()=>{reads++;return item}});snapshot.items[parent.id]=parent
    const original=vi.mocked(f.h.port.commitSource).getMockImplementation()!
    vi.mocked(f.h.port.commitSource).mockImplementationOnce(async(...args)=>{await original(...args);throw Error('private acknowledgement lost')})
    try{
      f.listeners.forEach(fn=>fn({kind:'snapshot',snapshot}));await f.source.source.flush()
      expect(f.h.ledger.page().summary.pending).toBe(1)
      for(let i=0;i<20;i++)f.listeners.forEach(fn=>fn({kind:'snapshot',snapshot}))
      // Equal revision is not an immutability proof. Each original read checks
      // thin row metadata once, while reusing derived facts and private writes.
      await f.source.source.flush();expect(reads).toBe(21);expect(f.h.ledger.page().summary.total).toBe(1)
      const sourceCommits=vi.mocked(f.h.port.commitSource).mock.calls.filter(call=>call[0].startsWith('memory-issues:'))
      expect(sourceCommits).toHaveLength(1);expect(f.h.owner.status().historyIncomplete).toBe(true)
    }finally{await f.source.close();await f.h.owner.close()}
  })
})
