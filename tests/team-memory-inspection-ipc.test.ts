import { describe, expect, it, vi } from 'vitest'
import { registerTeamMemoryInspectionIpc } from '../src/main/register-team-memory-inspection-ipc'
import { IPC } from '../src/shared/desktop-api'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import { emptyTeamMemorySnapshot } from '../src/domain/team-memory'
const { handlers, trusted } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  trusted: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (event: unknown, input: unknown) => unknown) => handlers.set(name, fn),
    removeHandler: (name: string) => handlers.delete(name)
  }
}))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: trusted }))
describe('explicit memory source inspection remains read-only and scope fenced', () => {
  it('validates source identity before reading, strips no original record fields, and cannot review/propose through the read-only inspect call', () => {
    trusted.mockReset()
    handlers.clear()
    const team = {
      ...emptyTeamControlSnapshot(),
      activeWorkspaceId: 'w',
      activeRun: {
        id: 'r',
        workspaceId: 'w',
        name: '',
        goal: '',
        templateId: 'independent-session-v1',
        status: 'running' as const,
        createdAt: 1,
        updatedAt: 1
      }
    }
    const snapshot = emptyTeamMemorySnapshot('w', 'r')
    snapshot.items.m = {
      id: 'm',
      workspaceId: 'w',
      runId: 'r',
      scope: 'run',
      kind: 'fact',
      title: 't',
      content: 'original body',
      status: 'proposed',
      version: 2,
      proposedBy: { type: 'operator' },
      sources: [],
      createdAt: 1,
      updatedAt: 1
    }
    const getSnapshot = vi.fn(() => snapshot),
      review = vi.fn(),
      dispose = registerTeamMemoryInspectionIpc(
        { getSnapshot, review } as never,
        () => team,
        () => undefined
      )
    try {
      const invoke = (input: unknown) => handlers.get(IPC.teamMemoryInspect)!({}, input)
      expect(
        invoke({
          workspaceId: 'w',
          runId: 'r',
          memoryId: 'm',
          version: 2,
          action: 'accept'
        })
      ).toMatchObject({
        item: { id: 'm', content: 'original body' }
      })
      expect(getSnapshot).toHaveBeenCalledOnce()
      expect(review).not.toHaveBeenCalled()
      expect([...handlers.keys()]).toEqual([IPC.teamMemoryInspect, IPC.teamMemoryReview])
      expect(() => invoke({ workspaceId: 'other', runId: 'r', memoryId: 'm', version: 2 })).toThrow('范围')
      expect(getSnapshot).toHaveBeenCalledOnce()
      expect(() => invoke({ workspaceId: 'w', runId: 'r', memoryId: 'm', version: 3 })).toThrow('范围')
      expect(review).not.toHaveBeenCalled()
      trusted.mockImplementationOnce(() => {
        throw Error('untrusted')
      })
      expect(() => invoke({ workspaceId: 'w', runId: 'r', memoryId: 'm', version: 2 })).toThrow('untrusted')
    } finally {
      dispose()
      expect(handlers.size).toBe(0)
    }
  })
})

