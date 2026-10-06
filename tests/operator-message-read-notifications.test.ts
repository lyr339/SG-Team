import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamCollaborationService } from '../src/application/team-collaboration-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { emptyTeamCollaborationSnapshot, type TeamCollaborationReadObservation, type TeamCollaborationSnapshot, type TeamMessage } from '../src/domain/team-collaboration'
import { connectOperatorMessageNotifications } from '../src/application/notifications/team-message-notifications'
import { connectNativeScopeAvailabilityNotifications } from '../src/application/notifications/native-scope-availability'
import { operatorMessageIds, readOperatorMessageState, reduceOperatorMessages, type OperatorMessageState } from '../src/domain/team-message-notification'
import { notificationFrame, notificationTeam, notificationSourceHarness } from './notification-source-fixtures'
import type { NotificationPush } from '../src/domain/notification'
import { NotificationProjectionSource } from '../src/application/notifications/projection-source'
import type { OperatorMessageInput } from '../src/domain/team-message-notification'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'), scope = { workspaceId: 'workspace-a', runId: 'run-a' }
const key = `operator-messages:${hash([scope.workspaceId, scope.runId])}`
const message = (id: string, patch: Partial<TeamMessage> = {}): TeamMessage => ({ id, ...{ runId: scope.runId }, threadId: 'thread-a', groupId: 'group-a', clientMessageId: id, kind: 'question',
  sender: { type: 'agent', slotId: 'slot-a' }, recipient: { type: 'operator' }, content: 'PRIVATE original body must never be read by this notification adapter', createdAt: 1_000,
  receipt: { notificationState: 'not_required', notificationDetail: 'PRIVATE receipt', updatedAt: 1_000 }, ...patch })
const snapshot = (...messages: TeamMessage[]): TeamCollaborationSnapshot => ({ ...emptyTeamCollaborationSnapshot(scope.runId), revision: 5, messages: Object.fromEntries(messages.map(message => [message.id, message])),
  messageOrder: messages.map(message => message.id), threads: [{ id: 'thread-a', runId: scope.runId, groupId: 'group-a', subject: 'original subject', createdAt: 1, updatedAt: 1 }] })
function fixture() {
  const h = notificationSourceHarness(), power = new EventEmitter(), events: NotificationPush[] = []; h.owner.subscribe(value => events.push(value))
  let listener!: (value: TeamCollaborationReadObservation) => void, sequence = 0
  const team = notificationTeam(), fallback = vi.fn(() => { throw Error('must reuse original read context') })
  const feed = { getReadOwnerId: () => 'owned-messages', subscribe: vi.fn(() => () => {}), subscribeReadObservation: (next: typeof listener) => { listener = next; return vi.fn() } }
  const connected = connectOperatorMessageNotifications(feed, fallback, h.owner, { power })
  return { h, power, events, team, feed, fallback, ...connected,
    emit: (value = snapshot(), override: Partial<TeamCollaborationReadObservation> = {}) => listener({ snapshot: value, context: team, stamp: { owner: 'owned-messages', sequence: ++sequence }, ...override }),
    cleanup: async () => { await connected.close(); await h.owner.close() } }
}

it('reads no bodies/receipts, preserves the complete original scope, and excludes a second team read and legacy subscription in production', async () => {
  const f = fixture(), row = message('human'), native = snapshot(row, message('agent-only', { recipient: { type: 'agent', slotId: 'another' } }))
  const body = vi.fn(() => { throw Error('notification must not read the body') }), receipt = vi.fn(() => { throw Error('notification must not read Agent receipts') })
  Object.defineProperty(row, 'content', { get: body }); Object.defineProperty(row, 'receipt', { get: receipt })
  try {
    f.emit(native); await f.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(1); expect(f.fallback).not.toHaveBeenCalled(); expect(f.feed.subscribe).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled(); expect(JSON.stringify(f.h.ledger.page())).not.toContain('PRIVATE')
    const old = f.h.ledger.page().records[0]!
    await f.h.owner.read(old.id, old.revision)
    f.emit(native); await f.source.flush(); expect(f.h.ledger.page().summary.unread).toBe(0)
    expect(f.h.ledger.sourceState(key).data).toMatchObject({ observedScope: scope, version: 2 })
  } finally { await f.cleanup() }
})

