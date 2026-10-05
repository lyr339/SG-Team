import { describe, expect, it, vi } from 'vitest'
import { QueueNotifications, queueNotificationIdentity } from '../src/application/notifications/queue-notifications'
import type { ChannelQueueFact } from '../src/domain/channel-queue-fact'
import type { SessionHandoffResult } from '../src/domain/session-handoff'
import { notificationFrame, notificationSession, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'

const raw = (patch: Partial<ChannelQueueFact> = {}): ChannelQueueFact => ({ entryId: 'outbox:actual-message', channelId: '1', runId: 'run-a', createdAt: 5_000, held: false, ...patch })
const result = (patch: Partial<SessionHandoffResult> = {}): SessionHandoffResult => ({ entryId: raw().entryId, targetChannelId: '1', held: true, transcriptPath: '/private/not-stored/transcript.jsonl',
  recordPath: '/private/not-stored/record.md', commandId: 'acceptance-not-delivery', issuedAt: 5_000, transcriptState: 'expected', ...patch })
describe('real-owner queue and handoff notification projections', () => {
  it('restores a taken handoff outside the hydrated timeline so a later explicitly linked reply still updates it', async () => {
    const h = notificationSourceHarness(); let facts: readonly ChannelQueueFact[] = [raw({ deliveredAt: 12_000 })]
    const provider = () => ({ facts, historyIncomplete: false }), source = new QueueNotifications(h.owner, provider)
    try {
      source.observe(notificationFrame(), notificationTeam()); source.registerHandoff(result(), '2'); await source.flush(); source.stop()
      facts = []
      const watch = vi.fn((fact: ChannelQueueFact) => { facts = [raw({ ...fact, deliveredAt: 12_000 })] })
      const restored = new QueueNotifications(h.owner, provider, Date.now, watch)
      restored.observe(notificationFrame(), notificationTeam()); await restored.flush()
      expect(watch).toHaveBeenCalledWith(expect.objectContaining({ entryId: raw().entryId, runId: 'run-a' }))
      restored.observe(notificationFrame({ conversations: { '1': [{ id: 'reply:late-after-restore', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', timestamp: 15_000,
        text: 'explicitly related answer', replyToEntryId: raw().entryId }] } }), notificationTeam()); await restored.flush()
      expect(h.ledger.page().summary.total).toBe(1); expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'replied', target: { entryId: 'reply:late-after-restore' } })
      restored.stop()
    } finally { source.stop(); await h.owner.close() }
  })
  it('bounded continuation commits every fact without uncommitted cursor advancement, and subsequent idle frames converge', async () => {
    const h = notificationSourceHarness(); let facts: readonly ChannelQueueFact[] = []
    const source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false }))
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      facts = Array.from({ length: 230 }, (_, index) => raw({ entryId: `outbox:volume-${index}` }))
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 230, unread: 0 })
      expect(vi.mocked(h.port.commitSource).mock.calls.map(call => call[3].length)).toEqual([0, 100, 100, 30])
      const frame = notificationFrame(), team = notificationTeam(), count = vi.mocked(h.port.commitSource).mock.calls.length
      for (let index = 0; index < 250; index++) source.observe(frame, team)
      await source.flush(); expect(h.port.commitSource).toHaveBeenCalledTimes(count)
    } finally { source.stop(); await h.owner.close() }
  })
  it('unconfirmed old-row audit removes navigation and promising delivery, without making up retirement', async () => {
    const h = notificationSourceHarness(); let facts: readonly ChannelQueueFact[] = [raw({ held: true })]
    const source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: facts[0]?.unconfirmed === true }))
    try {
      source.observe(notificationFrame(), notificationTeam()); source.registerHandoff(result(), '2'); await source.flush()
      facts = [raw({ held: true, unconfirmed: true, unconfirmedAt: 11_000 })]
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'unconfirmed', attention: 'notice', tone: 'warning', state: 'active', occurredAt: 11_000 })
      expect(h.ledger.page().records[0]?.target).toBeUndefined()
      expect(h.ledger.page().records[0]?.detail).toContain('不猜撤回、退役')
      expect((await h.owner.page()).historyIncomplete).toBe(true)
    } finally { source.stop(); await h.owner.close() }
  })
  it('a migration with linked handoff augments the same notification and never claims the identity rolled back', async () => {
    const h = notificationSourceHarness(), facts = [raw({ held: true })]
    const source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false }))
    try {
      source.observe(notificationFrame(), notificationTeam()); const handoff = result(); handoff.notification = source.registerHandoff(handoff, '2'); await source.flush()
      const original = h.ledger.page().records[0]!
      const linked = source.registerTransfer({ transfer: { groupId: 'group-a', fromSlotId: 'from', toSlotId: 'slot-a', toChannelId: '1', roleName: '架构实现', transferredLead: true, releasedTaskIds: ['task-1', 'task-2'],
        failover: { id: 'transfer-a', workspaceId: 'workspace-a', runId: 'run-a', slotId: 'from', roleName: '架构实现', fromChannelId: '2', fromAgentSessionId: 'source', status: 'completed', reason: 'manual', taskIds: [], detectedAt: 100, updatedAt: 200 } },
        contextHandoff: { ok: true, result: handoff } })
      await source.flush(); expect(linked).toEqual(handoff.notification)
      expect(h.ledger.page().summary.total).toBe(1); expect(h.ledger.page().records[0]?.id).toBe(original.id)
      expect(h.ledger.page().records[0]?.detail).toContain('释放 2 个任务，主控身份随迁')
      expect(h.ledger.page().records[0]?.detail).toContain('身份迁移不因后续交接状态回滚')
    } finally { source.stop(); await h.owner.close() }
  })
  it('logs queue changes quietly; command/status complete alone is not taking or replying, disappearance is not withdrawal', async () => {
    const h = notificationSourceHarness(); let facts: readonly ChannelQueueFact[] = []
    const source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false }), () => 10_000)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      facts = [raw()]; source.observe(notificationFrame(), notificationTeam()); await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'queued', attention: 'activity', target: { surface: 'queue' } })
      facts = []; source.observe(notificationFrame(), notificationTeam()); await source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe('queued')
      facts = [raw({ deliveredAt: 11_000 })]; source.observe(notificationFrame(), notificationTeam()); await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'delivered', attention: 'activity', state: 'resolved' })
      expect(h.ledger.page().summary.unread).toBe(0)
    } finally { source.stop(); await h.owner.close() }
  })
  it('keeps a handoff in one record across new binding/taking/reply, without claiming the transcript was fully read', async () => {
    const h = notificationSourceHarness(); let facts: readonly ChannelQueueFact[] = []
    const source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false }), () => 10_000)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      facts = [raw({ held: true })]
      const ref = source.registerHandoff(result(), '2'); await source.flush()
      const original = h.ledger.page().records.find(record => record.attention === 'notice')!
      expect(ref?.key).toBe(original.key)
      expect(original).toMatchObject({ subjectState: 'held', state: 'active', target: { surface: 'queue' } })
      expect(original.detail).toContain('尚未创建'); expect(JSON.stringify(h.ledger.page())).not.toContain('/private/not-stored')
      await h.owner.read(original.id, original.revision)
      facts = [raw({ held: true, deliveredAt: 12_000 })]
      const nextTeam = notificationTeam(); nextTeam.members[0]!.binding = { ...nextTeam.members[0]!.binding!, generation: 'bind-next', composerId: 'composer-next' }
      source.observe(notificationFrame({ sessions: [notificationSession({ generation: 1, composerId: 'composer-next' })] }), nextTeam); await source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
      expect(h.ledger.page().records[0]).toMatchObject({ id: original.id, subjectState: 'delivered', scope: { generation: '1', bindingGeneration: 'bind-next' } })
      expect(h.ledger.page().records[0]?.detail).toContain('未据此声称目标已读完')
      source.observe(notificationFrame({ sessions: [notificationSession({ generation: 1, composerId: 'composer-next' })], conversations: { '1': [{ id: 'reply:handoff', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', text: 'not retained', replyToEntryId: raw().entryId, timestamp: 13_000 }] } }), nextTeam)
      await source.flush(); expect(h.ledger.page().summary.total).toBe(1)
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'replied', target: { entryId: 'reply:handoff' } })
    } finally { source.stop(); await h.owner.close() }
  })
  it('restores association and pending metadata after observer recreation; replay stays quiet and actual retirement expires it', async () => {
    const h = notificationSourceHarness(); let facts: readonly ChannelQueueFact[] = [raw({ held: true })]
    const provider = () => ({ facts, historyIncomplete: false }), source = new QueueNotifications(h.owner, provider)
    try {
      source.observe(notificationFrame(), notificationTeam()); source.registerHandoff(result(), '2'); await source.flush(); source.stop()
      const restored = new QueueNotifications(h.owner, provider), pushes = vi.fn(); h.owner.subscribe(pushes)
      restored.observe(notificationFrame(), notificationTeam()); await restored.flush()
      expect(h.ledger.page().summary.total).toBe(1)
      expect(pushes.mock.calls.some(([event]) => event.announcement)).toBe(false)
      facts = [raw({ held: true, retiredAt: 15_000 })]; restored.observe(notificationFrame(), notificationTeam()); await restored.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ state: 'expired', subjectState: 'retired' })
      expect(h.ledger.page().records[0]?.target).toBeUndefined(); restored.stop()
    } finally { source.stop(); await h.owner.close() }
  })
  it('uses the database run, not the current workspace/CH binding, to attribute old queue facts', async () => {
    const h = notificationSourceHarness(); const facts = [raw({ held: true })]
    const source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false }))
    try {
      const old = notificationTeam(); source.observe(notificationFrame(), old); source.registerHandoff(result(), '2'); await source.flush()
      const next = notificationTeam(); next.activeWorkspaceId = 'workspace-b'; next.activeRun = { ...next.activeRun!, id: 'run-b', workspaceId: 'workspace-b' }
      next.runs = [old.activeRun!, next.activeRun]; next.members = []; next.bindings = []
      source.observe(notificationFrame(), next); await source.flush()
      const record = h.ledger.page().records[0]!
      expect(record.scope.workspaceId).toBe('workspace-a'); expect(record.scope.runId).toBe('run-a')
      expect(record.key).toBe(`queue:${queueNotificationIdentity(raw().entryId)}`)
    } finally { source.stop(); await h.owner.close() }
  })
  it('same input can retry only on a new observed frame after storage failure, and idle frames do not rewrite history', async () => {
    const h = notificationSourceHarness(); let facts: readonly ChannelQueueFact[] = []
    const source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false }))
    try {
      const frame = notificationFrame(), team = notificationTeam(); source.observe(frame, team); await source.flush()
      facts = [raw()]; vi.mocked(h.port.commitSource).mockRejectedValueOnce(Error('unconfirmed'))
      source.observe(frame, team); await source.flush(); expect(h.ledger.page().summary.total).toBe(0)
      source.observe(frame, team); await source.flush(); expect(h.ledger.page().summary.total).toBe(1)
      const count = vi.mocked(h.port.commitSource).mock.calls.length
      for (let index = 0; index < 250; index++) source.observe(frame, team)
      await source.flush(); expect(h.port.commitSource).toHaveBeenCalledTimes(count)
    } finally { source.stop(); await h.owner.close() }
  })
})

