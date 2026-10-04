import { describe, expect, it, vi } from 'vitest'
import { SqliteNotificationRepository } from '../src/infrastructure/notifications/sqlite-notification-repository'
import { NotificationService } from '../src/application/notification-service'
import type { NotificationRepository } from '../src/application/notification-repository'
import { SessionLifecycleNotifications, sessionNotificationObservation } from '../src/application/notifications/session-lifecycle-notifications'
import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import type { AgentSession } from '../src/domain/agent-session'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

function team(): TeamControlSnapshot {
  const base = emptyTeamControlSnapshot(); base.activeWorkspaceId = 'workspace-a'
  const run = { id: 'run-a', workspaceId: 'workspace-a', name: 'test', goal: '', templateId: 'independent-session-v1', status: 'running' as const, createdAt: 1, updatedAt: 1 }
  const binding = { id: 'binding-a', workspaceId: 'workspace-a', runId: run.id, slotId: 'slot-a', channelId: '1', agentSessionId: 'sg-channel:1', generation: 'binding-generation-a',
    installedAt: 1, launchDetail: '', lastCheckInNote: '', composerBindingKey: 'test-key', composerId: 'composer-a', composerBoundAt: 10 }
  base.activeRun = run; base.runs = [run]; base.bindings = [binding]
  base.members = [{ slot: { id: 'slot-a', runId: run.id, roleId: 'role-a', order: 0, name: '独立执行', avatarId: 'lead', channelId: '1', solo: true, createdAt: 1, updatedAt: 1 },
    role: { id: 'role-a', runId: run.id, key: 'solo-a', templateKey: 'solo', name: '独立执行', mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: 0 }, binding, readiness: 'active' }]
  return base
}
const session = (patch: Partial<AgentSession> = {}): AgentSession => ({ id: 'sg-channel:1', channelId: '1', generation: 0, displayName: 'CH-1', roleName: '独立执行', composerId: 'composer-a',
  status: 'waiting', currentTask: '', queueDepth: 0, connectionPhase: 'waiting', online: true, connected: true, waiting: true, workingFiles: [], healthEvidence: [], runtimeEvidence: 'active', lastSeenAt: 1_000, ...patch })