it('stale/wrong-owner, mismatched, clipped and incomplete projections cannot expire historical messages or change their read state', async () => {
  const f = fixture()
  try {
    f.emit(snapshot(message('human'))); await f.source.flush(); const before = f.h.ledger.page().records[0]!
    f.emit(snapshot(), { stamp: { owner: 'wrong-owner', sequence: 200 } })
    f.emit({ ...snapshot(), runId: 'other-run' }); f.emit({ ...snapshot(), groupId: 'group-a' })
    f.emit({ ...snapshot(), messages: { lost: message('lost') } })
    f.emit({ ...snapshot(message('dup')), messageOrder: ['dup', 'dup'] }); await f.source.flush()
    expect(f.h.ledger.page().records[0]).toEqual(before)
    expect(f.events.some(event => event.announcement)).toBe(false)
  } finally { await f.cleanup() }
})

it('equal native counters compare actual thin content; prior records expire quietly, archived scopes/activity are retained, and Agent receipts are not guessed', async () => {
  const f = fixture()
  try {
    f.emit(snapshot(message('human'), message('activity', { kind: 'status' }))); await f.source.flush()
    const initial = f.h.ledger.page({ key: 'operator-message:human' }).records[0]!
    await f.h.owner.read(initial.id, initial.revision); await f.h.owner.archive(initial.id)
    f.emit(snapshot()); await f.source.flush()
    const metadata = f.h.ledger.operatorMessageRecords(['operator-message:human', 'operator-message:activity'])
    expect(metadata.find(row => row.key.endsWith('human'))).toMatchObject({ subjectState: 'prior-data', scope: { ...scope, groupId: 'group-a' } })
    expect(metadata.find(row => row.key.endsWith('activity'))?.attention).toBe('activity')
    expect(f.h.ledger.page().summary).toMatchObject({ unread: 0, total: 1 })
    const activity = f.h.ledger.page().records[0]!
    expect(activity.detail).toContain('不能据此推断已回复'); expect(activity.target).toBeUndefined()
    const queries = vi.mocked(f.h.port.operatorMessageRecords!).mock.calls.length
    for (let index = 0; index < 100; index++) f.emit(snapshot())
    await f.source.flush(); expect(f.h.port.operatorMessageRecords).toHaveBeenCalledTimes(queries)
    f.emit(snapshot(message('human'), message('activity', { kind: 'status' }))); await f.source.flush()
    expect(f.h.ledger.page({ key: 'operator-message:human' }).summary.total).toBe(0) // Original archived state is not reversed.
    expect(f.h.ledger.page().records[0]).toMatchObject({ subjectState: 'status', attention: 'activity', state: 'resolved' })
    expect(f.events.some(event => event.announcement)).toBe(false)
  } finally { await f.cleanup() }
})

it('same-ID kind/subject change updates the exact record and event identity; runtime-only sender labels never masquerade as a native rebase', async () => {
  const f = fixture()
  try {
    f.emit(snapshot(message('human'))); await f.source.flush()
    const before = f.h.ledger.page().records[0]!
    f.team.members[0]!.role.name = 'new presentation name'; f.emit(snapshot(message('human'))); await f.source.flush()
    expect((f.h.ledger.sourceState(key).data as OperatorMessageState).rebases).toBe(0)
    const changed = snapshot(message('human', { kind: 'response' })); changed.threads[0]!.subject = 'current verified subject'
    f.emit(changed); await f.source.flush()
    const after = f.h.ledger.page().records[0]!
    expect(after.id).toBe(before.id); expect(after.eventId).not.toBe(before.eventId); expect(after.detail).toContain('current verified subject')
    expect(after.subjectState).toBe('response'); expect(f.events.some(event => event.announcement)).toBe(false)
    expect(after.revision).toBeGreaterThan(before.revision); expect(after.attentionRevision).toBe(before.attentionRevision)
    await f.h.owner.read(after.id, before.revision); expect(f.h.ledger.page().summary.unread).toBe(0) // Quiet native repair does not invent a new user demand.
  } finally { await f.cleanup() }
})

