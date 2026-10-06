import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { McpWriteNotifications } from '../src/application/notifications/mcp-write-notifications'
import { sessionNotificationObservation } from '../src/application/notifications/session-lifecycle-notifications'
import { legacyMcpWriteCandidates, readMcpWriteState, reduceMcpWriteNotifications, type McpWriteFact, type McpWriteState } from '../src/domain/mcp-write-notification'
import { observedMcpWrite, type McpWriteObservation } from '../src/domain/mcp-write-observation'
import type { NotificationDraft, NotificationPush } from '../src/domain/notification'
import type { ProcessBlockTool } from '../src/domain/conversation-entry'
import { notificationFrame, notificationSourceHarness, notificationTeam } from './notification-source-fixtures'
import type { NotificationRepositoryLifecycle } from '../src/application/notification-repository'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fixture(count = 1) {
  const team = notificationTeam(), binding = team.members[0]!.binding!
  binding.generation = 'original-generation'; binding.agentSessionId = `${binding.workspaceId}:ch-${binding.channelId}:${binding.generation}`
  const blocks: ProcessBlockTool[] = Array.from({ length: count }, (_, index) => ({ kind: 'tool', toolKind: 'mcp', id: `native-${index}`, status: 'done', startedAt: 12000 + index,
    toolName: 'mcp-SG Team-team_memory', input: { action: 'review', channel_id: '1', memoryId: `memory-${index}`, note: 'PRIVATE note, never copied' },
    output: JSON.stringify({ ok: false, agentSessionId: binding.agentSessionId, code: 'internal_error', sgWriteFailure: { version: 1, reason: 'storage' }, message: 'PRIVATE original output' }) }))
  const frame = notificationFrame({ liveProcess: { '1': { turn: 'original-turn', blocks, startedAt: 12000, updatedAt: 12000 } } })
  const session = sessionNotificationObservation(frame, team, 10000, 10000).facts[0]!, key = `mcp-write-source:${session.identity}`
  const facts: McpWriteFact[] = blocks.map(block => { const proof = observedMcpWrite(block.toolName, block.input, block.output)!; return { ...proof,
    identity: hash([session.identity, block.id, proof.tool, proof.action]), attentionKey: hash([session.identity, 'original-turn', proof.tool, proof.action, proof.reason]),
    blockId: block.id, at: block.startedAt!, name: session.name, scope: { ...session.scope, groupId: undefined } } })
  const input = { key, facts, signature: hash(facts), now: 10000, monitorStartedAt: 10000 }, drafts: NotificationDraft[] = []
  let previous: McpWriteState | undefined
  for (;;) { const result = reduceMcpWriteNotifications(previous, input, true, 1); drafts.push(...result.drafts); previous = result.state; if (result.complete) break }
  const old: McpWriteState = { version: 1, key, seen: facts.map(f => f.identity), attentionFamilies: previous.attentionFamilies }
  return { team, frame, facts, input, old, drafts: drafts.map(draft => ({ ...draft, target: draft.target?.kind === 'session' ? { ...draft.target, mcpWrite: undefined } : draft.target })) }
}
function seed(h: ReturnType<typeof notificationSourceHarness>, f: ReturnType<typeof fixture>, drafts: NotificationDraft[] = f.drafts) {
  for (let i = 0; i < drafts.length; i += 100) h.ledger.commitSource(f.input.key, i / 100, f.old, drafts.slice(i, i + 100), 10000)
}
describe('legacy MCP current-result comparison is not retroactive proof', () => {
  it.each([false, true])('associates exact canonical legacy metadata without replaying alerts or renewing human attention; already read=%s', async alreadyRead => {
    const h = notificationSourceHarness(), f = fixture(), source = new McpWriteNotifications(h.owner, () => 10000), events: NotificationPush[] = []
    seed(h, f)
    const old = h.ledger.page().records[0]!
    if (alreadyRead) h.ledger.read(old.id, old.revision, 10000)
    const before = h.ledger.page().records[0]!
    h.owner.subscribe(e => events.push(e))
    try {
      source.observe(f.frame, f.team); await source.source.flush()
      const row = h.ledger.page().records[0]!
      expect(row.id).toBe(old.id); expect(row.subjectState).toBe('legacy-comparison')
      expect(row.attentionRevision).toBe(before.attentionRevision); expect(row.readRevision).toBe(before.readRevision); expect(row.readAt).toBe(before.readAt)
      expect(row.target?.kind === 'session' && row.target.mcpWrite?.entity).toEqual({ kind: 'memory', id: 'memory-0' })
      expect(row.detail).toContain('当前结果仅供对照'); expect(row.detail).not.toContain('PRIVATE')
      expect(events.some(e => e.announcement)).toBe(false)
      expect(legacyMcpWriteCandidates(readMcpWriteState(h.ledger.sourceState(f.input.key).data, f.input.key), f.input)).toEqual([])
      const reads = vi.mocked(h.port.mcpWriteRecords!).mock.calls.length, commits = vi.mocked(h.port.commitSource).mock.calls.length
      for (let i = 0; i < 100; i++) source.observe(f.frame, f.team)
      await source.source.flush()
      expect(vi.mocked(h.port.mcpWriteRecords!).mock.calls).toHaveLength(reads); expect(vi.mocked(h.port.commitSource).mock.calls).toHaveLength(commits)
    } finally { await source.close(); await h.owner.close() }
  })
  it('inspects more than 100 identities including missing/ambiguous rows without a first-page loop or resurrection', async () => {
    const h = notificationSourceHarness(), f = fixture(231), source = new McpWriteNotifications(h.owner, () => 10000)
    const drafts = f.drafts.slice(1).map((draft, i) => i === 0 ? { ...draft, detail: 'unknown historical format' } : draft)
    seed(h, f, drafts)
    try {
      source.observe(f.frame, f.team); await source.source.flush()
      expect(vi.mocked(h.port.mcpWriteRecords!).mock.calls.map(([keys]) => keys.length)).toEqual([100, 100, 31])
      expect(h.ledger.page().summary.total).toBe(230)
      expect(h.ledger.page({ eventType: 'mcp.write-result', limit: 100 }).records.filter(row => row.subjectState === 'legacy-comparison')).toHaveLength(100)
      expect(h.ledger.page({ key: f.drafts[1]!.key }).records[0]!.detail).toBe('unknown historical format')
      expect(legacyMcpWriteCandidates(readMcpWriteState(h.ledger.sourceState(f.input.key).data, f.input.key), f.input)).toEqual([])
      expect(h.owner.status().historyIncomplete).toBe(false)
    } finally { await source.close(); await h.owner.close() }
  })
  it.each(['scope', 'time', 'state', 'proof', 'format', 'actor'])('does not replace an incompatible %s record with a convenient current result', async changed => {
    const h = notificationSourceHarness(), f = fixture(), source = new McpWriteNotifications(h.owner, () => 10000), original = f.drafts[0]!
    const target = original.target!.kind === 'session' ? original.target : undefined
    const existing: McpWriteObservation = { tool: 'team_memory', action: 'review', channelId: '1', agentSessionId: f.facts[0]!.agentSessionId, status: 'unconfirmed', reason: 'storage', entity: { kind: 'memory', id: 'OLDER ENTITY' } }
    const draft = changed === 'scope' ? { ...original, scope: { ...original.scope, bindingGeneration: 'other' }, target: { ...target!, scope: { ...original.scope, bindingGeneration: 'other' } } }
      : changed === 'time' ? { ...original, occurredAt: 11999 } : changed === 'state' ? { ...original, state: 'expired' as const }
      : changed === 'proof' ? { ...original, target: { ...target!, mcpWrite: existing } } : changed === 'format' ? { ...original, detail: 'do not parse prose' } : original
    seed(h, f, [draft])
    if (changed === 'actor') { const actor = 'other-actor'; f.team.members[0]!.binding!.agentSessionId = actor; const block = f.frame.liveProcess!['1']!.blocks[0]! as ProcessBlockTool; block.output = block.output!.replace(f.facts[0]!.agentSessionId, actor) }
    const before = h.ledger.page().records[0]!
    try { source.observe(f.frame, f.team); await source.source.flush(); expect(h.ledger.page().records[0]).toEqual(before) }
    finally { await source.close(); await h.owner.close() }
  })
  it('clearing the old read row during metadata lookup cannot recreate it or replay business work', async () => {
    const h = notificationSourceHarness(), f = fixture(), source = new McpWriteNotifications(h.owner, () => 10000)
    seed(h, f)
    vi.mocked(h.port.mcpWriteRecords!).mockImplementationOnce(async keys => { const rows = h.ledger.mcpWriteRecords(keys), page = h.ledger.page(); h.ledger.readAll({}, page.summary.revision, 10000); h.ledger.clearRead({}, 10000); return rows })
    try { source.observe(f.frame, f.team); await source.source.flush(); expect(h.ledger.page().summary.total).toBe(0) }
    finally { await source.close(); await h.owner.close() }
  })
  it('retains original capacity without a second per-identity list, and rejects contradictory inspection markers', () => {
    const ids = Array.from({ length: 20000 }, (_, i) => hash(i)), families = Array.from({ length: 10000 }, (_, i) => hash(['family', i]))
    const state = { version: 2, key: 'capacity', seen: ids.map(id => `~${id}`), attentionFamilies: families }
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(2 * 1024 * 1024)
    expect(readMcpWriteState(state, state.key)).toEqual(state)
    expect(() => readMcpWriteState({ ...state, seen: [ids[0], `~${ids[0]}`] }, state.key)).toThrow()
  })
  it('limits private metadata to this diagnostic namespace, 100 unique exact keys and no arbitrary record query', async () => {
    const h = notificationSourceHarness(), key = `mcp-write:${hash('record')}`
    try {
      expect(h.ledger.mcpWriteRecords([])).toEqual([])
      expect(() => h.ledger.mcpWriteRecords([key, key])).toThrow()
      expect(() => h.ledger.mcpWriteRecords(Array.from({ length: 101 }, (_, i) => `mcp-write:${hash(i)}`))).toThrow()
      expect(() => h.ledger.mcpWriteRecords(['operator-message:private'])).toThrow()
      expect(() => h.ledger.mcpWriteRecords(['mcp-write:short'])).toThrow()
    } finally { await h.owner.close() }
  })
  it('does not attach metadata returned by an older private storage generation', async () => {
    let lifecycle!: (event: NotificationRepositoryLifecycle) => void, resolve!: (value: ReturnType<typeof h.ledger.mcpWriteRecords>) => void
    const h = notificationSourceHarness(':memory:', listener => { lifecycle = listener; return () => {} }), f = fixture(), source = new McpWriteNotifications(h.owner, () => 10000)
    seed(h, f)
    const original = h.ledger.page().records[0]!, rows = h.ledger.mcpWriteRecords([original.key])
    vi.mocked(h.port.mcpWriteRecords!).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    try {
      source.observe(f.frame, f.team)
      await vi.waitFor(() => expect(h.port.mcpWriteRecords).toHaveBeenCalledOnce())
      lifecycle({ state: 'unavailable', generation: 1 }); resolve(rows); await source.source.flush()
      expect(h.ledger.page().records[0]).toEqual(original)
      expect(vi.mocked(h.port.commitSource).mock.calls).toHaveLength(0)
    } finally { await source.close(); await h.owner.close() }
  })
})
