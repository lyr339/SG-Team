import type { AgentRuntimeEvidence, AgentSessionStatus } from './agent-session'
import {
  cursorComposerBindingMarker,
  type ComposerBindingMethod
} from './cursor-telemetry'
import type { AssignedAgentSkill } from './agent-skill'
import type { CursorModelSelection } from './cursor-model'
import type { TeamFailoverRecord } from './team-failover'
import { TEAM_REPLY_STYLE_INSTRUCTION } from './team-reply-style'
import { hasConfirmedRuntimeStop, MEMBERSHIP_NOTICE_PREFIX, SG_TEAM_MCP_SERVER_ID } from './channel-message'
import { TaskPoolError } from './task-pool'

/**
 * run 只有两种状态（阶段 2 · 2B）：一建即 `running`，用户结束 / 被新 run 替换 / 升级归档后 `completed`。
 * 没有 draft / ready / launching（没有启动这一步）、attention（关注点在组上：`TeamGroupView.attention`）、
 * paused（没有暂停语义）。
 */
export type TeamRunStatus = 'running' | 'completed'

export type WorkspaceRunMode = 'team' | 'independent'
export const INDEPENDENT_SESSION_TEMPLATE_ID = 'independent-session-v1'

export function workspaceRunMode(run?: Pick<TeamRun, 'templateId'>): WorkspaceRunMode {
  return run?.templateId === INDEPENDENT_SESSION_TEMPLATE_ID ? 'independent' : 'team'
}

/**
 * 会话池 run：独立批次 run 就是工作区的会话池——长生命周期、每个 Cursor 会话一个席位、
 * 席位可随时入组/出组（team_groups）。与一次性团队 run（software-core-v1）的区别在于：
 * 池永不被失效接管自动收尾、没有整体启动状态机、没有 standby 概念。
 */
export function isSessionPoolRun(run?: Pick<TeamRun, 'templateId'>): boolean {
  return workspaceRunMode(run) === 'independent'
}

export type TeamRoleAccent = 'mint' | 'periwinkle' | 'apricot' | 'sky'

/**
 * 席位就绪度：未绑通道 → 未装 MCP → 离线 → 在线但不在协议内相位 → 待命 → 已签到在岗。
 * 没有 launching / attention（启动状态机已退役；需要关注的是组，不是席位）。
 */
export type TeamMemberReadiness =
  | 'unbound'
  | 'mcp_missing'
  | 'offline'
  | 'not_waiting'
  | 'ready'
  | 'active'

export interface TeamWorkspace {
  id: string
  name: string
  path: string
  createdAt: number
  updatedAt: number
}

export interface TeamRun {
  id: string
  workspaceId: string
  name: string
  goal: string
  templateId: string
  status: TeamRunStatus
  createdAt: number
  updatedAt: number
  /** 临时主控 SlotId：主控离线时由系统或手动指定，优先级高于角色模板。 */
  actingLeadSlotId?: string
}

export interface TeamRole {
  id: string
  runId: string
  key: string
  templateKey: string
  name: string
  mission: string
  instructions: string
  capabilities: string[]
  skills: AssignedAgentSkill[]
  accent: TeamRoleAccent
  order: number
  /** 组角色：随成员入组创建、出组/解散删除；空 = run 级角色（legacy 团队 run 或 solo 角色）。 */
  groupId?: string
}

/**
 * AgentSlot is the durable team member. A Cursor channel is only its current
 * runtime target and may be replaced by a later MCP generation.
 */
export interface AgentSlot {
  id: string
  runId: string
  roleId: string
  name: string
  avatarId: string
  /** 该席位下一次自动创建 Cursor Composer 时使用的独立模型配置。 */
  modelSelection?: CursorModelSelection
  /**
   * 独立席位：不入队，不参与团队调度；仅保留用户单聊与批量会话创建。
   * 会话池内 `solo === true ⇔ groupId === undefined`（入组翻为 false，出组恢复）。
   */
  solo?: boolean
  channelId?: string
  order: number
  createdAt: number
  updatedAt: number
  /** 所在协作组（会话池）；空 = 未入组。成员关系的唯一真相源。 */
  groupId?: string
  /** 出组时恢复的角色（入组前的 solo 角色 id）；只在入组期间有值。 */
  homeRoleId?: string
  groupJoinedAt?: number
}

export type TeamGroupStatus = 'active' | 'dissolved'

/**
 * 组内谁能 `team_task plan`（阶段 2 · 2A，决策 D2）：
 * - `lead_only`：只有有效 lead；组没有 lead 时组内无人能规划，任务由用户在拾光里为该组创建。
 * - `any_member`：组没有 lead 时任一成员都能规划（扁平协作组）；有 lead 时仍只有 lead。
 * 用户永远可以在桌面为任一组建任务，该策略只约束 Agent。
 */
export type TeamGroupPlanPolicy = 'lead_only' | 'any_member'

/**
 * 协作组：会话池内随时可建可拆的协作上下文（目标、成员、角色、lead、任务、消息、记忆）。
 * 入组 / 出组不触碰会话令牌、Composer 绑定与作用域——那些是池级事实。
 */
export interface TeamGroup {
  id: string
  runId: string
  name: string
  goal: string
  status: TeamGroupStatus
  /** 可为空：无 lead 的纯协作组（共享目标 + 消息 + 记忆）。 */
  leadSlotId?: string
  /** 临时主控（lead 离线时由系统或用户指定），优先级高于 leadSlotId。 */
  actingLeadSlotId?: string
  planPolicy: TeamGroupPlanPolicy
  createdAt: number
  updatedAt: number
  dissolvedAt?: number
}

