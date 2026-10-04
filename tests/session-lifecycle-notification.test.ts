import { describe, expect, it } from 'vitest'
import { readSessionLifecycleCheckpoint, reduceSessionLifecycleNotifications, type NotificationSessionFact, type SessionLifecycleCheckpoint, type SessionLifecycleObservation } from '../src/domain/session-lifecycle-notification'

const fact = (patch: Partial<NotificationSessionFact> = {}): NotificationSessionFact => ({ identity: 'real-identity-1', name: '前端体验 · CH-3',
  scope: { workspaceId: 'a', runId: 'run-a', slotId: 'slot-3', sessionId: 'session-3', channelId: '3', composerId: 'composer-3', generation: '1', bindingGeneration: 'bind-1' },
  online: true, evidence: 'active', retired: false, liveAt: 900, boundAt: 50, pendingWork: false, ...patch })
const input = (facts = [fact()], patch: Partial<SessionLifecycleObservation> = {}): SessionLifecycleObservation => ({ scopeKey: 'workspace-a:run-a', workspaceId: 'a', runId: 'run-a',
  runCompleted: false, healthy: true, baseline: false, monitorStartedAt: 100, now: 1_000, facts, ...patch })
const reduce = (old?: SessionLifecycleCheckpoint, observation = input(), revision = 1) => reduceSessionLifecycleNotifications(old, observation, revision, () => 'incident-1')
describe('session lifecycle notification evidence', () => {
  it('stock online/offline and late hydration are baseline facts, not a wall of freshly-online notifications', () => {
    const initial = reduce(undefined, input([fact()], { baseline: true }))
    expect(initial.drafts).toHaveLength(0)
    const empty = reduce(undefined, input([], { baseline: true })).checkpoint
    expect(reduce(empty, input([fact({ boundAt: 50 })])).drafts).toHaveLength(0)
  })
  it('new bindings created during this monitoring lifetime produce quiet, per-session online facts', () => {
    const next = reduce(undefined, input([fact({ boundAt: 150 })], { baseline: true }))
    expect(next.drafts[0]).toMatchObject({ title: '前端体验 · CH-3 已上线', attention: 'activity', announce: false })
    expect(next.drafts[0]?.scope.sessionId).toBe('session-3')
  })
  it('plain suspected silence neither claims actual termination nor floods the unread badge', () => {
    const baseline = reduce(undefined, input([fact()], { baseline: true })).checkpoint
    const offline = reduce(baseline, input([fact({ online: false, evidence: 'suspected' })]), 2)
    expect(offline.drafts[0]).toMatchObject({ attention: 'activity', title: '前端体验 · CH-3 暂时失联', announce: false, timeBasis: 'observed' })
    expect(offline.drafts[0]?.detail).toContain('尚未确认')
    expect(reduce(offline.checkpoint, input([fact({ online: false, evidence: 'suspected' })]), 3).drafts).toHaveLength(0)
  })
  it('one incident upgrades to confirmed stop and closes on verified recovery without inventing a new session', () => {
    const base = reduce(undefined, input([fact()], { baseline: true })).checkpoint
    const suspect = reduce(base, input([fact({ online: false, evidence: 'suspected' })]), 2)
    const original = structuredClone(suspect.checkpoint)
    const stopped = reduce(suspect.checkpoint, input([fact({ online: false, evidence: 'stopped', pendingWork: true })], { now: 1_100 }), 3)
    expect(suspect.checkpoint).toEqual(original)
    expect(stopped.drafts[0]?.key).toBe(suspect.drafts[0]?.key)
    expect(stopped.drafts[0]).toMatchObject({ attention: 'action', announce: true, state: 'active' })
    const alive = reduce(stopped.checkpoint, input([fact({ liveAt: 1_200 })], { now: 1_200 }), 4)
    expect(alive.drafts[0]).toMatchObject({ key: stopped.drafts[0]!.key, title: '前端体验 · CH-3 已恢复连接', state: 'resolved', announce: true })
  })
  it('observer unavailable does not turn everyone into offline incidents, but existing positive stop evidence remains meaningful', () => {
    const base = reduce(undefined, input([fact()], { baseline: true })).checkpoint
    expect(reduce(base, input([fact({ online: false, evidence: 'suspected' })], { healthy: false })).drafts).toHaveLength(0)
    expect(reduce(base, input([fact({ online: false, evidence: 'stopped' })], { healthy: false })).drafts[0]?.title).toContain('已离线')
  })
  it('long tasks with final live evidence never create an offline event just because MCP timestamps are old', () => {
    const base = reduce(undefined, input([fact()], { baseline: true })).checkpoint
    expect(reduce(base, input([fact({ online: true, liveAt: 5 })], { now: 900_000 })).drafts).toHaveLength(0)
  })
  it('normal run completion and retirement close lifecycle records without claiming task or reply completion', () => {
    const base = reduce(undefined, input([fact()], { baseline: true })).checkpoint
    const stopped = reduce(base, input([fact({ online: false, evidence: 'stopped', pendingWork: true })]), 2)
    const ended = reduce(stopped.checkpoint, input([fact({ online: false, evidence: 'stopped', retired: true })], { runCompleted: true }), 3)
    const incident = ended.drafts.find(draft => draft.key === stopped.drafts[0]!.key)
    expect(incident).toMatchObject({ attention: 'activity', state: 'expired', announce: false })
    expect(incident?.detail).toContain('不代表未完成任务')
    expect(ended.checkpoint.rows[fact().identity]?.incident).toBeUndefined()
  })
  it('mere disappearance or changing observed scope is not an unexpected death', () => {
    const base = reduce(undefined, input([fact()], { baseline: true })).checkpoint
    expect(reduce(base, input([])).drafts).toHaveLength(0)
    expect(reduce(base, input([], { scopeKey: 'other-workspace' })).drafts).toHaveLength(0)
  })
  it('same-channel replacement cannot resolve old work or inherit the old incident as its own', () => {
    const base = reduce(undefined, input([fact()], { baseline: true })).checkpoint
    const stopped = reduce(base, input([fact({ online: false, evidence: 'stopped', pendingWork: true })]), 2)
    const replacement = fact({ identity: 'new-identity', scope: { ...fact().scope, sessionId: 'new-session', composerId: 'new-composer', generation: '2' }, boundAt: 1_100 })
    const next = reduce(stopped.checkpoint, input([replacement], { now: 1_200 }), 3)
    expect(next.checkpoint.rows['new-identity']?.incident).toBeUndefined()
    expect(next.drafts.find(draft => draft.key === stopped.drafts[0]?.key)?.detail).toContain('不会因为新会话上线而被当作完成')
  })
  it('restart/sleep baselines do not replay a new outage and restore existing recovery only with newer life evidence', () => {
    const base = reduce(undefined, input([fact()], { baseline: true })).checkpoint
    const stopped = reduce(base, input([fact({ online: false, evidence: 'stopped' })]), 2)
    expect(reduce(stopped.checkpoint, input([fact({ online: false, evidence: 'stopped' })], { baseline: true })).drafts).toHaveLength(0)
    expect(reduce(stopped.checkpoint, input([fact({ liveAt: 900 })], { baseline: true })).drafts).toHaveLength(0)
    expect(reduce(stopped.checkpoint, input([fact({ liveAt: 1_100 })], { baseline: true })).drafts[0]).toMatchObject({ state: 'resolved', announce: false })
  })
  it('rejects corrupt persisted state rather than manufacturing a fresh history baseline', () => {
    expect(() => readSessionLifecycleCheckpoint({ version: 999, rows: {} }, 'scope')).toThrow('检查点格式异常')
    expect(readSessionLifecycleCheckpoint(undefined, 'scope')).toBeUndefined()
  })
  it('correlates the exact intended restart without turning unrelated session failures into planned stops', () => {
    const other = fact({ identity: 'other', name: '后端开发 · CH-4', scope: { ...fact().scope, sessionId: 'session-4', channelId: '4', composerId: 'composer-4' } })
    const base = reduce(undefined, input([fact(), other], { baseline: true })).checkpoint
    const restart = { id: 'restart-1', label: '用户请求重启 Cursor', section: 'maintenance' as const, status: 'running' as const,
      targets: [{ identity: fact().identity, name: fact().name, scope: fact().scope }] }
    const next = reduce(base, input([fact({ online: false, evidence: 'stopped' }), { ...other, online: false, evidence: 'stopped' }], { restart }), 2)
    expect(next.drafts.filter(draft => draft.category === 'sessions').map(draft => draft.scope.channelId)).toEqual(['4'])
    expect(next.checkpoint.rows[fact().identity]?.expectedRestartId).toBe('restart-1')
    const done = reduce(next.checkpoint, input([fact({ online: false, evidence: 'stopped' }), { ...other, online: false, evidence: 'stopped' }], { restart: { ...restart, status: 'done' } }), 3)
    expect(done.drafts.find(draft => draft.key === 'cursor-restart:restart-1')).toMatchObject({ title: 'Cursor 已重启，1 个原会话尚未恢复', tone: 'warning' })
    expect(done.drafts.filter(draft => draft.category === 'sessions')).toHaveLength(0)
  })
  it('a stored restart interrupted by app exit becomes unconfirmed, not falsely successful or automatically retried', () => {
    const restart = { id: 'restart-1', label: '重启', section: 'maintenance' as const, status: 'running' as const,
      targets: [{ identity: fact().identity, name: fact().name, scope: fact().scope }] }
    const base = reduce(undefined, input([fact()], { baseline: true, restart })).checkpoint
    const resumed = reduce(base, input([fact({ online: false, evidence: 'stopped' })], { baseline: true }), 2)
    expect(resumed.checkpoint.restart?.status).toBe('unknown')
    expect(resumed.drafts.find(draft => draft.key === 'cursor-restart:restart-1')).toMatchObject({ title: '上次重启结果待核对', announce: false })
  })
  it('a later pending reply upgrades the same confirmed incident, but does not spam or infer task completion when a gate expires', () => {
    const base = reduce(undefined, input([fact()], { baseline: true })).checkpoint
    const stopped = reduce(base, input([fact({ online: false, evidence: 'stopped' })]), 2)
    const waiting = reduce(stopped.checkpoint, input([fact({ online: false, evidence: 'stopped', pendingWork: true })]), 3)
    expect(waiting.drafts[0]).toMatchObject({ key: stopped.drafts[0]!.key, attention: 'action', announce: false })
    const timeout = reduce(waiting.checkpoint, input([fact({ online: false, evidence: 'stopped', pendingWork: false })]), 4)
    expect(timeout.drafts).toHaveLength(0)
    expect(timeout.checkpoint.rows[fact().identity]!.incident?.needsAction).toBe(true)
  })
  it('a finalized restart cannot reopen as the cause of a later independent offline event', () => {
    const restart = { id: 'restart-1', label: '重启', section: 'maintenance' as const, status: 'done' as const,
      targets: [{ identity: fact().identity, name: fact().name, scope: fact().scope }] }
    const base = reduce(undefined, input([fact()], { baseline: true, restart })).checkpoint
    expect(base.restart?.finalized).toBe(true)
    const stopped = reduce(base, input([fact({ online: false, evidence: 'stopped' })], { restart }), 2)
    expect(stopped.drafts.filter(draft => draft.category === 'maintenance')).toHaveLength(0)
    expect(stopped.drafts[0]?.title).toContain('已离线')
  })
})
