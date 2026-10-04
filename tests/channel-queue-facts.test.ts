import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { SessionHandoffService } from '../src/application/session-handoff-service'
import { QueueNotifications } from '../src/application/notifications/queue-notifications'
import { notificationFrame, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'

describe('real existing channel operations feed main-only queue facts', () => {
  it('a specifically watched handoff outside the recent timeline still uses one original lightweight read to observe taking', () => {
    const repository = new SqliteChannelMessageRepository(':memory:'), relay = new ChannelMessageRelay(repository, () => 10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/test'); relay.resetScope('run-a', 1)
      const oldest = relay.sendMessage({ channelId: '1', text: 'old held handoff', holdSessionToken: 'old-session-token' })
      relay.watchNotificationQueueFact(relay.notificationQueueSnapshot().facts[0]!)
      for (let index = 1; index < 550; index++) {
        const newer = relay.sendMessage({ channelId: '1', text: `newer taken ${index}` })
        repository.markOutboundDelivered([newer.entryId!.slice('outbox:'.length)], 10_000 + index)
      }
      expect(relay.conversationsOf('1')?.some(entry => entry.id === oldest.entryId)).toBe(false)
      const light = vi.spyOn(repository, 'listOutboundDeliveryStateSince'), heavy = vi.spyOn(repository, 'listOutboundSince'), extra = vi.spyOn(repository, 'queueDeliveryStateFor')
      repository.markOutboundDelivered([oldest.entryId!.slice('outbox:'.length)], 11_000)
      relay['refreshOutboundDeliveries']()
      expect(relay.notificationQueueSnapshot().facts.find(fact => fact.entryId === oldest.entryId)?.deliveredAt).toBe(11_000)
      expect(light).toHaveBeenCalledOnce(); expect(heavy).not.toHaveBeenCalled(); expect(extra).not.toHaveBeenCalled()
      relay['refreshOutboundDeliveries']()
      expect(light.mock.calls[1]?.[2]).toBeUndefined() // The confirmed watched row stops adding even its id to the next query.
    } finally { relay.stop(); repository.close() }
  })
  it('restored handoff identity not in the recent hydration cache is unconfirmed until its original DB row supplies facts', () => {
    const repository = new SqliteChannelMessageRepository(':memory:'), relay = new ChannelMessageRelay(repository, () => 10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/test'); relay.resetScope('run-a', 1)
      const accepted = repository.enqueueOutbound('1', 'private original', 100, undefined, false, 'run-a', { holdSessionToken: 'private-token', kind: 'user' })
      relay.watchNotificationQueueFact({ entryId: `outbox:${accepted.id}`, channelId: '1', runId: 'run-a', held: true, createdAt: 100 })
      expect(relay.notificationQueueSnapshot().facts[0]?.unconfirmed).toBe(true)
      relay['refreshOutboundDeliveries']()
      expect(relay.notificationQueueSnapshot().facts[0]).toMatchObject({ unconfirmed: undefined, held: true, runId: 'run-a', createdAt: 100 })
      expect(JSON.stringify(relay.notificationQueueSnapshot())).not.toContain('private')
    } finally { relay.stop(); repository.close() }
  })
  it('ending a long run audits cached pending rows beyond the 500-entry timeline window', () => {
    const repository = new SqliteChannelMessageRepository(':memory:'), relay = new ChannelMessageRelay(repository, () => 10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/test'); relay.resetScope('run-a', 1)
      const oldest = relay.sendMessage({ channelId: '1', text: 'old held handoff', holdSessionToken: 'old-session-token' })
      // Stay within the original pending-depth gate: one old held row plus newer
      // rows the Agent has actually consumed. Do not bypass production limits.
      for (let index = 1; index < 550; index++) {
        const accepted = relay.sendMessage({ channelId: '1', text: `unique newer ${index}` })
        repository.markOutboundDelivered([accepted.entryId!.slice('outbox:'.length)], 10_000 + index)
      }
      expect(relay.conversationsOf('1')).toHaveLength(500)
      relay.completeScope(20_000)
      expect(relay.notificationQueueSnapshot().facts).toHaveLength(550)
      expect(relay.notificationQueueSnapshot().facts.find(fact => fact.entryId === oldest.entryId)?.retiredAt).toBe(20_000)
      expect(relay.notificationQueueSnapshot().facts.filter(fact => fact.deliveredAt !== undefined)).toHaveLength(549)
    } finally { relay.stop(); repository.close() }
  })
  it('exposes stable entry/run identity without text, attachments or held token; reading snapshots adds no DB query', () => {
    const repository = new SqliteChannelMessageRepository(':memory:'), relay = new ChannelMessageRelay(repository, () => 10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/test'); relay.resetScope('run-a', 1)
      const accepted = relay.sendMessage({ channelId: '1', text: 'NEVER_COPY_TEXT', holdSessionToken: 'NEVER_COPY_HELD_TOKEN' })
      expect(accepted.entryId).toMatch(/^outbox:/)
      const first = relay.notificationQueueSnapshot()
      expect(first.facts[0]).toMatchObject({ entryId: accepted.entryId, runId: 'run-a', channelId: '1', held: true })
      expect(JSON.stringify(first)).not.toContain('NEVER_COPY')
      const light = vi.spyOn(repository, 'listOutboundDeliveryStateSince'), heavy = vi.spyOn(repository, 'listOutboundSince')
      for (let index = 0; index < 250; index++) expect(relay.notificationQueueSnapshot().facts).toBe(first.facts)
      expect(light).not.toHaveBeenCalled(); expect(heavy).not.toHaveBeenCalled()
      relay.releaseQueuedMessage('1', accepted.entryId!)
      expect(relay.notificationQueueSnapshot().facts[0]?.held).toBe(false)
      expect(relay.withdrawQueuedMessage('1', accepted.entryId!)).toBe(true)
      expect(relay.notificationQueueSnapshot().facts[0]?.withdrawnAt).toBe(10_000)
    } finally { relay.stop(); repository.close() }
  })
  it('tracks actual retirement and never infers retirement for a cached row taken concurrently before scope switching', () => {
    const repository = new SqliteChannelMessageRepository(':memory:'), relay = new ChannelMessageRelay(repository, () => 10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/test'); relay.resetScope('run-a', 1)
      const pending = relay.sendMessage({ channelId: '1', text: 'pending' }), taken = relay.sendMessage({ channelId: '1', text: 'taken' })
      repository.markOutboundDelivered([taken.entryId!.slice('outbox:'.length)], 10_100)
      const audit = vi.spyOn(repository, 'queueDeliveryStateFor')
      relay.resetScope('run-b', 20_000)
      const rows = relay.notificationQueueSnapshot().facts
      expect(rows.find(row => row.entryId === pending.entryId)).toMatchObject({ retiredAt: 10_000, runId: 'run-a' })
      expect(rows.find(row => row.entryId === taken.entryId)).toMatchObject({ deliveredAt: 10_100, retiredAt: undefined, runId: 'run-a' })
      expect(audit).toHaveBeenCalledOnce()
    } finally { relay.stop(); repository.close() }
  })
  it('audit failure cannot fail or repeat the original committed scope change', () => {
    const repository = new SqliteChannelMessageRepository(':memory:'), relay = new ChannelMessageRelay(repository, () => 10_000)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/test'); relay.resetScope('run-a', 1)
      const accepted = relay.sendMessage({ channelId: '1', text: 'pending' })
      vi.spyOn(repository, 'queueDeliveryStateFor').mockImplementation(() => { throw Error('audit unavailable') })
      expect(() => relay.resetScope('run-b', 20_000)).not.toThrow()
      expect(relay.notificationQueueSnapshot().historyIncomplete).toBe(true)
      expect(relay.notificationQueueSnapshot().facts.find(row => row.entryId === accepted.entryId)?.unconfirmed).toBe(true)
      expect(repository.queueDeliveryStateFor).toHaveBeenCalledOnce()
      expect(repository.listOutboundSince(0).find(row => `outbox:${row.id}` === accepted.entryId)?.retiredAt).toBe(10_000)
    } finally { relay.stop(); repository.close() }
  })
  it('actual handoff service links its real enqueue and late take to one private notification, with no observer wait', async () => {
    const repository = new SqliteChannelMessageRepository(':memory:'), relay = new ChannelMessageRelay(repository, () => 10_000), h = notificationSourceHarness()
    const folder = mkdtempSync(join(tmpdir(), 'sg-queue-handoff-test-')), team = notificationTeam(), frame = notificationFrame()
    const source = new QueueNotifications(h.owner, () => relay.notificationQueueSnapshot(), () => 10_000)
    let stop: (() => void) | undefined
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/test'); relay.resetScope('run-a', 1)
      stop = relay.subscribe(() => source.observe(relay.applyTo(frame), team))
      source.observe(relay.applyTo(frame), team); await source.flush()
      const service = new SessionHandoffService({ team: { getSnapshot: () => team }, sessions: { getSnapshot: () => relay.applyTo(frame), currentSessionToken: () => 'old-token',
        sendMessage: input => relay.sendMessage({ ...input, ...(input.holdUntilNewSession ? { holdSessionToken: 'old-token' } : {}) }) },
        locateTranscript: () => ({ path: '/not-stored/private-transcript.jsonl', exists: false, resolution: 'expected' }), conversationsOf: id => relay.conversationsOf(id), handoffRoot: folder, now: () => 10_000,
        observeOutcome: (result, from) => source.registerHandoff(result, from) })
      const send = vi.spyOn(relay, 'sendMessage')
      const result = service.deliver({ sourceChannelId: '1', target: { kind: 'self' } }); await source.flush()
      expect(send).toHaveBeenCalledOnce(); expect(result.notification?.key).toBe(h.ledger.page().records[0]?.key)
      expect(result.transcriptState).toBe('expected')
      expect(h.ledger.page().records[0]?.subjectState).toBe('held')
      repository.markOutboundDelivered([result.entryId!.slice('outbox:'.length)], 11_000)
      relay['refreshOutboundDeliveries'](); source.observe(relay.applyTo(frame), team); await source.flush()
      expect(h.ledger.page().summary.total).toBe(1); expect(h.ledger.page().records[0]?.subjectState).toBe('delivered')
      expect(JSON.stringify(h.ledger.page())).not.toContain('/not-stored')
    } finally { stop?.(); source.stop(); await h.owner.close(); relay.stop(); repository.close(); rmSync(folder, { recursive: true, force: true }) }
  })
  it('a broken observer cannot repeat or replace a successful handoff, and outcome describes only existing transcript facts', () => {
    const folder = mkdtempSync(join(tmpdir(), 'sg-queue-observer-test-')), send = vi.fn(() => ({ commandId: 'real-command', entryId: 'outbox:real-row' }))
    const service = new SessionHandoffService({ team: { getSnapshot: notificationTeam }, sessions: { getSnapshot: notificationFrame, currentSessionToken: () => 'old-token', sendMessage: send },
      locateTranscript: () => ({ path: '/tmp/transcript', exists: true, modifiedAt: 100, resolution: 'workspace' }), conversationsOf: () => [], handoffRoot: folder, now: () => 200,
      observeOutcome: () => { throw Error('only observer failed') } })
    try {
      const result = service.deliver({ sourceChannelId: '1', target: { kind: 'self' } })
      expect(send).toHaveBeenCalledOnce(); expect(result).toMatchObject({ entryId: 'outbox:real-row', commandId: 'real-command', transcriptState: 'older' })
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })
})