it('a real newly linked group-cleanup warning renews one existing queue parent and persists uncertainty through delivery/reply without duplicating or claiming release zero',async()=>{
  const h=notificationSourceHarness(),facts=[raw()],source=new QueueNotifications(h.owner,()=>({facts,historyIncomplete:false}))
  try{
    source.observe(notificationFrame(),notificationTeam());const accepted=source.registerHandoff(result(),'2');await source.flush()
    const first=h.ledger.page().records[0]!;await h.owner.read(first.id,first.revision)
    const effects:import('../src/domain/group-effects').GroupEffectsSummary={version:1,id:'ab000000-0000-4000-8000-000000000003',kind:'transfer',scope:{workspaceId:'workspace-a',runId:'run-a',groupId:'g'},name:'原组',observedAt:5000,sequence:5,primary:'returned',projection:'confirmed',phase:'completed',effects:[{kind:'release',status:'unconfirmed',reason:'storage'}]}
    const outcome={transfer:{groupId:'g',fromSlotId:'a',toSlotId:'b',roleName:'架构',transferredLead:false,releasedTaskIds:[],groupEffects:effects,failover:{id:'failover-test',runId:'run-a',workspaceId:'workspace-a',slotId:'a',roleName:'builder',fromChannelId:'1',fromAgentSessionId:'a-session',status:'completed',reason:'manual_membership_transfer',taskIds:[],detectedAt:1,updatedAt:1}}} as import('../src/domain/team-handoff').MembershipTransferOutcome
    outcome.contextHandoff={ok:true,result:{...result(),notification:accepted}}
    source.registerTransfer(outcome);await source.flush()
    const row=h.ledger.page().records[0]!
    expect(row).toMatchObject({id:first.id,tone:'warning',scope:{groupId:'g',groupOperationId:effects.id}})
    expect(row.detail).toContain('任务释放结果尚未确认');expect(row.detail).not.toContain('释放 0 个任务');expect(h.ledger.page().summary.unread).toBe(1)
    await h.owner.read(row.id,row.revision)
    source.registerTransfer(outcome);await source.flush();expect(h.ledger.page().summary.unread).toBe(0)
    facts[0]={...facts[0]!,deliveredAt:6000};source.observe(notificationFrame(),notificationTeam());await source.flush()
    expect(h.ledger.page().records[0]).toMatchObject({tone:'warning',state:'active'});expect(h.ledger.page().records[0]?.detail).toContain('任务释放结果尚未确认')
  }finally{source.stop();await h.owner.close()}
})
