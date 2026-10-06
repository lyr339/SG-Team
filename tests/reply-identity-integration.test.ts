import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { ReplyNotifications } from '../src/application/notifications/reply-notifications'
import { NOTIFICATION_SOURCE_PAYLOAD_LIMIT } from '../src/domain/notification'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { notificationFrame, notificationSession, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
const reply = (patch: Partial<ConversationEntry> = {}): ConversationEntry => ({ id: 'native:old', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', text: 'PRIVATE reply body never copied',
  timestamp: 2000, streamId: 'stream:old', turn: 'turn:old', ...patch })
const later = (count = 2100) => Array.from({ length: count }, (_, i) => reply({ id: `native:later-${i}`, streamId: `stream:later-${i}`, turn: `turn:later-${i}`, timestamp: 3000 + i }))
const canonical = () => reply({ id: 'reply:canonical-old', replyToEntryId: 'outbox:old' })
const frame = (entries: ConversationEntry[]) => notificationFrame({ conversations: { '1': entries } })
const observe = async (source: ReplyNotifications, entries: ConversationEntry[]) => { source.observe(frame(entries), notificationTeam()); await source.flush() }
const sourceKey = (h: ReturnType<typeof notificationSourceHarness>) => vi.mocked(h.port.commitSource).mock.calls[0]![0]

describe('durable reply identity projection, not a larger JSON window', () => {
  it.each(['read', 'archived', 'cleared'] as const)('preserves %s after window eviction, observer and private SQLite restart, and later canonical metadata', async action => {
    const directory = mkdtempSync(join(tmpdir(), 'sg-reply-restart-')), path = join(directory, 'private.sqlite')
    let h = notificationSourceHarness(path), source = new ReplyNotifications(h.owner, () => 1000)
    try {
      await observe(source, []); await observe(source, [reply()])
      const first = h.ledger.page().records[0]!, key = sourceKey(h)
      await h.owner.read(first.id, first.revision)
      if (action === 'archived') await h.owner.archive(first.id)
      if (action === 'cleared') await h.owner.clearRead({})
      await observe(source, later()); expect((h.ledger.sourceState(key).data as any).seen).not.toContain(first.key.slice(6))
      await source.close(); await h.owner.close()
      h = notificationSourceHarness(path); source = new ReplyNotifications(h.owner, () => 10000)
      await observe(source, [canonical()])
      expect(h.ledger.page().summary.total).toBe(action === 'read' ? 2101 : 2100)
      const restored = h.ledger.marker(first.key)
      expect(restored.cleared).toBe(action === 'cleared' ? true : undefined)
      if (action === 'read') expect(h.ledger.page({ key: first.key }).records[0]).toMatchObject({ id: first.id, attentionRevision: first.attentionRevision, readRevision: first.attentionRevision, target: { entryId: canonical().id } })
      if (action === 'archived') {
        const inspect = new DatabaseSync(path)
        try { expect(JSON.parse((inspect.prepare('SELECT payload FROM desktop_notifications WHERE id=?').get(first.id) as { payload: string }).payload).archivedAt).toBe(10000) }
        finally { inspect.close() }
      }
      expect(h.ledger.replyIdentities(key, [first.key.slice(6)])[0]?.row.entryId).toBe(canonical().id)
      expect(h.owner.status().health).toBe('ready')
    } finally { await source.close(); await h.owner.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('indexes every stock reply in a history much larger than the working window without publishing or exceeding the existing source payload limit', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 100000)
    try {
      await observe(source, [reply(), ...later(9000)])
      const key = sourceKey(h), state = h.ledger.sourceState(key).data as any
      expect(h.ledger.page().summary.total).toBe(0); expect(state.seen).toHaveLength(2000)
      const calls = vi.mocked(h.port.commitSource).mock.calls
      expect(calls).toHaveLength(91)
      for (const call of calls) { expect(Buffer.byteLength(JSON.stringify(call[2]))).toBeLessThanOrEqual(NOTIFICATION_SOURCE_PAYLOAD_LIMIT); expect(call[3]).toHaveLength(0); expect(call[5]!.rows.length).toBeLessThanOrEqual(100) }
      await source.close(); const restored = new ReplyNotifications(h.owner, () => 100000)
      await observe(restored, [canonical()]); await restored.close()
      expect(h.ledger.page().summary.total).toBe(0)
      expect(JSON.stringify(h.ledger.sourceState(key))).not.toContain('PRIVATE')
    } finally { await source.close(); await h.owner.close() }
  })
  it('one new reply after a long unchanged prefix does not rewrite a scan checkpoint for every known page', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 1000)
    try {
      await observe(source, []); const history = later(); await observe(source, history)
      const writes = vi.mocked(h.port.commitSource).mock.calls.length
      const lookups = vi.mocked(h.port.replyIdentities!).mock.calls.length
      await observe(source, [...history, originalNew()])
      expect(vi.mocked(h.port.commitSource).mock.calls.length - writes).toBe(1)
      expect(vi.mocked(h.port.replyIdentities!).mock.calls.length - lookups).toBe(22)
      expect(h.ledger.page().summary.total).toBe(2101)
    } finally { await source.close(); await h.owner.close() }
    function originalNew() { return reply({ id: 'native:incremental', streamId: 'stream:incremental', turn: 'turn:incremental' }) }
  })
  it('does not lose the initial stock classification or first-page identity when a later batch fails and the next original frame resumes it', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 10000), original: typeof h.port.commitSource = async (...args) => h.ledger.commitSource(...args)
    let writes = 0
    vi.mocked(h.port.commitSource).mockImplementation(async (...args) => { if (++writes === 2) throw Error('not committed'); return original(...args) })
    const entries = [reply(), ...later(220)]
    try {
      await observe(source, entries)
      const key = sourceKey(h)
      expect(h.ledger.sourceState(key)).toMatchObject({ revision: 1, data: { scan: { offset: 100, stock: 10000 } } })
      expect(h.ledger.replyIdentities(key, [(h.ledger.sourceState(key).data as any).seen[0]])).toHaveLength(1)
      await observe(source, entries); expect((h.ledger.sourceState(key).data as any).scan).toBeUndefined()
      await observe(source, [canonical()]); expect(h.ledger.page().summary.total).toBe(0)
      expect(vi.mocked(h.port.commitSource).mock.calls.every(call => call[3].length === 0)).toBe(true)
    } finally { await source.close(); await h.owner.close() }
  })
  it('rebases a conflict and reloads a commit with lost ACK without splitting the old reply or renewing its read attention', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 1000), original: typeof h.port.commitSource = async (...args) => h.ledger.commitSource(...args)
    try {
      await observe(source, []); await observe(source, [reply()])
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision); await observe(source, later())
      vi.mocked(h.port.commitSource).mockImplementationOnce(async (key, revision, data, drafts, now, identities) => {
        const current = h.ledger.sourceState(key); h.ledger.commitSource(key, revision, current.data, [], now)
        return h.ledger.commitSource(key, revision, data, drafts, now, identities)
      })
      await observe(source, [canonical()]); expect(h.ledger.page().summary.total).toBe(2101)
      vi.mocked(h.port.commitSource).mockImplementationOnce(async (...args) => { await original(...args); throw Error('committed, ACK lost') })
      const newest = reply({ id: 'reply:new-canonical-old', replyToEntryId: 'outbox:old' })
      await observe(source, [newest]); await observe(source, [newest])
      expect(h.ledger.page().summary).toMatchObject({ total: 2101, unread: 2100 })
      expect(h.ledger.page({ key: first.key }).records[0]).toMatchObject({ id: first.id, attentionRevision: first.attentionRevision, readRevision: first.attentionRevision, target: { entryId: newest.id } })
    } finally { await source.close(); await h.owner.close() }
  })
  it('rejects an old delayed index result across a private storage generation change instead of applying it to replacement history', async () => {
    let lifecycle!: (event: { state: 'unavailable' | 'recovered'; generation: number }) => void
    const h = notificationSourceHarness(':memory:', listener => { lifecycle = listener; return () => {} }), source = new ReplyNotifications(h.owner, () => 1000)
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
    try {
      await observe(source, []); await observe(source, [reply()])
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision)
      vi.mocked(h.port.replyIdentities!).mockImplementationOnce(async (key, aliases) => { const result = h.ledger.replyIdentities(key, aliases); entered(); await held; return result })
      const waiting = observe(source, [canonical()]); await started
      lifecycle({ state: 'unavailable', generation: 1 }); lifecycle({ state: 'recovered', generation: 2 }); release(); await waiting
      expect(h.ledger.page({ key: first.key }).records[0]?.target).toMatchObject({ entryId: reply().id })
      await observe(source, [canonical()]); expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 0 })
      expect(h.ledger.page({ key: first.key }).records[0]?.target).toMatchObject({ entryId: canonical().id })
    } finally { release?.(); await source.close(); await h.owner.close() }
  })
  it('resolves a late in-frame bridge before batching, while refusing to guess-merge two already published replies', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 1000)
    try {
      await observe(source, [])
      await observe(source, [reply({ turn: undefined }), ...later(150), reply({ id: 'native:turn-only', streamId: undefined }), canonical()])
      expect(h.ledger.page().summary.total).toBe(151)
      const old = h.ledger.replyIdentities(sourceKey(h), [createHash('sha256').update(JSON.stringify([sourceKey(h).slice(13), 'entry', reply().id])).digest('hex')])[0]!
      expect(h.ledger.page({ key: `reply:${old.row.key}` }).records[0]?.target).toMatchObject({ entryId: canonical().id })
      const third = reply({ id: 'native:other', streamId: 'stream:other', turn: 'turn:other' })
      await observe(source, [third]); const count = h.ledger.page().summary.total
      await observe(source, [reply({ id: 'reply:ambiguous', streamId: 'stream:old', turn: 'turn:other' })])
      expect(h.ledger.page().summary.total).toBe(count); expect(h.owner.status().historyIncomplete).toBe(true)
    } finally { await source.close(); await h.owner.close() }
  })
  it('retains historical alias ownership outside the eight-alias payload and never downgrades its canonical target to a trimmed native fallback', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 1000)
    try {
      await observe(source, []); await observe(source, [reply()])
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision)
      for (let i = 0; i < 30; i++) await observe(source, [reply({ id: `reply:revision-${i}`, replyToEntryId: `outbox:revision-${i}` })])
      const key = sourceKey(h), identity = key.slice(13)
      const alias = createHash('sha256').update(JSON.stringify([identity, 'entry', 'reply:revision-27'])).digest('hex')
      const match = h.ledger.replyIdentities(key, [alias])[0]!
      expect(match.aliases).toContain(alias); expect(match.row.aliases).not.toContain(alias)
      await observe(source, later()); await observe(source, [reply({ streamId: undefined, turn: undefined, id: 'reply:revision-27', replyToEntryId: undefined })])
      expect(h.ledger.page().summary.total).toBe(2101); expect(h.ledger.page({ key: first.key }).records[0]?.readRevision).toBe(first.attentionRevision)
      await observe(source, [reply({ streamId: undefined, turn: undefined })])
      expect(h.ledger.page({ key: first.key }).records[0]?.target).toMatchObject({ entryId: 'reply:revision-27' })
    } finally { await source.close(); await h.owner.close() }
  })
  it('keeps identities scoped to a real session generation and upgrades a known failed result without creating a new notification', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 1000)
    try {
      await observe(source, []); await observe(source, [reply({ status: 'failed' })])
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision); await observe(source, later())
      await observe(source, [canonical()]); expect(h.ledger.page().summary.total).toBe(2101)
      expect(h.ledger.page({ key: first.key }).records[0]).toMatchObject({ subjectState: 'complete', readRevision: first.attentionRevision })
      source.observe(notificationFrame({ sessions: [notificationSession({ generation: 1 })], conversations: { '1': [canonical()] } }), notificationTeam()); await source.flush()
      expect(h.ledger.page().summary.total).toBe(2102)
    } finally { await source.close(); await h.owner.close() }
  })
})