it('confirmed delta projection updates only new/changed messages in a 231-message run; receipt-only native revisions create no message writes', async () => {
  const f = fixture(), rows = Array.from({ length: 231 }, (_, index) => message(`message-${index}`))
  try {
    f.emit(snapshot(...rows)); await f.source.flush()
    const writes = vi.mocked(f.h.port.commitSource).mock.calls.length
    f.emit({ ...snapshot(...rows, message('new-human')), revision: 6 }); await f.source.flush()
    expect(f.h.port.commitSource).toHaveBeenCalledTimes(writes + 1)
    expect(vi.mocked(f.h.port.commitSource).mock.calls.at(-1)?.[3]).toHaveLength(1)
    const following = vi.mocked(f.h.port.commitSource).mock.calls.length
    f.emit({ ...snapshot(...rows, message('new-human')), revision: 7 }); await f.source.flush()
    expect(f.h.port.commitSource).toHaveBeenCalledTimes(following)
    expect(f.h.ledger.page().summary.total).toBe(232)
  } finally { await f.cleanup() }
})

it('unknown second-batch ACK resumes the actual compact checkpoint on the next original frame, not on a timer or replay', async () => {
  const f = fixture(), rows = Array.from({ length: 231 }, (_, index) => message(`message-${index}`))
  try {
    let writes = 0
    vi.mocked(f.h.port.commitSource).mockImplementation(async (...args) => { const result = f.h.ledger.commitSource(...args); if (++writes === 2) throw Error('ACK unknown'); return result })
    f.emit(snapshot(...rows)); await f.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(200); expect(writes).toBe(2)
    await f.source.flush(); expect(writes).toBe(2)
    f.emit(snapshot(...rows)); await f.source.flush(); expect(f.h.ledger.page().summary.total).toBe(231); expect(writes).toBe(3)
    expect((f.h.ledger.sourceState(key).data as OperatorMessageState).pendingMessages).toBeUndefined()
    expect(vi.mocked(f.h.port.commitSource).mock.calls.every(([, , , drafts]) => drafts.length <= 100)).toBe(true)
    expect(f.events.some(event => event.announcement)).toBe(false)
  } finally { await f.cleanup() }
})

it('the new private metadata read is bounded and exact; cleared records stay cleared on restored current original facts', async () => {
  const f = fixture()
  try {
    expect(() => f.h.ledger.operatorMessageRecords(['task:foreign'])).toThrow()
    expect(() => f.h.ledger.operatorMessageRecords(Array(101).fill('operator-message:x'))).toThrow()
    f.emit(snapshot(message('human'))); await f.source.flush()
    const record = f.h.ledger.page().records[0]!; await f.h.owner.read(record.id, record.revision); await f.h.owner.clearRead({ key: record.key })
    f.emit(snapshot()); await f.source.flush(); f.emit(snapshot(message('human'))); await f.source.flush()
    expect(f.h.ledger.page().summary.total).toBe(0); expect(f.h.ledger.operatorMessageRecords([record.key])).toEqual([])
    expect(f.h.ledger.marker(record.key).cleared).toBe(true)
  } finally { await f.cleanup() }
})

it('sleep pauses incoming observations; the next genuine wake read is quiet, and close detaches the new power/read subscriptions', async () => {
  const f = fixture()
  try {
    f.emit(snapshot()); await f.source.flush(); f.power.emit('suspend')
    f.emit(snapshot(message('during-sleep'))); await f.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.power.emit('resume'); await f.source.flush(); expect(f.h.ledger.page().summary.total).toBe(0)
    f.emit(snapshot(message('during-sleep'))); await f.source.flush()
    expect(f.events.some(event => event.announcement)).toBe(false)
    await f.close(); expect(f.power.listenerCount('suspend')).toBe(0); expect(f.power.listenerCount('resume')).toBe(0)
  } finally { await f.cleanup() }
})

it('50,000 actual team-message:UUID identities fit the existing 2 MiB checkpoint losslessly, with only constant-size durable progress added', async () => {
  const h = notificationSourceHarness()
  try {
    const seen = Array.from({ length: 50_000 }, (_, index) => `team-message:00000000-0000-0000-0000-${String(index).padStart(12, '0')}`)
    const old = readOperatorMessageState({ version: 1, key, seen }, key)!
    const result = reduceOperatorMessages(old, { key, facts: [], now: 100, currentRead: true, scope, nativeRevision: 1, signature: '1'.repeat(64) }, true, 2)
    expect(result.drafts).toHaveLength(100); expect(result.complete).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(result.state))).toBeLessThan(2 * 1024 * 1024)
    expect(result.state.seen).toHaveLength(50_000); expect(JSON.stringify(result.state.pendingMessages)).not.toContain('remaining')
    expect(result.state.seenEncoding).toBe('team-message-uuid'); expect(operatorMessageIds(result.state)).toEqual(seen)
    expect(operatorMessageIds(readOperatorMessageState(JSON.parse(JSON.stringify(result.state)), key)!)).toEqual(seen)
    expect(() => h.ledger.commitSource(key, 0, result.state, [], 100)).not.toThrow()
    expect(() => readOperatorMessageState({ version: 1, key, seen: ['duplicate', 'duplicate'] }, key)).toThrow()
    expect(() => readOperatorMessageState({ ...result.state, pendingMessages: { ...result.state.pendingMessages, presentAfter: 'foreign-id' } }, key)).toThrow()
  } finally { await h.owner.close() }
})

