import { describe, expect, it, vi } from 'vitest'
import { ReplyNotifications } from '../src/application/notifications/reply-notifications'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { notificationFrame, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'

const reply = (patch: Partial<ConversationEntry> = {}): ConversationEntry => ({ id: 'native:1', channelId: '1', role: 'assistant', status: 'complete', source: 'cursor', text: '相同的完整回答', timestamp: 2_000, streamId: 'stream-a', turn: 'turn-a', ...patch })
describe('final reply source with persistent association evidence', () => {
  it('late canonical metadata does not resurrect a result explicitly cleared by its human reader', async () => {
    const h = notificationSourceHarness(); const source = new ReplyNotifications(h.owner)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      source.observe(notificationFrame({ conversations: { '1': [reply()] } }), notificationTeam()); await source.flush()
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision); await h.owner.clearRead({})
      source.observe(notificationFrame({ conversations: { '1': [reply({ id: 'reply:canonical', replyToEntryId: 'outbox:1' })] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.total).toBe(0)
      expect(h.ledger.marker(first.key).cleared).toBe(true)
    } finally { source.stop(); await h.owner.close() }
  })
  it('a full 2,000-entry identity checkpoint fits the private store and heartbeat frames do not rewrite it', async () => {
    const h = notificationSourceHarness(); const source = new ReplyNotifications(h.owner)
    const frame = notificationFrame({ conversations: { '1': Array.from({ length: 2_000 }, (_, index) => reply({ id: `reply:${index}`, streamId: `stream-${index}`, turn: `turn-${index}` })) } })
    try {
      source.observe(frame, notificationTeam()); await source.flush()
      expect((await h.owner.page()).historyIncomplete).toBe(false)
      const count = vi.mocked(h.port.commitSource).mock.calls.length
      expect(count).toBe(1)
      for (let index = 0; index < 250; index++) source.observe(frame, notificationTeam())
      await source.flush(); expect(h.port.commitSource).toHaveBeenCalledTimes(count)
    } finally { source.stop(); await h.owner.close() }
  })
  it('missed result backfill is chunked without advancing uncommitted IDs or replaying announcements', async () => {
    const h = notificationSourceHarness(); const source = new ReplyNotifications(h.owner)
    const pushes: unknown[] = []; h.owner.subscribe(event => { if (event.announcement) pushes.push(event) })
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush(); source.stop()
      const restored = new ReplyNotifications(h.owner)
      restored.observe(notificationFrame({ conversations: { '1': Array.from({ length: 230 }, (_, index) => reply({ id: `reply:backfill-${index}`, streamId: `stream-${index}`, turn: `turn-${index}` })) } }), notificationTeam())
      await restored.flush(); restored.stop()
      expect(h.ledger.page().summary).toMatchObject({ total: 230, unread: 230 })
      expect(vi.mocked(h.port.commitSource).mock.calls.map(call => call[3].length)).toEqual([0, 100, 100, 30])
      expect(pushes).toHaveLength(0)
    } finally { source.stop(); await h.owner.close() }
  })
  it('uses source time to distinguish a new result from delayed initial history when the channel had no array yet', async () => {
    const h = notificationSourceHarness(); const source = new ReplyNotifications(h.owner, () => 1_500)
    try {
      source.observe(notificationFrame({ conversations: {} }), notificationTeam()); await source.flush()
      source.observe(notificationFrame({ conversations: { '1': [reply({ id: 'stock', timestamp: 1_000, streamId: 'old-stream', turn: 'old-turn' }), reply()] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.total).toBe(1)
      expect(h.ledger.page().records[0]?.target).toMatchObject({ entryId: 'native:1' })
    } finally { source.stop(); await h.owner.close() }
  })
  it('ignores stock and streaming; equal words in separate turns remain separate new results', async () => {
    const h = notificationSourceHarness(); const source = new ReplyNotifications(h.owner)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      source.observe(notificationFrame({ conversations: { '1': [reply({ status: 'streaming' })] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.total).toBe(0)
      source.observe(notificationFrame({ conversations: { '1': [reply(), reply({ id: 'native:2', streamId: 'stream-b', turn: 'turn-b' })] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 2, unread: 2 })
      source.stop(); const restored = new ReplyNotifications(h.owner)
      restored.observe(notificationFrame({ conversations: { '1': [reply(), reply({ id: 'native:2', streamId: 'stream-b', turn: 'turn-b' })] } }), notificationTeam()); await restored.flush()
      expect(h.ledger.page().summary.total).toBe(2); restored.stop()
    } finally { source.stop(); await h.owner.close() }
  })
  it('late outbox/relay association updates the same notification and preserves its human read revision', async () => {
    const h = notificationSourceHarness(); const source = new ReplyNotifications(h.owner)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      source.observe(notificationFrame({ conversations: { '1': [reply()] } }), notificationTeam()); await source.flush()
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision)
      source.observe(notificationFrame({ conversations: { '1': [reply({ replyToEntryId: 'outbox:1' }), reply({ id: 'reply:relay1', replyToEntryId: 'outbox:1', streamId: undefined })] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 0 })
      expect(h.ledger.page().records[0]).toMatchObject({ id: first.id, target: { entryId: 'reply:relay1' } })
      source.observe(notificationFrame({ conversations: { '1': [reply({ id: 'reply:relay1', replyToEntryId: 'outbox:1', streamId: undefined })] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.total).toBe(1)
    } finally { source.stop(); await h.owner.close() }
  })
  it('initial historical reply and its late canonical reference never turn into a new unread notification', async () => {
    const h = notificationSourceHarness(); const source = new ReplyNotifications(h.owner)
    try {
      source.observe(notificationFrame({ conversations: { '1': [reply()] } }), notificationTeam()); await source.flush()
      source.observe(notificationFrame({ conversations: { '1': [reply({ id: 'reply:relay1', replyToEntryId: 'outbox:1' })] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.total).toBe(0)
    } finally { source.stop(); await h.owner.close() }
  })
  it('same-array source events can recover from a failed write without automatically replaying an unknown transaction', async () => {
    const h = notificationSourceHarness(); const source = new ReplyNotifications(h.owner)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      const frame = notificationFrame({ conversations: { '1': [reply()] } })
      vi.mocked(h.port.commitSource).mockRejectedValueOnce(Error('temporary storage failure'))
      source.observe(frame, notificationTeam()); await source.flush(); expect(h.ledger.page().summary.total).toBe(0)
      source.observe(frame, notificationTeam()); await source.flush(); expect(h.ledger.page().summary.total).toBe(1)
    } finally { source.stop(); await h.owner.close() }
  })
  it('a stream/turn bridge late in one frame consolidates the components independent of array order', async () => {
    const h = notificationSourceHarness(); const source = new ReplyNotifications(h.owner)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      source.observe(notificationFrame({ conversations: { '1': [reply({ turn: undefined }), reply({ id: 'native:turn-only', streamId: undefined }),
        reply({ id: 'reply:canonical', replyToEntryId: 'outbox:1' })] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.total).toBe(1)
      expect(h.ledger.page().records[0]?.target).toMatchObject({ entryId: 'reply:canonical' })
    } finally { source.stop(); await h.owner.close() }
  })
})
