import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamControlService } from '../src/application/team-control-service'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { connectGroupTopologyNotifications } from '../src/application/notifications/group-topology-notifications'
import { notificationFrame, notificationSourceHarness } from './notification-source-fixtures'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sg-team-read-token-')), path = join(directory, 'business.sqlite'), repository = new SqliteTeamControlRepository(path)
  const frame = notificationFrame({ sessions: [], conversations: {} })
  const service = new TeamControlService(repository, { getSnapshot: () => frame, subscribe: () => () => {}, sendMessage: () => ({ commandId: 'fixture' }) })
  const team = service.createSessionPool({ workspaceId: 'token-workspace', workspaceName: 'fixture', workspacePath: directory,
    members: ['1', '2'].map(channelId => ({ channelId, roleTemplateKey: 'solo', avatarId: 'lead', skills: [], solo: true })) })
  const group = repository.createGroup({ runId: team.activeRun!.id, name: 'Original group', members: team.members.map(member => ({ slotId: member.slot.id, roleTemplateKey: 'builder' })), at: 1 }).group
  service.getSnapshot()
  return { directory, path, repository, service, team, group, close: () => { service.dispose(); repository.close(); rmSync(directory, { recursive: true, force: true }) } }
}

it('captures storage metadata in each ORIGINAL revision/meta statement; its getter is pure memory and stable frames do not reload native state', () => {
  const f = fixture()
  try {
    const load = vi.spyOn(f.repository, 'loadTeamControl'), revision = vi.spyOn(f.repository, 'revision')
    const get = vi.spyOn(Object.getPrototypeOf((f.repository as any).database.prepare('SELECT 1')), 'get')
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    try {
      const token = f.repository.lastReadVersion()
      expect(token?.revision).toBe(f.service.getSnapshot().revision)
      get.mockClear(); prepare.mockClear(); revision.mockClear()
      for (let n = 0; n < 100; n++) expect(f.repository.lastReadVersion()).toBe(token)
      expect(get).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled()
      for (let n = 0; n < 50; n++) f.service.getSnapshot()
      expect(revision).toHaveBeenCalledTimes(50); expect(load).not.toHaveBeenCalled()
      expect(Object.isFrozen(f.repository.lastReadVersion())).toBe(true)
    } finally { get.mockRestore(); prepare.mockRestore() }
  } finally { vi.restoreAllMocks(); f.close() }
})

it('a real external equal-revision commit invalidates a hot native cache once, updates actual group facts and does not claim every storage commit is a topology restore', async () => {
  const f = fixture(), h = notificationSourceHarness(), source = connectGroupTopologyNotifications(f.service, h.owner), database = new DatabaseSync(f.path)
  try {
    const before = f.service.getSnapshot(); await source.source.flush()
    const token = f.repository.lastReadVersion(), load = vi.spyOn(f.repository, 'loadTeamControl')
    database.prepare('UPDATE team_groups SET name=? WHERE id=?').run('Changed group without revision bump', f.group.id)
    const changed = f.service.getSnapshot(); await source.source.flush()
    expect(changed.revision).toBe(before.revision); expect(changed.groups[0]?.group.name).toBe('Changed group without revision bump')
    expect(load).toHaveBeenCalledOnce(); expect(f.repository.lastReadVersion()?.token).not.toBe(token?.token)
    expect(h.ledger.page({ eventType: 'group.rebase' }).records[0]?.title).toBe('相同修订号下的组关系数据已变化')
    const notifications = h.ledger.page().summary.total
    database.exec("CREATE TABLE unrelated_fixture(value TEXT); INSERT INTO unrelated_fixture VALUES('new storage commit')")
    f.service.getSnapshot(); await source.source.flush()
    expect(load).toHaveBeenCalledTimes(2); expect(h.ledger.page().summary.total).toBe(notifications)
    for (let index = 0; index < 50; index++) f.service.getSnapshot()
    await source.source.flush(); expect(load).toHaveBeenCalledTimes(2); expect(h.ledger.page().summary.total).toBe(notifications)
  } finally { vi.restoreAllMocks(); database.close(); await source.close(); await h.owner.close(); f.close() }
})

it('same-connection unversioned writes and original correctly versioned writes both invalidate, without another revision read or a schema change', () => {
  const f = fixture()
  try {
    const original = f.service.getSnapshot(), db: DatabaseSync = (f.repository as any).database
    const load = vi.spyOn(f.repository, 'loadTeamControl'), revision = vi.spyOn(f.repository, 'revision')
    db.prepare('UPDATE team_groups SET name=? WHERE id=?').run('Same connection changed', f.group.id)
    expect(f.service.getSnapshot().groups[0]?.group.name).toBe('Same connection changed')
    expect(load).toHaveBeenCalledOnce(); expect(revision).toHaveBeenCalledOnce()
    f.repository.updateGroupGoal({ groupId: f.group.id, goal: 'Original properly versioned write', at: 3 })
    const next = f.service.getSnapshot()
    expect(next.revision).toBeGreaterThan(original.revision); expect(load).toHaveBeenCalledTimes(2)
    expect(Number(db.prepare('SELECT schema_version FROM team_control_meta WHERE id=1').get()!.schema_version)).toBe(9)
  } finally { vi.restoreAllMocks(); f.close() }
})

it('the original watcher still emits a changed equal-revision dataset even if an earlier active-scope read already refreshed the native cache', async () => {
  vi.useFakeTimers()
  const f = fixture(), database = new DatabaseSync(f.path), snapshots: any[] = []
  const stop = f.service.subscribe(snapshot => snapshots.push(snapshot))
  try {
    f.service.startWatcher(250)
    database.prepare('UPDATE team_groups SET name=? WHERE id=?').run('Seen by scope before watcher', f.group.id)
    f.service.getActiveTaskScope() // Cache was refreshed, but no UI snapshot has been emitted yet.
    const before = snapshots.length
    await vi.advanceTimersByTimeAsync(250)
    expect(snapshots).toHaveLength(before + 1); expect(snapshots.at(-1)?.groups[0]?.group.name).toBe('Seen by scope before watcher')
    await vi.advanceTimersByTimeAsync(1000); expect(snapshots).toHaveLength(before + 1)
  } finally { stop(); database.close(); f.close(); vi.useRealTimers() }
})

it('a failed original reload never tags old cached data as current; next successful original read still reloads, and unknown metadata is not a valid cache proof', () => {
  const f = fixture(), database = new DatabaseSync(f.path)
  try {
    const last = f.service.getSnapshot()
    database.prepare('UPDATE team_groups SET name=? WHERE id=?').run('Changed while reload failed', f.group.id)
    const original = Error('original repository load failure'), load = vi.spyOn(f.repository, 'loadTeamControl').mockImplementationOnce(() => { throw original })
    expect(() => f.service.getSnapshot()).toThrow(original)
    const next = f.service.getSnapshot(); expect(next.revision).toBe(last.revision); expect(next.groups[0]?.group.name).toBe('Changed while reload failed')
    expect(load).toHaveBeenCalledTimes(2)
    const witness = vi.spyOn(f.repository, 'lastReadVersion').mockReturnValue(undefined)
    expect(f.service.getSnapshot().groups[0]?.group.name).toBe('Changed while reload failed')
    expect(load).toHaveBeenCalledTimes(3); witness.mockRestore()
  } finally { vi.restoreAllMocks(); database.close(); f.close() }
})
