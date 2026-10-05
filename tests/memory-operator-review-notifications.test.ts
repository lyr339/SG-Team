import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamMemoryService } from '../src/application/team-memory-service'
import { MemoryReviewCoordinator } from '../src/application/memory-review-coordinator'
import { connectMemoryIssueNotifications } from '../src/application/notifications/memory-issue-notifications'
import { notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
import { connectOperatorMessageNotifications } from '../src/application/notifications/team-message-notifications'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

function fixture(path?: string, channels = ['1']) {
  const directory = path ? undefined : mkdtempSync(join(tmpdir(), 'sg-memory-operator-')),
    business = path ?? join(directory!, 'business.sqlite')
  const repository = new SqliteTeamControlRepository(business),
    memoryRepository = new SqliteTeamMemoryRepository(business),
    messages = new SqliteTeamCollaborationRepository(business)
  const frame: DesktopSnapshot = {
    connection: {
      state: 'connected',
      endpoint: 'fixture',
      attempt: 0,
      lastError: ''
    },
    sessions: [],
    conversations: {},
    protocolIssues: [],
    updatedAt: 1
  }
  const sent = vi.fn(() => ({ commandId: 'fixture' })),
    control = new TeamControlService(repository, {
      getSnapshot: () => frame,
      subscribe: () => () => {},
      sendMessage: sent
    })
  const team = control.createSessionPool({
    workspaceId: 'operator-workspace',
    workspaceName: 'fixture',
    workspacePath: '/fixture-no-cursor',
    members: channels.map((channelId) => ({
      channelId,
      roleTemplateKey: 'solo',
      avatarId: 'lead',
      skills: [],
      solo: true
    }))
  })
  const memory = new TeamMemoryService(memoryRepository, control),
    h = notificationSourceHarness(),
    source = connectMemoryIssueNotifications(
      memory,
      () => {
        throw Error('no additional context read')
      },
      h.owner
    )
  const errors = vi.fn(),
    coordinator = new MemoryReviewCoordinator(memory, control, messages, errors, Date.now, source)
  const propose = (title: string, actor: 'agent' | 'operator' = 'agent') =>
    memoryRepository.propose({
      workspaceId: team.activeWorkspaceId!,
      runId: team.activeRun!.id,
      scope: 'run',
      kind: 'fact',
      title,
      content: 'original confidential body not copied to ledger',
      proposedBy:
        actor === 'operator' ? { type: 'operator' } : { type: 'agent', slotId: team.members[0]!.slot.id },
      sources: [{ type: 'file', ref: 'src/private.ts', label: 'private' }],
      clientProposalId: `operator-${title}`
    })
  const close = async () => {
    coordinator.stop()
    await source.close()
    await h.owner.close()
    memory.dispose()
    control.dispose()
    messages.close()
    memoryRepository.close()
    repository.close()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
  return {
    directory,
    business,
    repository,
    memoryRepository,
    messages,
    control,
    team,
    memory,
    h,
    source,
    errors,
    coordinator,
    propose,
    close,
    sent
  }
}
describe('an original operator escalation is not a generic proposed-item notification', () => {
  it('ordinary proposals stay quiet; only the coordinator actual operator return creates one actionable lifecycle and the original request count is unchanged', async () => {
    const f = fixture(),
      create = vi.spyOn(f.messages, 'createMessage')
    try {
      const ordinary = f.propose('ordinary')
      f.memory.getSnapshot()
      await f.source.source.flush()
      expect(f.h.ledger.page().summary.total).toBe(0)
      const userProposal = f.propose('human-authored', 'operator')
      f.coordinator.reconcile()
      await f.source.source.flush()
      await f.h.owner.flush()
      expect(create).toHaveBeenCalledOnce()
      expect(f.h.ledger.page().summary).toMatchObject({
        total: 1,
        pending: 1,
        unread: 1
      })
      const row = f.h.ledger.page().records[0]!
      expect(row).toMatchObject({
        eventType: 'memory.issue',
        subjectState: 'operator-review',
        scope: { memoryId: ordinary.id },
        target: { kind: 'memory', memoryId: ordinary.id }
      })
      expect(f.h.ledger.page().records.some((row) => row.scope.memoryId === userProposal.id)).toBe(false)
      const message = f.messages.loadRun(f.team.activeRun!.id).messages[create.mock.results[0]!.value.id]!
      const receipt = JSON.stringify(message.receipt)
      await f.h.owner.read(row.id, row.revision)
      expect(f.h.ledger.page().summary.pending).toBe(1)
      expect(JSON.stringify(f.messages.loadRun(f.team.activeRun!.id).messages[message.id]?.receipt)).toBe(
        receipt
      )
      const commits = vi.mocked(f.h.port.commitSource).mock.calls.length
      f.coordinator.reconcile()
      await f.source.source.flush()
      expect(create).toHaveBeenCalledTimes(2)
      expect(vi.mocked(f.h.port.commitSource).mock.calls.length).toBe(commits)
      expect(f.messages.loadRun(f.team.activeRun!.id).messageOrder).toHaveLength(1)
      expect(f.memory.getSnapshot().items[ordinary.id]?.status).toBe('proposed')
      expect(f.sent).not.toHaveBeenCalled()
      expect(JSON.stringify(f.h.ledger.page())).not.toContain('original confidential')
      expect(JSON.stringify(f.h.ledger.page())).not.toContain('src/private.ts')
      f.memory.review(ordinary.id, 'reject', 'actual human note', ordinary.version)
      await f.source.source.flush()
      expect(f.h.ledger.page().records[0]).toMatchObject({
        id: row.id,
        subjectState: 'rejected',
        state: 'resolved'
      })
      expect(f.h.ledger.page().summary.pending).toBe(0)
      expect(JSON.stringify(f.h.ledger.page())).not.toContain('actual human note')
    } finally {
      await f.close()
    }
  })
  it('notification observer failure cannot create a second request or turn a successful original request into adoption/error handling', async () => {
    const f = fixture(),
      create = vi.spyOn(f.messages, 'createMessage')
    try {
      const item = f.propose('observer-failure'),
        observer = {
          observeOperatorReview: vi.fn(() => {
            throw Error('display unavailable')
          })
        }
      const coordinator = new MemoryReviewCoordinator(
        f.memory,
        f.control,
        f.messages,
        f.errors,
        Date.now,
        observer
      )
      coordinator.reconcile()
      expect(create).toHaveBeenCalledOnce()
      expect(observer.observeOperatorReview).toHaveBeenCalledOnce()
      expect(f.errors).not.toHaveBeenCalled()
      expect(f.memory.getSnapshot().items[item.id]?.status).toBe('proposed')
    } finally {
      await f.close()
    }
  })
  it('failed original escalation never publishes a fabricated human-request success', async () => {
    const f = fixture()
    try {
      f.propose('original-failure')
      vi.spyOn(f.messages, 'createMessage').mockImplementationOnce(() => {
        throw Error('business store unavailable')
      })
      f.coordinator.reconcile()
      await f.source.source.flush()
      expect(f.errors).toHaveBeenCalledOnce()
      expect(f.h.ledger.page().summary.total).toBe(0)
    } finally {
      await f.close()
    }
  })
  it('an actual timeout escalates only after the original deadline, alongside its original reviewer request, without a second unread generic notice', async () => {
    const f = fixture(undefined, ['1', '2']),
      create = vi.spyOn(f.messages, 'createMessage')
    try {
      f.repository.createGroup({
        runId: f.team.activeRun!.id,
        name: 'fixture review group',
        members: f.team.members.map((member, index) => ({
          slotId: member.slot.id,
          roleTemplateKey: index ? 'reviewer' : 'builder'
        })),
        leadSlotId: f.team.members[0]!.slot.id,
        at: 1
      })
      const team = f.control.getSnapshot()
      const bound = (member: (typeof team.members)[number]) => ({
        ...member,
        binding: {
          ...notificationTeam().bindings[0]!,
          workspaceId: team.activeWorkspaceId!,
          runId: team.activeRun!.id,
          slotId: member.slot.id,
          channelId: member.slot.channelId!
        }
      })
      team.members = team.members.map(bound)
      team.groups = team.groups.map((view) => ({
        ...view,
        members: view.members.map(bound)
      }))
      const teamSource = { getSnapshot: () => team, subscribe: () => () => {} }
      const item = f.propose('deadline'),
        onTime = new MemoryReviewCoordinator(
          f.memory,
          teamSource,
          f.messages,
          f.errors,
          () => item.createdAt + 1,
          f.source
        )
      onTime.reconcile()
      await f.source.source.flush()
      expect(create).toHaveBeenCalledOnce()
      expect(f.h.ledger.page().summary.total).toBe(0)
      const late = new MemoryReviewCoordinator(
        f.memory,
        teamSource,
        f.messages,
        f.errors,
        () => item.createdAt + 31 * 60_000,
        f.source
      )
      late.reconcile()
      await f.source.source.flush()
      expect(create).toHaveBeenCalledTimes(3)
      const proof = f.source.operatorReviewProof({
        workspaceId: item.workspaceId,
        runId: item.runId,
        memoryId: item.id,
        version: item.version,
        groupId: item.groupId
      })!
      expect(proof.reason).toBe('timeout')
      expect(f.messages.loadRun(item.runId).messageOrder).toHaveLength(2)
      expect(f.h.ledger.page().summary).toMatchObject({ pending: 1, unread: 1 })
      const generic = connectOperatorMessageNotifications(
        {
          subscribe: (fn) => {
            fn(f.messages.loadRun(item.runId))
            return () => {}
          }
        },
        () => team,
        f.h.owner
      )
      try {
        await generic.source.flush()
        expect(f.h.ledger.page().summary).toMatchObject({
          total: 2,
          pending: 1,
          unread: 1
        })
        expect(f.h.ledger.page({ eventType: 'team.operator-message' }).records[0]?.attention).toBe('activity')
      } finally {
        await generic.close()
      }
      expect(f.memory.getSnapshot().items[item.id]?.status).toBe('proposed')
      expect(f.sent).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
})

describe('original competing reviewers cannot be overwritten by a delayed operator action', () => {
  it('returns the original committed conclusion even if its ensuing observation read fails; legacy service behavior is not replaced', async () => {
    const f = fixture()
    try {
      const item = f.propose('known-conclusion'),
        load = f.memoryRepository.load.bind(f.memoryRepository)
      const spy = vi.spyOn(f.memoryRepository, 'load').mockImplementation((...args) => {
        const snapshot = load(...args)
        if (snapshot.items[item.id]?.status === 'accepted') throw Error('post-commit display source failed')
        return snapshot
      })
      try {
        expect(
          f.memory.review(item.id, 'accept', 'known note', item.version, {
            workspaceId: item.workspaceId,
            runId: item.runId
          })
        ).toMatchObject({ status: 'accepted', reviewNote: 'known note' })
      } finally {
        spy.mockRestore()
      }
      expect(f.memory.getSnapshot().items[item.id]?.status).toBe('accepted')
      expect(
        f.memoryRepository
          .load(item.workspaceId, item.runId)
          .events.filter((event) => event.type === 'memory.accepted')
      ).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
  it('rechecks proposed/version under BEGIN IMMEDIATE, preserving a peer review that committed before lock acquisition', async () => {
    const f = fixture(),
      peer = new SqliteTeamMemoryRepository(f.business)
    try {
      const item = f.propose('transaction-race'),
        database = Reflect.get(f.memoryRepository, 'database') as import('node:sqlite').DatabaseSync,
        exec = database.exec.bind(database)
      let injected = false
      const spy = vi.spyOn(database, 'exec').mockImplementation((sql) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true
          peer.review({
            memoryId: item.id,
            decision: 'reject',
            reviewer: { type: 'operator' },
            note: 'peer conclusion'
          })
        }
        exec(sql)
      })
      try {
        expect(() => f.memory.review(item.id, 'accept', 'late conclusion', item.version)).toThrow('待确认')
        const result = f.memoryRepository.load(f.team.activeWorkspaceId!, f.team.activeRun!.id).items[
          item.id
        ]!
        expect(result).toMatchObject({
          status: 'rejected',
          reviewNote: 'peer conclusion'
        })
        expect(
          f.memoryRepository
            .load(f.team.activeWorkspaceId!, f.team.activeRun!.id)
            .events.filter((event) => event.type === 'memory.accepted')
        ).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    } finally {
      peer.close()
      await f.close()
    }
  })
  it('a run ended by another process before the original writer lock cannot be reviewed via a saved confirmation', async () => {
    const f = fixture(),
      peer = new SqliteTeamControlRepository(f.business)
    try {
      const item = f.propose('scope-race'),
        database = Reflect.get(f.memoryRepository, 'database') as import('node:sqlite').DatabaseSync,
        exec = database.exec.bind(database)
      let injected = false
      const spy = vi.spyOn(database, 'exec').mockImplementation((sql) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true
          peer.completeRun(f.team.activeRun!.id, Date.now(), 'fixture ends before reviewer lock')
        }
        exec(sql)
      })
      try {
        expect(() =>
          f.memory.review(item.id, 'accept', 'must not persist', item.version, {
            workspaceId: f.team.activeWorkspaceId!,
            runId: f.team.activeRun!.id
          })
        ).toThrow('已结束')
        expect(
          f.memoryRepository.load(f.team.activeWorkspaceId!, f.team.activeRun!.id).items[item.id]?.status
        ).toBe('proposed')
      } finally {
        spy.mockRestore()
      }
    } finally {
      peer.close()
      await f.close()
    }
  })
})
