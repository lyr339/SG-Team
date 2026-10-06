import { createHash } from 'node:crypto'
import { it, expect, vi } from 'vitest'
import { connectNativeScopeAvailabilityNotifications } from '../src/application/notifications/native-scope-availability'
import { nativeCheckpointScope, readNativeScopeCheckpoint, reduceMissingNativeScope } from '../src/domain/native-scope-notification'
import { validateNativeScopeCatalogue, type NativeScopeRef, type NativeScopeSourcePrefix } from '../src/domain/native-scope-availability'
import { reduceTaskNotifications, readTaskNotificationState, type TaskNotificationState } from '../src/domain/task-notification'
import { reduceGroupTopologyNotifications, readGroupTopologyState } from '../src/domain/group-topology-notification'
import { readMemoryIssueState, reduceMemoryIssueNotifications } from '../src/domain/memory-issue-notification'
import { emptyTeamControlSnapshot, type TeamControlReadObservation, type TeamControlSnapshot } from '../src/domain/team-control'
import type { NotificationDraft, NotificationPush } from '../src/domain/notification'
import { notificationSourceHarness } from './notification-source-fixtures'
import type { NotificationRepositoryLifecycle } from '../src/application/notification-repository'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const scope = { workspaceId: 'workspace-a', runId: 'run-a' }
const keyFor = (prefix: NativeScopeSourcePrefix, ref = scope) => `${prefix}${hash([ref.workspaceId, ref.runId])}`
function snapshot(scopes: NativeScopeRef[] = []): TeamControlSnapshot {
  return { ...emptyTeamControlSnapshot(), workspaces: [...new Set(scopes.map(ref => ref.workspaceId))].map(id => ({ id, name: id, path: '/fixture', createdAt: 1, updatedAt: 1 })),
    runs: scopes.map(ref => ({ id: ref.runId, workspaceId: ref.workspaceId, name: ref.runId, goal: '', templateId: 'fixture', status: 'running', createdAt: 1, updatedAt: 1 })) }
}
function observer(h: ReturnType<typeof notificationSourceHarness>) {
  let listener!: (value: TeamControlReadObservation) => void, sequence = 0
  const team = { getReadOwnerId: () => 'owned-catalogue', subscribeReadObservation: (value: typeof listener) => { listener = value; return vi.fn() } }
  const source = () => ({ flush: vi.fn(async () => {}), invalidateCheckpoint: vi.fn() })
  const sources = { 'group-topology:': source(), 'memory-issues:': source(), 'task-notifications:': source() }
  const events: NotificationPush[] = []; h.owner.subscribe(event => events.push(event))
  const connected = connectNativeScopeAvailabilityNotifications(team, h.owner, sources, { now: () => 20_000 })
  const emit = (value = snapshot(), override: Partial<TeamControlReadObservation> = {}) => listener({ snapshot: value,
    catalogue: { workspaceIds: value.workspaces.map(workspace => workspace.id), runs: value.runs.map(run => ({ workspaceId: run.workspaceId, runId: run.id })) },
    stamp: { owner: 'owned-catalogue', sequence: ++sequence }, ...override })
  return { ...connected, emit, sources, events }
}
function seedTasks(h: ReturnType<typeof notificationSourceHarness>, ref = scope, count = 1, descriptor = true) {
  const key = keyFor('task-notifications:', ref)
  const state: TaskNotificationState = { version: 1, key, nativeRevision: 5, rows: {}, ...(descriptor ? { observedScope: ref } : {}) }
  const drafts: NotificationDraft[] = []
  for (let index = 0; index < count; index++) {
    const id = `${ref.runId}-task-${index}`
    state.rows[id] = { status: 'failed', recorded: true, scope: ref, title: `original-${index}` }
    drafts.push({ key: `task:${id}`, category: 'team', eventType: 'task.state', eventId: `original:${id}`, subjectState: 'failed', source: '组任务', title: `original-${index}`,
      attention: 'notice', tone: 'warning', state: 'active', scope: ref, sourceRevision: 1, occurredAt: 1, announce: false })
  }
  let revision = 0
  do { const batch = drafts.splice(0, 100); h.ledger.commitSource(key, revision++, state, batch, 10_000) } while (drafts.length)
  return { key, state }
}