it('an accepted complete untrimmed message frame can advance beyond the old 64-batch guard without adding another original read', async () => {
  let revision = 1, writes = 0, failures = 0, maxBatch = 0
  let state: OperatorMessageState = { version: 1, key, seen: Array.from({ length: 6501 }, (_, index) => `team-message:00000000-0000-0000-0000-${String(index).padStart(12, '0')}`) }
  const owner = { sourceState: async () => ({ revision, data: state }), reportHistoryGap: () => { ++failures },
    commitSource: async (_key: string, expected: number, value: unknown, drafts: import('../src/domain/notification').NotificationDraft[]) => {
      expect(expected).toBe(revision); ++writes; maxBatch = Math.max(maxBatch, drafts.length); state = value as OperatorMessageState
      return { applied: true, source: { revision: ++revision, data: state }, changes: [] }
    } }
  const source = new NotificationProjectionSource<OperatorMessageInput, OperatorMessageState>(owner, readOperatorMessageState, reduceOperatorMessages, input => input.signature!, undefined, 512)
  try {
    source.observe(key, { key, facts: [], currentRead: true, scope, nativeRevision: 1, signature: '1'.repeat(64), now: 10_000 }); await source.flush()
    expect(writes).toBe(66); expect(maxBatch).toBe(100); expect(failures).toBe(0); expect(state.pendingMessages).toBeUndefined()
    expect(operatorMessageIds(state)).toHaveLength(6501)
  } finally { await source.close() }
})

it('an ID preserved in different original scopes does not get swallowed by a higher old record counter, and A/B/A reentry rechecks the current original facts', async () => {
  const f = fixture()
  const original = snapshot(message('shared-native-id'))
  try {
    f.emit(original); await f.source.flush()
    f.emit(snapshot(message('shared-native-id', { kind: 'response' }))); await f.source.flush()
    f.emit(original); await f.source.flush()
    const oldRevision = f.h.ledger.page().records[0]!.sourceRevision
    const secondTeam = notificationTeam(); secondTeam.activeWorkspaceId = 'workspace-b'; secondTeam.activeRun = { ...secondTeam.activeRun!, id: 'run-b', workspaceId: 'workspace-b' }
    const second = { ...snapshot(message('shared-native-id', { runId: 'run-b', groupId: 'group-b', kind: 'response' })), runId: 'run-b' }
    f.emit(second, { context: secondTeam }); await f.source.flush()
    const inSecond = f.h.ledger.page().records[0]!
    expect(inSecond.scope).toMatchObject({ workspaceId: 'workspace-b', runId: 'run-b', groupId: 'group-b' }); expect(inSecond.sourceRevision).toBeGreaterThan(oldRevision)
    f.emit(original); await f.source.flush()
    const returned = f.h.ledger.page().records[0]!
    expect(returned.scope).toMatchObject({ ...scope, groupId: 'group-a' }); expect(returned.subjectState).toBe('question'); expect(returned.sourceRevision).toBeGreaterThan(inSecond.sourceRevision)
  } finally { await f.cleanup() }
})