/** 建组时未显式给出策略：有 lead 的组默认 lead_only；无 lead 的组默认 any_member（任务书 2A「无 lead 时自动 any_member」）。 */
export function defaultGroupPlanPolicy(leadSlotId: string | undefined): TeamGroupPlanPolicy {
  return leadSlotId ? 'lead_only' : 'any_member'
}

/**
 * 组内除有效 lead 之外的成员是否也能规划任务：只有「没有有效 lead 且策略为 any_member」时成立。
 * 有 lead 时策略不生效——规划权始终归有效 lead（与 lead 权限和角色模板解耦的口径一致）。
 */
export function groupMembersMayPlan(
  group: Pick<TeamGroup, 'leadSlotId' | 'actingLeadSlotId' | 'planPolicy'>
): boolean {
  return effectiveGroupLeadSlotId(group) === undefined && group.planPolicy === 'any_member'
}

export type TeamGroupEventType =
  | 'created'
  | 'member_joined'
  | 'member_left'
  | 'member_checked_in'
  /** 入组席位换席重建完成（新 Cursor 会话已绑定），系统补投 joined 通知（阶段 2 · 2C）。 */
  | 'member_rejoined_after_rebuild'
  | 'lead_changed'
  | 'acting_lead_changed'
  | 'goal_updated'
  | 'plan_policy_updated'
  | 'dissolved'

export interface TeamGroupEvent {
  seq: number
  groupId: string
  type: TeamGroupEventType
  slotId?: string
  channelId?: string
  /** `operator`、`agent:<slotId>` 或 `system`（绑定观察者等系统路径）。 */
  actor: string
  detail?: string
  at: number
}

/** 有效 lead：临时主控优先于组 lead。 */
export function effectiveGroupLeadSlotId(group: Pick<TeamGroup, 'leadSlotId' | 'actingLeadSlotId'>): string | undefined {
  return group.actingLeadSlotId ?? group.leadSlotId
}

/** 建组 / 加人时的成员配置：席位 + 组内角色模板（默认 specialist）。 */
export interface TeamGroupMemberConfiguration {
  slotId: string
  roleTemplateKey: string
}

export interface RuntimeBinding {
  id: string
  workspaceId: string
  runId: string
  slotId: string
  channelId: string
  agentSessionId: string
  generation: string
  installedAt: number
  /**
   * 绑定备注：run 收尾原因（用户结束 / 被替换 / 升级归档）或交接说明；列名沿用 `launch_detail`。
   * 启动状态机已退役（阶段 2 · 2B）：`launch_status` 列保留但恒为 `not_started`，不再投影。
   */
  launchDetail: string
  /** 首次 team_check_in 时间；有值 = 该会话已在岗签到（就绪度 active）。换席重建时清空。 */
  acknowledgedAt?: number
  lastCheckInAt?: number
  lastCheckInNote: string
  composerBindingKey: string
  composerId?: string
  composerBoundAt?: number
  composerBindingMethod?: ComposerBindingMethod
  /**
   * 会话围栏令牌：签发给该席位当前 Cursor 会话，通信工具携带它以证明「我是这个
   * 席位的现任会话」。换席重建时轮换；团队 launch 不轮换。缺失 = 未签发（旧会话）。
   */
  sessionToken?: string
}

export interface TeamControlState {
  schemaVersion: 9
  revision: number
  activeWorkspaceId?: string
  workspaces: TeamWorkspace[]
  runs: TeamRun[]
  roles: TeamRole[]
  slots: AgentSlot[]
  bindings: RuntimeBinding[]
  /** 全部 run 的协作组（含已解散）；快照按活动 run 投影为 TeamGroupView。 */
  groups: TeamGroup[]
  updatedAt: number
}

export interface TeamMemberRuntime {
  channelId: string
  status: AgentSessionStatus
  online: boolean
  runtimeEvidence?: AgentRuntimeEvidence
  /** Cursor Agent 正等待 ask_question 等用户决策；在线但需要用户处理。 */
  awaitingUser?: boolean
  waiting: boolean
  /** 连接相位（waiting/processing/keepalive/need_reply_sync），在岗判定见 isAgentOnDuty。 */
  connectionPhase?: string
  /** 已投递待回复的出站消息身份（回复同步守门，事实源 channel_presence）。 */
  pendingOutboundId?: string
  /** 回复同步守门开启时间；超过 CHANNEL_REPLY_SYNC_STALE_MS 未收口由 check_messages 自动放行。 */
  pendingReplySyncSince?: number
  queueDepth: number
  lastSeenAt?: number
  /** Cursor/转录最近一次正面活动证据；与 MCP lastSeenAt 分离。 */
  lastAgentActivityAt?: number
  healthEvidence: string[]
  workingFiles: string[]
}

export interface TeamMemberView {
  slot: AgentSlot
  role: TeamRole
  binding?: RuntimeBinding
  runtime?: TeamMemberRuntime
  readiness: TeamMemberReadiness
}

/** 池的接入前提（没有目标 / 启动这两道门）：通道就绪、工作区已绑、全部席位已装 MCP；blockers 是人话版。 */
export interface TeamPreflight {
  bridgeConnected: boolean
  workspaceBound: boolean
  mcpInstalled: boolean
  blockers: string[]
}

export interface TeamRuntimeChannelView {
  channelId: string
  displayName: string
  status: AgentSessionStatus
  online: boolean
  runtimeEvidence?: AgentRuntimeEvidence
  waiting: boolean
  connectionPhase?: string
  queueDepth: number
  registered: boolean
  assignedSlotId?: string
  agentSessionId?: string
  generation?: string
}

