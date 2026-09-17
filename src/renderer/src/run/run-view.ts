import { hasInFlightExecution, isAgentOnDuty } from '../../../domain/channel-message'
import type { CursorModelSelection } from '../../../domain/cursor-model'
import type { DetectedCursorWorkspace } from '../../../domain/cursor-workspace'
import {
  isSessionPoolRun,
  type TeamControlSnapshot,
  type TeamMemberView,
  type TeamRun,
  type TeamWorkspace
} from '../../../domain/team-control'

/**
 * 「运行」页视图模型：一个工程同一时刻只有一个活跃 run——会话池（独立批次）。
 * 这里把领域快照折叠成页面需要的少数事实：阶段、席位状态、协作组、破坏性操作的后果，
 * 组件只负责摆放与交互。阶段 2 · 2B 起没有团队模式：升级前的一次性团队 run 已归档，
 * 若它仍是工作区最新的 run，页面回到「开始一次运行」并说明一句。
 */
export type RunSeatState = 'waiting' | 'working' | 'awaiting' | 'offline' | 'unconfirmed'

export interface RunSeat {
  channelId: string
  name: string
  roleName: string
  solo: boolean
  state: RunSeatState
  lastSeenAt?: number
  modelSelection?: CursorModelSelection
  /**
   * 需要（重新）创建 Cursor 会话：离线，或尚无运行证据。执行中的席位即使心跳停刷
   * 也不算——它正在干活，重建会杀掉一个活着的会话。
   */
  pending: boolean
  /** 会话池里已入组的席位：所属协作组名（独立席位与团队席位没有）。 */
  groupName?: string
}

/** 协作组卡片里的成员：席位 + 组内角色 + 运行态 + 是否有效 lead。 */
export interface RunGroupMember {
  slotId: string
  channelId: string
  roleName: string
  roleTemplateKey: string
  state: RunSeatState
  isLead: boolean
}

/** 协作组卡片：active 组可操作；24h 内解散的组只读展示。 */
export interface RunGroup {
  id: string
  name: string
  goal: string
  status: 'active' | 'dissolved'
  /** 有成员已确认离线：由用户决定移出或交接，系统不自动处理。 */
  attention: boolean
  leadSlotId?: string
  members: RunGroupMember[]
  updatedAt: number
  dissolvedAt?: number
}

/** 尚未入组的席位：建组 / 加人抽屉的候选。 */
export interface RunUngroupedSeat {
  slotId: string
  channelId: string
  name: string
  state: RunSeatState
}

export const SEAT_STATE_LABEL: Record<RunSeatState, string> = {
  waiting: '待命中',
  working: '执行中',
  awaiting: '等待回答',
  offline: '离线',
  unconfirmed: '待确认'
}

/** 席位运行态归一：与服务端守卫/围栏口径一致（在岗 / 执行租约 / 无证据 / 离线）。 */
export function seatStateOf(member: TeamMemberView): RunSeatState {
  const runtime = member.runtime
  if (!runtime) return 'unconfirmed'
  if (runtime.awaitingUser) return 'awaiting'
  if (isAgentOnDuty(runtime) && runtime.waiting) return 'waiting'
  if (runtime.online || hasInFlightExecution(runtime)) return 'working'
  return 'offline'
}

