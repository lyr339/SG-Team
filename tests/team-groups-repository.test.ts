import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createConfiguredTeamBundle, type WorkspaceTeamBundle } from '../src/domain/team-control'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'

/**
 * 会话池 + 协作组的仓储契约：入组 / 出组只改 agent_slots.group_id / role_id / is_solo 与组角色行，
 * 绝不触碰 runtime_bindings（令牌 / Composer / generation）；每次成员变化写一行审计事件。
 */

function databasePath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `sg-team-groups-${prefix}-`)), 'control.sqlite3')
}

/** 会话池：N 个 solo 席位的独立批次 run，并完成 MCP 注册（签发令牌）。 */
function installedPool(repository: SqliteTeamControlRepository, workspaceId: string, channelIds: string[]): WorkspaceTeamBundle {
  const pool = createConfiguredTeamBundle({
    workspaceId, workspaceName: workspaceId, workspacePath: `/workspace/${workspaceId}`, now: 100,
    mode: 'independent', runKey: `run-${workspaceId}00`,
    members: channelIds.map((channelId) => ({
      channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true
    }))
  })
  repository.upsertWorkspaceTeam(pool)
  repository.recordInstallation({
    workspaceId, runId: pool.run.id, generation: 'gen-pool',
    agents: pool.slots.map((slot) => ({
      agentSessionId: `${workspaceId}:ch-${slot.channelId}:gen-pool`, workspaceId,
      channelId: slot.channelId!, generation: 'gen-pool', runId: pool.run.id, capabilities: []
    }))
  })
  return pool
}

function slotOf(pool: WorkspaceTeamBundle, channelId: string) {
  return pool.slots.find((slot) => slot.channelId === channelId)!
}