describe('old reply checkpoints migrate without invented history', () => {
  it('backfills the rows a v2 checkpoint actually retained in <=100-row commits, preserving stock semantics and unrelated file data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sg-reply-v4-')), path = join(directory, 'private.sqlite')
    let h = notificationSourceHarness(path), source = new ReplyNotifications(h.owner, () => 10000)
    try {
      await observe(source, [reply(), ...later(119)])
      const key = sourceKey(h), saved = h.ledger.sourceState(key).data as any
      await source.close(); await h.owner.close()
      const db = new DatabaseSync(path)
      db.prepare('UPDATE desktop_notification_sources SET payload=? WHERE source_key=?').run(JSON.stringify({ version: 2, key, seen: saved.seen, rows: saved.rows }), key)
      db.exec(`UPDATE desktop_notification_meta SET schema_version=4; DROP TABLE desktop_notification_reply_keys; DROP TABLE desktop_notification_reply_aliases;
        CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES('original'); PRAGMA user_version=77;`); db.close()
      h = notificationSourceHarness(path); source = new ReplyNotifications(h.owner, () => 10000)
      expect(h.ledger.replyIdentities(key, [saved.seen[0]])).toEqual([]) // no initialization-time bulk rewrite
      await observe(source, [canonical()])
      expect(h.ledger.page().summary.total).toBe(0)
      const writes = vi.mocked(h.port.commitSource).mock.calls
      expect(writes.slice(0, 2).map(call => call[5]?.rows.length)).toEqual([100, 20])
      expect(h.ledger.replyIdentities(key, [saved.seen[0]])[0]?.row.entryId).toBe(canonical().id)
      const inspect = new DatabaseSync(path)
      try { expect(inspect.prepare('SELECT schema_version FROM desktop_notification_meta').get()!.schema_version).toBe(6); expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(77); expect(inspect.prepare('SELECT value FROM preserve').get()!.value).toBe('original') }
      finally { inspect.close() }
    } finally { await source.close(); await h.owner.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('consolidates two proven stock identities while carrying all their old aliases, without manufacturing a historical notification', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 10000)
    try {
      await observe(source, [reply({ turn: undefined }), reply({ id: 'native:turn-only', streamId: undefined })])
      const key = sourceKey(h), saved = (h.ledger.sourceState(key).data as any).seen as string[]
      expect(saved).toHaveLength(2); await observe(source, [canonical()])
      const first = h.ledger.replyIdentities(key, [saved[0]!])[0]!, second = h.ledger.replyIdentities(key, [saved[1]!])[0]!
      expect(first.row.key).toBe(second.row.key); expect(first.row.recorded).toBe(false)
      await source.close(); const restored = new ReplyNotifications(h.owner, () => 10000)
      await observe(restored, [reply({ id: 'native:turn-only', streamId: undefined, turn: undefined })]); await restored.close()
      expect(h.ledger.page().summary.total).toBe(0)
      expect(h.owner.status().health).toBe('ready')
    } finally { await source.close(); await h.owner.close() }
  })
})
