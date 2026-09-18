import { hasInFlightExecution, isAgentOnDuty } from '../../../domain/channel-message'
import type { CursorModelSelection } from '../../../domain/cursor-model'
import type { DetectedCursorWorkspace } from '../../../domain/cursor-workspace'
import { sameTaskGroup, type TaskPoolSnapshot } from '../../../domain/task-pool'
import {
  isSessionPoolRun,
  type TeamControlSnapshot,
  type TeamMemberView,
  type TeamRun,
  type TeamWorkspace
} from '../../../domain/team-control'

/**
 * 「运行」页视图模型：一个工程同一时刻只有一个活跃 run——会话池。
 * 这里把领域快照折叠成页面需要的少数事实：阶段、席位状态、协作组、破坏性操作的后果，
 * 组件只负责摆放与交互。阶段 2 · 2B 起没有团队模式：升级前的一次性团队 run 已归档，
 * 若它仍是工作区最新的 run，页面回到「开始一次运行」并说明一句。
 */
export type PoolSeatState = 'waiting' | 'working' | 'awaiting' | 'offline' | 'unconfirmed'

export interface PoolSeat {
  channelId: string
  name: string
  roleName: string
  solo: boolean
  state: PoolSeatState
  lastSeenAt?: number
  modelSelection?: CursorModelSelection
  /**
   * 需要（重新）创建 Cursor 会话：离线，或尚无运行证据。执行中的席位即使心跳停刷
   * 也不算——它正在干活，重建会杀掉一个活着的会话。
   */
  pending: boolean
  /** 已入组席位：所属协作组名（独立席位没有）。 */
  groupName?: string
}

/** 协作组卡片里的成员：席位 + 组内角色 + 运行态 + 是否有效 lead。 */
export interface PoolGroupMember {
  slotId: string
  channelId: string
  roleName: string
  roleTemplateKey: string
  state: PoolSeatState
  isLead: boolean
}

/** 组的任务计数（来自任务板快照，按 groupId 归组）：未完成 / 待验收 / 已完成。 */
export interface PoolGroupCounters {
  open: number
  review: number
  done: number
}

/** 协作组卡片：active 组可操作；24h 内解散的组只读展示。 */
export interface PoolGroup {
  id: string
  name: string
  goal: string
  status: 'active' | 'dissolved'
  /** 有成员已确认离线：由用户决定移出或交接，系统不自动处理。 */
  attention: boolean
  leadSlotId?: string
  members: PoolGroupMember[]
  counters: PoolGroupCounters
  updatedAt: number
  dissolvedAt?: number
}

/** 尚未入组的席位：建组 / 加人抽屉的候选。 */
export interface UngroupedSeat {
  slotId: string
  channelId: string
  name: string
  state: PoolSeatState
  avatarId?: string
}

export const SEAT_STATE_LABEL: Record<PoolSeatState, string> = {
  waiting: '待命中',
  working: '执行中',
  awaiting: '等待回答',
  offline: '离线',
  unconfirmed: '待确认'
}

/** 席位运行态归一：与服务端守卫/围栏口径一致（在岗 / 执行租约 / 无证据 / 离线）。 */
export function seatStateOf(member: TeamMemberView): PoolSeatState {
  const runtime = member.runtime
  if (!runtime) return 'unconfirmed'
  if (runtime.awaitingUser) return 'awaiting'
  if (isAgentOnDuty(runtime) && runtime.waiting) return 'waiting'
  if (runtime.online || hasInFlightExecution(runtime)) return 'working'
  return 'offline'
}

export function poolSeatOf(member: TeamMemberView, groupName?: string): PoolSeat {
  const state = seatStateOf(member)
  return {
    channelId: member.binding?.channelId ?? member.slot.channelId ?? '?',
    name: member.slot.name,
    roleName: member.role.name,
    solo: member.slot.solo === true,
    state,
    lastSeenAt: member.runtime?.lastSeenAt,
    modelSelection: member.slot.modelSelection,
    pending: state === 'offline' || state === 'unconfirmed',
    ...(groupName ? { groupName } : {})
  }
}

function channelIdOf(member: TeamMemberView): string {
  return member.binding?.channelId ?? member.slot.channelId ?? '?'
}

/** 任务板快照的最小面：组卡片只需要每组的任务计数。 */
export type PoolTaskFacts = Pick<TaskPoolSnapshot, 'tasks' | 'taskOrder'>

const OPEN_TASK_STATUSES = new Set(['queued', 'leased', 'running'])

function groupCountersOf(runId: string | undefined, groupId: string, tasks?: PoolTaskFacts): PoolGroupCounters {
  const counters: PoolGroupCounters = { open: 0, review: 0, done: 0 }
  if (!tasks || !runId) return counters
  for (const taskId of tasks.taskOrder) {
    const task = tasks.tasks[taskId]
    if (!task || task.runId !== runId || !sameTaskGroup(task.groupId, groupId)) continue
    if (OPEN_TASK_STATUSES.has(task.status)) counters.open += 1
    else if (task.status === 'review') counters.review += 1
    else if (task.status === 'done') counters.done += 1
  }
  return counters
}