it('uses ordered complete original catalogues, not current selection, completed status, stale stamps or clipped projections', async () => {
  const h = notificationSourceHarness(), seeded = seedTasks(h), source = observer(h)
  try {
    const present = snapshot([scope]); present.runs[0]!.status = 'completed'
    source.emit(present); await source.flush()
    expect(h.ledger.page().records[0]?.subjectState).toBe('failed')
    const queries = vi.mocked(h.port.listNativeSources!).mock.calls.length
    for (let index = 0; index < 40; index++) source.emit(present)
    await source.flush(); expect(h.port.listNativeSources).toHaveBeenCalledTimes(queries)
    source.emit(snapshot(), { stamp: { owner: 'other', sequence: 100 } }); await source.flush()
    expect(h.ledger.sourceState(seeded.key).revision).toBe(1)
    source.emit(snapshot(), { catalogue: undefined }); await source.flush()
    source.emit(present, { catalogue: { workspaceIds: [], runs: [] } }); await source.flush()
    expect(h.ledger.sourceState(seeded.key).revision).toBe(1)
    source.emit(); await source.flush(); await h.owner.flush()
    expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'scope-unconfirmed', state: 'expired', attentionRevision: 1 })
    expect(h.ledger.page().records[0]?.detail).toContain('不据此判断任务完成、取消')
    expect(source.events.some(event => event.announcement)).toBe(false)
    const repaired = readTaskNotificationState(h.ledger.sourceState(seeded.key).data, seeded.key)!
    expect(repaired.rows['run-a-task-0']?.status).toBe('failed'); expect(repaired.scopeMissing).toMatchObject({ rowsClosed: true, summaryClosed: true })
    expect(source.sources['task-notifications:'].invalidateCheckpoint).toHaveBeenCalledWith(seeded.key)
  } finally { await source.close(); await h.owner.close() }
})

it('keyset enumerates more than 200 historical scopes and exposes only thin descriptors, not source payloads or bodies', async () => {
  const h = notificationSourceHarness(), source = observer(h)
  try {
    for (let index = 0; index < 205; index++) seedTasks(h, { workspaceId: `workspace-${index}`, runId: `run-${index}` }, 0)
    const first = h.ledger.listNativeSources({ prefix: 'task-notifications:', limit: 100 })
    expect(first.rows).toHaveLength(100); expect(first.nextKey).toBe(first.rows.at(-1)?.key)
    expect(Object.keys(first.rows[0]!)).toEqual(['key', 'revision', 'scope'])
    expect(() => h.ledger.listNativeSources({ prefix: 'task-notifications:', after: 'wrong-prefix:' + '0'.repeat(64) })).toThrow()
    source.emit(); await source.flush()
    expect(vi.mocked(h.port.listNativeSources!).mock.calls.filter(([query]) => query.prefix === 'task-notifications:')).toHaveLength(3)
    for (const row of h.ledger.listNativeSources({ prefix: 'task-notifications:' }).rows) expect((h.ledger.sourceState(row.key).data as TaskNotificationState).scopeMissing).toMatchObject({ rowsClosed: true, summaryClosed: true })
    expect(h.ledger.page().summary.total).toBe(0)
  } finally { await source.close(); await h.owner.close() }
})