/** 活动 run 内一个协作组的投影：组 + 组内成员视图 + 有效 lead + 是否需要关注。 */
export interface TeamGroupView {
  group: TeamGroup
  /** `slot.groupId === group.id` 的成员，按席位顺序。 */
  members: TeamMemberView[]
  effectiveLeadSlotId?: string
  /** 有成员已确认离线（Cursor 明确终止）；由用户决定移出或交接，系统不自动处理。 */
  attention: boolean
}

/** 快照里 roles / slots / bindings 都已按活动 run 过滤；groups 同理，并升格为带成员的视图。 */
export interface TeamControlSnapshot extends Omit<TeamControlState, 'groups'> {
  activeRun?: TeamRun
  members: TeamMemberView[]
  runtimeChannels: TeamRuntimeChannelView[]
  standbyChannels: TeamRuntimeChannelView[]
  failovers: TeamFailoverRecord[]
  preflight: TeamPreflight
  /** 活动 run 的协作组：active 全部 + 最近 24h 内解散的（只读卡片）。 */
  groups: TeamGroupView[]
}

/** 已解散的组在快照里保留的时长（阶段 3 的历史折叠区之前，只读卡片）。 */
export const DISSOLVED_GROUP_VISIBLE_MS = 24 * 60 * 60_000

/** 简报与成员关系通知里的 lead 标签：`主控协调 · CH-1`；无有效 lead 时 undefined（模板写「无」）。 */
export function groupLeadLabel(view: TeamGroupView): string | undefined {
  const lead = view.effectiveLeadSlotId
    ? view.members.find((member) => member.slot.id === view.effectiveLeadSlotId)
    : undefined
  if (!lead) return undefined
  return `${lead.role.name} · CH-${lead.binding?.channelId ?? lead.slot.channelId ?? '?'}`
}

/**
 * 把活动 run 的组行投影成视图：成员 = `slot.groupId === group.id`（按席位顺序），
 * attention = 有成员已确认离线。解散超过 24h 的组不再出现。
 */
export function projectGroups(
  groups: TeamGroup[],
  activeRun: Pick<TeamRun, 'id'>,
  members: TeamMemberView[],
  now: number
): TeamGroupView[] {
  const membersByGroup = new Map<string, TeamMemberView[]>()
  for (const member of members) {
    const groupId = member.slot.groupId
    if (!groupId) continue
    const list = membersByGroup.get(groupId) ?? []
    list.push(member)
    membersByGroup.set(groupId, list)
  }
  return groups
    .filter((group) => group.runId === activeRun.id)
    .filter((group) => group.status === 'active'
      || (group.dissolvedAt !== undefined && now - group.dissolvedAt <= DISSOLVED_GROUP_VISIBLE_MS))
    .map((group): TeamGroupView => {
      const groupMembers = membersByGroup.get(group.id) ?? []
      return {
        group,
        members: groupMembers,
        effectiveLeadSlotId: effectiveGroupLeadSlotId(group),
        attention: groupMembers.some((member) => (
          member.runtime !== undefined && !member.runtime.online && hasConfirmedRuntimeStop(member.runtime)
        ))
      }
    })
}

export interface WorkspaceTeamBundle {
  workspace: TeamWorkspace
  run: TeamRun
  roles: TeamRole[]
  slots: AgentSlot[]
}

export interface TeamRoleTemplate {
  key: string
  name: string
  slotName: string
  mission: string
  instructions: string
  capabilities: string[]
  recommendedSkills: string[]
  accent: TeamRoleAccent
  avatarId: string
}