/** 会话池的协作组视图：直接映射快照里的 `groups`（active 全部 + 24h 内解散的）。 */
export function buildPoolGroups(team: TeamControlSnapshot, tasks?: PoolTaskFacts): PoolGroup[] {
  return team.groups.map((view): PoolGroup => ({
    id: view.group.id,
    name: view.group.name,
    goal: view.group.goal,
    status: view.group.status,
    attention: view.attention,
    leadSlotId: view.effectiveLeadSlotId,
    members: view.members.map((member): PoolGroupMember => ({
      slotId: member.slot.id,
      channelId: channelIdOf(member),
      roleName: member.role.name,
      roleTemplateKey: member.role.templateKey,
      state: seatStateOf(member),
      isLead: member.slot.id === view.effectiveLeadSlotId
    })),
    counters: groupCountersOf(team.activeRun?.id, view.group.id, tasks),
    updatedAt: view.group.updatedAt,
    dissolvedAt: view.group.dissolvedAt
  }))
}

/** 页面阶段：无运行（含归档的旧团队 run）→ 执行 → 已结束。 */
export type PoolPhase = 'none' | 'active' | 'completed'

export interface PoolStateChip {
  label: string
  tone: 'neutral' | 'progress' | 'active' | 'warning' | 'muted'
  hint?: string
}

export interface PoolView {
  workspace?: TeamWorkspace
  /** 当前会话池；升级前归档的一次性团队 run 不作为池暴露（见 `archivedLegacyTeam`）。 */
  pool?: TeamRun
  phase: PoolPhase
  /** 工作区最新的 run 是升级前的一次性团队 run（已归档）：页面回到开始页并说明一句。 */
  archivedLegacyTeam: boolean
  seats: PoolSeat[]
  /** 仍在线 / 执行中 / 尚无运行证据的席位数：破坏性操作前的软守卫依据。 */
  liveSeatCount: number
  /** 未待命席位：会话创建区的对象。 */
  pendingSeats: PoolSeat[]
  /** 有席位尚无运行证据：先确认它是否只是还没调用工具，再开放安全重建。 */
  evidencePending: boolean
  state: PoolStateChip
  /** Cursor 当前打开的工程与池所属工程不一致。 */
  cursorWorkspaceChanged: boolean
  /** 会话池的协作组。 */
  groups: PoolGroup[]
  /** 池里尚未入组的席位：建组 / 加人的候选。 */
  ungroupedSeats: UngroupedSeat[]
}

function poolStateChip(pool: TeamRun, seats: PoolSeat[]): PoolStateChip {
  if (pool.status === 'completed') return { label: '批次已结束', tone: 'muted', hint: '旧会话下一次轮询会收到结束指令并自行退出' }
  const waiting = seats.filter((seat) => seat.state === 'waiting').length
  const working = seats.filter((seat) => seat.state === 'working').length
  const awaiting = seats.filter((seat) => seat.state === 'awaiting').length
  if (!seats.length) return { label: '空批次', tone: 'neutral' }
  if (waiting + working + awaiting === 0) return { label: '全部离线', tone: 'warning' }
  if (awaiting > 0) {
    return {
      label: `等待回答 ${awaiting} · 待命 ${waiting} · 执行中 ${working}`,
      tone: 'warning',
      hint: '打开对应会话，在提问卡片中直接选择并提交'
    }
  }
  return {
    label: working ? `待命 ${waiting} · 执行中 ${working}` : `待命 ${waiting}/${seats.length}`,
    tone: waiting + working === seats.length ? 'active' : 'neutral'
  }
}

export function buildPoolView(
  team: TeamControlSnapshot,
  detected?: DetectedCursorWorkspace,
  tasks?: PoolTaskFacts
): PoolView {
  const workspace = team.workspaces.find((candidate) => candidate.id === team.activeWorkspaceId)
  const archivedLegacyTeam = team.activeRun !== undefined && !isSessionPoolRun(team.activeRun)
  const pool = archivedLegacyTeam ? undefined : team.activeRun
  const phase: PoolPhase = !pool ? 'none' : pool.status === 'completed' ? 'completed' : 'active'
  // 会话池 = 池内全部席位：独立的与已入组的都是池的成员，入组只是多了组内角色。
  const members = pool ? team.members : []
  const groups = pool ? buildPoolGroups(team, tasks) : []
  const groupNameBySlot = new Map(groups.flatMap((group) => (
    group.status === 'active' ? group.members.map((member) => [member.slotId, group.name] as const) : []
  )))
  const seats = members.map((member) => poolSeatOf(member, groupNameBySlot.get(member.slot.id)))
  const liveSeatCount = phase === 'completed'
    ? 0
    : seats.filter((seat) => seat.state !== 'offline').length
  const state: PoolStateChip = !pool
    ? archivedLegacyTeam
      ? { label: '旧团队运行已归档', tone: 'muted', hint: '一次性团队 run 已退役；开始新的独立批次，在运行中按需建组' }
      : { label: '尚未开始运行', tone: 'neutral' }
    : poolStateChip(pool, seats)
  return {
    workspace,
    pool,
    phase,
    archivedLegacyTeam,
    seats,
    liveSeatCount,
    pendingSeats: phase === 'completed' ? [] : seats.filter((seat) => seat.pending),
    evidencePending: phase !== 'completed' && seats.some((seat) => seat.state === 'unconfirmed'),
    state,
    cursorWorkspaceChanged: Boolean(detected && workspace && detected.id !== workspace.id),
    groups,
    ungroupedSeats: members
      .filter((member) => member.slot.solo === true)
      .map((member) => ({
        slotId: member.slot.id,
        channelId: channelIdOf(member),
        name: member.slot.name,
        state: seatStateOf(member),
        avatarId: member.slot.avatarId
      }))
  }
}