export function runSeatOf(member: TeamMemberView, groupName?: string): RunSeat {
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

/** 会话池的协作组视图：直接映射快照里的 `groups`（active 全部 + 24h 内解散的）。 */
export function buildRunGroups(team: TeamControlSnapshot): RunGroup[] {
  return team.groups.map((view): RunGroup => ({
    id: view.group.id,
    name: view.group.name,
    goal: view.group.goal,
    status: view.group.status,
    attention: view.attention,
    leadSlotId: view.effectiveLeadSlotId,
    members: view.members.map((member): RunGroupMember => ({
      slotId: member.slot.id,
      channelId: channelIdOf(member),
      roleName: member.role.name,
      roleTemplateKey: member.role.templateKey,
      state: seatStateOf(member),
      isLead: member.slot.id === view.effectiveLeadSlotId
    })),
    updatedAt: view.group.updatedAt,
    dissolvedAt: view.group.dissolvedAt
  }))
}

/** 页面阶段：无运行（含归档的旧团队 run）→ 执行 → 已结束。 */
export type RunPhase = 'none' | 'active' | 'completed'

export interface RunStateChip {
  label: string
  tone: 'neutral' | 'progress' | 'active' | 'warning' | 'muted'
  hint?: string
}

export interface RunView {
  workspace?: TeamWorkspace
  /** 当前会话池；升级前归档的一次性团队 run 不作为 run 暴露（见 `archivedLegacyTeam`）。 */
  run?: TeamRun
  phase: RunPhase
  /** 工作区最新的 run 是升级前的一次性团队 run（已归档）：页面回到开始页并说明一句。 */
  archivedLegacyTeam: boolean
  seats: RunSeat[]
  /** 仍在线 / 执行中 / 尚无运行证据的席位数：破坏性操作前的软守卫依据。 */
  liveSeatCount: number
  /** 未待命席位：会话创建区的对象。 */
  pendingSeats: RunSeat[]
  /** 有席位尚无运行证据：先确认它是否只是还没调用工具，再开放安全重建。 */
  evidencePending: boolean
  state: RunStateChip
  /** Cursor 当前打开的工程与运行所属工程不一致。 */
  cursorWorkspaceChanged: boolean
  /** 会话池的协作组。 */
  groups: RunGroup[]
  /** 会话池里尚未入组的席位：建组 / 加人的候选。 */
  ungroupedSeats: RunUngroupedSeat[]
}

function poolStateChip(run: TeamRun, seats: RunSeat[]): RunStateChip {
  if (run.status === 'completed') return { label: '批次已结束', tone: 'muted', hint: '旧会话下一次轮询会收到结束指令并自行退出' }
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

export function buildRunView(team: TeamControlSnapshot, detected?: DetectedCursorWorkspace): RunView {
  const workspace = team.workspaces.find((candidate) => candidate.id === team.activeWorkspaceId)
  const archivedLegacyTeam = team.activeRun !== undefined && !isSessionPoolRun(team.activeRun)
  const run = archivedLegacyTeam ? undefined : team.activeRun
  const phase: RunPhase = !run ? 'none' : run.status === 'completed' ? 'completed' : 'active'
  // 会话池 = 池内全部席位：独立的与已入组的都是池的成员，入组只是多了组内角色。
  const members = run ? team.members : []
  const groups = run ? buildRunGroups(team) : []
  const groupNameBySlot = new Map(groups.flatMap((group) => (
    group.status === 'active' ? group.members.map((member) => [member.slotId, group.name] as const) : []
  )))
  const seats = members.map((member) => runSeatOf(member, groupNameBySlot.get(member.slot.id)))
  const liveSeatCount = phase === 'completed'
    ? 0
    : seats.filter((seat) => seat.state !== 'offline').length
  const state: RunStateChip = !run
    ? archivedLegacyTeam
      ? { label: '旧团队运行已归档', tone: 'muted', hint: '一次性团队 run 已退役；开始新的独立批次，在运行中按需建组' }
      : { label: '尚未开始运行', tone: 'neutral' }
    : poolStateChip(run, seats)
  return {
    workspace,
    run,
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
      .map((member) => ({ slotId: member.slot.id, channelId: channelIdOf(member), name: member.slot.name, state: seatStateOf(member) }))
  }
}

/** 协作组的破坏性动作：与结束 / 切换 / 新建批次共用同一张确认面（`ReplaceRunSheet`），但后果说的是组，不是运行。 */
export type GroupAction =
  | { kind: 'remove'; group: RunGroup; member: RunGroupMember }
  | { kind: 'dissolve'; group: RunGroup }

export function groupActionConsequence(action: GroupAction): ReplaceRunConsequence {
  switch (action.kind) {
    case 'remove':
      return {
        title: `把 CH-${action.member.channelId} 移出「${action.group.name}」`,
        body: '该席位恢复为独立会话：Cursor 会话、令牌与时间线不变；它持有的任务回到队列等组内其他成员领取，发给它、尚未回应的消息不再催办；出组通知在它下一次轮询时送达。',
        confirmLabel: '确认移出',
        needsConfirm: true
      }
    case 'dissolve':
      return {
        title: `解散「${action.group.name}」`,
        body: `${action.group.members.length} 名成员恢复为独立会话；本组未完成的任务全部取消，消息与记忆保留只读，组卡片保留 24 小时后归入历史。`,
        confirmLabel: '确认解散',
        needsConfirm: true
      }
  }
}

/**
 * 破坏性动作的统一后果说明。结束、新建批次走同一段文案模板与同一个守卫
 *（仍有 live 席位才要确认），不再各处各写一套。
 */
export type ReplaceRunAction =
  | { kind: 'end' }
  | { kind: 'new-batch'; targetWorkspaceName?: string }

export interface ReplaceRunConsequence {
  title: string
  body: string
  confirmLabel: string
  needsConfirm: boolean
}

const FENCE_NOTE = '它们会在下一次轮询（最长 60 秒）收到结束指令并自行退出；尚未取走的排队消息将归档，不会误送进新的运行。'

export function replaceRunConsequence(view: RunView, action: ReplaceRunAction): ReplaceRunConsequence {
  const live = view.liveSeatCount
  const liveClause = live > 0 ? `${live} 个会话仍在线或待确认。` : '所有会话已离线。'
  switch (action.kind) {
    case 'end':
      return {
        title: '结束当前独立批次',
        body: `${liveClause}${live > 0 ? FENCE_NOTE : '结束后可以直接开始新的运行。'}`,
        confirmLabel: '确认结束',
        needsConfirm: live > 0
      }
    case 'new-batch':
      return {
        title: action.targetWorkspaceName ? `在「${action.targetWorkspaceName}」新建批次` : '新建独立批次',
        body: `${liveClause}当前批次会结束${live > 0 ? `，${FENCE_NOTE}` : '。'}`,
        confirmLabel: '确认新建',
        needsConfirm: live > 0
      }
  }
}