it('an unidentified legacy hydration checkpoint and a corrupt independent row cannot starve known task scopes', async () => {
  const h = notificationSourceHarness(), seeded = seedTasks(h), source = observer(h), groupKey = keyFor('group-topology:')
  try {
    h.ledger.commitSource(groupKey, 0, { version: 1, key: groupKey, revision: 1, groups: {} }, [], 1)
    const corrupt = keyFor('memory-issues:')
    h.ledger.commitSource(corrupt, 0, { version: 99, key: corrupt, observedScope: scope, rows: {} }, [], 1)
    source.emit(); await source.flush(); await h.owner.flush()
    expect(h.ledger.sourceState(groupKey).revision).toBe(1); expect(h.ledger.sourceState(corrupt).revision).toBe(1)
    expect((h.ledger.sourceState(seeded.key).data as TaskNotificationState).scopeMissing?.rowsClosed).toBe(true)
    expect(h.owner.status().historyIncomplete).toBe(true)
  } finally { await source.close(); await h.owner.close() }
})

it('a private storage generation change invalidates a delayed directory receipt; restoration waits for another original frame', async () => {
  let lifecycle!: (event: NotificationRepositoryLifecycle) => void
  const h = notificationSourceHarness(':memory:', listener => { lifecycle = listener; return () => {} }), seeded = seedTasks(h), source = observer(h)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(h.port.listNativeSources!).mockImplementationOnce(async query => { const page = h.ledger.listNativeSources(query); entered(); await gate; return page })
  try {
    lifecycle({ state: 'recovered', generation: 1 }); await h.owner.flush()
    source.emit(); await waiting
    lifecycle({ state: 'unavailable', generation: 1 }); lifecycle({ state: 'recovered', generation: 2 })
    release(); await source.flush(); await h.owner.flush()
    expect(h.ledger.sourceState(seeded.key).revision).toBe(1)
    const queries = vi.mocked(h.port.listNativeSources!).mock.calls.length
    await source.flush(); expect(h.port.listNativeSources).toHaveBeenCalledTimes(queries)
    source.emit(); await source.flush(); expect(h.ledger.page().records[0]?.subjectState).toBe('scope-unconfirmed')
  } finally { release(); await source.close(); await h.owner.close() }
})

it('persists bounded progress after an unknown second-batch ACK, resumes only on another original catalogue, and never resurrects cleared records', async () => {
  const h = notificationSourceHarness(), seeded = seedTasks(h, scope, 231), source = observer(h)
  try {
    const cleared = h.ledger.page({ key: 'task:run-a-task-0' }).records[0]!
    await h.owner.read(cleared.id, cleared.revision); await h.owner.clearRead({ key: cleared.key })
    let writes = 0
    vi.mocked(h.port.commitSource).mockImplementation(async (...args) => {
      const result = h.ledger.commitSource(...args)
      if (++writes === 2) throw Error('second batch ACK unknown')
      return result
    })
    source.emit(); await source.flush()
    const partial = h.ledger.sourceState(seeded.key).data as TaskNotificationState
    expect(partial.scopeMissing).toMatchObject({ rowsClosed: false, summaryClosed: false }); expect(Object.values(partial.rows).filter(row => !row.priorData)).toHaveLength(31); expect(writes).toBe(2)
    await source.flush(); expect(writes).toBe(2) // No automatic retry or original reread.
    source.emit(); await source.flush(); await h.owner.flush()
    const final = h.ledger.sourceState(seeded.key).data as TaskNotificationState
    expect(final.scopeMissing).toMatchObject({ rowsClosed: true, summaryClosed: true }); expect(writes).toBe(3)
    expect(h.ledger.page({ key: cleared.key }).summary.total).toBe(0)
    expect(h.ledger.page({ filter: 'pending' }).summary.pending).toBe(0)
    expect(source.events.some(event => event.announcement)).toBe(false)
    expect(vi.mocked(h.port.commitSource).mock.calls.every(([, , , drafts]) => drafts.length <= 100)).toBe(true)
  } finally { await source.close(); await h.owner.close() }
})