describe('operator review is a separately confirmed original-service command', () => {
  it('read-only view and unconfirmed/foreign/wrong-version calls cannot invoke review; a valid action calls the original service once with atomic scope/version expectations', () => {
    trusted.mockReset()
    handlers.clear()
    const team = {
      ...emptyTeamControlSnapshot(),
      activeWorkspaceId: 'w',
      activeRun: {
        id: 'r',
        workspaceId: 'w',
        name: '',
        goal: '',
        templateId: 'independent-session-v1',
        status: 'running' as const,
        createdAt: 1,
        updatedAt: 1
      }
    }
    const snapshot = emptyTeamMemorySnapshot('w', 'r')
    snapshot.items.m = {
      id: 'm',
      workspaceId: 'w',
      runId: 'r',
      scope: 'run',
      kind: 'fact',
      title: 't',
      content: 'original body',
      status: 'proposed',
      version: 2,
      proposedBy: { type: 'operator' },
      sources: [],
      createdAt: 1,
      updatedAt: 1
    }
    const getSnapshot = vi.fn(() => snapshot),
      review = vi.fn((id, decision, note) => {
        snapshot.items[id] = {
          ...snapshot.items[id]!,
          status: decision === 'accept' ? 'accepted' : 'rejected',
          reviewNote: note
        }
        return snapshot.items[id]!
      })
    const dispose = registerTeamMemoryInspectionIpc(
      { getSnapshot, review },
      () => team,
      () => undefined
    )
    const invoke = (input: unknown) => handlers.get(IPC.teamMemoryReview)!({}, input)
    const request = {
      workspaceId: 'w',
      runId: 'r',
      memoryId: 'm',
      version: 2,
      decision: 'accept',
      confirmed: true,
      note: 'input note never belongs to notifications'
    }
    try {
      handlers.get(IPC.teamMemoryInspect)!({}, request)
      expect(review).not.toHaveBeenCalled()
      for (const input of [
        { ...request, confirmed: false },
        { ...request, workspaceId: 'other' },
        { ...request, version: 1 },
        { ...request, decision: 'force-accept' }
      ])
        expect(() => invoke(input)).toThrow()
      expect(review).not.toHaveBeenCalled()
      expect(invoke(request)).toMatchObject({
        inspection: { item: { id: 'm', status: 'accepted' }, canReview: false }
      })
      expect(review).toHaveBeenCalledExactlyOnceWith('m', 'accept', request.note, 2, {
        workspaceId: 'w',
        runId: 'r'
      })
      trusted.mockImplementationOnce(() => {
        throw Error('untrusted')
      })
      expect(() => invoke(request)).toThrow('untrusted')
      expect(review).toHaveBeenCalledOnce()
    } finally {
      dispose()
    }
  })
  it('a known original conclusion plus failed post-read is partial refresh, not a failed review or an automatic retry', () => {
    trusted.mockReset()
    handlers.clear()
    const team = {
      ...emptyTeamControlSnapshot(),
      activeWorkspaceId: 'w',
      activeRun: {
        id: 'r',
        workspaceId: 'w',
        name: '',
        goal: '',
        templateId: 'independent-session-v1',
        status: 'running' as const,
        createdAt: 1,
        updatedAt: 1
      }
    }
    const snapshot = emptyTeamMemorySnapshot('w', 'r')
    snapshot.items.m = {
      id: 'm',
      workspaceId: 'w',
      runId: 'r',
      scope: 'run',
      kind: 'fact',
      title: 't',
      content: 'body',
      status: 'proposed',
      version: 1,
      proposedBy: { type: 'operator' },
      sources: [],
      createdAt: 1,
      updatedAt: 1
    }
    const getSnapshot = vi.fn(() => snapshot),
      review = vi.fn(() => ({
        ...snapshot.items.m!,
        status: 'accepted' as const
      })),
      finish = vi.fn(() => ({ key: 'fixture-reference' }))
    getSnapshot
      .mockImplementationOnce(() => snapshot)
      .mockImplementationOnce(() => {
        throw Error('post-read unavailable')
      })
    const dispose = registerTeamMemoryInspectionIpc(
      { getSnapshot, review },
      () => team,
      () => undefined,
      {
        operations: {
          begin: () => ({
            reference: { key: 'fixture-reference' },
            finish,
            fail: () => ({ key: 'fixture-reference' })
          })
        }
      }
    )
    try {
      expect(
        handlers.get(IPC.teamMemoryReview)!(
          {},
          {
            workspaceId: 'w',
            runId: 'r',
            memoryId: 'm',
            version: 1,
            decision: 'accept',
            confirmed: true
          }
        )
      ).toMatchObject({
        inspectionPending: true,
        inspection: { item: { status: 'accepted' }, canReview: false }
      })
      expect(review).toHaveBeenCalledOnce()
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ state: 'partial' }))
    } finally {
      dispose()
    }
  })
})

