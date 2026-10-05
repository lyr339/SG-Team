import { describe, it, expect, vi } from 'vitest'
import { GroupEffectsNotifications } from '../src/application/notifications/group-effects-notifications'
import { GROUP_EFFECTS_SOURCE_KEY } from '../src/domain/group-effects-notification'
import { groupEffectsKey } from '../src/domain/group-effects'
import { membershipTransferNotification } from '../src/domain/membership-transfer-notification'
import { groupEffectsFixture } from './group-effects-fixtures'

describe('actual group post-transaction facts, not inferred healthy relations', () => {
  it('preserves original reads/effect calls/messages and ordinary successes do not produce success history', async () => {
    const plain = groupEffectsFixture(false),
      seen = groupEffectsFixture(true)
    try {
      const before = vi.spyOn(seen.control, 'getSnapshot'),
        mutation = vi.spyOn(seen.repository, 'createGroup')
      plain.create()
      seen.create()
      await seen.flush()
      expect(mutation).toHaveBeenCalledOnce()
      expect(before).toHaveBeenCalledTimes(2)
      expect(seen.bridge.sent).toEqual(plain.bridge.sent)
      expect(seen.frames.at(-1)).toMatchObject({
        phase: 'completed',
        projection: 'confirmed',
        effects: [
          { kind: 'membership', status: 'queued' },
          { kind: 'membership', status: 'queued' }
        ]
      })
      expect(seen.h.ledger.page().summary.total).toBe(0)
      expect(seen.h.ledger.sourceState(GROUP_EFFECTS_SOURCE_KEY).data).toMatchObject({ rows: {} })
    } finally {
      await plain.close()
      await seen.close()
    }
  })
  it('a rejected original transaction produces no post-transaction observation, notification or side effect', async () => {
    const f = groupEffectsFixture()
    try {
      const error = Object.assign(Error('original rejection'), { code: 'invalid-scope' })
      vi.spyOn(f.repository, 'createGroup').mockImplementation(() => {
        throw error
      })
      expect(() => f.create()).toThrow(error)
      await f.flush()
      expect(f.frames).toHaveLength(0)
      expect(f.bridge.sendMessage).not.toHaveBeenCalled()
      expect(f.h.ledger.page().summary.total).toBe(0)
    } finally {
      await f.close()
    }
  })
  it('create succeeded but queue receipts failed: one diagnostic records actual unconfirmed results, not delivered/success/retry, with no goal or raw error copied', async () => {
    const f = groupEffectsFixture()
    try {
      f.bridge.sendMessage.mockImplementation(() => {
        throw Error('Bearer private-raw-input-error')
      })
      const result = f.create()
      await f.flush()
      expect(result.groups).toHaveLength(1)
      expect(f.bridge.sendMessage).toHaveBeenCalledTimes(2)
      expect(f.errors).toHaveBeenCalledTimes(2)
      expect(f.h.ledger.page().summary).toMatchObject({ total: 1, unread: 1, pending: 0 })
      expect(f.h.ledger.page().records[0]).toMatchObject({
        eventType: 'group.effects',
        subjectState: 'partial',
        tone: 'warning'
      })
      expect(f.frames.at(-1)?.effects.every((effect) => effect.status === 'unconfirmed')).toBe(true)
      expect(
        JSON.stringify(f.h.ledger.page()) + JSON.stringify(f.h.ledger.sourceState(GROUP_EFFECTS_SOURCE_KEY))
      ).not.toMatch(/private original goal|private-raw-input-error|Bearer/)
      const last = f.frames.at(-1)!,
        calls = vi.mocked(f.h.port.commitSource).mock.calls.length
      f.source!.observe(last)
      await f.flush()
      expect(vi.mocked(f.h.port.commitSource).mock.calls.length).toBe(calls)
    } finally {
      await f.close()
    }
  })
  it('post-commit snapshot failure preserves the original exception and zero remaining effects, while recording the actually returned primary relation', async () => {
    const f = groupEffectsFixture(),
      failure = Error('original post-mutation read unavailable')
    try {
      const original = f.control.getSnapshot.bind(f.control)
      vi.spyOn(f.control, 'getSnapshot')
        .mockImplementationOnce(original)
        .mockImplementationOnce(() => {
          throw failure
        })
      expect(() => f.create()).toThrow(failure)
      await f.flush()
      expect(f.repository.loadTeamControl().groups).toHaveLength(1)
      expect(f.bridge.sendMessage).not.toHaveBeenCalled()
      expect(f.frames.at(-1)).toMatchObject({
        primary: 'returned',
        phase: 'interrupted',
        projection: 'unconfirmed',
        effects: []
      })
      expect(f.h.ledger.page().summary.total).toBe(1)
    } finally {
      await f.close()
    }
  })
  it('task/orphan cleanup failures stay fail-soft and do not get told to the lead as no tasks / no messages', async () => {
    const f = groupEffectsFixture()
    try {
      const group = f.create().groups[0]!.group
      const release = vi.spyOn(f.tasks, 'releaseAgentWork').mockImplementationOnce(() => {
        throw Error('private cleanup error')
      })
      const orphan = vi.spyOn(f.messages, 'orphanPendingReceipts').mockImplementationOnce(() => {
        throw Error('private orphan error')
      })
      const result = f.service.removeGroupMember({ groupId: group.id, slotId: f.slots[1]! })
      await f.flush()
      expect(result.groups[0]?.members).toHaveLength(1)
      expect(release).toHaveBeenCalledOnce()
      expect(orphan).toHaveBeenCalledOnce()
      const businessMessages = f.messages.loadRun(f.runId)
      const text = businessMessages.messageOrder
        .map((id) => businessMessages.messages[id]!.content)
        .join('\n')
      expect(text).toContain('原服务未确认任务释放结果')
      expect(text).not.toContain('其名下没有进行中')
      expect(text).toContain('待回应消息收尾结果未确认')
      expect(f.errors).toHaveBeenCalledTimes(2)
      expect(f.frames.at(-1)?.effects.map((effect) => effect.status)).toEqual([
        'unconfirmed',
        'unconfirmed',
        'queued',
        'recorded'
      ])
    } finally {
      await f.close()
    }
  })
  it('a notification observer throwing or mutating its copy cannot retry or change original business messages', async () => {
    const f = groupEffectsFixture()
    try {
      const observe = vi.spyOn(f.observer, 'observe').mockImplementation((frame) => {
        frame.effects.length = 0
        frame.scope.runId = 'foreign'
        throw Error('observer broken')
      })
      expect(f.create().groups).toHaveLength(1)
      expect(f.bridge.sendMessage).toHaveBeenCalledTimes(2)
      expect(f.errors).not.toHaveBeenCalled()
      expect(observe).toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
  it('a throwing original error logger still aborts at the original point and captures missing final effects without swallowing the exception', async () => {
    const f = groupEffectsFixture(),
      failure = Error('original logger exception')
    try {
      f.bridge.sendMessage.mockImplementation(() => {
        throw Error('original send error')
      })
      f.errors.mockImplementation(() => {
        throw failure
      })
      expect(() => f.create()).toThrow(failure)
      await f.flush()
      expect(f.bridge.sendMessage).toHaveBeenCalledOnce()
      expect(f.frames.at(-1)).toMatchObject({
        phase: 'interrupted',
        effects: [{ kind: 'membership', status: 'unconfirmed' }]
      })
    } finally {
      await f.close()
    }
  })
  it('migration preserves the role change and reports cleanup uncertainty in its parent; no second unread is removed without an actually stored matching parent', async () => {
    const f = groupEffectsFixture()
    try {
      const group = f.create().groups[0]!.group
      vi.spyOn(f.tasks, 'releaseAgentWork').mockImplementationOnce(() => {
        throw Error('original release did not confirm')
      })
      const transfer = f.service.transferMembership({
        groupId: group.id,
        fromSlotId: f.slots[1]!,
        toSlotId: f.slots[2]!
      })
      await f.flush()
      expect(
        transfer.groupEffects?.effects.some(
          (effect) => effect.kind === 'release' && effect.status === 'unconfirmed'
        )
      ).toBe(true)
      const draft = membershipTransferNotification({ transfer }, f.control.getSnapshot())
      expect(draft).toMatchObject({ tone: 'warning', scope: { groupOperationId: transfer.groupEffects!.id } })
      expect(draft.detail).toContain('任务释放结果尚未确认')
      expect(draft.detail).not.toContain('释放 0 个任务')
      f.source!.linkTransfer(transfer.groupEffects!.id, { key: 'not-persisted-parent' })
      await f.flush()
      expect(f.h.ledger.page().summary.unread).toBe(1)
      f.h.owner.offerCurrent(draft)
      f.source!.linkTransfer(transfer.groupEffects!.id, { key: draft.key, eventId: draft.eventId })
      await f.flush()
      expect(f.h.ledger.page().summary).toMatchObject({ total: 2, unread: 1 })
      expect(f.h.ledger.page({ key: groupEffectsKey(transfer.groupEffects!.id) }).records[0]?.attention).toBe(
        'activity'
      )
    } finally {
      await f.close()
    }
  })
  it('a missing final private ACK leaves prior confirmed steps but no invented completion; a new original owner recovers quietly without replaying the group', async () => {
    const f = groupEffectsFixture()
    try {
      const original = vi.mocked(f.h.port.commitSource).getMockImplementation()!
      vi.mocked(f.h.port.commitSource).mockImplementation(async (...args) => {
        const data = args[2] as { rows: Record<string, { frame: { phase: string } }> }
        if (Object.keys(data.rows).length === 0) throw Error('final private checkpoint not acknowledged')
        return original(...args)
      })
      f.create()
      await f.flush()
      expect(f.h.ledger.page().summary.total).toBe(0)
      await f.source!.close()
      vi.mocked(f.h.port.commitSource).mockImplementation(original)
      const restored = new GroupEffectsNotifications(f.h.owner, 'ab000000-0000-4000-8000-000000000002')
      try {
        await restored.flush()
        expect(f.h.ledger.page().records[0]).toMatchObject({ subjectState: 'unconfirmed' })
        expect(f.bridge.sendMessage).toHaveBeenCalledTimes(2)
        expect(f.h.ledger.page().records[0]?.detail).toContain('没有保存本次全部')
      } finally {
        await restored.close()
      }
    } finally {
      await f.close()
    }
  })
})

it('all original post-mutation kinds are captured while effective-policy no-ops stay quiet and unknown receipts are not send successes', async () => {
  const f = groupEffectsFixture()
  try {
    const group = f.create().groups[0]!.group
    f.service.addGroupMembers({
      groupId: group.id,
      members: [{ slotId: f.slots[2]!, roleTemplateKey: 'builder' }]
    })
    f.service.setGroupLead({ groupId: group.id, slotId: f.slots[1]! })
    f.service.updateGroupGoal({ groupId: group.id, goal: 'private changed goal' })
    const calls = f.messages.loadRun(f.runId).messageOrder.length
    f.service.setGroupPlanPolicy({ groupId: group.id, planPolicy: 'any_member' })
    expect(f.messages.loadRun(f.runId).messageOrder.length).toBe(calls)
    f.service.setGroupLead({ groupId: group.id, slotId: null })
    f.service.setGroupPlanPolicy({ groupId: group.id, planPolicy: 'lead_only' })
    f.service.dissolveGroup({ groupId: group.id })
    await f.flush()
    expect([...new Set(f.frames.map((frame) => frame.kind))].sort()).toEqual([
      'add',
      'create',
      'dissolve',
      'goal',
      'lead',
      'policy'
    ])
    expect(f.frames.at(-1)?.effects.filter((effect) => effect.kind === 'orphan')).toHaveLength(3)
    expect(f.frames.at(-1)?.effects.filter((effect) => effect.kind === 'membership')).toHaveLength(3)
    expect(f.h.ledger.page().summary.total).toBe(0)
    expect(JSON.stringify(f.h.ledger.sourceState(GROUP_EFFECTS_SOURCE_KEY))).not.toContain(
      'private changed goal'
    )
  } finally {
    await f.close()
  }
})

it.each([true,false])('an unknown private diagnostic ACK is reconciled by a genuine repeated frame only, not by replaying the effect (committed = %s)',async committed=>{
  const f=groupEffectsFixture()
  try{
    f.bridge.sendMessage.mockImplementation(()=>{throw Error('original sender error')})
    const original=vi.mocked(f.h.port.commitSource).getMockImplementation()!
    let lost=false
    vi.mocked(f.h.port.commitSource).mockImplementation(async(...args)=>{
      if(!lost&&args[3].length){lost=true;if(committed)await original(...args);throw Error('unknown private ACK')}
      return original(...args)
    })
    f.create();await f.flush()
    expect(f.h.ledger.page().summary.total).toBe(committed?1:0)
    const calls=f.bridge.sendMessage.mock.calls.length
    f.source!.observe(f.frames.at(-1)!);await f.flush()
    expect(f.h.ledger.page().summary.total).toBe(1);expect(f.bridge.sendMessage.mock.calls.length).toBe(calls)
  }finally{await f.close()}
})