function code(operation: () => unknown): string | undefined {
  try {
    operation()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('SqliteTeamControlRepository 协作组', () => {
  it('createGroup flips members to group roles and leaves every runtime binding untouched (I1 / I2 / I6)', () => {
    const repository = new SqliteTeamControlRepository(databasePath('create'))
    try {
      const pool = installedPool(repository, 'pool', ['1', '2', '3'])
      const before = repository.loadTeamControl()
      const bindingsBefore = before.bindings.filter((binding) => binding.runId === pool.run.id)
      const [a, b] = [slotOf(pool, '1'), slotOf(pool, '2')]

      const mutation = repository.createGroup({
        runId: pool.run.id, name: '验收组', goal: '把接口重构收尾', at: 500,
        members: [{ slotId: a.id, roleTemplateKey: 'lead' }, { slotId: b.id, roleTemplateKey: 'specialist' }],
        leadSlotId: a.id
      })
      expect(mutation.group).toMatchObject({
        runId: pool.run.id, name: '验收组', goal: '把接口重构收尾', status: 'active', leadSlotId: a.id, createdAt: 500
      })
      expect(mutation.joined.map((change) => [change.slotId, change.channelId, change.roleName, change.roleTemplateKey])).toEqual([
        [a.id, '1', '主控协调', 'lead'],
        [b.id, '2', '专项实现 1', 'specialist']
      ])
      expect(mutation.leadChange).toEqual({ nextSlotId: a.id })

      const state = repository.loadTeamControl()
      expect(state.revision).toBeGreaterThan(before.revision)
      expect(state.groups).toHaveLength(1)
      const grouped = state.slots.filter((slot) => slot.groupId === mutation.group.id)
      expect(grouped.map((slot) => slot.channelId).sort()).toEqual(['1', '2'])
      for (const slot of grouped) {
        expect(slot.solo).toBe(false)
        expect(slot.homeRoleId).toBe(pool.slots.find((candidate) => candidate.id === slot.id)!.roleId)
        expect(slot.groupJoinedAt).toBe(500)
        const role = state.roles.find((candidate) => candidate.id === slot.roleId)!
        expect(role.groupId).toBe(mutation.group.id)
        expect(role.runId).toBe(pool.run.id)
      }
      // 第三席仍是独立席位，且 solo 角色行原样保留（出组时要恢复）。
      const solo = state.slots.find((slot) => slot.channelId === '3')!
      expect(solo).toMatchObject({ solo: true, groupId: undefined, homeRoleId: undefined })
      expect(state.roles.filter((role) => role.runId === pool.run.id && role.templateKey === 'solo')).toHaveLength(3)
      // I2：令牌 / Composer 键 / generation / launch 状态一字不变；run 状态仍 running。
      expect(state.bindings.filter((binding) => binding.runId === pool.run.id)).toEqual(bindingsBefore)
      expect(state.runs.find((run) => run.id === pool.run.id)?.status).toBe('running')
      // I6：审计行齐全。
      expect(repository.listGroupEvents(mutation.group.id).map((event) => [event.type, event.slotId, event.channelId])).toEqual([
        ['created', undefined, undefined],
        ['member_joined', a.id, '1'],
        ['member_joined', b.id, '2'],
        ['lead_changed', a.id, undefined]
      ])
    } finally {
      repository.close()
    }
  })

  it('resolves grouped identities with groupId and lead capabilities; ungrouped seats get not_in_group', () => {
    const repository = new SqliteTeamControlRepository(databasePath('identity'))
    try {
      const pool = installedPool(repository, 'ident', ['1', '2', '3'])
      const [a, b] = [slotOf(pool, '1'), slotOf(pool, '2')]
      // lead 权限与模板解耦：一个 specialist 也能当组 lead，并因此获得 coordination / planning。
      const { group } = repository.createGroup({
        runId: pool.run.id, name: 'G', members: [
          { slotId: a.id, roleTemplateKey: 'specialist' }, { slotId: b.id, roleTemplateKey: 'reviewer' }
        ], leadSlotId: a.id
      })
      const lead = repository.resolveChannelAgentIdentity('1')
      expect(lead).toMatchObject({ runId: pool.run.id, slotId: a.id, groupId: group.id })
      expect([...lead.capabilities].sort()).toEqual(['code', 'coordination', 'implementation', 'planning'])
      const reviewer = repository.resolveChannelAgentIdentity('2')
      expect(reviewer.groupId).toBe(group.id)
      expect([...reviewer.capabilities].sort()).toEqual(['qa', 'testing'])
      expect(repository.resolveAgentRuntimeIdentity('ident:ch-2:gen-pool', pool.run.id)).toEqual(reviewer)

      expect(code(() => repository.resolveChannelAgentIdentity('3'))).toBe('not_in_group')
      expect(code(() => repository.resolveAgentRuntimeIdentity('ident:ch-3:gen-pool', pool.run.id))).toBe('not_in_group')
      // 围栏查询不感知分组：令牌与绑定照旧，只有派生的 solo 标记随成员关系翻转。
      expect(repository.resolveChannelSessionOwner('1')).toMatchObject({ runId: pool.run.id, bound: true, solo: false })
      expect(repository.resolveChannelSessionOwner('3')).toMatchObject({ runId: pool.run.id, bound: true, solo: true })

      // 临时主控优先于组 lead：reviewer 接管后拿到主控能力，原 lead 若持 lead 模板则被摘除。
      repository.setGroupActingLead({ groupId: group.id, slotId: b.id })
      expect([...repository.resolveChannelAgentIdentity('2').capabilities].sort()).toEqual(['coordination', 'planning', 'qa', 'testing'])
      expect([...repository.resolveChannelAgentIdentity('1').capabilities].sort()).toEqual(['code', 'implementation'])
      repository.setGroupActingLead({ groupId: group.id, slotId: null })
      expect(repository.resolveChannelAgentIdentity('1').capabilities).toContain('planning')
    } finally {
      repository.close()
    }
  })

  it('numbers same-template roles by the highest existing instance so re-adding after a removal never collides', () => {
    const repository = new SqliteTeamControlRepository(databasePath('numbering'))
    try {
      const pool = installedPool(repository, 'num', ['1', '2', '3', '4'])
      const { group } = repository.createGroup({
        runId: pool.run.id, name: 'G', members: [
          { slotId: slotOf(pool, '1').id, roleTemplateKey: 'specialist' },
          { slotId: slotOf(pool, '2').id, roleTemplateKey: 'specialist' },
          { slotId: slotOf(pool, '3').id, roleTemplateKey: 'builder' }
        ]
      })
      const names = () => repository.loadTeamControl().roles
        .filter((role) => role.groupId === group.id)
        .map((role) => [role.key, role.name])
        .sort()
      const short = `g${group.id.slice(-8)}`
      expect(names()).toEqual([
        [`${short}:builder`, '架构实现'],
        [`${short}:specialist-1`, '专项实现 1'],
        [`${short}:specialist-2`, '专项实现 2']
      ])
      repository.removeGroupMember({ groupId: group.id, slotId: slotOf(pool, '1').id })
      const added = repository.addGroupMembers({
        groupId: group.id, members: [
          { slotId: slotOf(pool, '4').id, roleTemplateKey: 'specialist' },
          { slotId: slotOf(pool, '1').id, roleTemplateKey: 'builder' }
        ]
      })
      expect(added.joined.map((change) => change.roleName)).toEqual(['专项实现 3', '架构实现 2'])
      expect(names()).toEqual([
        [`${short}:builder`, '架构实现'],
        [`${short}:builder-2`, '架构实现 2'],
        [`${short}:specialist-2`, '专项实现 2'],
        [`${short}:specialist-3`, '专项实现 3']
      ])
    } finally {
      repository.close()
    }
  })

  it('removing a member restores its solo identity and deletes its group role; the effective lead must hand over first', () => {
    const repository = new SqliteTeamControlRepository(databasePath('remove'))
    try {
      const pool = installedPool(repository, 'rm', ['1', '2'])
      const [a, b] = [slotOf(pool, '1'), slotOf(pool, '2')]
      const { group } = repository.createGroup({
        runId: pool.run.id, name: 'G', members: [
          { slotId: a.id, roleTemplateKey: 'lead' }, { slotId: b.id, roleTemplateKey: 'builder' }
        ], leadSlotId: a.id
      })
      expect(code(() => repository.removeGroupMember({ groupId: group.id, slotId: a.id }))).toBe('lead_must_transfer_first')

      const tokenBefore = repository.resolveChannelSessionOwner('2')!.sessionToken
      const groupRoleId = repository.loadTeamControl().slots.find((slot) => slot.id === b.id)!.roleId
      const mutation = repository.removeGroupMember({ groupId: group.id, slotId: b.id, at: 900 })
      expect(mutation.left).toEqual([{ slotId: b.id, channelId: '2', roleName: '架构实现', roleTemplateKey: 'builder' }])
      expect(mutation.leadChange).toBeUndefined()
      const state = repository.loadTeamControl()
      const restored = state.slots.find((slot) => slot.id === b.id)!
      expect(restored).toMatchObject({ solo: true, roleId: b.roleId, groupId: undefined, homeRoleId: undefined, groupJoinedAt: undefined })
      expect(state.roles.some((role) => role.id === groupRoleId)).toBe(false)
      expect(repository.resolveChannelSessionOwner('2')!.sessionToken).toBe(tokenBefore)
      expect(code(() => repository.resolveChannelAgentIdentity('2'))).toBe('not_in_group')
      expect(repository.listGroupEvents(group.id).at(-1)).toMatchObject({ type: 'member_left', slotId: b.id, channelId: '2', at: 900 })

      // 现在 lead 是唯一成员：可以移出；lead 字段随之清空并留审计。
      const last = repository.removeGroupMember({ groupId: group.id, slotId: a.id })
      expect(last.group.leadSlotId).toBeUndefined()
      expect(last.leadChange).toEqual({ previousSlotId: a.id, nextSlotId: undefined })
      expect(repository.loadTeamControl().slots.filter((slot) => slot.runId === pool.run.id).every((slot) => slot.solo)).toBe(true)
      // force：有效 lead 在其他成员仍在时也能被移出（解散 / 用户明确要求）。
      const again = repository.createGroup({
        runId: pool.run.id, name: 'G2', members: [
          { slotId: a.id, roleTemplateKey: 'lead' }, { slotId: b.id, roleTemplateKey: 'builder' }
        ], leadSlotId: a.id
      })
      expect(repository.removeGroupMember({ groupId: again.group.id, slotId: a.id, force: true }).group.leadSlotId).toBeUndefined()
    } finally {
      repository.close()
    }
  })

  it('setGroupLead accepts any member or none, clears the acting lead and is audited', () => {
    const repository = new SqliteTeamControlRepository(databasePath('lead'))
    try {
      const pool = installedPool(repository, 'lead', ['1', '2', '3'])
      const [a, b] = [slotOf(pool, '1'), slotOf(pool, '2')]
      const { group } = repository.createGroup({
        runId: pool.run.id, name: 'G', members: [
          { slotId: a.id, roleTemplateKey: 'lead' }, { slotId: b.id, roleTemplateKey: 'builder' }
        ], leadSlotId: a.id
      })
      repository.setGroupActingLead({ groupId: group.id, slotId: b.id })
      const handed = repository.setGroupLead({ groupId: group.id, slotId: b.id })
      expect(handed.group).toMatchObject({ leadSlotId: b.id, actingLeadSlotId: undefined })
      expect(handed.leadChange).toEqual({ previousSlotId: a.id, nextSlotId: b.id })
      const none = repository.setGroupLead({ groupId: group.id, slotId: null })
      expect(none.group.leadSlotId).toBeUndefined()
      expect(none.leadChange).toEqual({ previousSlotId: b.id, nextSlotId: undefined })
      expect(code(() => repository.setGroupLead({ groupId: group.id, slotId: slotOf(pool, '3').id }))).toBe('group_member_not_found')
      expect(repository.listGroupEvents(group.id).filter((event) => event.type === 'lead_changed')).toHaveLength(3)
    } finally {
      repository.close()
    }
  })

  it('dissolveGroup restores every member, drops the group roles and keeps the group row as history', () => {
    const repository = new SqliteTeamControlRepository(databasePath('dissolve'))
    try {
      const pool = installedPool(repository, 'dis', ['1', '2', '3'])
      const { group } = repository.createGroup({
        runId: pool.run.id, name: 'G', goal: '目标', members: pool.slots.map((slot) => ({ slotId: slot.id, roleTemplateKey: 'specialist' })),
        leadSlotId: slotOf(pool, '1').id
      })
      repository.setGroupActingLead({ groupId: group.id, slotId: slotOf(pool, '2').id })
      const bindingsBefore = repository.loadTeamControl().bindings
      const mutation = repository.dissolveGroup({ groupId: group.id, at: 1_000 })
      expect(mutation.left.map((change) => change.channelId)).toEqual(['1', '2', '3'])
      expect(mutation.group).toMatchObject({ status: 'dissolved', dissolvedAt: 1_000, actingLeadSlotId: undefined, leadSlotId: slotOf(pool, '1').id })
      const state = repository.loadTeamControl()
      expect(state.slots.filter((slot) => slot.runId === pool.run.id).every((slot) => slot.solo && !slot.groupId && !slot.homeRoleId)).toBe(true)
      expect(state.roles.filter((role) => role.groupId === group.id)).toHaveLength(0)
      expect(state.bindings).toEqual(bindingsBefore)
      expect(state.groups.find((candidate) => candidate.id === group.id)?.status).toBe('dissolved')
      expect(repository.listGroupEvents(group.id).at(-1)?.type).toBe('dissolved')
      expect(code(() => repository.addGroupMembers({ groupId: group.id, members: [{ slotId: slotOf(pool, '1').id, roleTemplateKey: 'builder' }] })))
        .toBe('group_dissolved')
      expect(code(() => repository.updateGroupGoal({ groupId: group.id, goal: 'x' }))).toBe('group_dissolved')
      // 席位可以立刻加入新组。
      expect(repository.createGroup({
        runId: pool.run.id, name: 'G2', members: [{ slotId: slotOf(pool, '1').id, roleTemplateKey: 'builder' }]
      }).joined).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('rejects groups outside a running session pool, double membership, non-member leads and solo group roles', () => {
    const repository = new SqliteTeamControlRepository(databasePath('validation'))
    try {
      const team = createConfiguredTeamBundle({
        workspaceId: 'team', workspaceName: 'team', workspacePath: '/workspace/team', now: 100,
        members: [
          { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
          { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }
        ]
      })
      repository.upsertWorkspaceTeam(team)
      expect(code(() => repository.createGroup({
        runId: team.run.id, name: 'G', members: [{ slotId: team.slots[1]!.id, roleTemplateKey: 'builder' }]
      }))).toBe('group_requires_pool_run')

      const pool = installedPool(repository, 'valid', ['1', '2', '3'])
      const [a, b, c] = [slotOf(pool, '1'), slotOf(pool, '2'), slotOf(pool, '3')]
      expect(code(() => repository.createGroup({ runId: pool.run.id, name: '  ', members: [{ slotId: a.id, roleTemplateKey: 'builder' }] })))
        .toBe('group_name_required')
      expect(code(() => repository.createGroup({ runId: pool.run.id, name: 'G', members: [] }))).toBe('group_members_required')
      expect(code(() => repository.createGroup({
        runId: pool.run.id, name: 'G', members: [{ slotId: a.id, roleTemplateKey: 'builder' }], leadSlotId: b.id
      }))).toBe('group_lead_not_member')
      expect(code(() => repository.createGroup({ runId: pool.run.id, name: 'G', members: [{ slotId: a.id, roleTemplateKey: 'solo' }] })))
        .toBe('group_role_solo_forbidden')
      expect(code(() => repository.createGroup({
        runId: pool.run.id, name: 'G', members: [{ slotId: team.slots[1]!.id, roleTemplateKey: 'builder' }]
      }))).toBe('group_member_not_in_run')
      // 失败的建组不留下半成品：无组行、无事件、席位仍 solo。
      expect(repository.loadTeamControl().groups).toHaveLength(0)

      const { group } = repository.createGroup({ runId: pool.run.id, name: 'G', members: [{ slotId: a.id, roleTemplateKey: 'builder' }] })
      expect(code(() => repository.createGroup({ runId: pool.run.id, name: 'H', members: [{ slotId: a.id, roleTemplateKey: 'builder' }] })))
        .toBe('group_member_already_grouped')
      expect(code(() => repository.addGroupMembers({ groupId: group.id, members: [{ slotId: b.id, roleTemplateKey: 'builder' }, { slotId: b.id, roleTemplateKey: 'reviewer' }] })))
        .toBe('group_member_duplicate')
      expect(code(() => repository.removeGroupMember({ groupId: group.id, slotId: c.id }))).toBe('group_member_not_found')
      expect(code(() => repository.removeGroupMember({ groupId: 'team-group:nope', slotId: c.id }))).toBe('group_not_found')
      // 池结束后不能再变更组。
      repository.completeRun(pool.run.id, 2_000, '用户已结束')
      expect(code(() => repository.addGroupMembers({ groupId: group.id, members: [{ slotId: b.id, roleTemplateKey: 'builder' }] })))
        .toBe('group_run_inactive')
      // 整体重写拓扑会把成员角色抹回 solo：有组成员的池拒绝这条路径。
      expect(() => repository.upsertWorkspaceTeam(pool)).toThrowError(/已有协作组成员/)
    } finally {
      repository.close()
    }
  })

  it('records member_checked_in for grouped seats when the agent checks in', () => {
    const repository = new SqliteTeamControlRepository(databasePath('checkin'))
    try {
      const pool = installedPool(repository, 'chk', ['1', '2'])
      const a = slotOf(pool, '1')
      const { group } = repository.createGroup({ runId: pool.run.id, name: 'G', members: [{ slotId: a.id, roleTemplateKey: 'builder' }] })
      const identity = repository.resolveChannelAgentIdentity('1')
      const receipt = repository.recordAgentCheckIn(identity, 'join-ok')
      expect(receipt).toMatchObject({ runId: pool.run.id, slotId: a.id, roleName: '架构实现' })
      expect(repository.listGroupEvents(group.id).at(-1)).toMatchObject({
        type: 'member_checked_in', slotId: a.id, channelId: '1', actor: `agent:${a.id}`, detail: 'join-ok'
      })
      expect(repository.loadTeamControl().bindings.find((binding) => binding.slotId === a.id)?.acknowledgedAt).toBeTypeOf('number')
      expect(repository.loadTeamControl().runs.find((run) => run.id === pool.run.id)?.status).toBe('running')
    } finally {
      repository.close()
    }
  })

  it('migrates a v7 database to v8 idempotently, including a second connection that opens the same file', () => {
    const path = databasePath('migrate')
    const seeded = new SqliteTeamControlRepository(path)
    const pool = installedPool(seeded, 'mig', ['1', '2'])
    seeded.close()
    // 回到 v7 形态：没有组表，席位 / 角色没有组列。
    const old = new DatabaseSync(path)
    old.exec('DROP INDEX IF EXISTS idx_agent_slots_group')
    old.exec('ALTER TABLE agent_slots DROP COLUMN group_id')
    old.exec('ALTER TABLE agent_slots DROP COLUMN home_role_id')
    old.exec('ALTER TABLE agent_slots DROP COLUMN group_joined_at')
    old.exec('ALTER TABLE team_roles DROP COLUMN group_id')
    old.exec('DROP TABLE team_group_events')
    old.exec('DROP TABLE team_groups')
    old.exec('UPDATE team_control_meta SET schema_version = 7 WHERE id = 1')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    // 主进程与 MCP 进程各自打开同一库：第二个连接看到的已是 v8，不得报错也不得重复迁移。
    const second = new SqliteTeamControlRepository(path)
    try {
      for (const repository of [migrated, second]) {
        const state = repository.loadTeamControl()
        expect(state.schemaVersion).toBe(9)
        expect(state.groups).toEqual([])
        expect(state.slots.filter((slot) => slot.runId === pool.run.id).every((slot) => slot.solo && slot.groupId === undefined)).toBe(true)
      }
      const database = new DatabaseSync(path, { readOnly: true })
      try {
        const slotColumns = (database.prepare('PRAGMA table_info(agent_slots)').all() as Array<{ name: string }>).map((column) => column.name)
        expect(slotColumns).toEqual(expect.arrayContaining(['group_id', 'home_role_id', 'group_joined_at']))
        expect((database.prepare('PRAGMA table_info(team_roles)').all() as Array<{ name: string }>).map((column) => column.name)).toContain('group_id')
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('team_groups', 'team_group_events')").all()).toHaveLength(2)
      } finally {
        database.close()
      }
      // 迁移后的库可以直接建组，第二个连接实时看到。
      const { group } = migrated.createGroup({
        runId: pool.run.id, name: '迁移后建组', members: [{ slotId: slotOf(pool, '1').id, roleTemplateKey: 'builder' }]
      })
      expect(second.loadTeamControl().groups.map((candidate) => candidate.id)).toEqual([group.id])
      expect(second.resolveChannelAgentIdentity('1').groupId).toBe(group.id)
    } finally {
      second.close()
      migrated.close()
    }
  })

  it('defaults the plan policy from the lead and only opens planning to members in a lead-less any_member group (2A)', () => {
    const repository = new SqliteTeamControlRepository(databasePath('plan-policy'))
    try {
      const pool = installedPool(repository, 'plan', ['1', '2', '3', '4'])
      const [a, b, c, d] = [slotOf(pool, '1'), slotOf(pool, '2'), slotOf(pool, '3'), slotOf(pool, '4')]
      const planningCapabilities = (channelId: string) => repository.resolveChannelAgentIdentity(channelId).capabilities
        .filter((capability) => capability === 'planning' || capability === 'coordination').sort()

      // 有 lead：默认 lead_only；规划能力只在 lead 身上。
      const led = repository.createGroup({
        runId: pool.run.id, name: '有 lead', leadSlotId: a.id,
        members: [{ slotId: a.id, roleTemplateKey: 'specialist' }, { slotId: b.id, roleTemplateKey: 'builder' }]
      }).group
      expect(led.planPolicy).toBe('lead_only')
      expect(planningCapabilities('1')).toEqual(['coordination', 'planning'])
      expect(planningCapabilities('2')).toEqual([])
      // 有 lead 的组即使写成 any_member，规划权仍只归有效 lead（策略只是预设）。
      repository.setGroupPlanPolicy({ groupId: led.id, planPolicy: 'any_member' })
      expect(planningCapabilities('2')).toEqual([])
      expect(repository.listGroupEvents(led.id).at(-1)).toMatchObject({ type: 'plan_policy_updated', actor: 'operator', detail: 'lead_only → any_member' })

      // 无 lead：默认 any_member，每个成员都能规划（叠加主控模板能力）；显式 lead_only 则无人能规划。
      const flat = repository.createGroup({
        runId: pool.run.id, name: '无 lead', members: [{ slotId: c.id, roleTemplateKey: 'builder' }]
      }).group
      expect(flat.planPolicy).toBe('any_member')
      expect(planningCapabilities('3')).toEqual(['coordination', 'planning'])
      repository.setGroupPlanPolicy({ groupId: flat.id, planPolicy: 'lead_only' })
      expect(planningCapabilities('3')).toEqual([])
      expect(repository.loadTeamControl().groups.find((group) => group.id === flat.id)?.planPolicy).toBe('lead_only')

      const explicit = repository.createGroup({
        runId: pool.run.id, name: '显式', planPolicy: 'lead_only', members: [{ slotId: d.id, roleTemplateKey: 'reviewer' }]
      }).group
      expect(explicit.planPolicy).toBe('lead_only')
      expect(planningCapabilities('4')).toEqual([])
      // 后来指定了 lead：规划权归 lead，与策略无关。
      repository.setGroupLead({ groupId: flat.id, slotId: c.id })
      expect(planningCapabilities('3')).toEqual(['coordination', 'planning'])
      expect(code(() => repository.setGroupPlanPolicy({ groupId: flat.id, planPolicy: 'everyone' as never }))).toBe('group_plan_policy_invalid')
    } finally {
      repository.close()
    }
  })

  it('adds the plan_policy column to a v8 database that predates it, defaulting existing groups to lead_only', () => {
    const path = databasePath('plan-policy-migrate')
    const seeded = new SqliteTeamControlRepository(path)
    const pool = installedPool(seeded, 'ppm', ['1', '2'])
    const leaderless = seeded.createGroup({ runId: pool.run.id, name: '旧组', members: [{ slotId: slotOf(pool, '1').id, roleTemplateKey: 'builder' }] }).group
    expect(leaderless.planPolicy).toBe('any_member')
    seeded.close()
    // 回到没有 plan_policy 列的 v8 形态（09-15 之前的构建建的库）。
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE team_groups DROP COLUMN plan_policy')
    old.close()

    const migrated = new SqliteTeamControlRepository(path)
    const second = new SqliteTeamControlRepository(path)
    try {
      for (const repository of [migrated, second]) {
        expect(repository.loadTeamControl().schemaVersion).toBe(9)
        // 旧库里已有的无 lead 组按最保守的 lead_only 回填：不会因为升级就悄悄让成员拿到规划权。
        expect(repository.loadTeamControl().groups.find((group) => group.id === leaderless.id)?.planPolicy).toBe('lead_only')
      }
      expect(migrated.resolveChannelAgentIdentity('1').capabilities).not.toContain('planning')
      const fresh = migrated.createGroup({ runId: pool.run.id, name: '新组', members: [{ slotId: slotOf(pool, '2').id, roleTemplateKey: 'builder' }] }).group
      expect(fresh.planPolicy).toBe('any_member')
      expect(second.resolveChannelAgentIdentity('2').capabilities).toContain('planning')
    } finally {
      second.close()
      migrated.close()
    }
  })
})

describe('SqliteTeamControlRepository 成员身份迁移（2C）', () => {
  it('moves the group role in one transaction, leaves bindings alone and records a completed failover row', () => {
    const repository = new SqliteTeamControlRepository(databasePath('transfer'))
    try {
      const pool = installedPool(repository, 'tr', ['1', '2', '3'])
      const [a, b, c] = [slotOf(pool, '1'), slotOf(pool, '2'), slotOf(pool, '3')]
      const { group } = repository.createGroup({
        runId: pool.run.id, name: '接口重构', goal: '收口查询路径', at: 500,
        members: [{ slotId: a.id, roleTemplateKey: 'lead' }, { slotId: b.id, roleTemplateKey: 'builder' }],
        leadSlotId: a.id
      })
      const bindingsBefore = repository.loadTeamControl().bindings
        .map((binding) => [binding.slotId, binding.channelId, binding.sessionToken, binding.composerBindingKey])

      const transfer = repository.transferGroupMembership({ groupId: group.id, fromSlotId: b.id, toSlotId: c.id, at: 900 })
      expect(transfer.from).toMatchObject({ slotId: b.id, channelId: '2', roleName: '架构实现', roleTemplateKey: 'builder' })
      expect(transfer.to).toMatchObject({ slotId: c.id, channelId: '3', roleName: '架构实现', roleTemplateKey: 'builder' })
      expect(transfer.transferredLead).toBe(false)
      expect(transfer.failover).toMatchObject({
        runId: pool.run.id, slotId: b.id, roleName: '架构实现',
        fromChannelId: '2', fromAgentSessionId: 'tr:ch-2:gen-pool',
        toChannelId: '3', toAgentSessionId: 'tr:ch-3:gen-pool',
        status: 'completed', reason: 'manual_membership_transfer', detectedAt: 900, completedAt: 900
      })
      expect(repository.listFailovers(pool.run.id)).toHaveLength(1)

      const state = repository.loadTeamControl()
      // B 恢复独立（home 角色、is_solo=1），C 顶上同一组角色；lead 不动。
      const slotRow = (slotId: string) => state.slots.find((slot) => slot.id === slotId)!
      expect(slotRow(b.id)).toMatchObject({ groupId: undefined, solo: true })
      expect(slotRow(c.id)).toMatchObject({ groupId: group.id, solo: false })
      expect(state.groups.find((candidate) => candidate.id === group.id)?.leadSlotId).toBe(a.id)
      // 绑定 / 令牌 / Composer 键全部原样（I6：成员关系不触碰运行时）。
      expect(state.bindings.map((binding) => [binding.slotId, binding.channelId, binding.sessionToken, binding.composerBindingKey]))
        .toEqual(bindingsBefore)
      // 审计事件序列：member_left(B) → member_joined(C)。
      const events = repository.listGroupEvents(group.id).slice(-2)
      expect(events.map((event) => [event.type, event.slotId, event.channelId])).toEqual([
        ['member_left', b.id, '2'],
        ['member_joined', c.id, '3']
      ])
    } finally {
      repository.close()
    }
  })

  it('carries the lead and the acting lead with the membership so an effective lead never silently disappears', () => {
    const repository = new SqliteTeamControlRepository(databasePath('transfer-lead'))
    try {
      const pool = installedPool(repository, 'trl', ['1', '2', '3', '4'])
      const [a, b, c, d] = [slotOf(pool, '1'), slotOf(pool, '2'), slotOf(pool, '3'), slotOf(pool, '4')]
      const { group } = repository.createGroup({
        runId: pool.run.id, name: '验收', members: [{ slotId: a.id, roleTemplateKey: 'lead' }, { slotId: b.id, roleTemplateKey: 'builder' }],
        leadSlotId: a.id
      })
      // 组 lead（A）迁给 C：lead_slot_id 跟着走，事件带「成员身份迁移」说明。
      const leadTransfer = repository.transferGroupMembership({ groupId: group.id, fromSlotId: a.id, toSlotId: c.id })
      expect(leadTransfer.transferredLead).toBe(true)
      let state = repository.loadTeamControl()
      expect(state.groups.find((candidate) => candidate.id === group.id)).toMatchObject({ leadSlotId: c.id, actingLeadSlotId: undefined })
      expect(repository.listGroupEvents(group.id).at(-1)).toMatchObject({
        type: 'lead_changed', slotId: c.id, detail: `${a.id} → ${c.id}（成员身份迁移）`
      })
      // 临时主控（B 接管）迁给 D：acting_lead_slot_id 跟着走，有效 lead 从 B 到 D。
      repository.setGroupActingLead({ groupId: group.id, slotId: b.id })
      const actingTransfer = repository.transferGroupMembership({ groupId: group.id, fromSlotId: b.id, toSlotId: d.id })
      expect(actingTransfer.transferredLead).toBe(true)
      state = repository.loadTeamControl()
      expect(state.groups.find((candidate) => candidate.id === group.id)).toMatchObject({ leadSlotId: c.id, actingLeadSlotId: d.id })
      expect(repository.listGroupEvents(group.id).at(-1)).toMatchObject({
        type: 'acting_lead_changed', slotId: d.id, detail: `${b.id} → ${d.id}（成员身份迁移）`
      })
      // 名义 lead（C）另有临时主控（D）时迁给 A：lead_slot_id 照样改指 A（带审计），但有效 lead 仍是 D——
      // transferredLead=false，服务层据此不会告诉 A「你已成为唯一有效主控」。
      const nominalTransfer = repository.transferGroupMembership({ groupId: group.id, fromSlotId: c.id, toSlotId: a.id })
      expect(nominalTransfer.transferredLead).toBe(false)
      state = repository.loadTeamControl()
      expect(state.groups.find((candidate) => candidate.id === group.id)).toMatchObject({ leadSlotId: a.id, actingLeadSlotId: d.id })
      expect(repository.listGroupEvents(group.id).at(-1)).toMatchObject({
        type: 'lead_changed', slotId: a.id, detail: `${c.id} → ${a.id}（成员身份迁移）`
      })
    } finally {
      repository.close()
    }
  })

  it('refuses transfers that would corrupt membership, atomically (no partial writes)', () => {
    const repository = new SqliteTeamControlRepository(databasePath('transfer-refuse'))
    try {
      const pool = installedPool(repository, 'trr', ['1', '2', '3'])
      const [a, b, c] = [slotOf(pool, '1'), slotOf(pool, '2'), slotOf(pool, '3')]
      const { group } = repository.createGroup({
        runId: pool.run.id, name: 'G1', members: [{ slotId: a.id, roleTemplateKey: 'lead' }], leadSlotId: a.id
      })
      const other = repository.createGroup({
        runId: pool.run.id, name: 'G2', members: [{ slotId: b.id, roleTemplateKey: 'builder' }]
      }).group

      expect(code(() => repository.transferGroupMembership({ groupId: group.id, fromSlotId: a.id, toSlotId: a.id }))).toBe('transfer_same_slot')
      // 目标已在其他组：拒绝，且 A 仍在组内（leaveMember 不能留下半程状态）。
      expect(code(() => repository.transferGroupMembership({ groupId: group.id, fromSlotId: a.id, toSlotId: b.id }))).toBe('group_member_already_grouped')
      expect(repository.loadTeamControl().slots.find((slot) => slot.id === a.id)?.groupId).toBe(group.id)
      // 源不是本组成员。
      expect(code(() => repository.transferGroupMembership({ groupId: group.id, fromSlotId: c.id, toSlotId: b.id }))).toBe('group_member_not_found')
      // 解散后的组不能迁移。
      repository.dissolveGroup({ groupId: other.id })
      expect(code(() => repository.transferGroupMembership({ groupId: other.id, fromSlotId: b.id, toSlotId: c.id }))).toBe('group_dissolved')
      // 池结束后不能迁移。
      expect(repository.completeRun(pool.run.id, 2_000)).toBe(true)
      expect(code(() => repository.transferGroupMembership({ groupId: group.id, fromSlotId: a.id, toSlotId: c.id }))).toBe('group_run_inactive')
      expect(repository.listFailovers(pool.run.id)).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('records member_rejoined_after_rebuild with the system actor and refuses non-members', () => {
    const repository = new SqliteTeamControlRepository(databasePath('rebuilt'))
    try {
      const pool = installedPool(repository, 'rb', ['1', '2'])
      const [a, b] = [slotOf(pool, '1'), slotOf(pool, '2')]
      const { group } = repository.createGroup({
        runId: pool.run.id, name: 'G', members: [{ slotId: a.id, roleTemplateKey: 'builder' }]
      })
      const before = repository.loadTeamControl().revision
      repository.recordGroupMemberRebuilt({ groupId: group.id, slotId: a.id, at: 800 })
      expect(repository.listGroupEvents(group.id).at(-1)).toMatchObject({
        type: 'member_rejoined_after_rebuild', slotId: a.id, channelId: '1', actor: 'system', detail: '架构实现', at: 800
      })
      expect(repository.loadTeamControl().revision).toBeGreaterThan(before)
      expect(code(() => repository.recordGroupMemberRebuilt({ groupId: group.id, slotId: b.id }))).toBe('group_member_not_found')
      repository.dissolveGroup({ groupId: group.id })
      expect(code(() => repository.recordGroupMemberRebuilt({ groupId: group.id, slotId: a.id }))).toBe('group_dissolved')
    } finally {
      repository.close()
    }
  })
})
