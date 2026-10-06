import { describe, it, expect, vi } from 'vitest'
import { readQueueNotificationState } from '../src/domain/queue-notification'
import { QueueNotifications } from '../src/application/notifications/queue-notifications'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { notificationFrame, notificationSession, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
import type { ChannelQueueFact } from '../src/domain/channel-queue-fact'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const raw: ChannelQueueFact = { entryId: 'outbox:original', channelId: '1', runId: 'run-a', createdAt: 1000, held: true }
const reply = (entryId = raw.entryId): ConversationEntry => ({ id: 'reply:explicit', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', timestamp: 3000, text: 'PRIVATE body', replyToEntryId: entryId })
const handoff = (entryId = raw.entryId) => ({ entryId, commandId: 'not-a-receipt', targetChannelId: '1', held: true, transcriptPath: '/PRIVATE/not-copied', recordPath: '/PRIVATE/not-copied', transcriptState: 'present' as const, issuedAt: 1000 })
describe('queue current source and actual receiver boundaries', () => {
  it('does not use a current-workspace reply to confirm an old-run handoff with the same CH and outbox reference', async () => {
    const h = notificationSourceHarness(), facts = [raw], source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false })), old = notificationTeam()
    try {
      source.observe(notificationFrame(), old); source.registerHandoff(handoff(), '2'); await source.flush()
      const first = h.ledger.page().records[0]!
      const next = notificationTeam(); next.activeWorkspaceId = 'workspace-b'; next.activeRun = { ...next.activeRun!, id: 'run-b', workspaceId: 'workspace-b' }; next.runs = [old.activeRun!, next.activeRun]
      next.bindings = next.bindings.map(binding => ({ ...binding, runId: 'run-b', workspaceId: 'workspace-b' })); next.members = next.members.map(member => ({ ...member, binding: { ...member.binding!, runId: 'run-b', workspaceId: 'workspace-b' } }))
      source.observe(notificationFrame({ conversations: { '1': [reply()] } }), next); await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ id: first.id, subjectState: 'held', scope: { runId: 'run-a', workspaceId: 'workspace-a' } })
    } finally { await source.close(); await h.owner.close() }
  })
  it.each(['withdrawnAt', 'retiredAt'] as const)('does not let a native complete block override a confirmed unsent %s row', async column => {
    const h = notificationSourceHarness(); let facts: readonly ChannelQueueFact[] = [raw]
    const source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false })), team = notificationTeam()
    try {
      source.observe(notificationFrame(), team); source.registerHandoff(handoff(), '2'); await source.flush()
      facts = [{ ...raw, [column]: 2000 }]; source.observe(notificationFrame({ conversations: { '1': [reply()] } }), team); await source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe(column === 'withdrawnAt' ? 'withdrawn' : 'retired')
      expect(h.ledger.page().records[0]?.target).toBeUndefined()
    } finally { await source.close(); await h.owner.close() }
  })
  it('does not reassign a past taking receipt to a new Composer merely because the same CH is rebound', async () => {
    const h = notificationSourceHarness(), facts = [{ ...raw, deliveredAt: 2000 }], source = new QueueNotifications(h.owner, () => ({ facts, historyIncomplete: false })), team = notificationTeam()
    try {
      source.observe(notificationFrame(), team); source.registerHandoff(handoff(), '2'); await source.flush()
      const first = h.ledger.page().records[0]!
      const next = notificationTeam(); next.members[0]!.binding = { ...next.members[0]!.binding!, generation: 'bind-next', composerId: 'composer-next' }
      source.observe(notificationFrame({ sessions: [notificationSession({ generation: 1, composerId: 'composer-next' })] }), next); await source.flush()
      expect(h.ledger.page().records[0]?.scope).toEqual(first.scope)
    } finally { await source.close(); await h.owner.close() }
  })
  it('a real original lightweight reread of a restored pending row exposes uncertainty rather than replaying past delivery as current', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sg-queue-backup-')), path = join(directory, 'channels.sqlite')
    const repository = new SqliteChannelMessageRepository(path), relay = new ChannelMessageRelay(repository, () => 1000), h = notificationSourceHarness()
    const source = new QueueNotifications(h.owner, () => relay.notificationQueueSnapshot(), () => 10000), team = notificationTeam()
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/fixture'); relay.resetScope('run-a', 1)
      const sent = relay.sendMessage({ channelId: '1', text: 'PRIVATE original', holdSessionToken: 'PRIVATE token' })
      source.observe(relay.applyTo(notificationFrame()), team); source.registerHandoff(handoff(sent.entryId!), '2'); await source.flush()
      repository.markOutboundDelivered([sent.entryId!.slice(7)], 2000); relay['refreshOutboundDeliveries']()
      source.observe(relay.applyTo(notificationFrame()), team); await source.flush(); expect(h.ledger.page().records[0]?.subjectState).toBe('delivered')
      const db = new DatabaseSync(path); db.exec('UPDATE channel_outbox SET delivered_at=NULL'); db.close() // isolated older-backup state, never the user DB
      const light = vi.spyOn(repository, 'listOutboundDeliveryStateSince'), extra = vi.spyOn(repository, 'queueDeliveryStateFor'), heavy = vi.spyOn(repository, 'listOutboundSince')
      relay['refreshOutboundDeliveries'](); source.observe(relay.applyTo(notificationFrame()), team); await source.flush()
      expect(light).toHaveBeenCalledOnce(); expect(extra).not.toHaveBeenCalled(); expect(heavy).not.toHaveBeenCalled()
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'unconfirmed', state: 'active', tone: 'warning' })
      expect(h.ledger.page().records[0]?.target).toBeUndefined()
      const uncertain = h.ledger.page().records[0]!
      const echoed = relay.applyTo(notificationFrame()); echoed.conversations['1'] = [reply(sent.entryId!)]
      source.observe(echoed, team); await source.flush()
      expect(h.ledger.page().records[0]?.subjectState).toBe('unconfirmed') // Old Cursor reply does not repair restored channel state.
      source.observe(echoed, team); await source.flush(); expect(h.ledger.page().records[0]?.attentionRevision).toBe(uncertain.attentionRevision)
      repository.markOutboundDelivered([sent.entryId!.slice(7)], 4000); relay['refreshOutboundDeliveries']()
      source.observe(relay.applyTo(notificationFrame()), team); await source.flush()
      expect(h.ledger.page().records[0]).toMatchObject({ id: uncertain.id, subjectState: 'delivered', state: 'resolved' })
      expect(JSON.stringify(h.ledger.page())).not.toContain('PRIVATE')
    } finally { await source.close(); await h.owner.close(); relay.stop(); repository.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})