it('real original collaboration getter reuses one TeamControl read and one loadRun, preserves order and observer errors, and never calls original mutations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sg-operator-read-')), path = join(directory, 'business.sqlite')
  const repository = new SqliteTeamControlRepository(path), messageRepository = new SqliteTeamCollaborationRepository(path), h = notificationSourceHarness()
  const frame = notificationFrame({ sessions: [] }), control = new TeamControlService(repository, { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: () => ({ commandId: 'unused' }) }), messages = new TeamCollaborationService(messageRepository, control)
  const connected = connectOperatorMessageNotifications(messages, () => { throw Error('extra team read forbidden') }, h.owner)
  let database: DatabaseSync | undefined
  try {
    const pool = control.createSessionPool({ workspaceId: 'operator-workspace', workspaceName: 'fixture', workspacePath: '/fixture-no-cursor', members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true }] })
    const group = repository.createGroup({ runId: pool.activeRun!.id, name: 'fixture', members: [{ slotId: pool.members[0]!.slot.id, roleTemplateKey: 'builder' }], at: 1 }).group
    const original = messageRepository.createMessage({ runId: pool.activeRun!.id, groupId: group.id, sender: { type: 'agent', slotId: pool.members[0]!.slot.id }, recipient: { type: 'operator' },
      kind: 'question', content: 'PRIVATE original body', subject: 'original', clientMessageId: 'operator-read-fixture' })
    const order: string[] = [], get = control.getSnapshot.bind(control), load = messageRepository.loadRun.bind(messageRepository)
    const teamGet = vi.spyOn(control, 'getSnapshot').mockImplementation(() => { order.push('team'); return get() }), messageLoad = vi.spyOn(messageRepository, 'loadRun').mockImplementation(runId => { order.push('messages'); return load(runId) })
    const markRead = vi.spyOn(messageRepository, 'markRead'), acknowledge = vi.spyOn(messageRepository, 'acknowledge'), create = vi.spyOn(messageRepository, 'createMessage')
    messages.subscribeReadObservation(() => { throw Error('observer metadata error') })
    const snapshot = messages.getSnapshot(); await connected.source.flush()
    expect(teamGet).toHaveBeenCalledOnce(); expect(messageLoad).toHaveBeenCalledOnce(); expect(order).toEqual(['team', 'messages'])
    const record = h.ledger.page().records[0]!
    await h.owner.read(record.id, record.revision); expect(markRead).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
    database = new DatabaseSync(path); database.prepare("UPDATE team_messages SET kind='response' WHERE id=?").run(original.id)
    const changed = messages.getSnapshot(); await connected.source.flush()
    expect(changed.revision).toBe(snapshot.revision); expect(h.ledger.page().records[0]?.subjectState).toBe('response')
    expect(messageRepository.loadRun(pool.activeRun!.id).messages[original.id]?.receipt.readAt).toBeUndefined()
  } finally { database?.close(); await connected.close(); await h.owner.close(); messages.dispose(); control.dispose(); messageRepository.close(); repository.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('complete original catalogue disappearance expires operator messages without active-page guessing; presence alone does not restore them', async () => {
  const f = fixture()
  let catalogueListener!: Parameters<Parameters<typeof connectNativeScopeAvailabilityNotifications>[0]['subscribeReadObservation']>[0]
  const noSource = { flush: async () => {}, invalidateCheckpoint: () => {} }
  const catalogue = connectNativeScopeAvailabilityNotifications({ getReadOwnerId: () => 'catalogue-owner', subscribeReadObservation: listener => { catalogueListener = listener; return () => {} } }, f.h.owner,
    { 'operator-messages:': f.source, 'task-notifications:': noSource, 'group-topology:': noSource, 'memory-issues:': noSource })
  try {
    f.emit(snapshot(message('human'), message('status', { kind: 'status' }))); await f.source.flush()
    const empty = notificationTeam(); empty.runs = []; empty.activeRun = undefined; empty.workspaces = []
    catalogueListener({ snapshot: empty, stamp: { owner: 'catalogue-owner', sequence: 1 }, catalogue: { workspaceIds: [], runs: [] } }); await catalogue.flush()
    expect(f.h.ledger.page().records.every(record => record.subjectState === 'scope-unconfirmed' && record.state === 'expired' && !record.target)).toBe(true)
    expect(f.h.ledger.page({ key: 'operator-message:status' }).records[0]?.attention).toBe('activity')
    const present = notificationTeam(); present.workspaces = [{ id: scope.workspaceId, name: 'fixture', path: '/fixture', createdAt: 1, updatedAt: 1 }]
    catalogueListener({ snapshot: present, stamp: { owner: 'catalogue-owner', sequence: 2 }, catalogue: { workspaceIds: [scope.workspaceId], runs: [scope] } }); await catalogue.flush()
    expect(f.h.ledger.page().records[0]?.subjectState).toBe('scope-unconfirmed')
    f.emit(snapshot(message('human'), message('status', { kind: 'status' }))); await f.source.flush()
    expect(f.h.ledger.page({ key: 'operator-message:human' }).records[0]?.subjectState).toBe('question')
    expect(f.events.some(event => event.announcement)).toBe(false)
  } finally { await catalogue.close(); await f.cleanup() }
})