it('a newer original catalogue or suspend fences late private reads; wake needs a new genuine frame, and close drains accepted work', async () => {
  const h = notificationSourceHarness(), seeded = seedTasks(h), source = observer(h)
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(h.owner, 'sourceMarker').mockImplementationOnce(async key => { entered(); await gate; return h.ledger.marker(key) })
  try {
    source.emit(); await waiting
    source.emit(snapshot([scope])); release(); await source.flush()
    expect(h.ledger.sourceState(seeded.key).revision).toBe(1)
    source.suspend(); source.emit(); await source.flush(); source.resume(); await source.flush()
    expect(h.ledger.sourceState(seeded.key).revision).toBe(1)
    source.emit(); await source.close()
    expect((h.ledger.sourceState(seeded.key).data as TaskNotificationState).scopeMissing?.summaryClosed).toBe(true)
    const revision = h.ledger.sourceState(seeded.key).revision
    source.emit(snapshot([scope])); await source.flush(); expect(h.ledger.sourceState(seeded.key).revision).toBe(revision)
  } finally { release(); await source.close(); await h.owner.close() }
})

it('legacy row scopes are recovered from exact private identities; malformed or mismatched scope metadata remains untouched', async () => {
  const h = notificationSourceHarness(), seeded = seedTasks(h, scope, 1, false), source = observer(h)
  try {
    expect(nativeCheckpointScope(readNativeScopeCheckpoint(seeded.state, seeded.key, 'task-notifications:')!)).toEqual(scope)
    source.emit(); await source.flush()
    expect(h.ledger.page().records[0]?.subjectState).toBe('scope-unconfirmed')
    const wrongKey = keyFor('task-notifications:', { ...scope, runId: 'other-run' })
    h.ledger.commitSource(wrongKey, 0, { ...seeded.state, key: wrongKey, observedScope: scope }, [], 20_000)
    source.emit(snapshot([{ workspaceId: 'work-b', runId: 'run-b' }])); await source.flush()
    expect(h.ledger.sourceState(wrongKey).revision).toBe(1)
    expect(() => validateNativeScopeCatalogue({ workspaceIds: [], runs: [scope] })).toThrow()
    expect(() => validateNativeScopeCatalogue({ workspaceIds: ['workspace-a'], runs: Array(1) })).toThrow()
    expect(() => readTaskNotificationState({ ...seeded.state, observedScope: scope,
      rows: { t: { status: 'failed', scope: { workspaceId: 'other-workspace', runId: scope.runId } } } }, seeded.key)).toThrow()
    expect(() => readTaskNotificationState({ ...seeded.state, observedScope: scope, scopeMissing: { episode: 'a'.repeat(64), at: 1, summaryClosed: true, rowsClosed: false, after: 4 } }, seeded.key)).toThrow()
  } finally { await source.close(); await h.owner.close() }
})

it('quietly repairs legacy group records and pending rebase summaries without inventing hydration-only history', async () => {
  const h = notificationSourceHarness(), source = observer(h), key = keyFor('group-topology:')
  try {
    const identity = hash(['original-group']), baseline = hash(['never-announced'])
    const state = { version: 1, key, revision: 4, groups: {
      group: { id: 'group', identity, name: 'original', status: 'active', planning: 'members', members: [] },
      baseline: { id: 'baseline', identity: baseline, name: 'stock', status: 'active', planning: 'members', members: [] }
    }, rebases: 1, pendingRebase: { from: 5, to: 4, missing: [] } }
    const draft: NotificationDraft = { key: `group-topology:${identity}`, eventType: 'group.topology', title: 'old', category: 'team', source: '协作组', state: 'resolved', attention: 'activity', tone: 'info',
      scope: { ...scope, groupId: 'group' }, sourceRevision: 1, occurredAt: 1 }
    h.ledger.commitSource(key, 0, state, [draft, { ...draft, key: `group-rebase:${key.slice(-64)}:1`, eventType: 'group.rebase', state: 'active', attention: 'notice' }], 10_000)
    source.emit(); await source.flush()
    expect(h.ledger.page({ eventType: 'group.topology' }).summary.total).toBe(1)
    expect(h.ledger.page({ eventType: 'group.rebase' }).records[0]).toMatchObject({ subjectState: 'scope-unconfirmed', state: 'expired' })
    const saved = readGroupTopologyState(h.ledger.sourceState(key).data, key)!
    expect(saved.pendingRebase).toBeUndefined(); expect(saved.scopeMissing).toMatchObject({ rowsClosed: true, summaryClosed: true })
  } finally { await source.close(); await h.owner.close() }
})

