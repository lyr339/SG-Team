import type { AgentSession } from '../../domain/agent-session'
import { isAgentOnDuty, isExplicitlyStoppedPhase, isProcessingPhase } from '../../domain/channel-message'
import type { ProcessBlock } from '../../domain/conversation-entry'
import { CURSOR_STATUS_LINE_TEXT, cursorStatusLineFromBlocks, type CursorStatusLine } from '../../domain/cursor-status-line'
import type { LiveAgentResponseState, LiveProcessState, LiveStatusLineState } from '../../shared/desktop-api'
import { contextPercent, statusLabel } from './format'
import type { ProcessTurnStep } from './process-turn-view'

/**
 * 会话侧栏（名册）的视图折叠：分组、状态色调、标题拆分与头部摘要都在这里决定，
 * 行组件与侧栏只负责摆放。分组即色调——同一个函数同时决定「排在哪一组」与
 * 「状态点是什么颜色」，两者永远一致。
 */
export type SessionRailGroupId = 'active' | 'attention' | 'waiting' | 'offline'

export const SESSION_RAIL_GROUPS: ReadonlyArray<{ id: SessionRailGroupId; label: string; detail: string }> = [
  { id: 'active', label: '执行中', detail: '正在启动、恢复或处理任务' },
  { id: 'attention', label: '需关注', detail: '等待拍板、验收或重新进入待命' },
  { id: 'waiting', label: '待命', detail: '已在线并持续等待新消息' },
  { id: 'offline', label: '离线', detail: '当前没有可信的 Cursor 运行时活性' }
]

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

/** 行内状态词：离线统一说「已离线」，其余沿用全应用的状态文案。 */
export function sessionRailStateLabel(session: RailSessionFacts): string {
  if (sessionRailGroupOf(session) === 'offline') return '已离线'
  return session.awaitingUser ? '等待回答' : statusLabel(session.status)
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

/** 头部摘要：各状态组的数量 + 排队总数，代替旧版的三段筛选器。 */
export function sessionRailSummary(sessions: ReadonlyArray<RailSessionFacts & Pick<AgentSession, 'queueDepth'>>): string {
  if (!sessions.length) return ''
  const counts = new Map<SessionRailGroupId, number>()
  let queued = 0
  for (const session of sessions) {
    const group = sessionRailGroupOf(session)
    counts.set(group, (counts.get(group) ?? 0) + 1)
    queued += Math.max(0, session.queueDepth ?? 0)
  }
  const parts = SESSION_RAIL_GROUPS
    .filter((group) => (counts.get(group.id) ?? 0) > 0)
    .map((group) => `${counts.get(group.id)} ${group.label}`)
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
