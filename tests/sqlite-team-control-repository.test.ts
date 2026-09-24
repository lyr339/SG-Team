import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createConfiguredTeamBundle } from '../src/domain/team-control'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { createDefaultTeamBundle } from './legacy-team-fixtures'

function repositoryFixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-')), 'control.sqlite3')
  return new SqliteTeamControlRepository(path)
}

function bundle(workspaceId: string, channelIds = ['1'], goal?: string) {
  return createDefaultTeamBundle({
    workspaceId,
    workspaceName: workspaceId,
    workspacePath: `/workspace/${workspaceId}`,
    channelIds,
    now: 100,
    goal
  })
}

function installTeam(repository: SqliteTeamControlRepository, team: ReturnType<typeof bundle>, generation = 'generation123') {
  repository.recordInstallation({
    workspaceId: team.workspace.id,
    runId: team.run.id,
    generation,
    agents: team.slots.map((slot) => ({
      agentSessionId: `${team.workspace.id}:ch-${slot.channelId}:${generation}`,
      workspaceId: team.workspace.id,
      channelId: slot.channelId!,
      generation,
      runId: team.run.id,
      capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
    }))
  })
}

describe('SqliteTeamControlRepository', () => {
  it('keeps workspace runs isolated and preserves each goal when switching', () => {
    const repository = repositoryFixture()
    try {
      const alpha = bundle('alpha', ['1'], 'Alpha 目标')
      const beta = bundle('beta', ['1'], 'Beta 目标')
      repository.upsertWorkspaceTeam(alpha)
      repository.upsertWorkspaceTeam(beta)

      let state = repository.loadTeamControl()
      expect(state.activeWorkspaceId).toBe('beta')
      expect(state.runs).toHaveLength(2)
      expect(state.runs.find((run) => run.id === alpha.run.id)?.goal).toBe('Alpha 目标')

      repository.setActiveWorkspace('alpha')
      state = repository.loadTeamControl()
      expect(state.activeWorkspaceId).toBe('alpha')
      expect(state.runs.find((run) => run.id === beta.run.id)?.goal).toBe('Beta 目标')
    } finally {
      repository.close()
    }
  })

  it('persists configurable roles, assigned skills and stable avatar identities', () => {
    const repository = repositoryFixture()
    try {
      const team = createConfiguredTeamBundle({
        workspaceId: 'configured',
        workspaceName: 'configured',
        workspacePath: '/workspace/configured',
        members: [
          { channelId: '2', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          {
            channelId: '7', roleTemplateKey: 'frontend', avatarId: 'frontend',
            skills: [{ id: 'project:frontend-design', name: 'frontend-design', description: 'UI skill', scope: 'project' }],
            modelSelection: {
              modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', maxMode: false,
              parameters: [{ id: 'reasoning', value: 'high' }]
            }
          },
          { channelId: '19', roleTemplateKey: 'reviewer', avatarId: 'reviewer', skills: [] }
        ],
        now: 100
      })
      repository.upsertWorkspaceTeam(team)
      const state = repository.loadTeamControl()
      expect(state.schemaVersion).toBe(9)
      expect(state.roles.find((role) => role.templateKey === 'frontend')).toMatchObject({
        skills: [{ id: 'project:frontend-design', name: 'frontend-design' }]
      })
      expect(state.slots.map((slot) => [slot.channelId, slot.avatarId])).toEqual([
        ['2', 'lead'], ['7', 'frontend'], ['19', 'reviewer']
      ])
      expect(state.slots.find((slot) => slot.channelId === '7')?.modelSelection).toEqual({
        modelId: 'gpt-5.3-codex', displayName: 'Codex 5.3', maxMode: false,
        parameters: [{ id: 'reasoning', value: 'high' }]
      })
    } finally {
      repository.close()
    }
  })

  it('persists solo slots and rejects both identity resolution entry points with not_in_group', () => {
    const repository = repositoryFixture()
    try {
      const team = createConfiguredTeamBundle({
        workspaceId: 'solo-persist', workspaceName: 'solo-persist', workspacePath: '/workspace/solo-persist', now: 100,
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
        ]
      })
      repository.upsertWorkspaceTeam(team)
      repository.recordInstallation({
        workspaceId: team.workspace.id, runId: team.run.id, generation: 'generation123',
        agents: team.slots.map((slot) => ({
          agentSessionId: `solo-persist:ch-${slot.channelId}:generation123`, workspaceId: team.workspace.id,
          channelId: slot.channelId!, generation: 'generation123', runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      expect(repository.loadTeamControl().slots.find((slot) => slot.channelId === '2')?.solo).toBe(true)
      for (const resolve of [
        () => repository.resolveChannelAgentIdentity('2'),
        () => repository.resolveAgentRuntimeIdentity('solo-persist:ch-2:generation123', team.run.id)
      ]) {
        try {
          resolve()
          throw new Error('expected not_in_group')
        } catch (error) {
          expect(error).toMatchObject({ code: 'not_in_group' })
          expect((error as Error).message).toContain('check_messages / record_reply')
        }
      }
    } finally {
      repository.close()
    }
  })

  it('degrades to run_completed guidance after the run wraps up instead of a hard auth error (P0-2)', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('archive', ['1', '2'], '归档语义验证')
      repository.upsertWorkspaceTeam(team)
      installTeam(repository, team)
      expect(repository.resolveChannelAgentIdentity('1')).toMatchObject({ runId: team.run.id })
      expect(repository.completeRun(team.run.id, 300)).toBe(true)

      // run 收尾撤销注册是轮次归档：曾注册的通道得到「本轮已结束 + 如何恢复」
      // 的指引，而非 2026-09-01 事故里把 Agent 永久锁死的授权硬错。
      try {
        repository.resolveChannelAgentIdentity('1')
        throw new Error('expected run_completed')
      } catch (error) {
        expect(error).toMatchObject({ code: 'run_completed' })
        expect((error as Error).message).toContain('record_reply')
        expect((error as Error).message).toContain('check_messages')
      }
      // 从未注册到本轮的通道保持普通未注册语义。
      try {
        repository.resolveChannelAgentIdentity('9')
        throw new Error('expected agent_not_authorized')
      } catch (error) {
        expect(error).toMatchObject({ code: 'agent_not_authorized' })
      }
    } finally {
      repository.close()
    }
  })

  it('reconfigures an installed team to the exact selected seats', () => {
    const repository = repositoryFixture()
    try {
      const eightSeatTeam = bundle('alpha', ['1', '2', '3', '4', '5', '6', '7', '8'], '实现并验证')
      repository.upsertWorkspaceTeam(eightSeatTeam)
      installTeam(repository, eightSeatTeam)
      expect(repository.loadTeamControl().bindings.filter((binding) => binding.runId === eightSeatTeam.run.id))
        .toHaveLength(8)

      const fourSeatTeam = createConfiguredTeamBundle({
        workspaceId: 'alpha',
        workspaceName: 'alpha',
        workspacePath: '/workspace/alpha',
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] },
          { channelId: '3', roleTemplateKey: 'reviewer', avatarId: 'reviewer', skills: [] },
          { channelId: '4', roleTemplateKey: 'specialist', avatarId: 'frontend', skills: [] }
        ],
        now: 200
      })
      repository.upsertWorkspaceTeam(fourSeatTeam)

      const state = repository.loadTeamControl()
      const run = state.runs.find((candidate) => candidate.id === fourSeatTeam.run.id)!
      expect(state.slots.filter((slot) => slot.runId === run.id).map((slot) => slot.channelId)).toEqual(['1', '2', '3', '4'])
      expect(state.roles.filter((role) => role.runId === run.id).map((role) => role.templateKey)).toEqual([
        'lead', 'builder', 'reviewer', 'specialist'
      ])
      expect(state.bindings.filter((binding) => binding.runId === run.id)).toHaveLength(0)
    } finally {
      repository.close()
    }
  })

  it('check-in marks the binding acknowledged and leaves the run running (no launch state machine, 2B)', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha', ['1', '2'], '实现并验证')
      repository.upsertWorkspaceTeam(team)
      installTeam(repository, team)

      let state = repository.loadTeamControl()
      expect(state.runs[0]?.status).toBe('running')
      expect(state.bindings.every((binding) => binding.acknowledgedAt === undefined)).toBe(true)

      const first = state.bindings[0]!
      const receipt = repository.recordAgentCheckIn({
        agentSessionId: first.agentSessionId,
        runId: first.runId,
        capabilities: []
      }, '已读取角色边界')
      expect(receipt).toMatchObject({ runId: team.run.id, slotId: first.slotId })
      state = repository.loadTeamControl()
      expect(state.runs[0]?.status).toBe('running')
      const acknowledged = state.bindings.find((binding) => binding.id === first.id)!
      expect(acknowledged).toMatchObject({ acknowledgedAt: receipt.acknowledgedAt, lastCheckInNote: '已读取角色边界' })
      expect(state.bindings.find((binding) => binding.id !== first.id)?.acknowledgedAt).toBeUndefined()

      // 再次签到（刷新上下文）只刷 last_check_in_*：acknowledged_at 保留首次值，会话开始时间不漂移。
      const again = repository.recordAgentCheckIn({
        agentSessionId: first.agentSessionId,
        runId: first.runId,
        capabilities: []
      }, '入组后刷新简报')
      const refreshed = repository.loadTeamControl().bindings.find((binding) => binding.id === first.id)!
      expect(refreshed.acknowledgedAt).toBe(acknowledged.acknowledgedAt)
      expect(refreshed.lastCheckInAt).toBe(again.acknowledgedAt)
      expect(refreshed.lastCheckInNote).toBe('入组后刷新简报')
    } finally {
      repository.close()
    }
  })

  it('rejects check-in on a completed run with run_completed and leaves the binding untouched', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha', ['1'])
      repository.upsertWorkspaceTeam(team)
      installTeam(repository, team)
      expect(repository.completeRun(team.run.id, 300)).toBe(true)
      expect(() => repository.recordAgentCheckIn({
        agentSessionId: 'alpha:ch-1:generation123',
        runId: team.run.id,
        capabilities: ['coordination', 'planning']
      }, '迟到的签到')).toThrowError(expect.objectContaining({ code: 'run_completed' }))
      expect(repository.loadTeamControl().bindings[0]).toMatchObject({ launchDetail: '本轮运行已结束', lastCheckInNote: '' })
      expect(() => repository.recordAgentCheckIn({
        agentSessionId: 'alpha:ch-9:unknown',
        runId: team.run.id,
        capabilities: []
      }, '无绑定')).toThrowError(expect.objectContaining({ code: 'runtime_binding_missing' }))
    } finally {
      repository.close()
    }
  })

  it('keeps the run running and the existing generation when the same topology re-registers', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha', ['1', '2'], '实现并验证')
      repository.upsertWorkspaceTeam(team)
      installTeam(repository, team, 'generation123')
      const first = repository.loadTeamControl().bindings[0]!
      repository.recordAgentCheckIn({ agentSessionId: first.agentSessionId, runId: first.runId, capabilities: [] }, '已确认')

      // 安装器再次登记（通道补装 / 重激活）：幂等刷新，不得抹掉签到证据、不得改 run 状态。
      installTeam(repository, team, 'generation456')
      const state = repository.loadTeamControl()
      expect(state.runs[0]?.status).toBe('running')
      expect(state.bindings.every((binding) => binding.generation === 'generation123')).toBe(true)
      expect(state.bindings.find((binding) => binding.id === first.id)?.acknowledgedAt).toBeDefined()

      const receipt = repository.recordAgentCheckIn({
        agentSessionId: first.agentSessionId,
        runId: first.runId,
        capabilities: []
      }, '重新确认角色边界')
      expect(receipt.runId).toBe(team.run.id)
    } finally {
      repository.close()
    }
  })

  it('does not rotate runtime identity when the same topology is installed again', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha')
      repository.upsertWorkspaceTeam(team)
      const install = (generation: string) => repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation,
        agents: [{
          agentSessionId: `alpha:ch-1:${generation}`,
          workspaceId: 'alpha',
          channelId: '1',
          generation,
          runId: team.run.id,
          capabilities: ['coordination', 'planning']
        }]
      })

      install('generation123')
      const first = repository.loadTeamControl()
      install('generation456')
      const second = repository.loadTeamControl()
      expect(second.slots[0]?.id).toBe(first.slots[0]?.id)
      expect(second.bindings).toHaveLength(1)
      expect(second.bindings[0]).toMatchObject({
        generation: 'generation123',
        agentSessionId: 'alpha:ch-1:generation123',
        slotId: first.slots[0]?.id
      })
    } finally {
      repository.close()
    }
  })

  it('rolls authorization and runtime bindings back together when installation fails', () => {
    const repository = repositoryFixture()
    const authorization = new SqliteTaskPoolRepository(repository.path)
    try {
      const team = bundle('alpha', ['1', '2'])
      repository.upsertWorkspaceTeam(team)
      const registration = (generation: string) => ({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation,
        agents: team.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:${generation}`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation,
          runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })

      const raw = new DatabaseSync(repository.path)
      raw.exec(`
        CREATE TRIGGER force_runtime_binding_failure
        BEFORE INSERT ON runtime_bindings
        WHEN NEW.generation = 'generation456'
        BEGIN
          SELECT RAISE(ABORT, 'forced runtime binding failure');
        END;
      `)
      raw.close()

      expect(() => repository.recordInstallation(registration('generation456')))
        .toThrowError(/forced runtime binding failure/)
      expect(repository.loadTeamControl().bindings).toEqual([])
      expect(() => authorization.assertAgentAuthorized({
        agentSessionId: 'alpha:ch-1:generation456',
        runId: team.run.id,
        capabilities: ['coordination']
      })).toThrowError(/未注册或已被撤销/)
      expect(() => authorization.assertAgentAuthorized({
        agentSessionId: 'alpha:ch-2:generation456',
        runId: team.run.id,
        capabilities: ['code']
      })).toThrowError(/未注册或已被撤销/)
    } finally {
      authorization.close()
      repository.close()
    }
  })

  it('reconciles changed channel topology and fences the old generation', () => {
    const repository = repositoryFixture()
    const authorization = new SqliteTaskPoolRepository(repository.path)
    try {
      const initial = bundle('alpha', ['1', '2', '3'])
      repository.upsertWorkspaceTeam(initial)
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: initial.run.id,
        generation: 'generation123',
        agents: initial.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation: 'generation123',
          runId: initial.run.id,
          capabilities: initial.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })

      repository.upsertWorkspaceTeam(bundle('alpha', ['1', '3']))
      const state = repository.loadTeamControl()
      expect(state.slots.map((slot) => [slot.id.split(':').at(-1), slot.channelId])).toEqual([
        ['lead', '1'],
        ['builder', '3']
      ])
      expect(state.bindings).toEqual([])
      expect(() => authorization.assertAgentAuthorized({
        agentSessionId: 'alpha:ch-1:generation123',
        runId: initial.run.id,
        capabilities: ['coordination']
      })).toThrowError(/未注册或已被撤销/)
    } finally {
      authorization.close()
      repository.close()
    }
  })

  it('persists one Composer per runtime generation and rejects conflicts or stale writes', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('alpha', ['1', '2'])
      repository.upsertWorkspaceTeam(team)
      repository.recordInstallation({
        workspaceId: 'alpha',
        runId: team.run.id,
        generation: 'generation123',
        agents: team.slots.map((slot) => ({
          agentSessionId: `alpha:ch-${slot.channelId}:generation123`,
          workspaceId: 'alpha',
          channelId: slot.channelId!,
          generation: 'generation123',
          runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
        }))
      })
      const [first, second] = repository.loadTeamControl().bindings

      expect(repository.recordComposerBinding({
        runId: first!.runId,
        slotId: first!.slotId,
        generation: first!.generation,
        bindingKey: first!.composerBindingKey,
        composerId: 'composer-alpha-123',
        method: 'launch_marker',
        at: 300
      })).toBe(true)
      expect(repository.recordComposerBinding({
        runId: first!.runId,
        slotId: first!.slotId,
        generation: first!.generation,
        bindingKey: first!.composerBindingKey,
        composerId: 'composer-alpha-123',
        method: 'launch_marker',
        at: 301
      })).toBe(false)
      expect(repository.recordComposerBinding({
        runId: second!.runId,
        slotId: second!.slotId,
        generation: second!.generation,
        bindingKey: second!.composerBindingKey,
        composerId: 'composer-alpha-123',
        method: 'launch_marker',
        at: 302
      })).toBe(false)
      expect(repository.recordComposerBinding({
        runId: second!.runId,
        slotId: second!.slotId,
        generation: 'stale-generation',
        bindingKey: second!.composerBindingKey,
        composerId: 'composer-beta-123',
        method: 'channel_marker',
        at: 303
      })).toBe(false)

      expect(repository.loadTeamControl()).toMatchObject({
        schemaVersion: 9,
        bindings: expect.arrayContaining([expect.objectContaining({
          slotId: first!.slotId,
          composerId: 'composer-alpha-123',
          composerBoundAt: 300,
          composerBindingMethod: 'launch_marker'
        })])
      })

      // 换席重建轮换绑定键：旧键的迟到绑定被拒，新键照常。
      expect(repository.prepareComposerRelaunch({
        runId: team.run.id, slotId: first!.slotId, bindingKey: 'launch-attempt-2'
      })).toBe(true)
      const rotated = repository.loadTeamControl().bindings.find((value) => value.slotId === first!.slotId)!
      expect(rotated).toMatchObject({ composerBindingKey: 'launch-attempt-2' })
      expect(rotated.composerId).toBeUndefined()
      expect(rotated.acknowledgedAt).toBeUndefined()
      expect(repository.recordComposerBinding({
        runId: first!.runId,
        slotId: first!.slotId,
        generation: first!.generation,
        bindingKey: first!.composerBindingKey,
        composerId: 'composer-late-123',
        method: 'launch_marker',
        at: 401
      })).toBe(false)
      expect(repository.recordComposerBinding({
        runId: first!.runId,
        slotId: first!.slotId,
        generation: first!.generation,
        bindingKey: 'launch-attempt-2',
        composerId: 'composer-current-123',
        method: 'launch_marker',
        at: 402
      })).toBe(true)
    } finally {
      repository.close()
    }
  })

  it('rotates one offline Composer binding before a targeted relaunch', () => {
    const repository = repositoryFixture()
    try {
      const team = bundle('relaunch', ['1'])
      repository.upsertWorkspaceTeam(team)
      repository.recordInstallation({
        workspaceId: 'relaunch', runId: team.run.id, generation: 'generation123',
        agents: [{
          agentSessionId: 'relaunch:ch-1:generation123', workspaceId: 'relaunch', channelId: '1',
          generation: 'generation123', runId: team.run.id, capabilities: ['coordination', 'planning']
        }]
      })
      const binding = repository.loadTeamControl().bindings[0]!
      expect(repository.recordComposerBinding({
        runId: binding.runId, slotId: binding.slotId, generation: binding.generation,
        bindingKey: binding.composerBindingKey, composerId: 'composer-old-123', method: 'launch_marker', at: 100
      })).toBe(true)
      expect(repository.prepareComposerRelaunch({
        runId: binding.runId, slotId: binding.slotId, bindingKey: 'relaunch-key-2'
      })).toBe(true)
      const rotated = repository.loadTeamControl().bindings[0]!
      expect(rotated).toMatchObject({ composerBindingKey: 'relaunch-key-2' })
      expect(rotated.composerId).toBeUndefined()
      expect(rotated.acknowledgedAt).toBeUndefined()
      expect(repository.recordComposerBinding({
        runId: binding.runId, slotId: binding.slotId, generation: binding.generation,
        bindingKey: 'relaunch-key-2', composerId: 'composer-new-123', method: 'launch_marker', at: 200
      })).toBe(true)
    } finally {
      repository.close()
    }
  })

  it('migrates a version-1 runtime binding table without discarding the database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-v1-')), 'control.sqlite3')
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE team_control_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL, active_workspace_id TEXT, updated_at INTEGER NOT NULL
      );
      INSERT INTO team_control_meta VALUES (1, 1, 0, NULL, 0);
      CREATE TABLE runtime_bindings (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
        slot_id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL UNIQUE, generation TEXT NOT NULL,
        installed_at INTEGER NOT NULL, launch_status TEXT NOT NULL,
        launch_command_id TEXT, launch_detail TEXT NOT NULL,
        acknowledged_at INTEGER, last_check_in_at INTEGER,
        last_check_in_note TEXT NOT NULL
      );
    `)
    old.close()

    const repository = new SqliteTeamControlRepository(path)
    try {
      expect(repository.loadTeamControl().schemaVersion).toBe(9)
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        const columns = database.prepare('PRAGMA table_info(runtime_bindings)').all() as { name: string }[]
        expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
          'composer_id',
          'composer_bound_at',
          'composer_binding_method',
          'composer_binding_key'
        ]))
        const roleColumns = database.prepare('PRAGMA table_info(team_roles)').all() as { name: string }[]
        const slotColumns = database.prepare('PRAGMA table_info(agent_slots)').all() as { name: string }[]
        expect(roleColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['template_key', 'skills_json']))
        expect(slotColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['avatar_id', 'is_solo']))
      } finally {
        database.close()
      }
    } finally {
      repository.close()
    }
  })

  it('migrates schema v3 roles and slots to configurable skills and avatars', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-v3-')), 'control.sqlite3')
    const initial = new SqliteTeamControlRepository(path)
    initial.upsertWorkspaceTeam(bundle('legacy-v3', ['1', '2', '3']))
    initial.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE team_roles DROP COLUMN skills_json')
    old.exec('ALTER TABLE team_roles DROP COLUMN template_key')
    old.exec('ALTER TABLE team_runs DROP COLUMN acting_lead_slot_id')
    old.exec('ALTER TABLE agent_slots DROP COLUMN is_solo')
    old.exec('ALTER TABLE agent_slots DROP COLUMN avatar_id')
    old.exec('UPDATE team_control_meta SET schema_version = 3 WHERE id = 1')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      const state = migrated.loadTeamControl()
      expect(state.schemaVersion).toBe(9)
      expect(state.roles.map((role) => [role.key, role.templateKey, role.skills])).toEqual([
        ['lead', 'lead', []],
        ['builder', 'builder', []],
        ['reviewer', 'reviewer', []]
      ])
      expect(state.slots.map((slot) => slot.avatarId)).toEqual(['lead', 'architect', 'reviewer'])
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        const runColumns = database.prepare('PRAGMA table_info(team_runs)').all() as { name: string }[]
        const slotColumns = database.prepare('PRAGMA table_info(agent_slots)').all() as { name: string }[]
        expect(runColumns.map((column) => column.name)).toContain('acting_lead_slot_id')
        expect(slotColumns.map((column) => column.name)).toContain('is_solo')
      } finally {
        database.close()
      }
    } finally {
      migrated.close()
    }
  })

  it('migrates schema v6 by adding is_solo with a default of zero', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-v6-')), 'control.sqlite3')
    const current = new SqliteTeamControlRepository(path)
    current.upsertWorkspaceTeam(bundle('legacy-v6', ['1', '2']))
    current.close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE agent_slots DROP COLUMN is_solo')
    old.exec('UPDATE team_control_meta SET schema_version = 6 WHERE id = 1')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      const state = migrated.loadTeamControl()
      expect(state.schemaVersion).toBe(9)
      expect(state.slots.every((slot) => slot.solo === false)).toBe(true)
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        const columns = database.prepare('PRAGMA table_info(agent_slots)').all() as { name: string }[]
        expect(columns.map((column) => column.name)).toContain('is_solo')
      } finally {
        database.close()
      }
    } finally {
      migrated.close()
    }
  })

  it('migrates schema v4 to the failover event store without losing the active team', () => {
    const initial = repositoryFixture()
    const path = initial.path
    const team = bundle('failover-migration', ['1', '2'])
    initial.upsertWorkspaceTeam(team)
    initial.close()

    const old = new DatabaseSync(path)
    old.exec('DROP TABLE team_failovers')
    old.exec('UPDATE team_control_meta SET schema_version = 4 WHERE id = 1')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      expect(migrated.loadTeamControl()).toMatchObject({
        schemaVersion: 9,
        activeWorkspaceId: team.workspace.id
      })
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_failovers'").get())
          .toBeTruthy()
      } finally {
        database.close()
      }
    } finally {
      migrated.close()
    }
  })

  it('migrates v8 → v9 by archiving every legacy team run and every superseded pool run, idempotently (2B)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-v9-')), 'control.sqlite3')
    const seeded = new SqliteTeamControlRepository(path)
    // 同一工作区里的一次性团队 run：一个卡在 launching（已安装、一人已签到），一个还是 draft（未安装）。
    const launching = bundle('legacy', ['1', '2'], '升级前仍在启动')
    seeded.upsertWorkspaceTeam(launching)
    installTeam(seeded, launching)
    const launchingBinding = seeded.loadTeamControl().bindings[0]!
    seeded.recordAgentCheckIn({ agentSessionId: launchingBinding.agentSessionId, runId: launchingBinding.runId, capabilities: [] }, '签到')
    const draft = createDefaultTeamBundle({
      workspaceId: 'legacy', workspaceName: 'legacy', workspacePath: '/workspace/legacy', channelIds: ['1'], now: 200, runKey: 'run-draft0001'
    })
    seeded.upsertWorkspaceTeam(draft)
    // 已经 completed 的团队 run：保持原样，绑定文案不被覆盖。
    const done = createDefaultTeamBundle({
      workspaceId: 'done', workspaceName: 'done', workspacePath: '/workspace/done', channelIds: ['1'], now: 100
    })
    seeded.upsertWorkspaceTeam(done)
    installTeam(seeded, done)
    expect(seeded.completeRun(done.run.id, 150, '用户已结束本轮运行')).toBe(true)
    // 同一工作区两个 running 的会话池：旧的是早期代码遗留的脏数据，新的是活动池。
    const poolOf = (runKey: string, now: number) => createConfiguredTeamBundle({
      workspaceId: 'pool', workspaceName: 'pool', workspacePath: '/workspace/pool', now, runKey, mode: 'independent',
      members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }]
    })
    const stalePool = poolOf('run-older0001', 300)
    const activePool = poolOf('run-newer0001', 400)
    for (const [pool, generation] of [[stalePool, 'generationold'], [activePool, 'generationnew']] as const) {
      seeded.upsertWorkspaceTeam(pool)
      seeded.recordInstallation({
        workspaceId: 'pool', runId: pool.run.id, generation,
        agents: [{
          agentSessionId: `pool:ch-1:${generation}`, workspaceId: 'pool', channelId: '1',
          generation, runId: pool.run.id, capabilities: []
        }]
      })
    }
    seeded.close()

    const old = new DatabaseSync(path)
    old.prepare("UPDATE team_runs SET status = 'launching', launched_at = 120 WHERE id = ?").run(launching.run.id)
    old.prepare("UPDATE team_runs SET status = 'draft' WHERE id = ?").run(draft.run.id)
    // v8 的启动状态机留下的值：签到过的绑定 acknowledged、另一个 delivered + 启动指令 id。
    old.prepare("UPDATE runtime_bindings SET launch_status = 'acknowledged' WHERE agent_session_id = ?").run(launchingBinding.agentSessionId)
    old.prepare("UPDATE runtime_bindings SET launch_status = 'delivered', launch_command_id = 'cmd-1' WHERE run_id = ? AND agent_session_id <> ?")
      .run(launching.run.id, launchingBinding.agentSessionId)
    old.prepare('UPDATE team_control_meta SET schema_version = 8 WHERE id = 1').run()
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      const state = migrated.loadTeamControl()
      expect(state.schemaVersion).toBe(9)
      const statusOf = (runId: string) => state.runs.find((run) => run.id === runId)?.status
      expect(statusOf(launching.run.id)).toBe('completed')
      expect(statusOf(draft.run.id)).toBe('completed')
      expect(statusOf(done.run.id)).toBe('completed')
      expect(statusOf(stalePool.run.id)).toBe('completed')
      expect(statusOf(activePool.run.id)).toBe('running')
      expect(state.runs.every((run) => run.status === 'running' || run.status === 'completed')).toBe(true)

      const bindingsOf = (runId: string) => state.bindings.filter((binding) => binding.runId === runId)
      // 归档 = completeRun 的语义：绑定备注写明是升级归档（不是「全员离线」），该 run 的 agent 注册全部撤销。
      expect(bindingsOf(launching.run.id)).toHaveLength(2)
      expect(bindingsOf(launching.run.id).every((binding) => binding.launchDetail.includes('archived: legacy team run'))).toBe(true)
      expect(migrated.listAgentRegistrations(launching.run.id)).toEqual([])
      expect(bindingsOf(stalePool.run.id)[0]?.launchDetail).toContain('archived: superseded pool run')
      expect(migrated.listAgentRegistrations(stalePool.run.id)).toEqual([])
      // 之前就 completed 的 run 不被覆盖；活动池的绑定、注册与签到证据原样保留。
      expect(bindingsOf(done.run.id)[0]?.launchDetail).toBe('用户已结束本轮运行')
      expect(bindingsOf(activePool.run.id)[0]).toMatchObject({ launchDetail: '', generation: 'generationnew' })
      expect(migrated.listAgentRegistrations(activePool.run.id)).toHaveLength(1)
      expect(bindingsOf(launching.run.id).find((binding) => binding.agentSessionId === launchingBinding.agentSessionId)?.acknowledgedAt).toBeDefined()
      // 会话围栏据此把仍持旧团队令牌的会话判为 run_completed；活动池的通道照常。
      migrated.setActiveWorkspace('legacy')
      expect(migrated.resolveChannelSessionOwner('1')).toMatchObject({ runId: draft.run.id, runStatus: 'completed' })
      migrated.setActiveWorkspace('pool')
      expect(migrated.resolveChannelSessionOwner('1')).toMatchObject({ runId: activePool.run.id, runStatus: 'running', bound: true })
      // 已归档的团队 run 拒绝签到。
      expect(() => migrated.recordAgentCheckIn({
        agentSessionId: launchingBinding.agentSessionId, runId: launchingBinding.runId, capabilities: []
      }, '升级后签到')).toThrowError(expect.objectContaining({ code: 'run_completed' }))
    } finally {
      migrated.close()
    }
    // 启动状态机退役：列保留，但存量行全部归位（恒 not_started / NULL），此后没有代码再写别的值。
    const columns = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = columns.prepare('SELECT launch_status, launch_command_id FROM runtime_bindings').all() as { launch_status: string; launch_command_id: string | null }[]
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.launch_status === 'not_started' && row.launch_command_id === null)).toBe(true)
    } finally {
      columns.close()
    }

    // 幂等：再开一次库不再改任何行（活动池仍 running，revision 不变）。
    const before = new DatabaseSync(path, { readOnly: true })
    const revisionBefore = (before.prepare('SELECT revision FROM team_control_meta WHERE id = 1').get() as { revision: number }).revision
    before.close()
    const reopened = new SqliteTeamControlRepository(path)
    try {
      expect(reopened.loadTeamControl().runs.find((run) => run.id === activePool.run.id)?.status).toBe('running')
      expect(reopened.revision()).toBe(revisionBefore)
    } finally {
      reopened.close()
    }
  })
})