it('scope presence alone cannot restore a result; only the matching current specific read does, with fresh event identity and no old proof/live success replay', () => {
  const taskKey = keyFor('task-notifications:'), memoryKey = keyFor('memory-issues:'), groupKey = keyFor('group-topology:')
  const initial = { episode: '1'.repeat(64), at: 10 }, memoryIdentity = '2'.repeat(64), groupIdentity = '3'.repeat(64)
  const task = { version: 1 as const, key: taskKey, nativeRevision: 5, observedScope: scope, rows: { t: { status: 'done' as const, recorded: true, scope, title: 'old' } } }
  const taskMissing = readTaskNotificationState(reduceMissingNativeScope({ kind: 'task', state: task }, scope, initial, 2).state, taskKey)!
  const input = { key: taskKey, now: 20, completed: false, scope, nativeRevision: 5, facts: [{ id: 't', title: 'old', status: 'done' as const, scope, at: 1 }] }
  expect(reduceTaskNotifications(taskMissing, input, false, 3).drafts).toEqual([])
  const returned = reduceTaskNotifications(taskMissing, { ...input, currentRead: true }, true, 3)
  expect(returned.state.scopeMissing).toBeUndefined(); expect(returned.drafts[0]?.eventId).toContain(':data:1'); expect(returned.drafts.every(draft => !draft.announce)).toBe(true)
  expect(returned.drafts.at(-1)?.title).toContain('重新确认')
  const memory = { version: 1 as const, key: memoryKey, revision: 5, observedScope: scope, rows: { [memoryIdentity]: { identity: memoryIdentity, id: 'memory', version: 1, title: 'old', recorded: true, ceased: false,
    scope, state: 'operator-review' as const, operatorReview: { messageId: 'request', createdAt: 1, reason: 'timeout' as const, live: true } } } }
  const memoryMissing = readMemoryIssueState(reduceMissingNativeScope({ kind: 'memory', state: memory }, scope, initial, 2).state, memoryKey)!
  expect(memoryMissing.rows[memoryIdentity]?.operatorReview).toBeUndefined()
  const memoryReturned = reduceMemoryIssueNotifications(memoryMissing, { key: memoryKey, scope, currentRead: true, revision: 5, now: 20,
    facts: [{ identity: memoryIdentity, id: 'memory', version: 1, title: 'current', scope, state: 'eligible', ceased: false }] }, true, 3)
  expect(memoryReturned.drafts.some(draft => draft.attention === 'action')).toBe(false)
  const group = { version: 1 as const, key: groupKey, revision: 5, observedScope: scope, groups: { g: { id: 'g', identity: groupIdentity, name: 'old', status: 'active' as const, planning: 'members' as const, members: [] } } }
  const groupMissing = readGroupTopologyState(reduceMissingNativeScope({ kind: 'group', state: group }, scope, initial, 2).state, groupKey)!
  const groupReturned = reduceGroupTopologyNotifications(groupMissing, { key: groupKey, ...scope, currentRead: true, revision: 5, now: 20, facts: Object.values(group.groups) }, true, 3)
  expect(groupReturned.drafts.at(-1)?.title).toContain('重新确认'); expect(groupReturned.drafts.every(draft => !draft.announce)).toBe(true)
})