const frame = (sessions = [session()]): DesktopSnapshot => ({ connection: { state: 'connected', endpoint: 'test-only', attempt: 0, lastError: '' }, sessions, conversations: {}, protocolIssues: [], updatedAt: 1_000 })
function harness() {
  const ledger = new SqliteNotificationRepository(':memory:')
  const port: NotificationRepository = { marker: async key => ledger.marker(key), sourceState: vi.fn(async key => ledger.sourceState(key)),
    commitSource: vi.fn(async (key, expected, data, drafts, now) => ledger.commitSource(key, expected, data, drafts, now)),
    put: async (draft, now) => ledger.put(draft, now), page: async query => ledger.page(query), read: async (id, revision, now) => ledger.read(id, revision, now),
    readAll: async (query, revision, now) => ledger.readAll(query, revision, now), archive: async (id, now) => ledger.archive(id, now), clearRead: async (query, now) => ledger.clearRead(query, now),
    preferences: async () => ledger.preferences(), savePreferences: async value => ledger.savePreferences(value), close: async () => ledger.close() }
  let now = 2_000; const owner = new NotificationService(port, () => now)
  const lifecycle = new SessionLifecycleNotifications(owner, () => now, () => 'deterministic-incident')
  return { ledger, port, owner, lifecycle, advance: (time: number) => { now = time }, close: async () => { lifecycle.stop(); await owner.close() } }
}
describe('real session snapshots into durable notifications', () => {
  it('baseline hydration is quiet; one incident survives adapter restart and recovers without duplicate history', async () => {
    const h = harness()
    try {
      h.lifecycle.observe(frame(), team()); await h.lifecycle.flush(); expect(h.ledger.page().summary.total).toBe(0)
      h.advance(3_000); h.lifecycle.observe(frame([session({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped', pendingOutboundId: 'owed-reply' })]), team())
      await h.lifecycle.flush(); expect(h.ledger.page().summary).toMatchObject({ total: 1, unread: 1, pending: 1 })
      const id = h.ledger.page().records[0]!.id
      h.lifecycle.stop()
      const restored = new SessionLifecycleNotifications(h.owner, () => 4_000, () => 'wrong-new-incident')
      restored.observe(frame([session({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })]), team()); await restored.flush()
      expect(h.ledger.page().records[0]!.id).toBe(id)
      restored.observe(frame([session({ lastSeenAt: 4_500 })]), team()); await restored.flush()
      expect(h.ledger.page().summary).toMatchObject({ total: 1, pending: 0 })
      expect(h.ledger.page().records[0]!.title).toContain('已恢复连接'); restored.stop()
    } finally { await h.close() }
  })
  it('steady heartbeat and progress frames do not generate notification writes or an unread count', async () => {
    const h = harness()
    try {
      h.lifecycle.observe(frame(), team()); await h.lifecycle.flush()
      const count = vi.mocked(h.port.commitSource).mock.calls.length
      for (let time = 3_000; time < 10_000; time += 1_000) {
        h.advance(time); h.lifecycle.observe(frame([session({ lastSeenAt: time, currentTask: `Working ${time}` })]), team()); await h.lifecycle.flush()
      }
      expect(h.port.commitSource).toHaveBeenCalledTimes(count); expect(h.ledger.page().summary.unread).toBe(0)
    } finally { await h.close() }
  })
  it('suspend/resume consumes one baseline, not an indefinite global silence that swallows the next true stop', async () => {
    const h = harness()
    try {
      h.lifecycle.observe(frame(), team()); await h.lifecycle.flush()
      h.lifecycle.suspend(); h.lifecycle.observe(frame([]), team()); h.lifecycle.resume()
      h.lifecycle.observe(frame(), team()); await h.lifecycle.flush()
      h.advance(3_000); h.lifecycle.observe(frame([session({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })]), team()); await h.lifecycle.flush()
      expect(h.ledger.page().records[0]!.title).toContain('已离线')
    } finally { await h.close() }
  })
  it('unknown or mismatched binding identities cannot be silently attributed to the current workspace', () => {
    const unknown = sessionNotificationObservation(frame([session({ composerId: undefined })]), emptyTeamControlSnapshot(), 2_000, 1_000)
    expect(unknown.facts).toHaveLength(0)
    const mismatch = sessionNotificationObservation(frame([session({ composerId: 'foreign-composer' })]), team(), 2_000, 1_000)
    expect(mismatch.facts).toHaveLength(0)
    const actual = sessionNotificationObservation(frame(), team(), 2_000, 1_000)
    expect(actual.facts[0]?.scope).toMatchObject({ workspaceId: 'workspace-a', runId: 'run-a', bindingGeneration: 'binding-generation-a' })
    expect(JSON.stringify(actual)).not.toContain('conversations')
  })
  it('planned restart is one record and a later independent stop is not permanently suppressed', async () => {
    const h = harness()
    try {
      h.lifecycle.observe(frame(), team()); await h.lifecycle.flush()
      const id = h.lifecycle.beginRestart('切换并重启 Cursor', 'accounts')!; await h.lifecycle.flush()
      h.advance(3_000); h.lifecycle.observe(frame([session({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })]), team()); await h.lifecycle.flush()
      h.lifecycle.finishRestart(id, true); await h.lifecycle.flush()
      expect(h.ledger.page().summary.total).toBe(1); expect(h.ledger.page().records[0]!.title).toContain('原会话尚未恢复')
      h.advance(4_000); h.lifecycle.observe(frame([session({ lastSeenAt: 4_000 })]), team()); await h.lifecycle.flush()
      expect(h.ledger.page().records[0]!.title).toBe('Cursor 重启已完成')
      h.advance(5_000); h.lifecycle.observe(frame([session({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })]), team()); await h.lifecycle.flush()
      expect(h.ledger.page().records.some(record => record.category === 'sessions' && record.title.includes('已离线'))).toBe(true)
      expect(h.ledger.page().records.find(record => record.category === 'maintenance')!.title).toBe('Cursor 重启已完成')
    } finally { await h.close() }
  })
  it('a checkpoint no-op after reattaching still consumes bootstrap and permits a later true outage', async () => {
    const h = harness()
    try {
      h.lifecycle.observe(frame(), team()); await h.lifecycle.flush(); h.lifecycle.stop()
      const restored = new SessionLifecycleNotifications(h.owner, () => 3_000, () => 'new-incident')
      restored.observe(frame(), team()); await restored.flush()
      restored.observe(frame([session({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })]), team()); await restored.flush()
      expect(h.ledger.page().records[0]!.title).toContain('已离线'); restored.stop()
    } finally { await h.close() }
  })
  it('does not mix a final snapshot built for the next topology with the previous cached team callback', async () => {
    const h = harness()
    try {
      const current = team()
      h.lifecycle.observe(frame(), current); await h.lifecycle.flush()
      h.lifecycle.observe({ ...frame([session({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })]),
        runtimeScope: { workspaceId: 'another-workspace', runId: 'another-run', teamRevision: current.revision + 1 } }, current)
      await h.lifecycle.flush(); expect(h.ledger.page().summary.total).toBe(0)
    } finally { await h.close() }
  })
  it('a positive stop and recovery are both preserved if initial checkpoint loading is slow', async () => {
    const h = harness(); let release!: (value: { revision: number }) => void
    vi.mocked(h.port.sourceState).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    try {
      h.lifecycle.observe(frame(), team())
      h.advance(3_000); h.lifecycle.observe(frame([session({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })]), team())
      h.advance(4_000); h.lifecycle.observe(frame([session({ lastSeenAt: 4_000 })]), team())
      release({ revision: 0 }); await h.lifecycle.flush()
      expect(h.ledger.page().summary.total).toBe(1)
      expect(h.ledger.page().records[0]!.title).toContain('已恢复连接')
      expect(vi.mocked(h.port.commitSource).mock.calls.some(([, , , drafts]) => drafts.some(draft => draft.title.includes('已离线')))).toBe(true)
    } finally { await h.close() }
  })
  it('sleep retains accepted history transitions but does not replay their alerts on wake', async () => {
    const h = harness(); const events = vi.fn(); h.owner.subscribe(events)
    let release!: (value: { revision: number }) => void
    vi.mocked(h.port.sourceState).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    try {
      h.lifecycle.observe(frame(), team())
      h.advance(3_000); h.lifecycle.observe(frame([session({ online: false, connected: false, runtimeEvidence: 'stopped', connectionPhase: 'cursor_stopped' })]), team())
      h.lifecycle.suspend(); release({ revision: 0 }); await h.lifecycle.flush()
      h.advance(4_000); h.lifecycle.resume(); await h.lifecycle.flush()
      expect(h.ledger.page().records[0]!.title).toContain('已离线')
      expect(events.mock.calls.some(([event]) => event.announcement)).toBe(false)
      h.lifecycle.observe(frame([session({ lastSeenAt: 4_000 })]), team()); await h.lifecycle.flush()
      expect(h.ledger.page().records[0]!.title).toContain('已恢复连接')
      expect(events.mock.calls.some(([event]) => event.announcement)).toBe(false)
    } finally { await h.close() }
  })
})