export const TEAM_ROLE_TEMPLATES: TeamRoleTemplate[] = [
  {
    key: 'lead',
    name: '主控协调',
    slotName: '主控席',
    mission: '在用户明确要求开始执行后，把团队目标拆成可验收任务，维护依赖与优先级，并协调成员而不是包办实现。',
    instructions: '启动后先确认上下文并待命；只有收到用户明确开始、分配、拆任务或执行指令后，才创建可独立验收的任务。持续关注阻塞、冲突与验收结果；没有明确必要时不要越过实现或质量角色的边界。',
    capabilities: ['coordination', 'planning'],
    recommendedSkills: ['review', 'split-to-prs', 'doc-coauthoring', 'discernment-nudge'],
    accent: 'mint',
    avatarId: 'lead'
  },
  {
    key: 'builder',
    name: '架构实现',
    slotName: '实现席',
    mission: '负责架构边界与核心实现，产出可运行、可测试、可交接的代码。',
    instructions: '只领取能力匹配且依赖已满足的任务。修改前核对接口与现有约束；提交时写清文件、测试和遗留风险，不把代码存在当作完成。',
    capabilities: ['code', 'architecture'],
    recommendedSkills: ['mcp-builder', 'vercel-composition-patterns', 'vercel-react-best-practices', 'webapp-testing', 'gh-fix-ci'],
    accent: 'periwinkle',
    avatarId: 'architect'
  },
  {
    key: 'reviewer',
    name: '质量验证',
    slotName: '验收席',
    mission: '独立验证行为、边界和回归风险，用证据决定通过或打回。',
    instructions: '不要复述实现者结论。依据验收标准检查实际结果、失败路径和回归范围；证据不足时明确打回原因与复现步骤。',
    capabilities: ['qa', 'testing'],
    recommendedSkills: ['review', 'review-bugbot', 'review-security', 'webapp-testing', 'security-best-practices', 'gh-address-comments'],
    accent: 'apricot',
    avatarId: 'reviewer'
  },
  {
    key: 'frontend',
    name: '前端体验',
    slotName: '体验席',
    mission: '负责用户界面、交互状态、可访问性与视觉一致性，交付可验证的真实界面。',
    instructions: '保持现有设计系统，不制造重复信息和空壳交互；修改后必须在真实渲染环境验证核心流程与控制台健康。',
    capabilities: ['code', 'frontend', 'ux'],
    recommendedSkills: ['frontend-design', 'web-design-guidelines', 'webapp-testing', 'vercel-react-best-practices', 'vercel-composition-patterns'],
    accent: 'mint',
    avatarId: 'frontend'
  },
  {
    key: 'backend',
    name: '后端实现',
    slotName: '后端席',
    mission: '负责领域逻辑、服务边界、数据持久化与接口可靠性。',
    instructions: '优先维护事务边界、幂等性和迁移兼容；提交时提供接口、数据与失败路径测试证据。',
    capabilities: ['code', 'backend', 'database'],
    recommendedSkills: ['mcp-builder', 'claude-api', 'security-best-practices', 'review-security', 'webapp-testing'],
    accent: 'periwinkle',
    avatarId: 'architect'
  },
  {
    key: 'devops',
    name: 'DevOps',
    slotName: '运维席',
    mission: '负责构建、发布、运行监控和故障恢复，保障交付流水线稳定。',
    instructions: '所有变更必须可回滚、可观测、可重复；不得在证据不足时修改生产环境。',
    capabilities: ['devops', 'deployment', 'observability'],
    recommendedSkills: ['cloudflare-deploy', 'deploy-to-vercel', 'vercel-deploy', 'vercel-optimize', 'gh-fix-ci', 'sentry'],
    accent: 'sky',
    avatarId: 'devops'
  },
  {
    key: 'researcher',
    name: '研究分析',
    slotName: '研究席',
    mission: '负责资料检索、方案比较、需求澄清与证据整理，为主控提供可靠输入。',
    instructions: '区分事实、推断与建议；优先使用一手来源并留下可复查引用，不直接越权修改实现。',
    capabilities: ['research', 'analysis', 'documentation'],
    recommendedSkills: ['notion-research-documentation', 'doc-coauthoring', 'writing-guidelines', 'openai-docs', 'pdf'],
    accent: 'sky',
    avatarId: 'researcher'
  },
  {
    key: 'product',
    name: '产品需求',
    slotName: '产品席',
    mission: '负责目标澄清、用户流程、约束和验收口径，减少团队返工。',
    instructions: '把模糊需求转成可验证行为与边界，不替实现角色决定技术细节。',
    capabilities: ['product', 'requirements', 'documentation'],
    recommendedSkills: ['notion-spec-to-implementation', 'doc-coauthoring', 'internal-comms', 'writing-guidelines', 'brand-guidelines'],
    accent: 'apricot',
    avatarId: 'researcher'
  },
  {
    key: 'specialist',
    name: '专项实现',
    slotName: '专项席',
    mission: '承接拆分后的专项任务，与其他实现角色保持接口一致并主动报告冲突。',
    instructions: '严格按任务边界工作；开始前确认依赖，提交时提供验证证据。发现跨模块冲突时先报告。',
    capabilities: ['code', 'implementation'],
    recommendedSkills: ['mcp-builder', 'webapp-testing', 'review', 'gh-fix-ci'],
    accent: 'sky',
    avatarId: 'devops'
  },
  {
    key: 'solo',
    name: '独立执行',
    slotName: '独立席',
    mission: '作为独立会话直接服务用户，接收并执行用户单独指派的任务，不参与团队协作与任务板。',
    instructions: '只面向用户工作：收到用户消息后直接完成并回复；不调用任何 team_* 团队工具，不参与任务板。',
    capabilities: [],
    recommendedSkills: [],
    accent: 'sky',
    avatarId: 'researcher'
  }
]

export const AGENT_AVATAR_IDS = ['lead', 'architect', 'reviewer', 'frontend', 'devops', 'researcher'] as const
/** 主控模板能力：有效 lead（含临时主控）在授权时叠加，持 lead 模板但被替代的成员则被摘除。 */
export const LEAD_ROLE_CAPABILITIES: readonly string[] = TEAM_ROLE_TEMPLATES.find((template) => template.key === 'lead')!.capabilities

export interface TeamMemberConfiguration {
  channelId: string
  roleTemplateKey: string
  avatarId: string
  skills: AssignedAgentSkill[]
  modelSelection?: CursorModelSelection
  /** 独立席位：不入队，仅保留单聊与批量会话创建。 */
  solo?: boolean
}

function roleTemplateOf(key: string): TeamRoleTemplate {
  const template = TEAM_ROLE_TEMPLATES.find((candidate) => candidate.key === key.trim())
  if (!template) throw new Error(`未知团队角色模板：${key}`)
  return template
}

function uniqueChannelIds(values: string[]): string[] {
  return [...new Set(values.map(String).map((value) => value.trim()).filter((value) => /^\d+$/.test(value)))]
    .sort((left, right) => Number(left) - Number(right) || left.localeCompare(right))
}

export function emptyTeamControlState(): TeamControlState {
  return {
    schemaVersion: 9,
    revision: 0,
    workspaces: [],
    runs: [],
    roles: [],
    slots: [],
    bindings: [],
    groups: [],
    updatedAt: Date.now()
  }
}

export function emptyTeamControlSnapshot(): TeamControlSnapshot {
  return {
    ...emptyTeamControlState(),
    members: [],
    runtimeChannels: [],
    standbyChannels: [],
    failovers: [],
    groups: [],
    preflight: {
      bridgeConnected: false,
      workspaceBound: false,
      mcpInstalled: false,
      blockers: ['拾光通道尚未连接', '尚未绑定 Cursor 工作区']
    }
  }
}

