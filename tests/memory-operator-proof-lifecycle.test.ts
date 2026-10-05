import { describe, expect, it, vi } from 'vitest'
import { connectMemoryIssueNotifications } from '../src/application/notifications/memory-issue-notifications'
import type { MemoryOperatorReviewObservation } from '../src/domain/memory-operator-review'
import {
  emptyTeamMemorySnapshot,
  type TeamMemoryItem,
  type TeamMemoryReadObservation
} from '../src/domain/team-memory'
import { notificationSourceHarness, notificationTeam } from './notification-source-fixtures'

function fixture() {
  const h = notificationSourceHarness(),
    team = notificationTeam()
  let listener!: (value: TeamMemoryReadObservation) => void,
    sequence = 0
  const memory = {
    getReadOwnerId: () => 'original-memory-owner',
    subscribeReadObservation: (fn: typeof listener) => {
      listener = fn
      return () => {}
    }
  }
  const connect = () =>
    connectMemoryIssueNotifications(
      memory,
      () => {
        throw Error('no added source queries')
      },
      h.owner
    )
  let source = connect()
  const item: TeamMemoryItem = {
    id: 'm',
    workspaceId: 'workspace-a',
    runId: 'run-a',
    scope: 'run',
    kind: 'decision',
    title: 'Original title',
    content: 'private body',
    status: 'proposed',
    version: 1,
    proposedBy: { type: 'agent', slotId: 'slot-a' },
    sources: [],
    createdAt: 1,
    updatedAt: 1
  }
  const request = {
    workspaceId: item.workspaceId,
    runId: item.runId,
    memoryId: item.id,
    version: item.version
  }
  const proof: MemoryOperatorReviewObservation = {
    ...request,
    memoryVersion: item.version,
    title: item.title,
    proof: {
      messageId: 'original-request',
      createdAt: Date.now(),
      reason: 'no-reviewer'
    }
  }
  const emit = (
    revision = 1,
    patch: Partial<TeamMemoryItem> = {},
    context = team,
    owner = memory.getReadOwnerId(),
    seq = ++sequence
  ) => {
    const snapshot = emptyTeamMemorySnapshot(context.activeWorkspaceId, context.activeRun?.id)
    snapshot.revision = revision
    if (context.activeRun) {
      snapshot.items.m = { ...item, ...patch }
      snapshot.itemOrder = ['m']
    }
    listener({
      kind: 'snapshot',
      snapshot,
      context,
      stamp: { owner, sequence: seq }
    })
  }
  return {
    h,
    team,
    item,
    request,
    proof,
    emit,
    get source() {
      return source
    },
    unavailable: () =>
      listener({
        kind: 'unavailable',
        workspaceId: item.workspaceId,
        runId: item.runId,
        context: team
      }),
    restart: async () => {
      await source.close()
      source = connect()
    },
    close: async () => {
      await source.close()
      await h.owner.close()
    }
  }
}
describe('manual-request evidence is bounded to the current original memory reads', () => {
  it('even a higher-revision same-item/version group change cannot carry the old scope receipt into the new group', async () => {
    const f = fixture()
    f.team.groups = ['original', 'other'].map((id) => ({
      group: {
        id,
        runId: f.item.runId,
        name: id,
        goal: '',
        status: 'active',
        planPolicy: 'any_member',
        createdAt: 1,
        updatedAt: 1
      },
      members: [],
      attention: false
    }))
    try {
      f.emit(1, { groupId: 'original' })
      f.source.observeOperatorReview({ ...f.proof, groupId: 'original' })
      await f.source.source.flush()
      expect(f.source.operatorReviewProof({ ...f.request, groupId: 'original' })).toBeDefined()
      f.emit(2, { groupId: 'other' })
      await f.source.source.flush()
      expect(f.source.operatorReviewProof({ ...f.request, groupId: 'original' })).toBeUndefined()
      expect(f.source.operatorReviewProof({ ...f.request, groupId: 'other' })).toBeUndefined()
      expect(f.h.ledger.page().records[0]?.subjectState).toBe('operator-unconfirmed')
    } finally {
      await f.close()
    }
  })
  it('a different actually returned original request renews the same item once, while duplicate receipts do not re-notify', async () => {
    const f = fixture()
    try {
      f.emit()
      f.source.observeOperatorReview(f.proof)
      await f.source.source.flush()
      const first = f.h.ledger.page().records[0]!
      await f.h.owner.read(first.id, first.revision)
      const second = { ...f.proof, proof: { ...f.proof.proof, messageId: 'different-original-request' } }
      f.source.observeOperatorReview(second)
      await f.source.source.flush()
      const next = f.h.ledger.page().records[0]!
      expect(next.id).toBe(first.id)
      expect(next.eventId).not.toBe(first.eventId)
      expect(f.h.ledger.page().summary.unread).toBe(1)
      await f.h.owner.read(next.id, next.revision)
      f.source.observeOperatorReview(second)
      await f.source.source.flush()
      expect(f.h.ledger.page().summary).toMatchObject({ total: 1, pending: 1, unread: 0 })
      expect(f.h.ledger.page().records[0]?.revision).toBe(next.revision)
    } finally {
      await f.close()
    }
  })
  it('an unconfirmed/missing group withdraws its receipt without falsely completing the proposal; a later confirmed terminal item still resolves it', async () => {
    const f = fixture(),
      groupId = 'group-a',
      request = { ...f.request, groupId }
    f.team.groups = [
      {
        group: {
          id: groupId,
          runId: f.item.runId,
          name: 'original group',
          goal: '',
          status: 'active',
          planPolicy: 'any_member',
          createdAt: 1,
          updatedAt: 1
        },
        members: [],
        attention: false
      }
    ]
    try {
      f.emit(1, { groupId })
      f.source.observeOperatorReview({ ...f.proof, groupId })
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(request)).toBeDefined()
      f.team.groups = []
      f.emit(1, { groupId })
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(request)).toBeUndefined()
      expect(f.h.ledger.page({ memoryId: f.item.id }).records[0]?.subjectState).toBe('operator-unconfirmed')
      f.source.observeOperatorReview({ ...f.proof, groupId })
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(request)).toBeUndefined()
      f.emit(2, { groupId, status: 'accepted' })
      await f.source.source.flush()
      expect(f.h.ledger.page({ memoryId: f.item.id }).records[0]).toMatchObject({
        subjectState: 'accepted',
        state: 'resolved'
      })
    } finally {
      await f.close()
    }
  })
  it('rejects extra body/credential fields in a source proof instead of persisting them under thin metadata', async () => {
    const f = fixture()
    try {
      f.emit()
      f.source.observeOperatorReview({
        ...f.proof,
        proof: { ...f.proof.proof, body: 'private accidental payload' } as never
      })
      await f.source.source.flush()
      expect(f.h.ledger.page().summary.total).toBe(0)
      expect(f.source.operatorReviewProof(f.request)).toBeUndefined()
      expect(JSON.stringify(f.h.ledger.page())).not.toContain('private accidental payload')
    } finally {
      await f.close()
    }
  })
  it('does not trust stale owners, foreign groups or different versions; a confirmed terminal/scope end retracts proof without changing the original item', async () => {
    const f = fixture()
    try {
      f.emit()
      await f.source.source.flush()
      f.source.observeOperatorReview({ ...f.proof, groupId: 'foreign' })
      f.source.observeOperatorReview({ ...f.proof, memoryVersion: 2 })
      await f.source.source.flush()
      expect(f.h.ledger.page().summary.total).toBe(0)
      f.source.observeOperatorReview(f.proof)
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)?.messageId).toBe('original-request')
      f.emit(0, {}, { ...f.team, activeWorkspaceId: undefined, activeRun: undefined }, 'foreign-owner')
      expect(f.source.operatorReviewProof(f.request)).toBeDefined()
      f.emit(2, { status: 'rejected' })
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)).toBeUndefined()
      expect(f.h.ledger.page().records[0]).toMatchObject({
        subjectState: 'rejected',
        state: 'resolved'
      })
      expect(f.item.status).toBe('proposed')
    } finally {
      await f.close()
    }
  })
  it('source unavailability withdraws the live proof; an equal-revision reread alone cannot certify the original message again', async () => {
    const f = fixture()
    try {
      f.emit()
      f.source.observeOperatorReview(f.proof)
      await f.source.source.flush()
      f.unavailable()
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)).toBeUndefined()
      expect(f.h.ledger.page().records[0]).toMatchObject({
        subjectState: 'operator-unconfirmed',
        state: 'active'
      })
      f.source.observeOperatorReview(f.proof)
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)).toBeUndefined()
      f.emit()
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)).toBeUndefined()
      f.source.observeOperatorReview(f.proof)
      await f.source.source.flush()
      expect(f.h.ledger.page().summary).toMatchObject({
        total: 1,
        pending: 1,
        unread: 1
      })
      expect(f.h.ledger.page().records[0]?.subjectState).toBe('operator-review')
    } finally {
      await f.close()
    }
  })
  it('a real current-read revision regression invalidates newer receipts even when the restored memory identity/version is the same', async () => {
    const f = fixture()
    try {
      f.emit(20)
      f.source.observeOperatorReview(f.proof)
      await f.source.source.flush()
      const row = f.h.ledger.page().records[0]!
      await f.h.owner.read(row.id, row.revision)
      f.emit(4)
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)).toBeUndefined()
      expect(f.h.ledger.page({ memoryId: f.item.id }).records[0]).toMatchObject({
        id: row.id,
        subjectState: 'operator-unconfirmed'
      })
      expect(f.h.ledger.page({ memoryId: f.item.id }).summary.unread).toBe(0)
      // Only the original coordinator create/duplicate result can reconfirm it.
      f.source.observeOperatorReview(f.proof)
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)).toBeDefined()
      expect(f.h.ledger.page({ memoryId: f.item.id }).summary.unread).toBe(0)
      expect(
        vi
          .mocked(f.h.port.commitSource)
          .mock.calls.slice(-2)
          .flatMap((call) => call[3])
          .every((draft) => !draft.announce)
      ).toBe(true)
    } finally {
      await f.close()
    }
  })
  it('switching away, returning, and restarting never turns retained history into a current proof or replays its alert', async () => {
    const f = fixture()
    try {
      f.emit()
      f.source.observeOperatorReview(f.proof)
      await f.source.source.flush()
      const row = f.h.ledger.page().records[0]!
      await f.h.owner.read(row.id, row.revision)
      f.emit(1, {}, { ...f.team, activeWorkspaceId: undefined, activeRun: undefined })
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)).toBeUndefined()
      expect(f.h.ledger.page().records[0]?.subjectState).toBe('operator-unconfirmed')
      f.emit()
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)).toBeUndefined()
      f.source.observeOperatorReview(f.proof)
      await f.source.source.flush()
      await f.restart()
      f.emit()
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)).toBeUndefined()
      expect(f.h.ledger.page().records[0]?.subjectState).toBe('operator-unconfirmed')
      f.source.observeOperatorReview({
        ...f.proof,
        proof: { ...f.proof.proof, createdAt: 1 }
      })
      await f.source.source.flush()
      expect(f.source.operatorReviewProof(f.request)?.live).toBe(false)
      expect(f.h.ledger.page().summary).toMatchObject({
        total: 1,
        pending: 1,
        unread: 0
      })
      expect(
        vi
          .mocked(f.h.port.commitSource)
          .mock.calls.at(-1)?.[3]
          .every((draft) => !draft.announce)
      ).toBe(true)
    } finally {
      await f.close()
    }
  })
  it.each([true, false])(
    'a repeated original receipt reconciles an unknown private write ACK (committed = %s) rather than getting stuck behind an in-memory proof dedup',
    async (committed) => {
      const f = fixture()
      try {
        f.emit()
        await f.source.source.flush()
        const originalCommit = f.h.port.commitSource.bind(f.h.port)
        vi.mocked(f.h.port.commitSource).mockImplementationOnce(async (...args) => {
          if (committed) await originalCommit(...args)
          throw Error('unknown ACK, do not retry blindly')
        })
        f.source.observeOperatorReview(f.proof)
        await f.source.source.flush()
        expect(f.h.ledger.page({ memoryId: f.item.id }).summary.total).toBe(committed ? 1 : 0)
        const calls = vi.mocked(f.h.port.sourceState).mock.calls.length
        // This test intentionally does not emit a memory heartbeat in between.
        f.source.observeOperatorReview(f.proof)
        await f.source.source.flush()
        expect(vi.mocked(f.h.port.sourceState).mock.calls.length).toBeGreaterThan(calls)
        expect(f.h.ledger.page({ memoryId: f.item.id }).summary).toMatchObject({
          total: 1,
          pending: 1,
          unread: 1
        })
        f.source.observeOperatorReview(f.proof)
        await f.source.source.flush()
        expect(f.h.ledger.page({ memoryId: f.item.id }).summary.total).toBe(1)
      } finally {
        await f.close()
      }
    }
  )
})
