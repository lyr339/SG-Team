import type { AgentSession } from '../../domain/agent-session'
import { isAgentOnDuty, isExplicitlyStoppedPhase, isProcessingPhase } from '../../domain/channel-message'
import type { ProcessBlock } from '../../domain/conversation-entry'
import { CURSOR_STATUS_LINE_TEXT, cursorStatusLineFromBlocks, type CursorStatusLine } from '../../domain/cursor-status-line'
import type { LiveAgentResponseState, LiveProcessState, LiveStatusLineState } from '../../shared/desktop-api'
import { contextPercent, statusLabel } from './format'
import type { ProcessTurnStep } from './process-turn-view'

/**
 * 会话侧栏（名册）的视图折叠：分区、状态色调、标题拆分与头部摘要都在这里决定，
 * 行组件与侧栏只负责摆放。
 *
 * 一级分区是**协作组**（阶段 3 · D4=a）：名册本来就是常驻导航，而组是席位的属性，
 * 放在席位旁边最直接，运行页因此不必再渲染同一批席位。状态（执行中 / 需关注 / 待命 /
 * 离线）降级为行内状态点、**分区内的排序键**与分区书签的状态色——`sessionRailGroupOf`
 * 仍是唯一那一个函数，同时决定「分区内排在哪」「状态点什么颜色」「书签什么颜色」，三者永远一致。
 */
export type SessionRailGroupId = 'active' | 'attention' | 'waiting' | 'offline'

type RailSessionFacts = Pick<AgentSession, 'online' | 'status' | 'runtimeEvidence' | 'awaitingUser' | 'waiting' | 'connectionPhase'>

/** 分类只投影现有运行事实，不改变 Agent 状态；离线证据始终拥有最高优先级。 */
export function sessionRailGroupOf(session: RailSessionFacts): SessionRailGroupId {
  if (!session.online || session.status === 'offline' || session.status === 'stopped' || session.runtimeEvidence === 'stopped') return 'offline'
  if (session.awaitingUser) return 'attention'
  if (session.status === 'blocked' || session.status === 'review') return 'attention'
  if (session.status === 'running' || session.status === 'starting' || session.status === 'reviving'
    || isProcessingPhase(session.connectionPhase ?? '')) return 'active'
  if (session.status === 'waiting' || isAgentOnDuty(session)) return 'waiting'
  return 'attention'
}

/** 行内状态词：离线组统一说「已离线」（含 stopped / 终止证据），其余沿用全应用的三字状态文案。 */
export function sessionRailStateLabel(session: RailSessionFacts): string {
  if (sessionRailGroupOf(session) === 'offline') return '已离线'
  return session.awaitingUser ? '待回答' : statusLabel(session.status)
}

/**
 * 把 displayName 拆成「角色名 + 通道号」两段：App 组装的显示名形如「架构实现 · CH-2」，
 * 未绑定席位的通道只有「SG Team CH-4」。通道号单独用等宽数字排，角色名可截断。
 */
export function sessionRailTitle(session: Pick<AgentSession, 'displayName' | 'channelId'>): { name: string; channel: string } {
  const channel = `CH-${session.channelId}`
  const name = session.displayName
    .replace(/\s*·\s*CH-\d+\s*$/u, '')
    .replace(/^SG Team\s+CH-\d+$/u, 'SG Team')
    .trim()
  return { name: name || 'SG Team', channel }
}

/** 未入组席位所在分区的 id：组 id 由服务端生成（`team-group:…`），不会与它相撞。 */
export const RAIL_INDEPENDENT_SECTION_ID = 'independent'

/**
 * 组来源投影（App 从 `teamControl.groups` 的 active 组映射而来）。名册只认通道号：
 * 席位 ↔ 通道一一对应，用它匹配就不必把 slot / binding 的形状带进渲染层。
 */
export interface RailGroupSource {
  id: string
  name: string
  /** 成员通道号；顺序无关，分区内的次序由状态与用户手动排序决定。 */
  channelIds: readonly string[]
  /** 有效 lead 的通道号（组可以没有 lead）。 */
  leadChannelId?: string
  /** 有成员确认离线：组头挂徽标，由用户决定交接还是移出。 */
  attention: boolean
}

/** 名册的一级分区：一个 active 组一段，未入组席位统一落「独立」段。 */
export interface SessionRailSection<Session> {
  id: string
  kind: 'group' | 'independent'
  label: string
  /**
   * 分区书签的状态色 = 分区内最紧要那一行的状态（排序后的首行）：折叠之后它是这一段
   * 唯一还看得见的状态提示——「有人在干活」「全员离线」一眼可辨。
   */
  state: SessionRailGroupId
  /** 组内有成员确认离线（`TeamGroupView.attention`）；「独立」段恒为 false。 */
  attention: boolean
  leadChannelId?: string
  sessions: Session[]
}