it('trusted IPC calls the real isolated review service once; human read/confirmation and post-commit display failure never mutate original Agent receipts or replay review', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path')
  const { SqliteTeamControlRepository } = await import(
    '../src/infrastructure/team-control/sqlite-team-control-repository'
  )
  const { SqliteTeamMemoryRepository } = await import(
    '../src/infrastructure/team-memory/sqlite-team-memory-repository'
  )
  const { SqliteTeamCollaborationRepository } = await import(
    '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
  )
  const { TeamControlService } = await import('../src/application/team-control-service'),
    { TeamMemoryService } = await import('../src/application/team-memory-service')
  const { MemoryReviewCoordinator } = await import('../src/application/memory-review-coordinator')
  const { connectMemoryIssueNotifications } = await import(
    '../src/application/notifications/memory-issue-notifications'
  )
  const { PageOperationNotifications } = await import(
    '../src/application/notifications/page-operation-notifications'
  )
  const { notificationSourceHarness, notificationFrame } = await import('./notification-source-fixtures')
  const directory = mkdtempSync(join(tmpdir(), 'sg-manual-memory-ipc-')),
    path = join(directory, 'business.sqlite')
  const repository = new SqliteTeamControlRepository(path),
    memoryRepository = new SqliteTeamMemoryRepository(path),
    messages = new SqliteTeamCollaborationRepository(path)
  const send = vi.fn(() => ({ commandId: 'fixture-only' })),
    control = new TeamControlService(repository, {
      getSnapshot: () => notificationFrame({ sessions: [] }),
      subscribe: () => () => {},
      sendMessage: send
    })
  const team = control.createSessionPool({
    workspaceId: 'fixture-workspace',
    workspaceName: 'isolated',
    workspacePath: '/fixture-no-cursor',
    members: [
      {
        channelId: '1',
        roleTemplateKey: 'solo',
        avatarId: 'lead',
        skills: [],
        solo: true
      }
    ]
  })
  const memory = new TeamMemoryService(memoryRepository, control),
    h = notificationSourceHarness(),
    source = connectMemoryIssueNotifications(memory, () => control.getSnapshot(), h.owner)
  const operations = new PageOperationNotifications(h.owner),
    coordinator = new MemoryReviewCoordinator(memory, control, messages, () => {}, Date.now, source)
  trusted.mockReset()
  handlers.clear()
  const dispose = registerTeamMemoryInspectionIpc(
    memory,
    () => control.getSnapshot(),
    () => undefined,
    { operatorReviewProof: source.operatorReviewProof, operations }
  )
  const review = vi.spyOn(memory, 'review')
  try {
    const item = memoryRepository.propose({
      workspaceId: team.activeWorkspaceId!,
      runId: team.activeRun!.id,
      scope: 'run',
      kind: 'fact',
      title: 'fixture manual review',
      content: 'private original body only',
      proposedBy: { type: 'agent', slotId: team.members[0]!.slot.id },
      sources: [{ type: 'file', ref: 'src/private.ts', label: 'private' }],
      clientProposalId: 'fixture-proposal'
    })
    coordinator.reconcile()
    await source.source.flush()
    await operations.flush()
    const ref = {
      workspaceId: item.workspaceId,
      runId: item.runId,
      memoryId: item.id,
      version: item.version
    }
    const inspect = (input: unknown) => handlers.get(IPC.teamMemoryInspect)!({}, input),
      write = (input: unknown) => handlers.get(IPC.teamMemoryReview)!({}, input)
    expect(inspect(ref)).toMatchObject({
      canReview: true,
      operatorReview: { reason: 'no-reviewer' }
    })
    const row = h.ledger.page({ memoryId: item.id, eventType: 'memory.issue' }).records[0]!
    await h.owner.read(row.id, row.revision)
    expect(memory.getSnapshot().items[item.id]?.status).toBe('proposed')
    expect(h.ledger.page().summary.pending).toBe(1)
    const receipt = JSON.stringify(messages.loadRun(item.runId).messages)
    const load = memoryRepository.load.bind(memoryRepository)
    const failedRead = vi.spyOn(memoryRepository, 'load').mockImplementation((...args) => {
      const snapshot = load(...args)
      if (snapshot.items[item.id]?.status === 'accepted') throw Error('post-commit display unavailable')
      return snapshot
    })
    try {
      expect(
        write({
          ...ref,
          decision: 'accept',
          confirmed: true,
          note: 'private human note',
          notificationId: 'ab000001-0000-4000-8000-000000000001'
        })
      ).toMatchObject({
        conclusion: 'accepted',
        inspectionPending: true,
        inspection: { item: { status: 'accepted' }, canReview: false }
      })
    } finally {
      failedRead.mockRestore()
    }
    await source.source.flush()
    await operations.flush()
    expect(review).toHaveBeenCalledOnce()
    expect(h.ledger.page({ eventType: 'page.operation.result' }).records[0]?.subjectState).toBe('partial')
    memory.getSnapshot()
    await source.source.flush()
    await h.owner.flush()
    expect(h.ledger.page({ memoryId: item.id, eventType: 'memory.issue' }).records[0]).toMatchObject({
      id: row.id,
      subjectState: 'accepted',
      state: 'resolved'
    })
    expect(JSON.stringify(messages.loadRun(item.runId).messages)).toBe(receipt)
    expect(JSON.stringify(h.ledger.page())).not.toMatch(
      /private original body|private human note|src\/private.ts/
    )
    expect(
      memoryRepository
        .load(item.workspaceId, item.runId)
        .events.filter((event) => event.type === 'memory.accepted')
    ).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()
  } finally {
    dispose()
    coordinator.stop()
    await source.close()
    await operations.flush()
    operations.dispose()
    await h.owner.close()
    memory.dispose()
    control.dispose()
    messages.close()
    memoryRepository.close()
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