describe('SqliteTeamControlRepository 会话围栏令牌', () => {
  const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/

  /** legacy 团队 run（lead + 若干 solo 旁路席位），直接 running（阶段 2 · 2B 起没有 draft / ready）。 */
  function installed(repository: SqliteTeamControlRepository, workspaceId: string, channelIds: string[]) {
    const team = createConfiguredTeamBundle({
      workspaceId, workspaceName: workspaceId, workspacePath: `/workspace/${workspaceId}`, now: 100,
      members: channelIds.map((channelId, index) => (
        index === 0
          ? { channelId, roleTemplateKey: 'lead', avatarId: 'lead', skills: [] }
          : { channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }
      ))
    })
    team.run.status = 'running'
    repository.upsertWorkspaceTeam(team)
    repository.recordInstallation({
      workspaceId, runId: team.run.id, generation: 'generation123',
      agents: team.slots.map((slot) => ({
        agentSessionId: `${workspaceId}:ch-${slot.channelId}:generation123`, workspaceId,
        channelId: slot.channelId!, generation: 'generation123', runId: team.run.id,
        capabilities: team.roles.find((role) => role.id === slot.roleId)!.capabilities
      }))
    })
    return team
  }

  it('issues one distinct token per binding at install time and exposes it through the owner query', () => {
    const repository = repositoryFixture()
    try {
      const team = installed(repository, 'fenced', ['1', '2'])
      const bindings = repository.loadTeamControl().bindings.filter((binding) => binding.runId === team.run.id)
      expect(bindings).toHaveLength(2)
      for (const binding of bindings) expect(binding.sessionToken).toMatch(TOKEN_PATTERN)
      expect(new Set(bindings.map((binding) => binding.sessionToken)).size).toBe(2)

      const lead = repository.resolveChannelSessionOwner('1')
      // 席位随归属一起返回（团队消息按它收件）；这个 legacy 夹具没有协作组，所以没有 groupId。
      expect(lead).toEqual({
        runId: team.run.id, runStatus: 'running', bound: true,
        sessionToken: bindings.find((binding) => binding.channelId === '1')!.sessionToken, solo: false,
        slotId: bindings.find((binding) => binding.channelId === '1')!.slotId
      })
      expect(repository.resolveChannelSessionOwner('2')).toMatchObject({ bound: true, solo: true })
      expect(repository.resolveChannelSessionOwner(' 2 ')).toEqual(repository.resolveChannelSessionOwner('2'))
    } finally {
      repository.close()
    }
  })

  it('reports an unbound channel of the active run and no owner when no workspace is active', () => {
    const repository = repositoryFixture()
    try {
      expect(repository.resolveChannelSessionOwner('1')).toBeUndefined()
      const team = installed(repository, 'partial', ['1'])
      expect(repository.resolveChannelSessionOwner('9')).toEqual({
        runId: team.run.id, runStatus: 'running', bound: false, sessionToken: undefined, solo: false
      })
    } finally {
      repository.close()
    }
  })

  it('follows the newest run of the active workspace, exactly like the desktop activeRun projection', () => {
    const repository = repositoryFixture()
    try {
      const first = installed(repository, 'switching', ['1'])
      const firstToken = repository.resolveChannelSessionOwner('1')?.sessionToken
      const second = createConfiguredTeamBundle({
        workspaceId: 'switching', workspaceName: 'switching', workspacePath: '/workspace/switching',
        now: 200, runKey: 'run-second00', mode: 'independent',
        members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }]
      })
      repository.upsertWorkspaceTeam(second)
      // 新 run 尚未安装：通道在新 run 里无绑定 → 旧令牌按 channel_unbound 退役。
      expect(repository.resolveChannelSessionOwner('1')).toMatchObject({ runId: second.run.id, bound: false })
      expect(repository.resolveChannelSessionOwner('1')?.runId).not.toBe(first.run.id)
      repository.recordInstallation({
        workspaceId: 'switching', runId: second.run.id, generation: 'generation456',
        agents: [{
          agentSessionId: 'switching:ch-1:generation456', workspaceId: 'switching', channelId: '1',
          generation: 'generation456', runId: second.run.id, capabilities: []
        }]
      })
      const owner = repository.resolveChannelSessionOwner('1')
      expect(owner).toMatchObject({ runId: second.run.id, runStatus: 'running', bound: true, solo: true })
      expect(owner?.sessionToken).toMatch(TOKEN_PATTERN)
      expect(owner?.sessionToken).not.toBe(firstToken)
    } finally {
      repository.close()
    }
  })

  it('rotates the token on seat relaunch so a still-alive old Composer is fenced out', () => {
    const repository = repositoryFixture()
    try {
      const team = installed(repository, 'relaunch', ['1'])
      const before = repository.resolveChannelSessionOwner('1')!.sessionToken
      const slot = team.slots[0]!
      expect(repository.prepareComposerRelaunch({ runId: team.run.id, slotId: slot.id, bindingKey: 'relaunch-key-1' })).toBe(true)
      const after = repository.resolveChannelSessionOwner('1')!.sessionToken
      expect(after).toMatch(TOKEN_PATTERN)
      expect(after).not.toBe(before)
      // 同拓扑重复安装（补装 / 重激活）不轮换令牌：仍在轮询的会话不能被自己的围栏误杀。
      repository.recordInstallation({
        workspaceId: 'relaunch', runId: team.run.id, generation: 'generation456',
        agents: team.slots.map((candidate) => ({
          agentSessionId: `relaunch:ch-${candidate.channelId}:generation456`, workspaceId: 'relaunch',
          channelId: candidate.channelId!, generation: 'generation456', runId: team.run.id,
          capabilities: team.roles.find((role) => role.id === candidate.roleId)!.capabilities
        }))
      })
      expect(repository.resolveChannelSessionOwner('1')!.sessionToken).toBe(after)
    } finally {
      repository.close()
    }
  })

  it('marks the owner as completed with the caller-supplied completion detail', () => {
    const repository = repositoryFixture()
    try {
      const team = installed(repository, 'ending', ['1'])
      expect(repository.completeRun(team.run.id, 400, '用户已结束本轮运行')).toBe(true)
      expect(repository.resolveChannelSessionOwner('1')).toMatchObject({ runId: team.run.id, runStatus: 'completed', bound: true })
      const binding = repository.loadTeamControl().bindings.find((candidate) => candidate.runId === team.run.id)!
      expect(binding.launchDetail).toBe('用户已结束本轮运行')
      // 已结束的 run 不能再收尾一次（returns false，不改动绑定文案）。
      expect(repository.completeRun(team.run.id, 500)).toBe(false)
      expect(repository.loadTeamControl().bindings.find((candidate) => candidate.runId === team.run.id)?.launchDetail)
        .toBe('用户已结束本轮运行')
      // 缺省文案：没有 failover「全员离线」语义了，只是中性的「已结束」。
      const other = installed(repository, 'ending-default', ['1'])
      expect(repository.completeRun(other.run.id, 400)).toBe(true)
      expect(repository.loadTeamControl().bindings.find((candidate) => candidate.runId === other.run.id)?.launchDetail)
        .toBe('本轮运行已结束')
    } finally {
      repository.close()
    }
  })

  it('adds the session_token column to a pre-fence database and treats existing bindings as legacy', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-fence-migrate-')), 'control.sqlite3')
    const seeded = new SqliteTeamControlRepository(path)
    const team = installed(seeded, 'legacy', ['1'])
    seeded.close()
    // 模拟升级前的库：旧构建没有 session_token 列。
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE runtime_bindings DROP COLUMN session_token')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    try {
      const binding = migrated.loadTeamControl().bindings.find((candidate) => candidate.runId === team.run.id)!
      expect(binding.sessionToken).toBeUndefined()
      expect(migrated.resolveChannelSessionOwner('1')).toMatchObject({ runId: team.run.id, bound: true, sessionToken: undefined })
      // 迁移后新签发照常。
      expect(migrated.prepareComposerRelaunch({ runId: team.run.id, slotId: team.slots[0]!.id, bindingKey: 'post-migrate' })).toBe(true)
      expect(migrated.resolveChannelSessionOwner('1')?.sessionToken).toMatch(TOKEN_PATTERN)
    } finally {
      migrated.close()
    }
  })

  it('drops the retired team-continuity tables left behind by older builds, idempotently (2D)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-team-control-continuity-drop-')), 'control.sqlite3')
    const seeded = new SqliteTeamControlRepository(path)
    const team = installed(seeded, 'cont', ['1'])
    seeded.close()
    // 模拟旧构建的 continuity 仓储建过的四张表（含指向 team_runs / agent_slots 的外键与已写入的行）。
    const old = new DatabaseSync(path)
    old.exec('PRAGMA foreign_keys = ON')
    old.exec(`
      CREATE TABLE team_continuity_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE team_checkpoints (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, reason TEXT NOT NULL, digest TEXT NOT NULL, capsule_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE team_restore_operations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE, checkpoint_id TEXT NOT NULL REFERENCES team_checkpoints(id) ON DELETE RESTRICT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE team_restore_members (restore_id TEXT NOT NULL REFERENCES team_restore_operations(id) ON DELETE CASCADE, slot_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE, role_name TEXT NOT NULL, message_id TEXT, PRIMARY KEY (restore_id, slot_id));
      INSERT INTO team_continuity_meta VALUES (1, 1, 3, 0);
    `)
    old.prepare('INSERT INTO team_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)').run('cp-1', team.workspace.id, team.run.id, 'automatic', 'a'.repeat(64), '{}', 1)
    old.prepare('INSERT INTO team_restore_operations VALUES (?, ?, ?, ?, ?, ?, ?)').run('r-1', team.workspace.id, team.run.id, 'cp-1', 'waiting', 1, 1)
    old.prepare('INSERT INTO team_restore_members VALUES (?, ?, ?, NULL)').run('r-1', team.slots[0]!.id, '主控协调')
    old.close()

    const tables = (): string[] => {
      const db = new DatabaseSync(path)
      try {
        return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'team_%' ORDER BY name").all() as Array<{ name: string }>)
          .map((row) => row.name)
      } finally {
        db.close()
      }
    }
    const migrated = new SqliteTeamControlRepository(path)
    migrated.close()
    const after = tables()
    for (const table of ['team_continuity_meta', 'team_checkpoints', 'team_restore_operations', 'team_restore_members']) {
      expect(after).not.toContain(table)
    }
    // 现役表与数据不受影响；再次打开是无操作。
    const reopened = new SqliteTeamControlRepository(path)
    try {
      expect(reopened.loadTeamControl().runs.map((run) => run.id)).toContain(team.run.id)
      expect(reopened.resolveChannelSessionOwner('1')).toMatchObject({ runId: team.run.id, bound: true })
    } finally {
      reopened.close()
    }
    expect(tables()).toEqual(after)
  })
})
