import { numberOf, type SqliteRow } from '../sqlite/rows'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  AgentAuthorizationIdentity,
  AgentRegistration,
  AgentRegistrationBatch
} from '../../application/agent-authorization'
import type { AgentCheckInReceipt } from '../../application/agent-presence'
import type { TeamControlRepository } from '../../application/team-control-repository'
import {
  buildGroupRoles,
  defaultGroupPlanPolicy,
  effectiveGroupLeadSlotId,
  groupMembersMayPlan,
  INDEPENDENT_SESSION_TEMPLATE_ID,
  isSessionPoolRun,
  LEAD_ROLE_CAPABILITIES,
  type AgentSlot,
  type RuntimeBinding,
  type TeamControlState,
  type TeamGroup,
  type TeamGroupEvent,
  type TeamGroupEventType,
  type TeamGroupMemberConfiguration,
  type TeamGroupPlanPolicy,
  type TeamGroupStatus,
  type TeamRole,
  type TeamRoleAccent,
  type TeamRun,
  type TeamRunStatus,
  type TeamWorkspace,
  type WorkspaceTeamBundle
} from '../../domain/team-control'
import type { GroupMembershipChange, GroupMembershipTransfer, TeamGroupMutation } from '../../application/team-control-repository'
import type { AssignedAgentSkill } from '../../domain/agent-skill'
import type { CursorModelSelection } from '../../domain/cursor-model'
import type { ChannelSessionOwnership } from '../../domain/session-fence'
import { TaskPoolError } from '../../domain/task-pool'
import type { ComposerBindingMethod } from '../../domain/cursor-telemetry'
import type { TeamFailoverRecord, TeamFailoverStatus } from '../../domain/team-failover'
import {
  ensureAgentRegistrationsSchema,
  replaceWorkspaceAgentRegistrations,
  revokeWorkspaceAgentRegistrations
} from '../sqlite/agent-registrations'

const TEAM_SCHEMA_VERSION = 9
const GROUP_NAME_MAX_LENGTH = 80
const GROUP_GOAL_MAX_LENGTH = 8_000
const COMPOSER_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/
const COMPOSER_BINDING_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const COMPOSER_BINDING_METHODS = new Set<ComposerBindingMethod>(['launch_marker', 'channel_marker'])
/** completeRun 的缺省收尾原因（显式结束/替换由调用方传入）。 */
const RUN_COMPLETED_DEFAULT_DETAIL = '本轮运行已结束'
/** v9 迁移把一次性团队 run 归档时写进各绑定 launch_detail 的说明。 */
const RUN_ARCHIVED_LEGACY_TEAM_DETAIL = 'archived: legacy team run（升级归档，团队 run 已退役）'
/** v9 迁移把同工作区内被更新 run 取代、却仍标 running 的旧独立 run 归档时的说明。 */
const RUN_ARCHIVED_STALE_POOL_DETAIL = 'archived: superseded pool run（升级归档，已被更新的运行取代）'

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : numberOf(value)
}

/**
 * 会话围栏令牌：每个 (run, slot) 绑定在签发/换席时生成一次，随开场提示交给该
 * Cursor 会话；通信工具携带它时服务端据此区分「同一通道号上的新旧会话」。
 * 与 composer_binding_key 不同，团队 launch 不轮换它（否则启动前创建的会话会被
 * 自己的团队围栏误杀）。
 */
function newSessionToken(): string {
  return randomUUID()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function stringArrayOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('团队能力字段不是合法 JSON 数组')
  return parsed.map(String).filter(Boolean)
}

/**
 * 身份行的有效能力。
 * - 组内席位：有效 lead（临时主控优先于组 lead）叠加主控模板能力；持 lead 模板却不是有效
 *   lead 的成员被摘除主控能力。lead 权限与角色模板解耦——任何模板的成员都能被指定为组 lead。
 * - legacy 团队 run：沿用 run 级 acting lead 与 run 内 lead 角色的能力交换。
 */
function effectiveCapabilities(row: SqliteRow): string[] {
  const base = new Set(stringArrayOf(row.capabilities_json))
  const slotId = String(row.slot_id)
  const templateKey = String(row.template_key ?? '')
  if (optionalString(row.group_id)) {
    const effectiveLead = optionalString(row.group_acting_lead_slot_id) ?? optionalString(row.group_lead_slot_id)
    const membersMayPlan = groupMembersMayPlan({
      leadSlotId: optionalString(row.group_lead_slot_id),
      actingLeadSlotId: optionalString(row.group_acting_lead_slot_id),
      planPolicy: planPolicyOf(row.group_plan_policy)
    })
    if (effectiveLead === slotId || membersMayPlan) {
      // 有效 lead，或无 lead 且允许全员规划的组里的每个成员：叠加主控模板能力（coordination / planning），
      // 让 TaskAgentService 的 plan / 任务板视图放行；directive / broadcast / collect 仍由 isEffectiveLead 单独把关。
      for (const capability of LEAD_ROLE_CAPABILITIES) base.add(capability)
    } else if (templateKey === 'lead') {
      for (const capability of LEAD_ROLE_CAPABILITIES) base.delete(capability)
    }
    return [...base]
  }
  const lead = new Set(stringArrayOf(row.lead_capabilities_json))
  const actingLeadSlotId = optionalString(row.acting_lead_slot_id)
  if (actingLeadSlotId) {
    if (slotId === actingLeadSlotId) {
      for (const capability of lead) base.add(capability)
    } else if (templateKey === 'lead') {
      for (const capability of lead) base.delete(capability)
    }
  }
  return [...base]
}

/**
 * 身份解析共用的 SELECT 主体：注册 → 绑定 → 席位 → 角色 → run，并带出组（LEFT JOIN）。
 * legacy 的 run 级 lead 角色只取 `group_id IS NULL` 的那一行——池 run 内每个组都可能有自己的
 * lead 模板角色，不加限定会让 JOIN 出多行。
 */
const IDENTITY_SELECT = `
  SELECT ar.agent_session_id, ar.run_id, b.slot_id, s.is_solo, s.group_id, r.template_key, r.capabilities_json,
    tr.acting_lead_slot_id, lead.capabilities_json AS lead_capabilities_json,
    g.lead_slot_id AS group_lead_slot_id, g.acting_lead_slot_id AS group_acting_lead_slot_id,
    g.plan_policy AS group_plan_policy
  FROM agent_registrations ar
  JOIN runtime_bindings b
    ON b.agent_session_id = ar.agent_session_id AND b.run_id = ar.run_id
  JOIN agent_slots s ON s.id = b.slot_id AND s.run_id = b.run_id
  JOIN team_roles r ON r.id = s.role_id AND r.run_id = b.run_id
  JOIN team_runs tr ON tr.id = b.run_id
  LEFT JOIN team_groups g ON g.id = s.group_id
  LEFT JOIN team_roles lead ON lead.run_id = b.run_id AND lead.template_key = 'lead' AND lead.group_id IS NULL
`

/**
 * 独立席位（is_solo=1 ⇔ 未入组）不参与团队协作：错误码 `not_in_group` 直接传播为工具结果，
 * 让模型得到「未入组 → 只用通信工具；入组后拾光会投递成员关系通知」的指引，而非笼统授权错误。
 */
function assertGroupedIdentity(row: SqliteRow, channelId: string | undefined): void {
  if (numberOf(row.is_solo) !== 1) return
  const who = channelId ? `CH-${channelId}` : '当前通道'
  throw new TaskPoolError(
    'not_in_group',
    `${who} 当前是独立席位，未加入任何协作组；请只用 check_messages / record_reply 与用户沟通。`
      + '入组后拾光会投递成员关系通知，届时再调用 team_check_in。'
  )
}

function identityFromRow(row: SqliteRow): AgentAuthorizationIdentity {
  return {
    agentSessionId: String(row.agent_session_id),
    runId: String(row.run_id),
    slotId: String(row.slot_id),
    capabilities: effectiveCapabilities(row),
    groupId: optionalString(row.group_id)
  }
}

/** `plan_policy` 列缺失（旧构建写入的行 / 尚未迁移的库）或值非法时按 lead_only 读——最保守的一档。 */
function planPolicyOf(value: unknown): TeamGroupPlanPolicy {
  return value === 'any_member' ? 'any_member' : 'lead_only'
}

function groupFromRow(row: SqliteRow): TeamGroup {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    name: String(row.name),
    goal: String(row.goal),
    status: String(row.status) as TeamGroupStatus,
    leadSlotId: optionalString(row.lead_slot_id),
    actingLeadSlotId: optionalString(row.acting_lead_slot_id),
    planPolicy: planPolicyOf(row.plan_policy),
    createdAt: numberOf(row.created_at),
    updatedAt: numberOf(row.updated_at),
    dissolvedAt: optionalNumber(row.dissolved_at)
  }
}

function groupEventFromRow(row: SqliteRow): TeamGroupEvent {
  return {
    seq: numberOf(row.seq),
    groupId: String(row.group_id),
    type: String(row.event_type) as TeamGroupEventType,
    slotId: optionalString(row.slot_id),
    channelId: optionalString(row.channel_id),
    actor: String(row.actor_key),
    detail: optionalString(row.detail),
    at: numberOf(row.created_at)
  }
}

function assignedSkillsOf(value: unknown): AssignedAgentSkill[] {
  if (typeof value !== 'string' || !value) return []
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('团队技能字段不是合法 JSON 数组')
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return []
    const scope = raw.scope === 'project' || raw.scope === 'user' ? raw.scope : 'builtin'
    return [{
      id: raw.id,
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : '',
      scope
    }]
  })
}

function cursorModelSelectionOf(value: unknown): CursorModelSelection | undefined {
  if (typeof value !== 'string' || !value) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const raw = parsed as Record<string, unknown>
  if (typeof raw.modelId !== 'string' || !raw.modelId.trim() || raw.modelId.length > 160) return undefined
  const displayName = typeof raw.displayName === 'string' && raw.displayName.trim()
    ? raw.displayName.trim().slice(0, 160)
    : raw.modelId.trim()
  const parameters = Array.isArray(raw.parameters) ? raw.parameters.slice(0, 32).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const parameter = item as Record<string, unknown>
    return typeof parameter.id === 'string' && parameter.id.trim()
      && typeof parameter.value === 'string' && parameter.value.length <= 160
      ? [{ id: parameter.id.trim().slice(0, 80), value: parameter.value }]
      : []
  }) : []
  return {
    modelId: raw.modelId.trim(),
    displayName,
    parameters,
    maxMode: raw.maxMode === true
  }
}

function tableHasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[])
    .some((row) => String(row.name) === column)
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

/**
 * 阶段 2 · 2D 退役的团队连续性（自动检查点 / 一键恢复）表，按外键依赖自子向父排列：
 * team_restore_members → team_restore_operations → team_checkpoints → team_continuity_meta。
 */
const RETIRED_CONTINUITY_TABLES = [
  'team_restore_members',
  'team_restore_operations',
  'team_checkpoints',
  'team_continuity_meta'
] as const

function normalizedNote(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 2_000)
}

function normalizedGroupName(value: string): string {
  const name = value.replace(/\s+/g, ' ').trim()
  if (!name) throw new TaskPoolError('group_name_required', '协作组名称不能为空')
  if (name.length > GROUP_NAME_MAX_LENGTH) throw new TaskPoolError('group_name_too_long', `协作组名称不能超过 ${GROUP_NAME_MAX_LENGTH} 个字符`)
  return name
}

/** 组目标可空（无 lead 的纯协作组可以只共享消息与记忆）。 */
function normalizedGroupGoal(value: string): string {
  const goal = value.replace(/\r\n/g, '\n').trim()
  if (goal.length > GROUP_GOAL_MAX_LENGTH) throw new TaskPoolError('group_goal_too_long', `组目标不能超过 ${GROUP_GOAL_MAX_LENGTH} 个字符`)
  return goal
}

function failoverFromRow(row: SqliteRow): TeamFailoverRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    slotId: String(row.slot_id),
    roleName: String(row.role_name),
    fromChannelId: String(row.from_channel_id),
    fromAgentSessionId: String(row.from_agent_session_id),
    toChannelId: optionalString(row.to_channel_id),
    toAgentSessionId: optionalString(row.to_agent_session_id),
    status: String(row.status) as TeamFailoverStatus,
    reason: String(row.reason),
    checkpointId: optionalString(row.checkpoint_id),
    messageId: optionalString(row.message_id),
    taskIds: stringArrayOf(row.task_ids_json),
    detectedAt: numberOf(row.detected_at),
    updatedAt: numberOf(row.updated_at),
    completedAt: optionalNumber(row.completed_at)
  }
}

