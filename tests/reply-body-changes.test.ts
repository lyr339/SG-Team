import { describe, expect, it, vi } from 'vitest'
import { replyBodyMaterial, validReplyBodyProof } from '../src/domain/reply-body-proof'
import { readReplyNotificationState } from '../src/domain/reply-notification'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplyNotifications } from '../src/application/notifications/reply-notifications'
import { notificationFrame, notificationTeam, notificationSourceHarness } from './notification-source-fixtures'
import type { ConversationEntry } from '../src/domain/conversation-entry'
const entry = (text: string): ConversationEntry => ({ id: 'reply:original', channelId: '1', role: 'assistant', source: 'cursor', status: 'complete', text,
  timestamp: 2000, replyToEntryId: 'outbox:original' })
describe('native body changes cannot inherit a previous human read', () => {
  it('keeps one logical record but reports a new observed body version instead of silently reusing an already read result', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 1000)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      source.observe(notificationFrame({ conversations: { '1': [entry('PRIVATE old body')] } }), notificationTeam()); await source.flush()
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision)
      source.observe(notificationFrame({ conversations: { '1': [entry('PRIVATE new body')] } }), notificationTeam()); await source.flush()
      const updated = h.ledger.page().records[0]!
      expect(updated).toMatchObject({ id: first.id, subjectState: 'body-changed', state: 'resolved' })
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1 })
      expect(JSON.stringify(h.ledger.page())).not.toContain('PRIVATE')
    } finally { await source.close(); await h.owner.close() }
  })
  it('keeps code whitespace significant, actor-scopes the digest, and rejects malformed proof fields', () => {
    const scope = { sessionId: 'one', channelId: '1' }
    expect(replyBodyMaterial('a\n  b', scope)).not.toBe(replyBodyMaterial('a\n b', scope))
    expect(replyBodyMaterial('same', scope)).not.toBe(replyBodyMaterial('same', { ...scope, sessionId: 'two' }))
    expect(replyBodyMaterial('a\\nb', scope)).toBe(replyBodyMaterial('a\nb', scope))
    for (const proof of [{ version: 2, digest: 'a'.repeat(64), status: 'complete' }, { version: 1, digest: 'short', status: 'complete' },
      { version: 1, digest: 'a'.repeat(64), status: 'streaming' }, { version: 1, digest: 'a'.repeat(64), status: 'complete', text: 'PRIVATE' }]) expect(validReplyBodyProof(proof)).toBe(false)
  })
  it('an old checkpoint backfill cannot erase a newer body proof already in the durable index', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 1000)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      source.observe(notificationFrame({ conversations: { '1': [entry('PRIVATE same')] } }), notificationTeam()); await source.flush()
      const first = h.ledger.page().records[0]!, key = vi.mocked(h.port.sourceState).mock.calls[0]![0]
      await h.owner.read(first.id, first.revision); await source.close()
      const checkpoint = h.ledger.sourceState(key), state = checkpoint.data as any
      for (const row of Object.values(state.rows) as any[]) { delete row.bodyDigest; delete row.legacyComparison }
      state.version = 3
      const rowKey = state.seen[0], aliases = state.rows[rowKey].aliases
      h.ledger.commitSource(key, checkpoint.revision, state, [], 1000, { sourceKey: key, rows: [{ key: rowKey, ...state.rows[rowKey] }] })
      // Simulate the genuine old private index payload as well, not a future proof labelled v3.
      const restored = new ReplyNotifications(h.owner, () => 3000)
      try {
        // The index correctly preserves a newer proof; this old checkpoint must never be trusted as a v4 proof itself.
        expect(readReplyNotificationState(state, key)?.version).toBe(4)
        const digest = first.target?.kind === 'session' ? first.target.replyBody?.digest : undefined
        expect(digest).toMatch(/^[a-f0-9]{64}$/)
        expect(h.ledger.replyIdentities(key, [...new Set([rowKey, ...aliases])] as string[])[0]?.row.bodyDigest).toBe(digest)
      } finally { await restored.close() }
      expect(h.ledger.page().summary.unread).toBe(0)
    } finally { await source.close(); await h.owner.close() }
  })
  it('protects a known canonical body against a conflicting trimmed/native fallback without creating another unread', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 1000), team = notificationTeam()
    try {
      source.observe(notificationFrame(), team); await source.flush()
      const canonical = { ...entry('PRIVATE canonical'), turn: 'same-turn' }
      source.observe(notificationFrame({ conversations: { '1': [canonical] } }), team); await source.flush()
      const first = h.ledger.page().records[0]!; await h.owner.read(first.id, first.revision)
      source.observe(notificationFrame({ conversations: { '1': [{ ...canonical, id: 'native:fallback', replyToEntryId: undefined, text: 'PRIVATE different fallback' }] } }), team); await source.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 0 })
      expect(h.ledger.page().records[0]?.target).toEqual(first.target)
    } finally { await source.close(); await h.owner.close() }
  })
  it('migrates real unproved v3/old-index data as a comparison, not a retroactive body receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-reply-body-legacy-')), path = join(dir, 'private.sqlite')
    let h = notificationSourceHarness(path), source = new ReplyNotifications(h.owner, () => 1000)
    try {
      source.observe(notificationFrame(), notificationTeam()); await source.flush()
      const original = entry('PRIVATE legacy source')
      source.observe(notificationFrame({ conversations: { '1': [original] } }), notificationTeam()); await source.flush()
      const first = h.ledger.page().records[0]!, key = vi.mocked(h.port.sourceState).mock.calls[0]![0]
      await h.owner.read(first.id, first.revision); await source.close(); await h.owner.close()
      const db = new DatabaseSync(path)
      try {
        const index = db.prepare('SELECT logical_key,payload FROM desktop_notification_reply_keys').all()
        for (const row of index) { const value = JSON.parse(row.payload as string); delete value.bodyDigest; delete value.legacyComparison
          db.prepare('UPDATE desktop_notification_reply_keys SET payload=? WHERE logical_key=?').run(JSON.stringify(value), row.logical_key as string) }
        const state = JSON.parse(db.prepare('SELECT payload FROM desktop_notification_sources WHERE source_key=?').get(key)!.payload as string)
        state.version = 3; for (const row of Object.values(state.rows) as any[]) { delete row.bodyDigest; delete row.legacyComparison }
        db.prepare('UPDATE desktop_notification_sources SET payload=? WHERE source_key=?').run(JSON.stringify(state), key)
        const record = JSON.parse(db.prepare('SELECT payload FROM desktop_notifications WHERE id=?').get(first.id)!.payload as string)
        delete record.target.replyBody; record.eventId = `reply:${first.key.slice(6)}:complete`
        db.prepare('UPDATE desktop_notifications SET payload=? WHERE id=?').run(JSON.stringify(record), first.id)
        db.exec('UPDATE desktop_notification_meta SET schema_version=7')
      } finally { db.close() }
      h = notificationSourceHarness(path); source = new ReplyNotifications(h.owner, () => 10000)
      source.observe(notificationFrame({ conversations: { '1': [original] } }), notificationTeam()); await source.flush()
      const comparison = h.ledger.page().records[0]!
      expect(comparison).toMatchObject({ id: first.id, subjectState: 'legacy-comparison', readRevision: first.attentionRevision, attentionRevision: first.attentionRevision })
      expect(comparison.detail).toContain('不能用当前文本补造当时的内容')
      expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 0 })
      expect(comparison.target?.kind === 'session' ? comparison.target.replyBody?.digest : null).toMatch(/^[a-f0-9]{64}$/)
      expect(h.owner.status().historyIncomplete).toBe(false)
    } finally { await source.close(); await h.owner.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('a later canonical reference keeps an observed update label/time and human read, rather than relabelling it as a new reply', async () => {
    const h = notificationSourceHarness(), source = new ReplyNotifications(h.owner, () => 10000), team = notificationTeam()
    const native = { ...entry('PRIVATE old'), id: 'native:old', streamId: 'stream:one', turn: 'turn:one' }
    try {
      source.observe(notificationFrame(), team); await source.flush()
      source.observe(notificationFrame({ conversations: { '1': [native] } }), team); await source.flush()
      const current = { ...native, text: 'PRIVATE updated' }
      source.observe(notificationFrame({ conversations: { '1': [current] } }), team); await source.flush()
      const updated = h.ledger.page().records[0]!
      await h.owner.read(updated.id, updated.revision)
      source.observe(notificationFrame({ conversations: { '1': [{ ...current, id: 'reply:canonical' }] } }), team); await source.flush()
      const refined = h.ledger.page().records[0]!
      expect(refined).toMatchObject({ id: updated.id, subjectState: 'body-changed', occurredAt: updated.occurredAt, timeBasis: 'observed', attentionRevision: updated.attentionRevision,
        readRevision: updated.attentionRevision, target: { entryId: 'reply:canonical' } })
    } finally { await source.close(); await h.owner.close() }
  })
})