/**
 * 破坏性动作的统一确认面（`ConfirmSheet`）：标题说动作、正文说后果、按钮说结果。
 * 移出成员与解散组永远确认（组身份、任务与消息受影响）；结束与新建批次只在仍有
 * live 席位时确认。加人、换 lead、改目标不确认——再改回去即可撤销。
 */
export interface ConfirmConsequence {
  title: string
  body: string
  confirmLabel: string
  needsConfirm: boolean
  /** 破坏性程度：danger 的确认按钮走红色（解散 / 结束），其余中性。 */
  tone: 'danger' | 'neutral'
}

/** 待移出的成员（名册多选与组卡片共用同一份文案来源）。 */
export interface RemoveMemberFact {
  channelId: string
  groupName: string
}

export type PoolAction =
  | { kind: 'remove-members'; members: RemoveMemberFact[] }
  | { kind: 'dissolve-group'; group: Pick<PoolGroup, 'name' | 'members'> }
  | { kind: 'end-pool' }
  | { kind: 'new-batch'; targetWorkspaceName?: string }

const FENCE_NOTE = '它们会在下一次轮询（最长 60 秒）收到结束指令并自行退出；尚未取走的排队消息将归档，不会误送进新的运行。'
const REMOVE_NOTE = '恢复为独立会话：Cursor 会话、令牌与时间线不变；持有的任务回到队列等组内其他成员领取，发给它、尚未回应的消息不再催办；出组通知在下一次轮询时送达。'

/**
 * 移出成员的后果（1..N 个，可跨组）：名册多选浮动条与组卡片走同一段文案。
 * 单独导出是为了名册不必构造整个 PoolView。
 */
export function removeMembersConsequence(members: RemoveMemberFact[]): ConfirmConsequence {
  const groupNames = [...new Set(members.map((member) => member.groupName))]
  const title = members.length === 1
    ? `把 CH-${members[0]!.channelId} 移出「${members[0]!.groupName}」`
    : groupNames.length === 1
      ? `把 ${members.length} 个会话移出「${groupNames[0]}」`
      : `把 ${members.length} 个会话移出协作组`
  return {
    title,
    body: `${members.length === 1 ? '该席位' : '这些席位'}${REMOVE_NOTE}`,
    confirmLabel: '确认移出',
    needsConfirm: true,
    tone: 'neutral'
  }
}

export function consequenceOf(view: PoolView, action: PoolAction): ConfirmConsequence {
  switch (action.kind) {
    case 'remove-members':
      return removeMembersConsequence(action.members)
    case 'dissolve-group':
      return {
        title: `解散「${action.group.name}」`,
        body: `${action.group.members.length} 名成员恢复为独立会话；本组未完成的任务全部取消，消息与记忆保留只读，组卡片保留 24 小时后归入历史。`,
        confirmLabel: '确认解散',
        needsConfirm: true,
        tone: 'danger'
      }
    case 'end-pool': {
      const live = view.liveSeatCount
      return {
        title: '结束当前独立批次',
        body: `${liveClause(live)}${live > 0 ? FENCE_NOTE : '结束后可以直接开始新的运行。'}`,
        confirmLabel: '确认结束',
        needsConfirm: live > 0,
        tone: 'danger'
      }
    }
    case 'new-batch': {
      const live = view.liveSeatCount
      return {
        title: action.targetWorkspaceName ? `在「${action.targetWorkspaceName}」新建批次` : '新建独立批次',
        body: `${liveClause(live)}当前批次会结束${live > 0 ? `，${FENCE_NOTE}` : '。'}`,
        confirmLabel: '确认新建',
        needsConfirm: live > 0,
        tone: 'neutral'
      }
    }
  }
}

function liveClause(live: number): string {
  return live > 0 ? `${live} 个会话仍在线或待确认。` : '所有会话已离线。'
}