/** 分区内排序：先按状态紧要程度，再落回传入顺序（= 用户的手动排序，`sort` 稳定）。 */
const SECTION_SORT_RANK: Record<SessionRailGroupId, number> = { active: 0, attention: 1, waiting: 2, offline: 3 }

/**
 * 会话 → 名册分区。组按来源顺序成段，空组不出段（没有成员的组在名册里没有意义，它仍在
 * 运行页的组卡片上）；「独立」段恒排在全部组之后。席位同时出现在两个组时归先声明的那个。
 * 传入的 sessions 应已应用用户手动排序。
 */
export function buildSessionRailSections<Session extends RailSessionFacts & { channelId: string }>(
  sessions: readonly Session[],
  groups: readonly RailGroupSource[]
): Array<SessionRailSection<Session>> {
  const sectionIdByChannel = new Map<string, string>()
  for (const group of groups) {
    for (const channelId of group.channelIds) {
      if (!sectionIdByChannel.has(channelId)) sectionIdByChannel.set(channelId, group.id)
    }
  }
  const members = new Map<string, Session[]>()
  for (const session of sessions) {
    const sectionId = sectionIdByChannel.get(session.channelId) ?? RAIL_INDEPENDENT_SECTION_ID
    const bucket = members.get(sectionId)
    if (bucket) bucket.push(session)
    else members.set(sectionId, [session])
  }
  const section = (
    bucket: Session[],
    shape: Pick<SessionRailSection<Session>, 'id' | 'kind' | 'label' | 'attention' | 'leadChannelId'>
  ): SessionRailSection<Session> => {
    const sorted = [...bucket].sort((left, right) => SECTION_SORT_RANK[sessionRailGroupOf(left)] - SECTION_SORT_RANK[sessionRailGroupOf(right)])
    return { ...shape, state: sessionRailGroupOf(sorted[0]!), sessions: sorted }
  }
  const sections = groups.flatMap((group): Array<SessionRailSection<Session>> => {
    const bucket = members.get(group.id)
    return bucket?.length
      ? [section(bucket, {
          id: group.id,
          kind: 'group',
          label: group.name,
          attention: group.attention,
          ...(group.leadChannelId ? { leadChannelId: group.leadChannelId } : {})
        })]
      : []
  })
  const independent = members.get(RAIL_INDEPENDENT_SECTION_ID)
  if (independent?.length) {
    sections.push(section(independent, { id: RAIL_INDEPENDENT_SECTION_ID, kind: 'independent', label: '独立', attention: false }))
  }
  return sections
}

/**
 * 头部摘要：`2 组 · 4 会话 · 1 需关注 · 排队 3`。组是一级事实所以排在最前（没有组就不报「0 组」）；
 * 状态只报「需关注」这一个需要人介入的计数，其余状态已由每行的状态点表达，不在摘要里重复。
 */
export function sessionRailSummary(
  sections: ReadonlyArray<SessionRailSection<RailSessionFacts & Pick<AgentSession, 'queueDepth'>>>
): string {
  const sessions = sections.flatMap((section) => section.sessions)
  if (!sessions.length) return ''
  const groupCount = sections.filter((section) => section.kind === 'group').length
  const attention = sessions.filter((session) => sessionRailGroupOf(session) === 'attention').length
  const queued = sessions.reduce((total, session) => total + Math.max(0, session.queueDepth ?? 0), 0)
  const parts = groupCount ? [`${groupCount} 组`] : []
  parts.push(`${sessions.length} 会话`)
  if (attention > 0) parts.push(`${attention} 需关注`)
  if (queued > 0) parts.push(`排队 ${queued}`)
  return parts.join(' · ')
}

/**
 * 上下文光环：环绕头像的一圈弧，弧长 = 上下文占用比例。SVG 圆用 pathLength=100
 * 归一化，dasharray 直接写百分比；空值（遥测未到）不画弧，只留轨道。
 */
export function contextRingDash(percent: number | undefined): string | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined
  const clamped = Math.min(100, Math.max(0, percent))
  // 极小的占用仍给一段可见弧，避免 0.3% 被圆头端点吞掉后看起来像「没有数据」。
  const visible = clamped > 0 && clamped < 1.5 ? 1.5 : clamped
  return `${Math.round(visible * 10) / 10} 100`
}

export function sessionRailContextPercent(session: Pick<AgentSession, 'contextUsage'>): number | undefined {
  return contextPercent(session.contextUsage)
}

/**
 * 名册卡片的常驻状态行：复刻 Cursor 会话列表的副标题（措辞、算法、常驻语义全部原版），
 * 色相类复用过程流的工具调色板。
 */
export interface SessionRailActivity {
  /** 工具色相类（is-read / is-command …），样式层复用过程流的 --tool-hue 调色板。 */
  kind: ProcessTurnStep['kind']
  /** 主文，Cursor 原文措辞：Thinking / Reading / 正文首行片段 / Completed / Planning next moves …。 */
  verb: string
  /** 工具对象（路径 / 模式 / 词）或问题标题；固定措辞与正文片段没有明细。 */
  detail?: string
  /** 回合存活：Cursor 同款转圈；否则静态字形。 */
  live: boolean
  /** 收口态（Completed / Stopped）：灰化，不占色相。 */
  muted: boolean
}