export class SqliteTeamControlRepository implements TeamControlRepository {
  private readonly database: DatabaseSync
  private readonly revisionStatement: StatementSync

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path, { timeout: 5_000, defensive: true })
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA synchronous = NORMAL')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
    this.revisionStatement = this.database.prepare(
      'SELECT revision FROM team_control_meta WHERE id = 1'
    )
  }

  revision(): number {
    const row = this.revisionStatement.get() as SqliteRow | undefined
    if (!row) throw new Error('团队控制数据库缺少 meta 行')
    return numberOf(row.revision)
  }

  loadTeamControl(): TeamControlState {
    const meta = this.database.prepare(
      'SELECT schema_version, revision, active_workspace_id, updated_at FROM team_control_meta WHERE id = 1'
    ).get() as SqliteRow | undefined
    if (!meta) throw new Error('团队控制数据库缺少 meta 行')

    const workspaces = (this.database.prepare(
      'SELECT * FROM team_workspaces ORDER BY updated_at DESC, id ASC'
    ).all() as SqliteRow[]).map((row): TeamWorkspace => ({
      id: String(row.id),
      name: String(row.name),
      path: String(row.path),
      createdAt: numberOf(row.created_at),
      updatedAt: numberOf(row.updated_at)
    }))

    const runs = (this.database.prepare(
      'SELECT * FROM team_runs ORDER BY created_at ASC, id ASC'
    ).all() as SqliteRow[]).map((row): TeamRun => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      goal: String(row.goal),
      templateId: String(row.template_id),
      status: String(row.status) as TeamRunStatus,
      createdAt: numberOf(row.created_at),
      updatedAt: numberOf(row.updated_at),
      actingLeadSlotId: optionalString(row.acting_lead_slot_id)
    }))

    const roles = (this.database.prepare(
      'SELECT * FROM team_roles ORDER BY role_order ASC, id ASC'
    ).all() as SqliteRow[]).map((row): TeamRole => ({
      id: String(row.id),
      runId: String(row.run_id),
      key: String(row.role_key),
      templateKey: String(row.template_key),
      name: String(row.name),
      mission: String(row.mission),
      instructions: String(row.instructions),
      capabilities: stringArrayOf(row.capabilities_json),
      skills: assignedSkillsOf(row.skills_json),
      accent: String(row.accent) as TeamRoleAccent,
      order: numberOf(row.role_order),
      groupId: optionalString(row.group_id)
    }))

    const groups = (this.database.prepare(
      'SELECT * FROM team_groups ORDER BY created_at ASC, id ASC'
    ).all() as SqliteRow[]).map(groupFromRow)

    const modelSelectionBySlot = new Map((this.database.prepare(
      'SELECT slot_id, selection_json FROM agent_slot_model_selections'
    ).all() as SqliteRow[]).flatMap((row) => {
      const selection = cursorModelSelectionOf(row.selection_json)
      return selection ? [[String(row.slot_id), selection] as const] : []
    }))
    const slots = (this.database.prepare(
      'SELECT * FROM agent_slots ORDER BY slot_order ASC, id ASC'
    ).all() as SqliteRow[]).map((row): AgentSlot => ({
      id: String(row.id),
      runId: String(row.run_id),
      roleId: String(row.role_id),
      name: String(row.name),
      avatarId: String(row.avatar_id),
      modelSelection: modelSelectionBySlot.get(String(row.id)),
      solo: numberOf(row.is_solo) === 1,
      channelId: optionalString(row.channel_id),
      order: numberOf(row.slot_order),
      createdAt: numberOf(row.created_at),
      updatedAt: numberOf(row.updated_at),
      groupId: optionalString(row.group_id),
      homeRoleId: optionalString(row.home_role_id),
      groupJoinedAt: optionalNumber(row.group_joined_at)
    }))

    const bindings = (this.database.prepare(
      'SELECT * FROM runtime_bindings ORDER BY installed_at ASC, id ASC'
    ).all() as SqliteRow[]).map((row): RuntimeBinding => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      runId: String(row.run_id),
      slotId: String(row.slot_id),
      channelId: String(row.channel_id),
      agentSessionId: String(row.agent_session_id),
      generation: String(row.generation),
      installedAt: numberOf(row.installed_at),
      launchDetail: String(row.launch_detail),
      acknowledgedAt: optionalNumber(row.acknowledged_at),
      lastCheckInAt: optionalNumber(row.last_check_in_at),
      lastCheckInNote: String(row.last_check_in_note),
      composerBindingKey: optionalString(row.composer_binding_key) ?? String(row.generation),
      composerId: optionalString(row.composer_id),
      composerBoundAt: optionalNumber(row.composer_bound_at),
      composerBindingMethod: optionalString(row.composer_binding_method) as RuntimeBinding['composerBindingMethod'],
      sessionToken: optionalString(row.session_token)
    }))

    return {
      schemaVersion: numberOf(meta.schema_version) as 9,
      revision: numberOf(meta.revision),
      activeWorkspaceId: optionalString(meta.active_workspace_id),
      workspaces,
      runs,
      roles,
      slots,
      bindings,
      groups,
      updatedAt: numberOf(meta.updated_at)
    }
  }

  /** 单槽模型选定持久化：lobby 逐会话配置的保存出口；slot_id 幂等 upsert。 */
  setSlotModelSelection(slotId: string, selection: CursorModelSelection, updatedAt = Date.now()): void {
    this.database.prepare(`
      INSERT INTO agent_slot_model_selections (slot_id, selection_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(slot_id) DO UPDATE SET
        selection_json = excluded.selection_json,
        updated_at = excluded.updated_at
    `).run(slotId, JSON.stringify(selection), updatedAt)
    this.bumpRevision()
  }

  upsertWorkspaceTeam(bundle: WorkspaceTeamBundle): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const { workspace, run } = bundle
      const existingSlots = this.database.prepare(`
        SELECT s.id, s.channel_id, s.avatar_id, s.is_solo, s.group_id, r.template_key, r.capabilities_json, r.skills_json,
          ms.selection_json AS model_selection_json
        FROM agent_slots s
        JOIN team_roles r ON r.id = s.role_id
        LEFT JOIN agent_slot_model_selections ms ON ms.slot_id = s.id
        WHERE s.run_id = ? ORDER BY s.slot_order ASC
      `).all(run.id) as SqliteRow[]
      // 拓扑 bundle 会把席位角色重写回 solo 角色；已入组的池 run 不能走这条整体重写路径。
      if (existingSlots.some((slot) => optionalString(slot.group_id))) {
        throw new Error('会话池内已有协作组成员，不能整体重写拓扑；请先解散协作组')
      }
      const desiredTopology = new Map(bundle.slots.map((slot) => {
        const role = bundle.roles.find((candidate) => candidate.id === slot.roleId)!
        return [slot.id, {
          channelId: slot.channelId ?? null,
          avatarId: slot.avatarId,
          templateKey: role.templateKey,
          capabilities: JSON.stringify(role.capabilities),
          skills: JSON.stringify(role.skills),
          modelSelection: slot.modelSelection ? JSON.stringify(slot.modelSelection) : null,
          solo: slot.solo === true ? 1 : 0
        }] as const
      }))
      const topologyChanged = existingSlots.length > 0 && (
        existingSlots.length !== bundle.slots.length ||
        existingSlots.some((slot) => {
          const desired = desiredTopology.get(String(slot.id))
          return !desired
            || desired.channelId !== slot.channel_id
            || desired.avatarId !== String(slot.avatar_id)
            || desired.templateKey !== String(slot.template_key)
            || desired.capabilities !== String(slot.capabilities_json)
            || desired.skills !== String(slot.skills_json)
            || desired.modelSelection !== slot.model_selection_json
            || desired.solo !== numberOf(slot.is_solo)
        })
      )
      this.database.prepare(`
        INSERT INTO team_workspaces (id, name, path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          path = excluded.path,
          updated_at = excluded.updated_at
      `).run(workspace.id, workspace.name, workspace.path, workspace.createdAt, workspace.updatedAt)
      this.database.prepare(`
        INSERT OR IGNORE INTO team_runs (
          id, workspace_id, name, goal, template_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.workspaceId,
        run.name,
        run.goal,
        run.templateId,
        run.status,
        run.createdAt,
        run.updatedAt
      )

      const insertRole = this.database.prepare(`
        INSERT INTO team_roles (
          id, run_id, role_key, template_key, name, mission, instructions,
          capabilities_json, skills_json, accent, role_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role_key = excluded.role_key,
          template_key = excluded.template_key,
          name = excluded.name,
          mission = excluded.mission,
          instructions = excluded.instructions,
          capabilities_json = excluded.capabilities_json,
          skills_json = excluded.skills_json,
          accent = excluded.accent,
          role_order = excluded.role_order
      `)
      for (const role of bundle.roles) {
        insertRole.run(
          role.id,
          role.runId,
          role.key,
          role.templateKey,
          role.name,
          role.mission,
          role.instructions,
          JSON.stringify(role.capabilities),
          JSON.stringify(role.skills),
          role.accent,
          role.order
        )
      }

      if (topologyChanged) {
        // 拓扑变了：旧绑定与注册作废（席位要重新安装 MCP），run 状态不变——没有 draft 可以退回去。
        this.database.prepare('DELETE FROM runtime_bindings WHERE run_id = ?').run(run.id)
        revokeWorkspaceAgentRegistrations(this.database, workspace.id)
        this.database.prepare('UPDATE team_runs SET updated_at = ? WHERE id = ?').run(Date.now(), run.id)
      }

      const slotIds = bundle.slots.map((slot) => slot.id)
      const slotPlaceholders = slotIds.map(() => '?').join(', ')
      this.database.prepare(`
        DELETE FROM agent_slots WHERE run_id = ? AND id NOT IN (${slotPlaceholders})
      `).run(run.id, ...slotIds)
      this.database.prepare('UPDATE agent_slots SET channel_id = NULL WHERE run_id = ?').run(run.id)

      const insertSlot = this.database.prepare(`
        INSERT INTO agent_slots (
          id, run_id, role_id, name, avatar_id, channel_id, is_solo, slot_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role_id = excluded.role_id,
          name = excluded.name,
          avatar_id = excluded.avatar_id,
          channel_id = excluded.channel_id,
          is_solo = excluded.is_solo,
          slot_order = excluded.slot_order,
          updated_at = excluded.updated_at
      `)
      for (const slot of bundle.slots) {
        insertSlot.run(
          slot.id,
          slot.runId,
          slot.roleId,
          slot.name,
          slot.avatarId,
          slot.channelId ?? null,
          slot.solo === true ? 1 : 0,
          slot.order,
          slot.createdAt,
          slot.updatedAt
        )
        if (slot.modelSelection) {
          this.database.prepare(`
            INSERT INTO agent_slot_model_selections (slot_id, selection_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(slot_id) DO UPDATE SET
              selection_json = excluded.selection_json,
              updated_at = excluded.updated_at
          `).run(slot.id, JSON.stringify(slot.modelSelection), slot.updatedAt)
        } else {
          this.database.prepare('DELETE FROM agent_slot_model_selections WHERE slot_id = ?').run(slot.id)
        }
      }

      // 组角色不属于拓扑 bundle：同一 run 再次 upsert（历史遗留路径）不得把入组成员的角色行扫掉。
      const roleIds = bundle.roles.map((role) => role.id)
      const rolePlaceholders = roleIds.map(() => '?').join(', ')
      this.database.prepare(`
        DELETE FROM team_roles WHERE run_id = ? AND group_id IS NULL AND id NOT IN (${rolePlaceholders})
      `).run(run.id, ...roleIds)

      this.bumpRevision(workspace.id)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  setActiveWorkspace(workspaceId: string): void {
    const normalized = workspaceId.trim()
    const exists = this.database.prepare('SELECT 1 FROM team_workspaces WHERE id = ?').get(normalized)
    if (!exists) throw new Error('工作区不存在')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.bumpRevision(normalized)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  recordInstallation(batch: AgentRegistrationBatch): void {
    const workspaceId = batch.workspaceId.trim()
    const runId = batch.runId.trim()
    if (!workspaceId || !runId || !batch.agents.length) throw new Error('Agent 安装批次不完整')

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.database.prepare(
        'SELECT id FROM team_runs WHERE id = ? AND workspace_id = ?'
      ).get(runId, workspaceId)
      if (!run) throw new Error('Agent 安装批次不属于当前团队工作区')

      const expectedSlots = this.database.prepare(`
        SELECT s.id, s.channel_id, r.capabilities_json
        FROM agent_slots s
        JOIN team_roles r ON r.id = s.role_id
        WHERE s.run_id = ?
        ORDER BY s.slot_order ASC
      `).all(runId) as SqliteRow[]
      if (batch.agents.length < expectedSlots.length || expectedSlots.some((slot) => {
        const agent = batch.agents.find((candidate) => candidate.channelId === String(slot.channel_id))
        if (!agent) return true
        const expected = stringArrayOf(slot.capabilities_json).sort()
        const actual = [...new Set(agent.capabilities.map((value) => value.trim()).filter(Boolean))].sort()
        return JSON.stringify(expected) !== JSON.stringify(actual)
      })) {
        throw new Error('Agent 安装批次与当前 Team 角色或通道拓扑不一致')
      }

      const existingBindings = this.database.prepare(`
        SELECT slot_id, channel_id, agent_session_id, generation
        FROM runtime_bindings
        WHERE run_id = ?
        ORDER BY channel_id ASC
      `).all(runId) as SqliteRow[]
      const existingBySlot = new Map(existingBindings.map((binding) => [String(binding.slot_id), binding]))
      const topologyAlreadyInstalled = existingBindings.length === expectedSlots.length && expectedSlots.every((slot) => {
        const binding = existingBySlot.get(String(slot.id))
        if (!binding || String(binding.channel_id) !== String(slot.channel_id)) return false
        const agent = batch.agents.find((candidate) => candidate.channelId === String(slot.channel_id))
        if (!agent) return false
        const expected = stringArrayOf(slot.capabilities_json).sort()
        const actual = [...new Set(agent.capabilities.map((value) => value.trim()).filter(Boolean))].sort()
        return JSON.stringify(expected) === JSON.stringify(actual)
      })
      const installedAt = Date.now()
      if (topologyAlreadyInstalled) {
        const generations = [...new Set(existingBindings.map((binding) => String(binding.generation)))]
        const canRefreshRegistrations = generations.length === 1 && existingBindings.every((binding) => (
          String(binding.agent_session_id) === `${workspaceId}:ch-${String(binding.channel_id)}:${String(binding.generation)}`
        ))
        if (canRefreshRegistrations) {
          replaceWorkspaceAgentRegistrations(this.database, {
            workspaceId,
            runId,
            generation: generations[0]!,
            agents: expectedSlots.map((slot) => {
              const binding = existingBySlot.get(String(slot.id))!
              return {
                agentSessionId: String(binding.agent_session_id),
                runtimeId: `${workspaceId}:ch-${String(slot.channel_id)}`,
                workspaceId,
                channelId: String(slot.channel_id),
                generation: generations[0]!,
                runId,
                capabilities: stringArrayOf(slot.capabilities_json)
              }
            })
          }, installedAt)
        }
        // 相同拓扑重复安装必须是幂等刷新：保留 runtime_bindings 的 generation、
        // composer 绑定、会话令牌和 check_in 证据，避免把仍在轮询的 Cursor 会话误杀。run 状态不变。
        this.database.prepare('UPDATE team_runs SET updated_at = ? WHERE id = ?').run(installedAt, runId)
        this.bumpRevision(workspaceId)
        this.database.exec('COMMIT')
        return
      }

      replaceWorkspaceAgentRegistrations(this.database, batch)

      this.database.prepare('DELETE FROM runtime_bindings WHERE run_id = ?').run(runId)
      const insertBinding = this.database.prepare(`
        INSERT INTO runtime_bindings (
          id, workspace_id, run_id, slot_id, channel_id, agent_session_id, generation,
          installed_at, launch_status, launch_command_id, launch_detail,
          acknowledged_at, last_check_in_at, last_check_in_note, composer_binding_key, session_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'not_started', NULL, '', NULL, NULL, '', ?, ?)
      `)
      for (const slot of expectedSlots) {
        const agent = batch.agents.find((candidate) => candidate.channelId === String(slot.channel_id))
        if (!agent) throw new Error(`CH-${slot.channel_id} 缺少已注册运行时`)
        insertBinding.run(
          `runtime-binding:${agent.agentSessionId}`,
          workspaceId,
          runId,
          String(slot.id),
          agent.channelId,
          agent.agentSessionId,
          agent.generation,
          installedAt,
          agent.generation,
          newSessionToken()
        )
      }
      // 安装不改 run 状态：run 一建即 running，没有 draft / ready 可以归位。
      this.database.prepare('UPDATE team_runs SET updated_at = ? WHERE id = ?').run(installedAt, runId)
      this.bumpRevision(workspaceId)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  recordComposerBinding(input: {
    runId: string
    slotId: string
    generation: string
    bindingKey: string
    composerId: string
    method: ComposerBindingMethod
    at: number
  }): boolean {
    const runId = input.runId.trim()
    const slotId = input.slotId.trim()
    const generation = input.generation.trim()
    const bindingKey = input.bindingKey.trim()
    const composerId = input.composerId.trim()
    if (
      !runId ||
      !slotId ||
      !generation ||
      !COMPOSER_BINDING_KEY_PATTERN.test(bindingKey) ||
      !COMPOSER_ID_PATTERN.test(composerId)
    ) {
      throw new Error('Cursor Composer 绑定参数无效')
    }
    if (!COMPOSER_BINDING_METHODS.has(input.method)) throw new Error('Cursor Composer 绑定方式无效')
    if (!Number.isFinite(input.at) || input.at <= 0) throw new Error('Cursor Composer 绑定时间无效')

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const binding = this.database.prepare(`
        SELECT composer_id, generation, composer_binding_key
        FROM runtime_bindings
        WHERE run_id = ? AND slot_id = ?
      `).get(runId, slotId) as SqliteRow | undefined
      if (
        !binding ||
        String(binding.generation) !== generation ||
        String(binding.composer_binding_key) !== bindingKey
      ) {
        this.database.exec('ROLLBACK')
        return false
      }
      const currentComposerId = optionalString(binding.composer_id)
      if (currentComposerId && currentComposerId !== composerId) {
        this.database.exec('ROLLBACK')
        return false
      }
      const conflict = this.database.prepare(`
        SELECT slot_id FROM runtime_bindings
        WHERE run_id = ? AND composer_id = ? AND slot_id <> ?
      `).get(runId, composerId, slotId) as SqliteRow | undefined
      if (conflict) {
        this.database.exec('ROLLBACK')
        return false
      }
      const result = this.database.prepare(`
        UPDATE runtime_bindings
        SET composer_id = ?, composer_bound_at = ?, composer_binding_method = ?
        WHERE run_id = ? AND slot_id = ? AND generation = ?
          AND composer_binding_key = ? AND composer_id IS NULL
      `).run(composerId, input.at, input.method, runId, slotId, generation, bindingKey)
      if (numberOf(result.changes) === 0) {
        this.database.exec('ROLLBACK')
        return false
      }
      this.bumpRevision()
      this.database.exec('COMMIT')
      return true
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  prepareComposerRelaunch(input: {
    runId: string
    slotId: string
    bindingKey: string
  }): boolean {
    const bindingKey = input.bindingKey.trim()
    if (!COMPOSER_BINDING_KEY_PATTERN.test(bindingKey)) throw new Error('Cursor Composer 绑定键无效')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      // 换席重建：旧 Composer 若仍活着，其持有的旧 session 令牌即刻失效（会话围栏）。
      const result = this.database.prepare(`
        UPDATE runtime_bindings
        SET composer_binding_key = ?, composer_id = NULL, composer_bound_at = NULL,
            composer_binding_method = NULL, launch_detail = '', acknowledged_at = NULL,
            last_check_in_at = NULL, last_check_in_note = '', session_token = ?
        WHERE run_id = ? AND slot_id = ?
      `).run(bindingKey, newSessionToken(), input.runId.trim(), input.slotId.trim())
      if (numberOf(result.changes) > 0) this.bumpRevision()
      this.database.exec('COMMIT')
      return numberOf(result.changes) === 1
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  resolveAgentRuntimeIdentity(identityKey: string, runId = ''): AgentAuthorizationIdentity {
    const normalizedIdentityKey = identityKey.trim()
    const normalizedRunId = runId.trim()
    const row = this.database.prepare(`
      ${IDENTITY_SELECT}
      WHERE (ar.runtime_id = ? OR ar.agent_session_id = ?)
        AND (? = '' OR ar.run_id = ?) AND ar.revoked_at IS NULL
      ORDER BY ar.installed_at DESC LIMIT 1
    `).get(normalizedIdentityKey, normalizedIdentityKey, normalizedRunId, normalizedRunId) as SqliteRow | undefined
    if (!row) {
      const registered = this.database.prepare(`
        SELECT 1 FROM agent_registrations
        WHERE (runtime_id = ? OR agent_session_id = ?)
          AND (? = '' OR run_id = ?) AND revoked_at IS NULL
      `).get(normalizedIdentityKey, normalizedIdentityKey, normalizedRunId, normalizedRunId)
      throw new TaskPoolError(
        registered ? 'standby_not_assigned' : 'agent_not_authorized',
        registered
          ? '当前通道处于备用状态，尚未接替任何 AgentSlot'
          : '当前 Agent generation 未注册或已被撤销'
      )
    }
    assertGroupedIdentity(row, undefined)
    return identityFromRow(row)
  }

  /**
   * 统一通道服务器（S3-1）按 channelId 实时解析当前活动 TeamRun 内的身份：
   * server 进程长驻、不携带 run 级 env，团队换届无需重写 Cursor 配置。
   * 语义对齐 resolveAgentRuntimeIdentity：已注册未接替 → standby_not_assigned；
   * 未注册 → agent_not_authorized。
   */
  resolveChannelAgentIdentity(channelId: string): AgentAuthorizationIdentity {
    const normalizedChannelId = String(channelId).trim()
    const state = this.loadTeamControl()
    const activeRun = state.activeWorkspaceId
      ? state.runs
        .filter((run) => run.workspaceId === state.activeWorkspaceId)
        .sort((left, right) => right.createdAt - left.createdAt)[0]
      : undefined
    if (!activeRun) {
      throw new TaskPoolError('agent_not_authorized', '当前没有活动 TeamRun，通道身份无法解析')
    }
    const row = this.database.prepare(`
      ${IDENTITY_SELECT}
      WHERE ar.run_id = ? AND ar.channel_id = ? AND ar.revoked_at IS NULL
      ORDER BY ar.installed_at DESC LIMIT 1
    `).get(activeRun.id, normalizedChannelId) as SqliteRow | undefined
    if (!row) {
      // P0-2：run 收尾撤销注册是「轮次归档」，不是授权故障。曾注册到本轮的
      // 通道在 run 结束后调用 team_* 工具，必须得到「本轮已结束 + 如何恢复」
      // 的指引，而不是不可恢复的「未注册」硬错（2026-09-01 事故：Agent 被误判
      // 离线触发自动收尾后，工具调用全部报授权错误且无法恢复）。run_completed
      // 经 refreshIdentity 直接传播为工具结果（与 solo_channel 同模式）；
      // check_messages / record_reply 等通信工具不经身份解析，不受影响。
      if (activeRun.status === 'completed') {
        const archived = this.database.prepare(`
          SELECT 1 FROM agent_registrations
          WHERE run_id = ? AND channel_id = ?
        `).get(activeRun.id, normalizedChannelId)
        if (archived) {
          throw new TaskPoolError(
            'run_completed',
            `会话池已结束，CH-${normalizedChannelId} 的团队身份已随之归档（非授权故障，重试无效）。`
              + '请停止调用 team_* 工具；如需同步最终结论请用 record_reply，之后用 check_messages 静默待命，'
              + '会话围栏会在下一次轮询给出后续指示。'
          )
        }
      }
      const registered = this.database.prepare(`
        SELECT 1 FROM agent_registrations
        WHERE run_id = ? AND channel_id = ? AND revoked_at IS NULL
      `).get(activeRun.id, normalizedChannelId)
      throw new TaskPoolError(
        registered ? 'standby_not_assigned' : 'agent_not_authorized',
        registered
          ? '当前通道处于备用状态，尚未接替任何 AgentSlot'
          : `CH-${normalizedChannelId} 未注册到当前 TeamRun`
      )
    }
    assertGroupedIdentity(row, normalizedChannelId)
    return identityFromRow(row)
  }

  /**
   * 会话围栏查询（通信工具每次调用）：当前活动 run 内该通道的席位归属。
   * 轻量 SQL，不装配完整团队状态——check_messages 长轮询期间每轮取队列前都复核一次
   *（每秒 × 通道数），loadTeamControl 的十余条查询在这里是浪费。
   * - undefined：没有活动 run，或该通道不属于活动 run（无绑定）；
   * - sessionToken 缺失：该绑定尚未签发令牌（旧会话 / 备用接替），按无令牌旧会话放行。
   */
  resolveChannelSessionOwner(channelId: string): ChannelSessionOwnership | undefined {
    const normalizedChannelId = String(channelId).trim()
    const row = this.database.prepare(`
      SELECT tr.id AS run_id, tr.status AS run_status, b.slot_id, b.session_token, s.is_solo, s.group_id
      FROM team_control_meta meta
      JOIN team_runs tr ON tr.workspace_id = meta.active_workspace_id
      LEFT JOIN runtime_bindings b ON b.run_id = tr.id AND b.channel_id = ?
      LEFT JOIN agent_slots s ON s.id = b.slot_id AND s.run_id = b.run_id
      WHERE meta.id = 1
      ORDER BY tr.created_at DESC
      LIMIT 1
    `).get(normalizedChannelId) as SqliteRow | undefined
    const runId = row ? optionalString(row.run_id) : undefined
    if (!row || !runId) return undefined
    const slotId = optionalString(row.slot_id)
    const bound = slotId !== undefined
    return {
      runId,
      runStatus: String(row.run_status) as TeamRunStatus,
      bound,
      sessionToken: bound ? optionalString(row.session_token) : undefined,
      solo: bound && numberOf(row.is_solo) === 1,
      ...(slotId ? { slotId } : {}),
      ...(bound && optionalString(row.group_id) ? { groupId: optionalString(row.group_id) } : {})
    }
  }

  /**
   * 工具面探针（阶段 4 · 4A）：当前活动 run（与 `resolveChannelSessionOwner` 同一口径——活动工作区最新的 run）
   * 是否正在运行且至少有一个活动协作组。MCP 进程据此决定是否向 Cursor 暴露团队工具；
   * 每次 check_messages 返回前问一次，必须是一条轻量 SQL。
   */
  hasActiveGroup(): boolean {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM team_control_meta meta
      JOIN team_runs tr ON tr.workspace_id = meta.active_workspace_id
      JOIN team_groups g ON g.run_id = tr.id AND g.status = 'active'
      WHERE meta.id = 1 AND tr.status = 'running'
        AND tr.id = (
          SELECT newest.id FROM team_runs newest
          WHERE newest.workspace_id = meta.active_workspace_id
          ORDER BY newest.created_at DESC LIMIT 1
        )
    `).get() as SqliteRow
    return numberOf(row.count) > 0
  }

  listAgentRegistrations(runId: string): AgentRegistration[] {
    return (this.database.prepare(`
      SELECT agent_session_id, runtime_id, workspace_id, channel_id, generation, run_id, capabilities_json
      FROM agent_registrations
      WHERE run_id = ? AND revoked_at IS NULL
      ORDER BY CAST(channel_id AS INTEGER), channel_id
    `).all(runId.trim()) as SqliteRow[]).map((row) => ({
      agentSessionId: String(row.agent_session_id),
      runtimeId: optionalString(row.runtime_id),
      workspaceId: String(row.workspace_id),
      channelId: String(row.channel_id),
      generation: String(row.generation),
      runId: String(row.run_id),
      capabilities: stringArrayOf(row.capabilities_json)
    }))
  }

  listFailovers(runId: string): TeamFailoverRecord[] {
    return (this.database.prepare(`
      SELECT * FROM team_failovers WHERE run_id = ?
      ORDER BY detected_at DESC, id DESC
    `).all(runId.trim()) as SqliteRow[]).map(failoverFromRow)
  }

  completeRun(runId: string, at: number, detail = RUN_COMPLETED_DEFAULT_DETAIL): boolean {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const normalizedRunId = runId.trim()
      const result = this.database.prepare(`
        UPDATE team_runs SET status = 'completed', acting_lead_slot_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(at, normalizedRunId)
      if (numberOf(result.changes) > 0) {
        this.database.prepare(`
          UPDATE agent_registrations SET revoked_at = ?
          WHERE run_id = ? AND revoked_at IS NULL
        `).run(at, normalizedRunId)
        // 收尾原因写进绑定备注；launch_status 列不再表达状态（阶段 2 · 2B）。
        this.database.prepare(`
          UPDATE runtime_bindings SET launch_detail = ? WHERE run_id = ?
        `).run(normalizedNote(detail), normalizedRunId)
        this.bumpRevision()
      }
      this.database.exec('COMMIT')
      return numberOf(result.changes) > 0
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  setActingLead(input: { runId: string; slotId: string | null; at: number }): boolean {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const normalizedRunId = input.runId.trim()
      const normalizedSlotId = input.slotId?.trim() ?? null
      if (normalizedSlotId) {
        const slot = this.database.prepare(`
          SELECT s.id FROM agent_slots s
          JOIN team_roles r ON r.id = s.role_id
          WHERE s.id = ? AND s.run_id = ? AND COALESCE(s.is_solo, 0) = 0
        `).get(normalizedSlotId, normalizedRunId) as SqliteRow | undefined
        if (!slot) throw new TaskPoolError('acting_lead_slot_not_found', '目标 AgentSlot 不属于当前 TeamRun')
      }
      const result = this.database.prepare(`
        UPDATE team_runs SET acting_lead_slot_id = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(normalizedSlotId, input.at, normalizedRunId)
      if (numberOf(result.changes) !== 1) {
        throw new TaskPoolError('acting_lead_run_inactive', '只有运行中的 TeamRun 可以设置临时主控')
      }
      this.bumpRevision()
      this.database.exec('COMMIT')
      return true
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * team_check_in 落库：签到时间 / 备注写回绑定，入组席位追加 member_checked_in 审计行。
   * 池 run 没有启动状态机（阶段 2 · 2B）：run 只有 running / completed，已结束的 run 拒绝签到
   *（`run_completed`）；不再有「自愈推进 launching」与「全员签到 → running」的状态推进。
   */
  recordAgentCheckIn(identity: AgentAuthorizationIdentity, note: string): AgentCheckInReceipt {
    const at = Date.now()
    let row: SqliteRow | undefined
    this.database.exec('BEGIN IMMEDIATE')
    try {
      row = this.database.prepare(`
        SELECT b.workspace_id, b.run_id, b.slot_id, b.channel_id, s.group_id, r.name AS role_name, tr.status AS run_status
        FROM runtime_bindings b
        JOIN agent_slots s ON s.id = b.slot_id
        JOIN team_roles r ON r.id = s.role_id
        JOIN team_runs tr ON tr.id = b.run_id
        WHERE b.agent_session_id = ? AND b.run_id = ?
      `).get(identity.agentSessionId, identity.runId) as SqliteRow | undefined
      if (!row) {
        throw new TaskPoolError('runtime_binding_missing', '当前 Agent 没有有效的外置 Team RuntimeBinding')
      }
      if (String(row.run_status) !== 'running') {
        throw new TaskPoolError('run_completed', '当前运行已经结束，不能再登记在岗')
      }

      // acknowledged_at 只写首次（就绪度 active 的唯一依据）；重复签到只刷 last_check_in_*。
      const updated = this.database.prepare(`
        UPDATE runtime_bindings
        SET acknowledged_at = COALESCE(acknowledged_at, ?), last_check_in_at = ?, last_check_in_note = ?
        WHERE agent_session_id = ? AND run_id = ?
      `).run(at, at, normalizedNote(note), identity.agentSessionId, identity.runId)
      if (numberOf(updated.changes) !== 1) {
        throw new TaskPoolError('runtime_binding_missing', '当前 Agent RuntimeBinding 已失效')
      }
      const groupId = optionalString(row.group_id)
      if (groupId) {
        this.appendGroupEvent({
          groupId,
          type: 'member_checked_in',
          slotId: String(row.slot_id),
          channelId: optionalString(row.channel_id),
          actor: `agent:${String(row.slot_id)}`,
          detail: normalizedNote(note) || undefined,
          at
        })
      }
      this.bumpRevision()
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }

    return {
      workspaceId: String(row!.workspace_id),
      runId: String(row!.run_id),
      slotId: String(row!.slot_id),
      roleName: String(row!.role_name),
      acknowledgedAt: at
    }
  }

  // ------------------------------------------------------------------ 协作组（会话池）
  //
  // 每个公开方法 = 一次 BEGIN IMMEDIATE 事务：校验 → 改 team_groups / agent_slots / team_roles →
  // 写 team_group_events 审计行 → bumpRevision。成员关系的唯一真相源是 agent_slots.group_id；
  // `is_solo` 与之同步翻转，让既有的「非 solo 成员」过滤器（编排器、简报、失效接管）自动生效。
  // 绝不触碰 runtime_bindings 的令牌 / Composer / generation，也不改 run 状态。
  //
  // 池状态守卫只加在「扩大成员关系」的路径（createGroup / addGroupMembers 要求池 running）：
  // 已结束的池不再接纳新成员，但仍允许移出 / 换 lead / 改目标 / 解散，让用户能收拾残局。

  createGroup(input: {
    runId: string
    name: string
    goal?: string
    members: TeamGroupMemberConfiguration[]
    leadSlotId?: string
    planPolicy?: TeamGroupPlanPolicy
    at?: number
  }): TeamGroupMutation {
    const runId = input.runId.trim()
    const name = normalizedGroupName(input.name)
    const goal = normalizedGroupGoal(input.goal ?? '')
    if (!input.members.length) throw new TaskPoolError('group_members_required', '协作组至少需要 1 名成员')
    const leadSlotId = input.leadSlotId?.trim() || undefined
    if (leadSlotId && !input.members.some((member) => member.slotId.trim() === leadSlotId)) {
      throw new TaskPoolError('group_lead_not_member', 'lead 必须是本组成员')
    }
    const planPolicy = input.planPolicy ?? defaultGroupPlanPolicy(leadSlotId)
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.requirePoolRun(runId)
      const groupId = `team-group:${run.workspaceId}:${randomUUID()}`
      this.database.prepare(`
        INSERT INTO team_groups (
          id, run_id, name, goal, status, lead_slot_id, acting_lead_slot_id, plan_policy, created_at, updated_at, dissolved_at
        ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?, NULL)
      `).run(groupId, runId, name, goal, planPolicy, at, at)
      this.appendGroupEvent({ groupId, type: 'created', actor: 'operator', detail: name, at })
      const joined = this.joinMembers(groupId, runId, input.members, at)
      if (leadSlotId) {
        this.database.prepare('UPDATE team_groups SET lead_slot_id = ? WHERE id = ?').run(leadSlotId, groupId)
        this.appendGroupEvent({
          groupId, type: 'lead_changed', slotId: leadSlotId, actor: 'operator', detail: `无 → ${leadSlotId}`, at
        })
      }
      this.bumpRevision()
      this.database.exec('COMMIT')
      return {
        group: this.requireGroup(groupId),
        joined,
        left: [],
        leadChange: leadSlotId ? { nextSlotId: leadSlotId } : undefined
      }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  addGroupMembers(input: { groupId: string; members: TeamGroupMemberConfiguration[]; at?: number }): TeamGroupMutation {
    if (!input.members.length) throw new TaskPoolError('group_members_required', '至少指定 1 名要加入的成员')
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const group = this.requireActiveGroup(input.groupId)
      this.requirePoolRun(group.runId)
      const joined = this.joinMembers(group.id, group.runId, input.members, at)
      this.database.prepare('UPDATE team_groups SET updated_at = ? WHERE id = ?').run(at, group.id)
      this.bumpRevision()
      this.database.exec('COMMIT')
      return { group: this.requireGroup(group.id), joined, left: [] }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  removeGroupMember(input: { groupId: string; slotId: string; at?: number; force?: boolean }): TeamGroupMutation {
    const slotId = input.slotId.trim()
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const group = this.requireActiveGroup(input.groupId)
      const memberCount = numberOf((this.database.prepare(
        'SELECT COUNT(*) AS count FROM agent_slots WHERE group_id = ?'
      ).get(group.id) as SqliteRow).count)
      if (effectiveGroupLeadSlotId(group) === slotId && memberCount > 1 && input.force !== true) {
        throw new TaskPoolError('lead_must_transfer_first', '该成员是本组有效 lead 且组内还有其他成员；请先指定新 lead 再移出')
      }
      const left = this.leaveMember(group, slotId, at)
      const leadChange = this.clearLeadIfMember(group, slotId, at)
      this.database.prepare('UPDATE team_groups SET updated_at = ? WHERE id = ?').run(at, group.id)
      this.bumpRevision()
      this.database.exec('COMMIT')
      return { group: this.requireGroup(group.id), joined: [], left: [left], leadChange }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  setGroupLead(input: { groupId: string; slotId: string | null; at?: number }): TeamGroupMutation {
    const slotId = input.slotId?.trim() || undefined
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const group = this.requireActiveGroup(input.groupId)
      if (slotId) this.requireGroupMember(group.id, slotId)
      this.database.prepare(`
        UPDATE team_groups SET lead_slot_id = ?, acting_lead_slot_id = NULL, updated_at = ? WHERE id = ?
      `).run(slotId ?? null, at, group.id)
      this.appendGroupEvent({
        groupId: group.id,
        type: 'lead_changed',
        slotId,
        actor: 'operator',
        detail: `${group.leadSlotId ?? '无'} → ${slotId ?? '无'}`,
        at
      })
      this.bumpRevision()
      this.database.exec('COMMIT')
      return {
        group: this.requireGroup(group.id),
        joined: [],
        left: [],
        leadChange: { previousSlotId: group.leadSlotId, nextSlotId: slotId }
      }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  setGroupActingLead(input: { groupId: string; slotId: string | null; at?: number }): TeamGroupMutation {
    const slotId = input.slotId?.trim() || undefined
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const group = this.requireActiveGroup(input.groupId)
      if (slotId) this.requireGroupMember(group.id, slotId)
      this.database.prepare(
        'UPDATE team_groups SET acting_lead_slot_id = ?, updated_at = ? WHERE id = ?'
      ).run(slotId ?? null, at, group.id)
      this.appendGroupEvent({
        groupId: group.id,
        type: 'acting_lead_changed',
        slotId,
        actor: 'operator',
        detail: `${group.actingLeadSlotId ?? '无'} → ${slotId ?? '无'}`,
        at
      })
      this.bumpRevision()
      this.database.exec('COMMIT')
      return {
        group: this.requireGroup(group.id),
        joined: [],
        left: [],
        leadChange: { previousSlotId: effectiveGroupLeadSlotId(group), nextSlotId: slotId ?? group.leadSlotId }
      }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  updateGroupGoal(input: { groupId: string; goal: string; at?: number }): TeamGroupMutation {
    const goal = normalizedGroupGoal(input.goal)
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const group = this.requireActiveGroup(input.groupId)
      this.database.prepare('UPDATE team_groups SET goal = ?, updated_at = ? WHERE id = ?').run(goal, at, group.id)
      this.appendGroupEvent({
        groupId: group.id, type: 'goal_updated', actor: 'operator', detail: goal.slice(0, 200) || undefined, at
      })
      this.bumpRevision()
      this.database.exec('COMMIT')
      return { group: this.requireGroup(group.id), joined: [], left: [] }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  setGroupPlanPolicy(input: { groupId: string; planPolicy: TeamGroupPlanPolicy; at?: number }): TeamGroupMutation {
    if (input.planPolicy !== 'lead_only' && input.planPolicy !== 'any_member') {
      throw new TaskPoolError('group_plan_policy_invalid', `未知的规划策略：${String(input.planPolicy)}`)
    }
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const group = this.requireActiveGroup(input.groupId)
      this.database.prepare('UPDATE team_groups SET plan_policy = ?, updated_at = ? WHERE id = ?')
        .run(input.planPolicy, at, group.id)
      this.appendGroupEvent({
        groupId: group.id, type: 'plan_policy_updated', actor: 'operator', detail: `${group.planPolicy} → ${input.planPolicy}`, at
      })
      this.bumpRevision()
      this.database.exec('COMMIT')
      return { group: this.requireGroup(group.id), joined: [], left: [] }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  dissolveGroup(input: { groupId: string; at?: number }): TeamGroupMutation {
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const group = this.requireActiveGroup(input.groupId)
      const memberIds = (this.database.prepare(
        'SELECT id FROM agent_slots WHERE group_id = ? ORDER BY slot_order ASC, id ASC'
      ).all(group.id) as SqliteRow[]).map((row) => String(row.id))
      const left = memberIds.map((slotId) => this.leaveMember(group, slotId, at))
      this.database.prepare(`
        UPDATE team_groups SET status = 'dissolved', acting_lead_slot_id = NULL, dissolved_at = ?, updated_at = ?
        WHERE id = ?
      `).run(at, at, group.id)
      this.appendGroupEvent({ groupId: group.id, type: 'dissolved', actor: 'operator', detail: `${left.length} 名成员恢复独立`, at })
      this.bumpRevision()
      this.database.exec('COMMIT')
      return { group: this.requireGroup(group.id), joined: [], left }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  transferGroupMembership(input: {
    groupId: string
    fromSlotId: string
    toSlotId: string
    at?: number
  }): GroupMembershipTransfer {
    const fromSlotId = input.fromSlotId.trim()
    const toSlotId = input.toSlotId.trim()
    if (!fromSlotId || !toSlotId) throw new TaskPoolError('transfer_slot_required', '迁移需要同时指定原席位与目标席位')
    if (fromSlotId === toSlotId) throw new TaskPoolError('transfer_same_slot', '目标席位不能是原席位自己')
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const group = this.requireActiveGroup(input.groupId)
      const run = this.requirePoolRun(group.runId)
      // A 出组（leaveMember 校验成员关系并写 member_left）、B 以同一角色模板入组（joinMembers
      // 校验 B 未入组并写 member_joined）。先出后进：A 的组角色行删除后，B 的新角色拿到同一 role_key。
      const left = this.leaveMember(group, fromSlotId, at)
      const joined = this.joinMembers(group.id, group.runId, [
        { slotId: toSlotId, roleTemplateKey: left.roleTemplateKey }
      ], at)[0]!
      // lead 随迁：组身份 = 组角色 + lead 身份。指向 A 的 lead / 临时主控指针都改指 B，有效 lead 不因
      // 迁移而消失（也绝不落进「无 lead 组开放规划」的意外分支）。transferredLead 只看有效 lead 是否
      // 从 A 移到了 B：A 是名义 lead 但另有临时主控时指针照样移动，但组里的有效 lead 并没有变。
      const transferredLead = effectiveGroupLeadSlotId(group) === fromSlotId
      if (group.leadSlotId === fromSlotId) {
        this.database.prepare('UPDATE team_groups SET lead_slot_id = ? WHERE id = ?').run(toSlotId, group.id)
        this.appendGroupEvent({
          groupId: group.id, type: 'lead_changed', slotId: toSlotId, channelId: joined.channelId,
          actor: 'operator', detail: `${fromSlotId} → ${toSlotId}（成员身份迁移）`, at
        })
      }
      if (group.actingLeadSlotId === fromSlotId) {
        this.database.prepare('UPDATE team_groups SET acting_lead_slot_id = ? WHERE id = ?').run(toSlotId, group.id)
        this.appendGroupEvent({
          groupId: group.id, type: 'acting_lead_changed', slotId: toSlotId, channelId: joined.channelId,
          actor: 'operator', detail: `${fromSlotId} → ${toSlotId}（成员身份迁移）`, at
        })
      }
      this.database.prepare('UPDATE team_groups SET updated_at = ? WHERE id = ?').run(at, group.id)
      // 审计走 team_failovers（reason 固定 manual_membership_transfer）：绑定 / 令牌 / Composer 不动，
      // 没有「等待接替确认」这一步，落库即 completed。会话字段缺省为空串 / NULL（席位可能尚未安装）。
      const bindingOf = this.database.prepare(
        'SELECT agent_session_id FROM runtime_bindings WHERE run_id = ? AND slot_id = ?'
      )
      const fromBinding = bindingOf.get(group.runId, fromSlotId) as SqliteRow | undefined
      const toBinding = bindingOf.get(group.runId, toSlotId) as SqliteRow | undefined
      const failoverId = `team-handoff:membership:${randomUUID()}`
      this.database.prepare(`
        INSERT INTO team_failovers (
          id, workspace_id, run_id, slot_id, role_name,
          from_channel_id, from_agent_session_id, to_channel_id, to_agent_session_id,
          status, reason, checkpoint_id, message_id, task_ids_json,
          detected_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'manual_membership_transfer', NULL, NULL, '[]', ?, ?, ?)
      `).run(
        failoverId, run.workspaceId, group.runId, fromSlotId, left.roleName,
        left.channelId ?? '', fromBinding ? String(fromBinding.agent_session_id) : '',
        joined.channelId ?? null, toBinding ? String(toBinding.agent_session_id) : null,
        at, at, at
      )
      this.bumpRevision()
      this.database.exec('COMMIT')
      return {
        group: this.requireGroup(group.id),
        from: left,
        to: joined,
        transferredLead,
        failover: this.listFailovers(group.runId).find((record) => record.id === failoverId)!
      }
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  recordGroupMemberRebuilt(input: { groupId: string; slotId: string; at?: number }): void {
    const slotId = input.slotId.trim()
    const at = input.at ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const group = this.requireActiveGroup(input.groupId)
      const row = this.database.prepare(`
        SELECT s.channel_id, r.name AS role_name
        FROM agent_slots s
        JOIN team_roles r ON r.id = s.role_id
        WHERE s.id = ? AND s.group_id = ?
      `).get(slotId, group.id) as SqliteRow | undefined
      if (!row) throw new TaskPoolError('group_member_not_found', `席位 ${slotId} 不是本组成员`)
      this.appendGroupEvent({
        groupId: group.id,
        type: 'member_rejoined_after_rebuild',
        slotId,
        channelId: optionalString(row.channel_id),
        actor: 'system',
        detail: String(row.role_name),
        at
      })
      this.bumpRevision()
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  listGroupEvents(groupId: string, limit = 50): TeamGroupEvent[] {
    const normalizedLimit = Math.min(500, Math.max(1, Math.floor(limit)))
    return (this.database.prepare(`
      SELECT * FROM team_group_events WHERE group_id = ? ORDER BY seq DESC LIMIT ?
    `).all(groupId.trim(), normalizedLimit) as SqliteRow[]).reverse().map(groupEventFromRow)
  }

  /** 入组：插组角色行、席位指向新角色并记住 home 角色、is_solo 翻 0；逐人写 member_joined。 */
  private joinMembers(
    groupId: string,
    runId: string,
    members: TeamGroupMemberConfiguration[],
    at: number
  ): GroupMembershipChange[] {
    const slotIds = [...new Set(members.map((member) => member.slotId.trim()))]
    if (slotIds.length !== members.length) throw new TaskPoolError('group_member_duplicate', '同一席位在成员列表里重复')
    const placeholders = slotIds.map(() => '?').join(', ')
    const slotRows = new Map((this.database.prepare(`
      SELECT id, run_id, channel_id, group_id FROM agent_slots WHERE id IN (${placeholders})
    `).all(...slotIds) as SqliteRow[]).map((row) => [String(row.id), row] as const))
    for (const slotId of slotIds) {
      const row = slotRows.get(slotId)
      if (!row || String(row.run_id) !== runId) {
        throw new TaskPoolError('group_member_not_in_run', `席位 ${slotId} 不属于当前会话池`)
      }
      if (optionalString(row.group_id)) {
        throw new TaskPoolError('group_member_already_grouped', `席位 ${slotId} 已在其他协作组内（一个席位同一时刻只属于一个组）`)
      }
    }
    const existingGroupRoles = (this.database.prepare(
      'SELECT role_key, template_key, role_order FROM team_roles WHERE group_id = ?'
    ).all(groupId) as SqliteRow[]).map((row) => ({
      key: String(row.role_key),
      templateKey: String(row.template_key),
      order: numberOf(row.role_order)
    }))
    const roles = buildGroupRoles({ group: { id: groupId, runId }, members, existingGroupRoles })
    const insertRole = this.database.prepare(`
      INSERT INTO team_roles (
        id, run_id, role_key, template_key, name, mission, instructions,
        capabilities_json, skills_json, accent, role_order, group_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const joinSlot = this.database.prepare(`
      UPDATE agent_slots
      SET group_id = ?, role_id = ?, home_role_id = COALESCE(home_role_id, role_id), is_solo = 0,
          group_joined_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND group_id IS NULL
    `)
    return roles.map((role, index): GroupMembershipChange => {
      const slotId = slotIds[index]!
      insertRole.run(
        role.id, role.runId, role.key, role.templateKey, role.name, role.mission, role.instructions,
        JSON.stringify(role.capabilities), JSON.stringify(role.skills), role.accent, role.order, groupId
      )
      const updated = joinSlot.run(groupId, role.id, at, at, slotId, runId)
      if (numberOf(updated.changes) !== 1) {
        throw new TaskPoolError('group_member_already_grouped', `席位 ${slotId} 的成员关系在本次事务内已变化`)
      }
      const channelId = optionalString(slotRows.get(slotId)!.channel_id)
      this.appendGroupEvent({
        groupId, type: 'member_joined', slotId, channelId, actor: 'operator', detail: role.name, at
      })
      return { slotId, channelId, roleName: role.name, roleTemplateKey: role.templateKey }
    })
  }

  /** 出组：席位恢复 home 角色与 is_solo=1，删除其组角色行；写 member_left。 */
  private leaveMember(group: TeamGroup, slotId: string, at: number): GroupMembershipChange {
    const row = this.database.prepare(`
      SELECT s.channel_id, s.role_id, s.home_role_id, s.group_id, r.name AS role_name, r.template_key
      FROM agent_slots s
      JOIN team_roles r ON r.id = s.role_id
      WHERE s.id = ? AND s.run_id = ?
    `).get(slotId, group.runId) as SqliteRow | undefined
    if (!row || optionalString(row.group_id) !== group.id) {
      throw new TaskPoolError('group_member_not_found', `席位 ${slotId} 不在协作组「${group.name}」内`)
    }
    const homeRoleId = optionalString(row.home_role_id)
    if (!homeRoleId) throw new TaskPoolError('group_member_home_role_missing', `席位 ${slotId} 缺少入组前的角色，无法恢复独立身份`)
    const groupRoleId = String(row.role_id)
    this.database.prepare(`
      UPDATE agent_slots
      SET group_id = NULL, role_id = ?, home_role_id = NULL, is_solo = 1, group_joined_at = NULL, updated_at = ?
      WHERE id = ? AND run_id = ?
    `).run(homeRoleId, at, slotId, group.runId)
    // 席位已改指 home 角色，组角色行此刻无人引用（FK RESTRICT 才允许删除）。
    this.database.prepare('DELETE FROM team_roles WHERE id = ? AND group_id = ?').run(groupRoleId, group.id)
    const channelId = optionalString(row.channel_id)
    this.appendGroupEvent({
      groupId: group.id, type: 'member_left', slotId, channelId, actor: 'operator', detail: String(row.role_name), at
    })
    return { slotId, channelId, roleName: String(row.role_name), roleTemplateKey: String(row.template_key) }
  }

  /** 被移出的席位若是 lead / 临时主控，组的 lead 字段随之清空（带审计）。 */
  private clearLeadIfMember(group: TeamGroup, slotId: string, at: number): TeamGroupMutation['leadChange'] {
    let leadChange: TeamGroupMutation['leadChange']
    if (group.actingLeadSlotId === slotId) {
      this.database.prepare('UPDATE team_groups SET acting_lead_slot_id = NULL WHERE id = ?').run(group.id)
      this.appendGroupEvent({
        groupId: group.id, type: 'acting_lead_changed', actor: 'operator', detail: `${slotId} → 无（成员移出）`, at
      })
      leadChange = { previousSlotId: slotId, nextSlotId: group.leadSlotId }
    }
    if (group.leadSlotId === slotId) {
      this.database.prepare('UPDATE team_groups SET lead_slot_id = NULL WHERE id = ?').run(group.id)
      this.appendGroupEvent({
        groupId: group.id, type: 'lead_changed', actor: 'operator', detail: `${slotId} → 无（成员移出）`, at
      })
      leadChange = { previousSlotId: slotId, nextSlotId: undefined }
    }
    return leadChange
  }

  private requirePoolRun(runId: string): { id: string; workspaceId: string } {
    const row = this.database.prepare(
      'SELECT id, workspace_id, template_id, status FROM team_runs WHERE id = ?'
    ).get(runId) as SqliteRow | undefined
    if (!row) throw new TaskPoolError('run_not_found', 'TeamRun 不存在')
    if (!isSessionPoolRun({ templateId: String(row.template_id) })) {
      throw new TaskPoolError('group_requires_pool_run', '协作组只能在会话池（独立批次）内创建；一次性团队 run 不支持分组')
    }
    if (String(row.status) !== 'running') {
      throw new TaskPoolError('group_run_inactive', '会话池已结束，不能再变更协作组')
    }
    return { id: String(row.id), workspaceId: String(row.workspace_id) }
  }

  private requireGroup(groupId: string): TeamGroup {
    const row = this.database.prepare('SELECT * FROM team_groups WHERE id = ?').get(groupId.trim()) as SqliteRow | undefined
    if (!row) throw new TaskPoolError('group_not_found', '协作组不存在')
    return groupFromRow(row)
  }

  private requireActiveGroup(groupId: string): TeamGroup {
    const group = this.requireGroup(groupId)
    if (group.status !== 'active') throw new TaskPoolError('group_dissolved', `协作组「${group.name}」已解散`)
    return group
  }

  private requireGroupMember(groupId: string, slotId: string): void {
    const row = this.database.prepare('SELECT 1 FROM agent_slots WHERE id = ? AND group_id = ?').get(slotId, groupId)
    if (!row) throw new TaskPoolError('group_member_not_found', `席位 ${slotId} 不是本组成员`)
  }

  private appendGroupEvent(input: {
    groupId: string
    type: TeamGroupEventType
    slotId?: string
    channelId?: string
    actor: string
    detail?: string
    at: number
  }): void {
    this.database.prepare(`
      INSERT INTO team_group_events (group_id, event_type, slot_id, channel_id, actor_key, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.groupId,
      input.type,
      input.slotId ?? null,
      input.channelId ?? null,
      input.actor,
      input.detail?.slice(0, 2_000) ?? null,
      input.at
    )
  }

  close(): void {
    if (this.database.isOpen) this.database.close()
  }

  private bumpRevision(activeWorkspaceId?: string): void {
    if (activeWorkspaceId !== undefined) {
      this.database.prepare(`
        UPDATE team_control_meta
        SET revision = revision + 1, active_workspace_id = ?, updated_at = ?
        WHERE id = 1
      `).run(activeWorkspaceId, Date.now())
      return
    }
    this.database.prepare(`
      UPDATE team_control_meta SET revision = revision + 1, updated_at = ? WHERE id = 1
    `).run(Date.now())
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS team_control_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        active_workspace_id TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        goal TEXT NOT NULL,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        launched_at INTEGER,
        acting_lead_slot_id TEXT
      );

      CREATE TABLE IF NOT EXISTS team_groups (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        lead_slot_id TEXT,
        acting_lead_slot_id TEXT,
        plan_policy TEXT NOT NULL DEFAULT 'lead_only',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        dissolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS team_group_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        slot_id TEXT,
        channel_id TEXT,
        actor_key TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_roles (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        role_key TEXT NOT NULL,
        template_key TEXT NOT NULL,
        name TEXT NOT NULL,
        mission TEXT NOT NULL,
        instructions TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        skills_json TEXT NOT NULL,
        accent TEXT NOT NULL,
        role_order INTEGER NOT NULL,
        group_id TEXT REFERENCES team_groups(id) ON DELETE CASCADE,
        UNIQUE (run_id, role_key)
      );

      CREATE TABLE IF NOT EXISTS agent_slots (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES team_roles(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        avatar_id TEXT NOT NULL,
        channel_id TEXT,
        is_solo INTEGER NOT NULL DEFAULT 0,
        slot_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        group_id TEXT REFERENCES team_groups(id) ON DELETE SET NULL,
        home_role_id TEXT,
        group_joined_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS agent_slot_model_selections (
        slot_id TEXT PRIMARY KEY REFERENCES agent_slots(id) ON DELETE CASCADE,
        selection_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_bindings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        slot_id TEXT NOT NULL UNIQUE REFERENCES agent_slots(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL UNIQUE,
        generation TEXT NOT NULL,
        installed_at INTEGER NOT NULL,
        launch_status TEXT NOT NULL,
        launch_command_id TEXT,
        launch_detail TEXT NOT NULL,
        acknowledged_at INTEGER,
        last_check_in_at INTEGER,
        last_check_in_note TEXT NOT NULL,
        composer_binding_key TEXT NOT NULL,
        composer_id TEXT,
        composer_bound_at INTEGER,
        composer_binding_method TEXT
      );

      CREATE TABLE IF NOT EXISTS team_failovers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
        slot_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
        role_name TEXT NOT NULL,
        from_channel_id TEXT NOT NULL,
        from_agent_session_id TEXT NOT NULL,
        to_channel_id TEXT,
        to_agent_session_id TEXT,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        checkpoint_id TEXT,
        message_id TEXT,
        task_ids_json TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_slots_run_channel
      ON agent_slots(run_id, channel_id) WHERE channel_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_team_runs_workspace ON team_runs(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runtime_bindings_run ON runtime_bindings(run_id, channel_id);
      CREATE INDEX IF NOT EXISTS idx_team_failovers_run ON team_failovers(run_id, detected_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_team_failovers_waiting_slot
      ON team_failovers(run_id, slot_id) WHERE status = 'waiting_for_agent';
      CREATE INDEX IF NOT EXISTS idx_team_groups_run ON team_groups(run_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_team_group_events_group ON team_group_events(group_id, seq);

      INSERT OR IGNORE INTO team_control_meta (
        id, schema_version, revision, active_workspace_id, updated_at
      ) VALUES (1, ${TEAM_SCHEMA_VERSION}, 0, NULL, 0);
    `)
    ensureAgentRegistrationsSchema(this.database)
    const meta = this.database.prepare(
      'SELECT schema_version FROM team_control_meta WHERE id = 1'
    ).get() as SqliteRow
    let databaseVersion = numberOf(meta.schema_version)
    if (databaseVersion === 1) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.exec('ALTER TABLE runtime_bindings ADD COLUMN composer_id TEXT')
        this.database.exec('ALTER TABLE runtime_bindings ADD COLUMN composer_bound_at INTEGER')
        this.database.exec('ALTER TABLE runtime_bindings ADD COLUMN composer_binding_method TEXT')
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(2, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 2
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 2) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.exec('ALTER TABLE runtime_bindings ADD COLUMN composer_binding_key TEXT')
        this.database.exec(`
          UPDATE runtime_bindings SET composer_binding_key = generation
          WHERE composer_binding_key IS NULL OR length(trim(composer_binding_key)) = 0
        `)
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(3, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 3
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 3) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!tableHasColumn(this.database, 'team_roles', 'template_key')) {
          this.database.exec("ALTER TABLE team_roles ADD COLUMN template_key TEXT NOT NULL DEFAULT ''")
        }
        if (!tableHasColumn(this.database, 'team_roles', 'skills_json')) {
          this.database.exec("ALTER TABLE team_roles ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'")
        }
        if (!tableHasColumn(this.database, 'agent_slots', 'avatar_id')) {
          this.database.exec("ALTER TABLE agent_slots ADD COLUMN avatar_id TEXT NOT NULL DEFAULT 'devops'")
        }
        this.database.exec(`
          UPDATE team_roles
          SET template_key = CASE
            WHEN role_key = 'lead' THEN 'lead'
            WHEN role_key = 'builder' THEN 'builder'
            WHEN role_key = 'reviewer' THEN 'reviewer'
            WHEN role_key LIKE 'specialist-%' THEN 'specialist'
            ELSE role_key
          END
          WHERE length(trim(template_key)) = 0
        `)
        this.database.exec(`
          UPDATE agent_slots
          SET avatar_id = CASE
            WHEN role_id IN (SELECT id FROM team_roles WHERE template_key = 'lead') THEN 'lead'
            WHEN role_id IN (SELECT id FROM team_roles WHERE template_key = 'builder') THEN 'architect'
            WHEN role_id IN (SELECT id FROM team_roles WHERE template_key = 'reviewer') THEN 'reviewer'
            ELSE avatar_id
          END
        `)
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(4, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 4
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 4) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(5, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 5
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 5) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!tableHasColumn(this.database, 'team_runs', 'acting_lead_slot_id')) {
          this.database.exec('ALTER TABLE team_runs ADD COLUMN acting_lead_slot_id TEXT')
        }
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(6, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 6
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 6) {
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!tableHasColumn(this.database, 'agent_slots', 'is_solo')) {
          this.database.exec('ALTER TABLE agent_slots ADD COLUMN is_solo INTEGER NOT NULL DEFAULT 0')
        }
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(7, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 7
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 7) {
      // v8：会话池 + 协作组。全部 additive：新表由上方 CREATE IF NOT EXISTS 建好，这里只补旧表的列，
      // 并把既有 solo 席位的角色记为 home 角色（出组时恢复用）。桌面主进程与 Cursor 托管的 MCP
      // 进程各自打开同一库并各自迁移，列存在性守卫让先后到达的两次迁移都幂等。
      this.database.exec('BEGIN IMMEDIATE')
      try {
        if (!tableHasColumn(this.database, 'agent_slots', 'group_id')) {
          this.database.exec('ALTER TABLE agent_slots ADD COLUMN group_id TEXT REFERENCES team_groups(id) ON DELETE SET NULL')
        }
        if (!tableHasColumn(this.database, 'agent_slots', 'home_role_id')) {
          this.database.exec('ALTER TABLE agent_slots ADD COLUMN home_role_id TEXT')
        }
        if (!tableHasColumn(this.database, 'agent_slots', 'group_joined_at')) {
          this.database.exec('ALTER TABLE agent_slots ADD COLUMN group_joined_at INTEGER')
        }
        if (!tableHasColumn(this.database, 'team_roles', 'group_id')) {
          this.database.exec('ALTER TABLE team_roles ADD COLUMN group_id TEXT REFERENCES team_groups(id) ON DELETE CASCADE')
        }
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(8, Date.now())
        this.database.exec('COMMIT')
        databaseVersion = 8
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion === 8) {
      // v9（阶段 2 · 2B）：团队 run 的启动状态机退役，run 只剩 running / completed。
      // - 一次性团队 run（software-core-v1）不再能被创建、启动或接管：无论停在哪个状态，一律归档为
      //   completed（detail 标明是升级归档，不是「全员离线」）。仍在 running 的旧团队会话会在下一次轮询
      //   被会话围栏以 run_completed 退役——升级后没有任何界面能继续操作它，与其半死不如明确结束。
      // - 早期代码遗留的、非最新的 running 独立 run（同一工作区内已被更新的 run 取代）同样归档；
      //   activeRun 永远取最新一条，这些行只是脏数据。
      // - draft / ready / launching / attention / paused 这些值此后不会再被写入。
      this.database.exec('BEGIN IMMEDIATE')
      try {
        const now = Date.now()
        const runs = this.database.prepare(
          'SELECT id, workspace_id, template_id, status, created_at FROM team_runs ORDER BY created_at DESC, id DESC'
        ).all() as SqliteRow[]
        const newestPoolByWorkspace = new Map<string, string>()
        for (const run of runs) {
          const workspaceId = String(run.workspace_id)
          if (!newestPoolByWorkspace.has(workspaceId)) newestPoolByWorkspace.set(workspaceId, String(run.id))
        }
        const legacyTeamRunIds = runs
          .filter((run) => String(run.template_id) !== INDEPENDENT_SESSION_TEMPLATE_ID && String(run.status) !== 'completed')
          .map((run) => String(run.id))
        const stalePoolIds = runs
          .filter((run) => String(run.template_id) === INDEPENDENT_SESSION_TEMPLATE_ID
            && String(run.status) !== 'completed'
            && newestPoolByWorkspace.get(String(run.workspace_id)) !== String(run.id))
          .map((run) => String(run.id))
        // 归档 = completeRun 的三件事（run 置 completed、撤销该 run 的 agent 注册、收尾原因写进绑定备注），
        // 只是 detail 标明是升级归档；注册按 run 撤销，同工作区更新的池 run 不受影响。
        const archiveRun = this.database.prepare("UPDATE team_runs SET status = 'completed', updated_at = ? WHERE id = ?")
        const revokeRegistrations = this.database.prepare(
          'UPDATE agent_registrations SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL'
        )
        const noteBindings = this.database.prepare('UPDATE runtime_bindings SET launch_detail = ? WHERE run_id = ?')
        for (const runId of legacyTeamRunIds) {
          archiveRun.run(now, runId)
          revokeRegistrations.run(now, runId)
          noteBindings.run(RUN_ARCHIVED_LEGACY_TEAM_DETAIL, runId)
        }
        for (const runId of stalePoolIds) {
          archiveRun.run(now, runId)
          revokeRegistrations.run(now, runId)
          noteBindings.run(RUN_ARCHIVED_STALE_POOL_DETAIL, runId)
        }
        // 兜底：任何仍带旧状态值的行（理论上上面两步已覆盖）一律归档，保证此后 status 只有两种取值。
        this.database.prepare(`
          UPDATE team_runs SET status = 'completed', updated_at = ?
          WHERE status IN ('draft', 'ready', 'launching', 'attention', 'paused')
        `).run(now)
        // 启动状态机退役：launch_status 列保留（不重建表）但此后恒为 not_started，存量行一并归位；
        // launch_command_id 同理清空。就绪度改由 acknowledged_at 表达。
        this.database.exec("UPDATE runtime_bindings SET launch_status = 'not_started', launch_command_id = NULL")
        this.database.prepare(
          'UPDATE team_control_meta SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
        ).run(9, now)
        this.database.exec('COMMIT')
        databaseVersion = 9
        if (legacyTeamRunIds.length || stalePoolIds.length) {
          process.stderr.write(`[team-control] v9: archived ${legacyTeamRunIds.length} legacy team run(s) and ${stalePoolIds.length} stale pool run(s)\n`)
        }
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK')
        throw error
      }
    }
    if (databaseVersion !== TEAM_SCHEMA_VERSION) {
      throw new Error(`团队控制数据库版本不兼容：${databaseVersion}，当前支持 ${TEAM_SCHEMA_VERSION}`)
    }
    // 会话围栏令牌：纯附加列，不升 schema 版本（旧构建的 MCP 进程与新主进程可能
    // 短暂共用同一库；SELECT * 对多出的列无感）。NULL = 该绑定尚未签发令牌（旧会话）。
    // 主进程与 MCP 进程各自打开同一库并各自迁移：检查与 ALTER 之间另一进程可能已加列，
    // 此时 ALTER 报 duplicate column——按幂等处理，只在列确实不存在时才视为失败。
    if (!tableHasColumn(this.database, 'runtime_bindings', 'session_token')) {
      try {
        this.database.exec('ALTER TABLE runtime_bindings ADD COLUMN session_token TEXT')
      } catch (error) {
        if (!tableHasColumn(this.database, 'runtime_bindings', 'session_token')) throw error
      }
    }
    // 协作组规划策略（阶段 2 · 2A）：同样是纯附加列 + 默认值，不升 schema 版本。v8 建好的组补上默认
    // lead_only——与建组时「有 lead 默认 lead_only」一致；无 lead 的旧组需要用户显式改策略才开放全员规划。
    if (!tableHasColumn(this.database, 'team_groups', 'plan_policy')) {
      try {
        this.database.exec("ALTER TABLE team_groups ADD COLUMN plan_policy TEXT NOT NULL DEFAULT 'lead_only'")
      } catch (error) {
        if (!tableHasColumn(this.database, 'team_groups', 'plan_policy')) throw error
      }
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_bindings_run_composer
      ON runtime_bindings(run_id, composer_id) WHERE composer_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_agent_slots_group ON agent_slots(group_id) WHERE group_id IS NOT NULL;
    `)
    // 团队连续性（自动检查点 / 一键恢复）随阶段 2 · 2D 退役：池模型下的恢复是席位重建 + 上下文交接 +
    // 入组通知 + team_check_in 实时简报，检查点没有读者。旧构建建过的四张表按存在性删除（同样不升
    // schema 版本；DROP 在另一进程刚删过时以 IF EXISTS 幂等），删表顺序按外键自子向父。
    if (RETIRED_CONTINUITY_TABLES.some((table) => tableExists(this.database, table))) {
      this.database.exec(RETIRED_CONTINUITY_TABLES.map((table) => `DROP TABLE IF EXISTS ${table};`).join('\n'))
    }
  }
}