it('an older inspected pending frame cannot roll back a newer receipt even if a stale provider resurfaces it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sg-queue-order-')), repository = new SqliteChannelMessageRepository(join(directory, 'channels.sqlite')), relay = new ChannelMessageRelay(repository, () => 1000), h = notificationSourceHarness()
  let current = relay.notificationQueueSnapshot()
  const source = new QueueNotifications(h.owner, () => current, () => 10000), team = notificationTeam()
  try {
    repository.markChannelEmbedded('1', 'workspace-a', '/fixture'); relay.resetScope('run-a', 1)
    const sent = relay.sendMessage({ channelId: '1', text: 'PRIVATE', holdSessionToken: 'PRIVATE token' })
    current = relay.notificationQueueSnapshot(); const oldPending = current
    source.observe(relay.applyTo(notificationFrame()), team); source.registerHandoff(handoff(sent.entryId!), '2'); await source.flush()
    repository.markOutboundDelivered([sent.entryId!.slice(7)], 2000); relay['refreshOutboundDeliveries'](); current = relay.notificationQueueSnapshot()
    source.observe(relay.applyTo(notificationFrame()), team); await source.flush()
    const delivered = h.ledger.page().records[0]!
    current = oldPending; source.observe(notificationFrame(), team); await source.flush()
    expect(h.ledger.page().records[0]).toEqual(delivered)
  } finally { await source.close(); await h.owner.close(); relay.stop(); repository.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('unchanged original delivery reads keep the same fact reference and inspection, without per-poll notification writes', async () => {
  const repository = new SqliteChannelMessageRepository(':memory:'), relay = new ChannelMessageRelay(repository, () => 1000), h = notificationSourceHarness()
  const source = new QueueNotifications(h.owner, () => relay.notificationQueueSnapshot()), team = notificationTeam()
  try {
    repository.markChannelEmbedded('1', 'workspace-a', '/fixture'); relay.resetScope('run-a', 1)
    relay.sendMessage({ channelId: '1', text: 'PRIVATE original' })
    relay['refreshOutboundDeliveries']()
    const before = relay.notificationQueueSnapshot()
    source.observe(relay.applyTo(notificationFrame()), team); await source.flush(); const writes = vi.mocked(h.port.commitSource).mock.calls.length
    for (let i = 0; i < 200; i++) { relay['refreshOutboundDeliveries'](); source.observe(relay.applyTo(notificationFrame()), team) }
    await source.flush()
    expect(relay.notificationQueueSnapshot().facts).toBe(before.facts)
    expect(h.port.commitSource).toHaveBeenCalledTimes(writes)
    expect(relay.notificationQueueSnapshot().facts[0]?.inspection).toEqual(before.facts[0]?.inspection)
  } finally { await source.close(); await h.owner.close(); relay.stop(); repository.close() }
})

it('a watched old handoff absent from an older database is exposed by the same existing lightweight read, even beyond hydration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sg-queue-missing-')), path = join(directory, 'channels.sqlite'), h = notificationSourceHarness(), team = notificationTeam()
  let repository = new SqliteChannelMessageRepository(path), relay = new ChannelMessageRelay(repository, () => 1000)
  let source = new QueueNotifications(h.owner, () => relay.notificationQueueSnapshot(), () => 10000, fact => relay.watchNotificationQueueFact(fact))
  try {
    repository.markChannelEmbedded('1', 'workspace-a', '/fixture'); relay.resetScope('run-a', 1)
    const sent = relay.sendMessage({ channelId: '1', text: 'PRIVATE old', holdSessionToken: 'PRIVATE token' })
    source.observe(relay.applyTo(notificationFrame()), team); source.registerHandoff(handoff(sent.entryId!), '2'); await source.flush()
    repository.markOutboundDelivered([sent.entryId!.slice(7)], 2000); relay['refreshOutboundDeliveries'](); source.observe(relay.applyTo(notificationFrame()), team); await source.flush()
    const first = h.ledger.page().records[0]!
    for (let i = 0; i < 550; i++) { const newer = relay.sendMessage({ channelId: '1', text: `PRIVATE newer ${i}` }); repository.markOutboundDelivered([newer.entryId!.slice(7)], 2001 + i) }
    await source.close(); relay.stop(); repository.close()
    const db = new DatabaseSync(path); db.prepare('DELETE FROM channel_outbox WHERE id=?').run(sent.entryId!.slice(7)); db.close() // isolated backup predates this one id
    repository = new SqliteChannelMessageRepository(path); relay = new ChannelMessageRelay(repository, () => 1000); relay.start(); relay.stop()
    source = new QueueNotifications(h.owner, () => relay.notificationQueueSnapshot(), () => 10000, fact => relay.watchNotificationQueueFact(fact))
    source.observe(relay.applyTo(notificationFrame()), team); await source.flush()
    const light = vi.spyOn(repository, 'listOutboundDeliveryStateSince'), heavy = vi.spyOn(repository, 'listOutboundSince'), extra = vi.spyOn(repository, 'queueDeliveryStateFor')
    relay['refreshOutboundDeliveries'](); source.observe(relay.applyTo(notificationFrame()), team); await source.flush()
    expect(light).toHaveBeenCalledOnce(); expect(heavy).not.toHaveBeenCalled(); expect(extra).not.toHaveBeenCalled()
    expect(h.ledger.page({ key: first.key }).records[0]).toMatchObject({ id: first.id, subjectState: 'unconfirmed', state: 'active' })
    expect(relay.notificationQueueSnapshot().facts.find(fact => fact.entryId === sent.entryId)?.missing).toBe(true)
  } finally { await source.close(); await h.owner.close(); relay.stop(); repository.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('a queued projection from a retired reader cannot commit after the provider has changed to another reader', async () => {
  const h = notificationSourceHarness(), first = { ...raw, inspection: { id: '11111111-1111-4111-8111-111111111111', sequence: 1 } }
  let current = { facts: [first] as readonly ChannelQueueFact[], historyIncomplete: false, inspectionId: first.inspection.id }
  const source = new QueueNotifications(h.owner, () => current, () => 10000), team = notificationTeam()
  let entered!: () => void, release!: () => void
  const enteredPromise = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
  vi.mocked(h.port.sourceState).mockImplementationOnce(async key => { entered(); await held; return h.ledger.sourceState(key) })
  try {
    source.observe(notificationFrame(), team); await enteredPromise
    current = { facts: [], historyIncomplete: false, inspectionId: '22222222-2222-4222-8222-222222222222' }; release(); await source.flush()
    expect(h.ledger.page().summary.total).toBe(0)
    expect(h.port.commitSource).toHaveBeenCalledTimes(1) // empty old observation is sealed without copying its stale facts
    expect(h.owner.status().historyIncomplete).toBe(true)
  } finally { release?.(); await source.close(); await h.owner.close() }
})

it('lost ACK and CAS rebase preserve one uncertainty episode; clearing it does not cause a replayed warning', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sg-queue-ack-')), repository = new SqliteChannelMessageRepository(join(directory, 'channels.sqlite')), relay = new ChannelMessageRelay(repository, () => 1000), h = notificationSourceHarness()
  const source = new QueueNotifications(h.owner, () => relay.notificationQueueSnapshot(), () => 10000), team = notificationTeam()
  try {
    repository.markChannelEmbedded('1', 'workspace-a', '/fixture'); relay.resetScope('run-a', 1)
    const sent = relay.sendMessage({ channelId: '1', text: 'PRIVATE', holdSessionToken: 'PRIVATE' })
    source.observe(relay.applyTo(notificationFrame()), team); source.registerHandoff(handoff(sent.entryId!), '2'); await source.flush()
    repository.markOutboundDelivered([sent.entryId!.slice(7)], 2000); relay['refreshOutboundDeliveries'](); source.observe(relay.applyTo(notificationFrame()), team); await source.flush()
    const db = new DatabaseSync(repository.path); db.exec('UPDATE channel_outbox SET delivered_at=NULL'); db.close()
    relay['refreshOutboundDeliveries']()
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { h.ledger.commitSource(...args); throw Error('ACK lost') })
    source.observe(relay.applyTo(notificationFrame()), team); await source.flush(); source.observe(relay.applyTo(notificationFrame()), team); await source.flush()
    const uncertain = h.ledger.page().records[0]!; expect(h.ledger.page().summary.total).toBe(1); expect(uncertain.subjectState).toBe('unconfirmed')
    await h.owner.read(uncertain.id, uncertain.revision); await h.owner.clearRead({})
    source.observe(relay.applyTo(notificationFrame()), team); await source.flush(); expect(h.ledger.page().summary.total).toBe(0)
    repository.markOutboundDelivered([sent.entryId!.slice(7)], 4000); relay['refreshOutboundDeliveries']()
    vi.mocked(h.port.commitSource).mockImplementationOnce(async (key, expected, data, drafts, now) => {
      h.ledger.commitSource(key, expected, h.ledger.sourceState(key).data, [], now)
      return h.ledger.commitSource(key, expected, data, drafts, now)
    })
    source.observe(relay.applyTo(notificationFrame()), team); await source.flush()
    expect(h.ledger.page().summary.total).toBe(1); expect(h.ledger.page().records[0]?.subjectState).toBe('delivered') // genuinely new confirmed stage, not a replay
  } finally { await source.close(); await h.owner.close(); relay.stop(); repository.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('legacy rows gain no invented inspection; malformed current counters cannot authorize a rollback', () => {
  const key = 'queue-source:test', id = '1'.repeat(32)
  expect(readQueueNotificationState({ version: 1, key, rows: { [id]: ['d', '1'] }, handoffs: {} }, key)).toMatchObject({ version: 2, rows: { [id]: ['d', '1'] } })
  expect(() => readQueueNotificationState({ version: 2, key, rows: { [id]: ['d', '1', 1] }, handoffs: {} }, key)).toThrow('身份异常')
  expect(() => readQueueNotificationState({ version: 2, key, inspectionId: '11111111-1111-4111-8111-111111111111', rows: { [id]: ['b', '1', -1] }, handoffs: {} }, key)).toThrow('身份异常')
})