export function createConfiguredTeamBundle(input: {
  workspaceId: string
  workspacePath: string
  workspaceName: string
  members: TeamMemberConfiguration[]
  mode?: WorkspaceRunMode
  runKey?: string
  now?: number
}): WorkspaceTeamBundle {
  const workspaceId = input.workspaceId.trim()
  const workspacePath = input.workspacePath.trim()
  const workspaceName = input.workspaceName.trim()
  if (!workspaceId || !workspacePath || !workspaceName) throw new Error('工作区信息不完整')

  const mode = input.mode ?? 'team'
  const channelIds = uniqueChannelIds(input.members.map((member) => member.channelId))
  if (!channelIds.length || channelIds.length !== input.members.length) {
    throw new Error('团队通道不能为空、重复或无效')
  }
  const teamMembers = input.members.filter((member) => member.solo !== true)
  if (mode === 'independent') {
    if (teamMembers.length || input.members.some((member) => member.roleTemplateKey !== 'solo')) {
      throw new Error('独立会话模式只接受独立席位')
    }
  } else {
    if (!teamMembers.length) throw new Error('团队至少需要 1 个非独立席位（含 1 名主控）')
    const leadCount = teamMembers.filter((member) => member.roleTemplateKey === 'lead').length
    if (leadCount !== 1) throw new Error('团队必须且只能有 1 名主控协调（独立席位不参与计数）')
  }
  const now = input.now ?? Date.now()
  const runKey = input.runKey?.trim()
  if (runKey && !/^[a-zA-Z0-9_-]{8,80}$/.test(runKey)) throw new Error('TeamRun 标识无效')
  const runId = `${mode === 'independent' ? 'session-run' : 'team-run'}:${workspaceId}:${runKey ?? 'main'}`
  const identityScope = runKey ? `${workspaceId}:${runKey}` : workspaceId
  const occurrences = new Map<string, number>()
  const configured = input.members.map((member) => {
    const template = roleTemplateOf(member.solo === true ? 'solo' : member.roleTemplateKey)
    const count = (occurrences.get(template.key) ?? 0) + 1
    occurrences.set(template.key, count)
    const key = count === 1 && template.key !== 'specialist' ? template.key : `${template.key}-${count}`
    if (!AGENT_AVATAR_IDS.includes(member.avatarId as typeof AGENT_AVATAR_IDS[number])) {
      throw new Error(`未知 Agent 头像：${member.avatarId}`)
    }
    const sourceSkills = member.solo === true ? [] : member.skills
    const skills = [...new Map(sourceSkills.map((skill) => [skill.id.trim(), {
      id: skill.id.trim(),
      name: skill.name.trim(),
      description: skill.description.trim().slice(0, 500),
      scope: skill.scope
    }])).values()].filter((skill) => skill.id && skill.name)
    return { member, template, key, skills, instanceNumber: count }
  })
  const roles: TeamRole[] = configured.map(({ template, key, skills, instanceNumber }, index) => ({
    id: `team-role:${identityScope}:${key}`,
    runId,
    key,
    templateKey: template.key,
    name: template.name
      + (template.key === 'specialist' || template.key === 'solo' || occurrences.get(template.key)! > 1 ? ` ${instanceNumber}` : ''),
    mission: template.mission,
    instructions: template.instructions,
    capabilities: [...template.capabilities],
    skills,
    accent: template.accent,
    order: index
  }))
  const slots: AgentSlot[] = roles.map((role, index) => ({
    id: `agent-slot:${identityScope}:${role.key}`,
    runId,
    roleId: role.id,
    name: configured[index]!.template.slotName
      + (role.templateKey === 'specialist' || role.templateKey === 'solo' || occurrences.get(role.templateKey)! > 1 ? ` ${configured[index]!.instanceNumber}` : ''),
    avatarId: configured[index]!.member.avatarId,
    modelSelection: configured[index]!.member.modelSelection
      ? structuredClone(configured[index]!.member.modelSelection)
      : undefined,
    solo: configured[index]!.member.solo === true,
    channelId: configured[index]!.member.channelId.trim(),
    order: index,
    createdAt: now,
    updatedAt: now
  }))

  return {
    workspace: {
      id: workspaceId,
      name: workspaceName,
      path: workspacePath,
      createdAt: now,
      updatedAt: now
    },
    run: {
      id: runId,
      workspaceId,
      name: mode === 'independent' ? `${workspaceName} · 独立会话` : `${workspaceName} · ${runKey ? '本轮运行' : '主运行'}`,
      goal: '',
      templateId: mode === 'independent' ? INDEPENDENT_SESSION_TEMPLATE_ID : 'software-core-v1',
      status: 'running',
      createdAt: now,
      updatedAt: now
    },
    roles,
    slots
  }
}

/** 组 id 形如 `team-group:<workspaceId>:<uuid>`；角色 key 只取 uuid 尾 8 位作前缀。 */
function groupKeyPrefix(groupId: string): string {
  return `g${groupId.slice(-8)}`
}