function isPendingQuestionBlock(block: ProcessBlock): boolean {
  return block.kind === 'tool' && block.question?.status === 'pending' && block.status !== 'failed'
}

/** Cursor 副标题 → 名册行：工具标签拆回「动词 + 对象」两段（label 本身就是 verb + ' ' + detail）。 */
function railActivityFromCursorLine(line: CursorStatusLine): SessionRailActivity {
  if (line.kind === 'thinking') return { kind: 'thinking', verb: CURSOR_STATUS_LINE_TEXT.thinking, live: true, muted: false }
  if (line.kind === 'text') return { kind: 'message', verb: line.label, live: true, muted: false }
  if (line.kind === 'todos') return { kind: 'todo', verb: line.label, live: true, muted: false }
  const detail = line.detail && line.label.endsWith(line.detail) ? line.detail : undefined
  const verb = detail ? line.label.slice(0, line.label.length - detail.length).trim() || line.label : line.label
  return { kind: line.toolKind ?? 'other', verb, ...(detail ? { detail } : {}), live: true, muted: false }
}

const planning = (): SessionRailActivity => ({ kind: 'other', verb: CURSOR_STATUS_LINE_TEXT.planning, live: true, muted: false })
const settled = (stopped: boolean): SessionRailActivity => ({
  kind: 'other', verb: stopped ? CURSOR_STATUS_LINE_TEXT.stopped : CURSOR_STATUS_LINE_TEXT.completed, live: false, muted: true
})

/**
 * 名册卡片的常驻状态行，永远返回一条（Cursor 的会话列表副标题从不为空）。规则按优先级只命中一条：
 *
 * 1. 离线 → "Stopped"（明确终止：Cursor 主进程终止 / 工具中止 / 运行时正面停止 / 回合 aborted）
 *    或 "Completed"（心跳消失但没有终止证据）；灰化、无转圈。
 * 2. 正在启动 → "Starting up"。
 * 3. 等待用户决策 → "Awaiting approval · 问题标题"（Cursor `Tu_` 对待决策组的措辞；ask_question 也走它）。
 *    运行时权威值 `awaitingUser` 优先，未知时回退过程块里的待答问卷；`false` 可撤销迟到过程帧里的旧 pending。
 * 4. 有 Cursor 侧事实（hook v32 / inspect 帧）：回合存活 → 副标题原文（Thinking / Reading foo.ts /
 *    正文首行 / n/m To-Dos Completed），一个都没扫到 → "Planning next moves"；回合结束 → Completed / Stopped。
 * 5. 没有事实（旧 hook 帧、观察器与 inspect 都缺席）：按过程块 / 直播正文用同一算法回退；
 *    回合明确结束 → Completed；一无所知但席位在岗 → "Planning next moves"（Cursor 对「生成中但
 *    无可展示动作」的原话）。
 */
export function sessionRailActivity(
  session: RailSessionFacts,
  liveProcess?: LiveProcessState,
  liveResponse?: LiveAgentResponseState,
  statusLine?: LiveStatusLineState
): SessionRailActivity {
  if (sessionRailGroupOf(session) === 'offline') {
    const stopped = session.status === 'stopped'
      || session.runtimeEvidence === 'stopped'
      || isExplicitlyStoppedPhase(session.connectionPhase ?? '')
      || statusLine?.composerStatus === 'aborted'
    return settled(stopped)
  }
  if (session.status === 'starting') return { kind: 'other', verb: CURSOR_STATUS_LINE_TEXT.starting, live: true, muted: false }

  const blocks = liveProcess?.blocks ?? []
  const pending = [...blocks].reverse().find(isPendingQuestionBlock)
  if (session.awaitingUser === true || (session.awaitingUser === undefined && pending)) {
    const title = pending?.kind === 'tool' ? pending.question?.title : undefined
    return { kind: 'question', verb: CURSOR_STATUS_LINE_TEXT.awaitingApproval, ...(title ? { detail: title } : {}), live: false, muted: false }
  }

  if (statusLine) {
    if (!statusLine.generating) return settled(statusLine.composerStatus === 'aborted')
    return statusLine.statusLine ? railActivityFromCursorLine(statusLine.statusLine) : planning()
  }

  const streaming = liveResponse?.status === 'streaming'
  if (liveProcess?.generating === true || streaming) {
    const line = cursorStatusLineFromBlocks(
      blocks,
      liveResponse ? { text: liveResponse.text, streaming } : undefined
    )
    return line ? railActivityFromCursorLine(line) : planning()
  }
  if (liveProcess?.generating === false) return settled(false)
  return planning()
}