it('multi-batch source return preserves its reason at a newer native revision, including legacy tasks without a saved native counter', () => {
  const key = keyFor('task-notifications:'), facts = Array.from({ length: 231 }, (_, index) => ({ id: `task-${index}`, title: `original-${index}`, status: 'failed' as const, scope, at: 1 }))
  let state: TaskNotificationState = { version: 1, key, observedScope: scope, nativeRevision: 1,
    rows: Object.fromEntries(facts.map(fact => [fact.id, { status: fact.status, scope, title: fact.title, recorded: true, priorData: true }])),
    scopeMissing: { episode: '1'.repeat(64), at: 1, rowsClosed: true, summaryClosed: true } }
  const input = { key, now: 20, completed: false, currentRead: true, nativeRevision: 9, scope, facts }
  const first = reduceTaskNotifications(state, input, true, 2)
  expect(first.complete).toBe(false); expect(first.state.pendingRebase).toMatchObject({ from: 1, to: 9, origin: 'scope-returned' })
  state = readTaskNotificationState(first.state, key)!
  const second = reduceTaskNotifications(state, input, true, 3)
  state = readTaskNotificationState(second.state, key)!
  const third = reduceTaskNotifications(state, input, true, 4)
  expect(third.complete).toBe(true); expect(third.drafts.at(-1)?.title).toContain('重新确认')
  expect([first, second, third].every(result => result.drafts.length <= 100 && result.drafts.every(draft => !draft.announce))).toBe(true)
  const legacy = { ...first.state, nativeRevision: undefined, pendingRebase: undefined,
    scopeMissing: { episode: '2'.repeat(64), at: 1, rowsClosed: true, summaryClosed: true } }
  const returned = reduceTaskNotifications(legacy, input, true, 5)
  expect(JSON.stringify(returned)).not.toContain('NaN')
  expect(() => readTaskNotificationState(returned.state, key)).not.toThrow()
})

it('a returned scope with absent original entities replaces the scope-unknown wording with prior-data, not a terminal workflow guess', () => {
  const taskKey = keyFor('task-notifications:'), groupKey = keyFor('group-topology:'), memoryKey = keyFor('memory-issues:'), identity = '5'.repeat(64)
  const missing = { episode: '4'.repeat(64), at: 1, rowsClosed: true, summaryClosed: true }
  const task = reduceTaskNotifications({ version: 1, key: taskKey, observedScope: scope, nativeRevision: 1, scopeMissing: missing,
    rows: { t: { status: 'failed', priorData: true, recorded: true, scope } } }, { key: taskKey, now: 2, completed: false, currentRead: true, nativeRevision: 3, scope, facts: [] }, true, 3)
  expect(task.drafts[0]).toMatchObject({ key: 'task:t', subjectState: 'prior-data', state: 'expired' })
  const group = reduceGroupTopologyNotifications({ version: 1, key: groupKey, observedScope: scope, revision: 1, scopeMissing: missing, priorData: ['g'],
    groups: { g: { id: 'g', identity, name: 'old', status: 'active', planning: 'members', members: [] } } }, { key: groupKey, ...scope, revision: 3, now: 2, currentRead: true, facts: [] }, true, 3)
  expect(group.drafts[0]).toMatchObject({ key: `group-topology:${identity}`, subjectState: 'prior-data', state: 'expired' })
  const memory = reduceMemoryIssueNotifications({ version: 1, key: memoryKey, observedScope: scope, revision: 1, scopeMissing: missing,
    rows: { [identity]: { identity, id: 'm', version: 1, title: 'old', state: 'conflict', priorData: true, recorded: true, ceased: true, scope } } },
  { key: memoryKey, scope, revision: 3, now: 2, currentRead: true, facts: [] }, true, 3)
  expect(memory.drafts[0]).toMatchObject({ key: `memory-issue:${identity}`, subjectState: 'prior-data', state: 'expired' })
})