/** 从组内既有角色 key（`g<short>:<template>` / `g<short>:<template>-<n>`）解析实例号。 */
function groupRoleInstanceNumber(roleKey: string, prefix: string, templateKey: string): number | undefined {
  const base = `${prefix}:${templateKey}`
  if (roleKey === base) return 1
  if (!roleKey.startsWith(`${base}-`)) return undefined
  const value = Number(roleKey.slice(base.length + 1))
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * 组角色行：每个组成员一行专属角色（出组时整行删除），id 以 (group, slot) 定址；
 * role_key 带组短 id 前缀以满足 `UNIQUE(run_id, role_key)`；同模板多人按组内既有最大实例号续号
 *（不是按数量——中间成员出组后再加人不能撞上仍在组里的编号）。solo 模板不能作组角色。
 */
export function buildGroupRoles(input: {
  group: Pick<TeamGroup, 'id' | 'runId'>
  members: TeamGroupMemberConfiguration[]
  existingGroupRoles: Pick<TeamRole, 'key' | 'templateKey' | 'order'>[]
  now?: number
}): TeamRole[] {
  const prefix = groupKeyPrefix(input.group.id)
  const nextInstance = new Map<string, number>()
  for (const role of input.existingGroupRoles) {
    const instance = groupRoleInstanceNumber(role.key, prefix, role.templateKey)
    if (instance !== undefined) {
      nextInstance.set(role.templateKey, Math.max(nextInstance.get(role.templateKey) ?? 0, instance))
    }
  }
  let order = input.existingGroupRoles.reduce((max, role) => Math.max(max, role.order + 1), 0)
  const seen = new Set<string>()
  return input.members.map((member): TeamRole => {
    const slotId = member.slotId.trim()
    if (!slotId) throw new TaskPoolError('group_member_slot_required', '组成员缺少席位 id')
    if (seen.has(slotId)) throw new TaskPoolError('group_member_duplicate', `同一席位在成员列表里重复：${slotId}`)
    seen.add(slotId)
    const template = roleTemplateOf(member.roleTemplateKey)
    if (template.key === 'solo') throw new TaskPoolError('group_role_solo_forbidden', '独立执行角色不能作为组内角色')
    const instance = (nextInstance.get(template.key) ?? 0) + 1
    nextInstance.set(template.key, instance)
    const numbered = template.key === 'specialist' || instance > 1
    return {
      id: `team-role:${input.group.id}:${slotId}`,
      runId: input.group.runId,
      key: numbered ? `${prefix}:${template.key}-${instance}` : `${prefix}:${template.key}`,
      templateKey: template.key,
      name: numbered ? `${template.name} ${instance}` : template.name,
      mission: template.mission,
      instructions: template.instructions,
      capabilities: [...template.capabilities],
      skills: [],
      accent: template.accent,
      order: order++,
      groupId: input.group.id
    }
  })
}

/**
 * 一句话启动提示（S4 底层注入）：作为 Cursor composer 唯一用户消息出现；
 * 角色职责/团队目标/协作规范全部经 MCP instructions 与 team_check_in
 * 返回值注入，不再占用会话可见内容。
 */
/**
 * 通信工具的调用参数片段：席位已签发会话令牌时附带 session（会话围栏），否则只有
 * channel_id。所有开场提示/简报/待命指令统一经此生成，保证 Agent 看到的形态一致。
 */
export function communicationCallArguments(input: { channelId: string; sessionToken?: string }): string {
  const session = input.sessionToken?.trim()
  return session
    ? `{channel_id:'${input.channelId}', session:'${session}'}`
    : `{channel_id:'${input.channelId}'}`
}

/** 会话令牌说明（有令牌时附在开场提示末尾）。 */
export function sessionTokenInstruction(input: { channelId: string; sessionToken?: string }): string {
  const session = input.sessionToken?.trim()
  if (!session) return ''
  return `本会话令牌（session）：${session}。每次调用 check_messages / record_reply 都必须附带 session:'${session}'；`
    + '若返回「会话围栏」终止指令，说明本会话已被新会话接管或本轮已结束——立即停止轮询并结束，不要重试。'
}

/**
 * 席位开场指令（阶段 2 · 2B 起唯一的一种）：只交付本会话动态参数与首个动作；完整循环、静默和终止规则
 * 由 SG Team MCP instructions 单一陈述，绑定标记由 AgentSessionLauncher 统一追加。
 * 入组席位重建后的会话同样先进入 check_messages，入组通知随首个轮询到达（阶段 2C）。
 */
export function buildSoloLaunchHint(input: { channelId: string; sessionToken?: string }): string {
  const { channelId } = input
  const call = communicationCallArguments(input)
  return [
    `${SG_TEAM_MCP_SERVER_ID} · CH-${channelId} · 独立会话。不要回复本条——不思考、不输出任何文字、不使用 team_*；`,
    `立即调用 check_messages(${call}) 进入长会话待命，之后按服务器说明持续对话，通信工具沿用同一参数。`
  ].join('\n')
}

/** team_check_in 简报里的协作组参数：目标在组上；lead 一句话；无 lead 组不输出 lead 专用工作流。 */
export interface TeamRoleBriefingGroup {
  name: string
  goal: string
  /** 有效 lead 的角色名 + 通道（`主控协调 · CH-1`）；无 lead 组为空。 */
  leadLabel?: string
  memberCount: number
  /** 无 lead 且策略 any_member：组内任一成员都能 team_task plan（见 `groupMembersMayPlan`）。 */
  membersMayPlan?: boolean
}

/**
 * 角色简报：team_check_in 完整返回，属工具输出而非会话内容。
 * 只写角色相关的内容（身份、目标、职责、工作流、协作规范）；通信协议（record_reply /
 * check_messages / 静默规则 / 终止条件）由服务器说明唯一陈述，这里不复述。
 *
 * 简报只对协作组成员存在（阶段 2 · 2B）：未入组席位在 team_check_in 得到 not_in_group，legacy 团队 run 已归档，
 * 所以目标、lead 与成员关系一律来自组；run 只提供 id 作为稳定坐标。
 */
export function buildTeamRoleBriefing(input: {
  run: Pick<TeamRun, 'id'>
  role: TeamRole
  slot: AgentSlot
  binding: RuntimeBinding
  effectiveLead?: boolean
  originalLeadDemoted?: boolean
  group: TeamRoleBriefingGroup
}): string {
  const { run, role, slot, binding, group } = input
  const effectiveLead = input.effectiveLead ?? role.templateKey === 'lead'
  const channelId = binding.channelId
  const server = SG_TEAM_MCP_SERVER_ID
  const ch = `{channel_id:'${channelId}'}`
  const sessionNote = sessionTokenInstruction({ channelId, sessionToken: binding.sessionToken })
  const telemetryMarker = cursorComposerBindingMarker({
    bindingKey: binding.composerBindingKey,
    channelId
  })
  // 带 channel_id 的调用示例：`{channel_id:'2', view:'board'}`。
  const call = (args: string) => `{channel_id:'${channelId}', ${args}}`
  // 无 lead 且允许全员规划的组：成员也持有规划权（`groupMembersMayPlan`）。
  const memberMayPlan = !effectiveLead && group.membersMayPlan === true
  const planRule = `只有收到用户明确要求“开始 / 分配 / 拆任务 / 执行”后，才用 team_task(${call("action:'plan', tasks:[...]")}) 创建带依赖、验收标准和目标 AgentSlot 的计划；创建后由拾光自动分派、催办与派验收，不需要你逐条派发。`
  const roleWorkflow = effectiveLead
    ? `2. 调用 team_tasks(${call("view:'board'")}) 了解任务板。启动后即使任务板为空也只待命，不要依据团队目标自行调用 team_task plan；${planRule}`
    : role.templateKey === 'reviewer'
      ? `2. 优先调用 team_tasks(${call("view:'reviews'")}) 并用 team_review(${call("action:'claim'")}) 领取独立验收；没有待验收项时再看 view:'mine' / view:'available'。`
      : `2. 调用 team_tasks(${call("view:'mine'")})；有 leased/running 任务就继续，否则看 view:'available' 并用 team_task(${call("action:'claim'")}) 按能力领取。${memberMayPlan ? `本组允许全体成员规划：${planRule}` : ''}`
  const executionWorkflow = role.templateKey === 'reviewer'
    ? "3. 验收必须独立复现并检查验收标准，最后用 team_review({action:'submit', decision, evidence, reason}) 提交通过证据或明确打回原因。"
    : "3. 领取后 team_task({action:'start'})；每个里程碑（实现完成、测试完成、遇到阻塞、返工完成）都用 team_task({action:'progress', progress, summary}) 上报；完成后 team_task({action:'submit', output}) 提交验收，不能自行宣布验收通过。"
  // 阶段 2 · 2A（决策 D1）：分派、催办、派验收、打回后的重派全部由桌面编排器完成；lead 只规划、答用户、汇总真实上报，
  // 成员的上报由 team_task / team_review 动作自动生成，不再要求手写一条 team_message。
  const collaborationWorkflow = effectiveLead
    ? "4. 团队消息随 check_messages 送达（【拾光团队消息】，已读无需 read）：成员的 status 上报与系统的【任务完成】/【任务失败】/【成员离线提醒】是你向用户汇报的依据。分派、催办、派验收、打回后的重派由拾光自动完成，你不要手动调度、催办或安排验收。只有出现新的可执行结论、阻塞、需要用户决策或用户明确询问时，才用 record_reply 向用户同步 1—3 句；纯状态消息、纯 keepalive 一律静默续等，禁止制造可见消息堵塞队列。用户要求“全体/各角色/多人”回答时必须 team_message broadcast + collect 收真实回应，禁止代答。"
    : "4. 团队消息随 check_messages 送达（【拾光团队消息】，已读无需 read）；标「需回应」的（成员发来的 directive / question）用 team_message({action:'respond', messageId, content}) 回应原 messageId，拾光系统的调度按正文执行。领取、进度、提交、失败与验收结论会随 team_task / team_review 的动作自动上报主控，不要再另发 team_message 复述；只有遇到需要主控或用户决策的阻塞时才 team_message send。"
  const skills = role.skills.length
    ? `已分配 Agent Skills：${role.skills.map((skill) => `/${skill.name}`).join('、')}。只在任务相关时按 Cursor Skills 机制调用，不要把技能名称当作已完成工作。`
    : '当前席位没有单独指定 Agent Skill；仍可按 Cursor 自动发现机制使用工作区内相关技能。'
  const leaderlessLabel = group.membersMayPlan
    ? '无——任务由用户在拾光里创建，或由任一成员规划，系统自动分派'
    : '无——任务由用户在拾光里创建并自动分派，组内成员只共享目标、消息与记忆'
  return [
    `你是拾光外置协作中枢中协作组「${group.name}」的「${role.name}」Agent（组内 ${group.memberCount} 名成员；lead：${group.leadLabel ?? leaderlessLabel}）。`,
    effectiveLead && role.templateKey !== 'lead'
      ? `当前权限：你已接管为协作组「${group.name}」的唯一有效主控；保留原专业职责，同时承担全局规划、消息协调与向用户汇报的责任（分派与催办由拾光自动完成）。`
      : input.originalLeadDemoted
        ? '当前权限：主控权限已转移给临时主控；你保留原席位上下文，但不得再调用主控专用工具，直至权限复位。'
        : '',
    `稳定身份：${slot.id}；本次可替换运行时：CH-${channelId}；TeamRun：${run.id}。`,
    `本次 Cursor 会话绑定标记：${telemetryMarker}`,
    ...(sessionNote ? [sessionNote] : []),
    `组目标：${group.goal || '（未填写，以用户随后指令为准）'}`,
    `核心职责：${role.mission}`,
    `工作边界：${role.instructions}`,
    TEAM_REPLY_STYLE_INSTRUCTION,
    skills,
    `所有团队工具与通信工具只调用 ${server}，且每次传 ${ch}；通信协议（record_reply / check_messages / 静默规则 / 终止条件）以 ${server} 服务器说明为准，团队消息不是用户可见对话，不 record_reply。`,
    '按顺序执行：',
    `1. 本简报即启动回执，随附的 context 是本组上下文快照（稳定成员目录、未读消息数、已确认记忆）；需要刷新时再次调用 team_check_in ${ch}。不要读取或复述 Cursor 历史聊天，聊天记录不是团队记忆。`,
    roleWorkflow,
    executionWorkflow,
    collaborationWorkflow,
    '5. 单点 Agent 间指令与回应用 team_message 的 send / respond，以 messageId 建立回执；禁止用普通回复或冒充成员已响应。',
    "6. 会影响团队后续工作的决策、约束、风险或经验，用 team_memory({action:'propose', kind, title, content, sources}) 记录并附消息/任务/文件来源；主控与质量角色用 team_memory review 处理待确认提案，不要求用户整理记忆。",
    effectiveLead
      ? '7. 空任务板表示等待用户下一条指令。有任务时不要催办、不要安排验收、不要打回返工——验收结论由质量角色给出，系统负责重派；收到【任务失败】后是否重新规划由你判断。向用户说明现状只用于状态真的变化、出现阻塞或用户询问，禁止重复发送同一进展。'
      : !group.leadLabel
        ? `7. 本组没有 lead：任务由用户在拾光里创建${group.membersMayPlan ? '，或按第 2 条由成员规划' : ''}，系统自动分派；成员间用 team_message 协调；额度耗尽、工具缺失或无法推进时用 record_reply 向用户说明一次。`
        : '7. 额度耗尽、工具缺失或无法推进时，立即向主控 team_message send 上报阻塞原因与已尝试步骤，禁止沉默卡死。',
    `成员关系：拾光操作员随时可能把你移出本组或解散本组，届时 check_messages 会投递${MEMBERSHIP_NOTICE_PREFIX}；出组后回到只用 check_messages / record_reply，不再调用 team_*。`,
    '额度耗尽、授权失败、工具缺失或不可恢复错误：明确报告一次并停止自动重试。'
  ].join('\n')
}

export type MembershipNoticeKind = 'joined' | 'left' | 'dissolved' | 'lead_changed'

/**
 * 成员关系通知正文（任务书 §6.2）。四种模板都以 MEMBERSHIP_NOTICE_PREFIX 开头（relay 据此判定
 * silent + membership 投递类型），不含 messageId，不要求 record_reply；入组通知内联简报摘要
 *（组名、目标、角色、lead、首个动作），出组 / 解散 / lead 变更各一段。
 */
export function buildMembershipNotice(input: {
  kind: MembershipNoticeKind
  channelId: string
  group: Pick<TeamGroup, 'name' | 'goal'>
  roleName?: string
  /** 有效 lead 的标签（`主控协调 · CH-1`）；无 lead 组为空。 */
  leadLabel?: string
  /** lead_changed：本席位是否成为 / 不再是有效 lead。 */
  becameLead?: boolean
}): string {
  const ch = `{channel_id:'${input.channelId}'}`
  const lead = input.leadLabel ?? '无'
  switch (input.kind) {
    case 'joined':
      return [
        `${MEMBERSHIP_NOTICE_PREFIX}你（CH-${input.channelId}）已加入协作组「${input.group.name}」，角色「${input.roleName ?? '成员'}」；lead：${lead}。`,
        `组目标：${input.group.goal || '（未填写，以用户随后指令为准）'}`,
        `立即调用 team_check_in(${ch}) 领取完整简报与上下文，之后按简报与服务器说明工作；简报之外不要自行开始任务。`
      ].join('\n')
    case 'left':
      return [
        `${MEMBERSHIP_NOTICE_PREFIX}你（CH-${input.channelId}）已被移出协作组「${input.group.name}」，恢复为独立席位。`,
        '组内任务租约与验收已由拾光释放；组内消息不再可见。从现在起只用 check_messages / record_reply 与用户沟通，不要再调用任何 team_* 工具，直到收到新的入组通知。'
      ].join('\n')
    case 'dissolved':
      return [
        `${MEMBERSHIP_NOTICE_PREFIX}协作组「${input.group.name}」已解散，你（CH-${input.channelId}）恢复为独立席位。`,
        '组内未完成任务已取消，消息与记忆保留只读。从现在起只用 check_messages / record_reply 与用户沟通，不要再调用任何 team_* 工具，直到收到新的入组通知。'
      ].join('\n')
    case 'lead_changed':
      return [
        `${MEMBERSHIP_NOTICE_PREFIX}协作组「${input.group.name}」的 lead 已变更：现在的 lead 是 ${lead}。`,
        input.becameLead
          ? `你（CH-${input.channelId}）已成为本组唯一有效主控：调用 team_check_in(${ch}) 刷新权限与简报，再用 team_tasks(${ch.replace('}', ", view:'board'}")}) 核对任务板。`
          : `你（CH-${input.channelId}）不再持有主控权限：调用 team_check_in(${ch}) 刷新简报后按成员工作流继续；进行中的任务不受影响。`
      ].join('\n')
  }
}
