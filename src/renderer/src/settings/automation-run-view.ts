/**
 * 自动化运行卡的视图模型：把 AccountAutomationRun 投影成「卡头 + 四阶段时间线 + 结束摘要」。
 * 纯函数、零副作用；只做投影，不改运行相位、不改服务端消息。
 *
 * 四阶段是真实的工作阶段：准备（前置检查 + 处理前倒计时）→ 服务处理 → 加固账号（加固前倒计时 +
 * 会话刷新 + 删除）→ 收尾（清场）。倒计时不是独立步骤，而是当前步骤上的一个进度环。
 */
import type { AccountAutomationPhase, AccountAutomationRun } from '../../../domain/account-automation'
import { automationDurationText, isActiveAutomationPhase, type ActiveAutomationPhase } from './settings-view'

export type AutomationStageKey = 'prepare' | 'process' | 'harden' | 'finish'
export type AutomationStageState = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'
export type AutomationRunTone = 'running' | 'done' | 'failed' | 'cancelled'

export interface AutomationStageView {
  key: AutomationStageKey
  title: string
  /** 一句话状态：进行中为实时消息或倒计时，完成为结果定语，未开始为该步说明。 */
  detail: string
  state: AutomationStageState
  /** 倒计时（仅 countdown / hardening-countdown 相位且尚在计时的当前步）。 */
  countdown?: { remainingSec: number; totalSec: number }
}

export interface AutomationHandoverView {
  label: string
  status: 'preparing' | 'switching' | 'done' | 'failed'
  /** 用户语句：准备中 / 等待 Cursor 确认 / 已切换 · 耗时 / 切换失败：原因；切换前等待期间给出秒数。 */
  detail: string
  /** 服务端原始子状态消息，供悬停排障。 */
  rawMessage: string
}

export interface AutomationRunView {
  tone: AutomationRunTone
  /** 进行中 / 已完成 / 未完成 / 已取消 */
  statusLabel: string
  /** 仅在倒计时仍在走时可取消——倒计时结束后的复核与已发出的请求都不可中止。 */
  cancellable: boolean
  stages: readonly AutomationStageView[]
  /** 仅有始有终的运行给出。 */
  durationText: string
  /** 完成态的服务端总结；失败 / 取消的原因已落在对应步骤上，不再重复。 */
  summary?: string
  handover?: AutomationHandoverView
}

const AUTOMATION_STAGE_ORDER: readonly AutomationStageKey[] = ['prepare', 'process', 'harden', 'finish']

const STAGE_COPY: Record<AutomationStageKey, { title: string; waiting: string; done: string }> = {
  prepare: { title: '准备', waiting: '检查卡密、活跃账号与浏览器会话', done: '检查通过' },
  process: { title: '服务处理', waiting: '提交当前账号的 Token 自助处理', done: '处理已完成' },
  // 「加固」是删除官网账号的界面趣称；协议语义（deleting / importing）保持原表述。
  harden: { title: '加固账号', waiting: '处理完成后秒级加固（不可撤销）', done: '账号已加固' },
  finish: { title: '收尾', waiting: '移除本地记录并清理浏览器环境', done: '已完成' }
}

export const AUTOMATION_STAGE_STATE_LABEL: Record<AutomationStageState, string> = {
  waiting: '等待',
  running: '进行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '未执行'
}

/** 活跃相位 → 正在进行的阶段；importing 是加固链路里的会话刷新子阶段。 */
const RUNNING_STAGE: Record<ActiveAutomationPhase, AutomationStageKey> = {
  countdown: 'prepare',
  processing: 'process',
  'hardening-countdown': 'harden',
  importing: 'harden',
  deleting: 'harden',
  cleaning: 'finish'
}

const TONE_LABEL: Record<AutomationRunTone, string> = {
  running: '进行中',
  done: '已完成',
  failed: '未完成',
  cancelled: '已取消'
}

const HANDOVER_LABEL: Record<AutomationHandoverView['status'], string> = {
  preparing: '准备中',
  switching: '等待 Cursor 确认',
  done: '已切换',
  failed: '切换失败'
}

/** 倒计时显示整秒：0.5s 步进的剩余值向上取整，等待期间永不显示 0。 */
export function countdownSeconds(remainingSec: number | undefined): number | undefined {
  if (typeof remainingSec !== 'number' || !Number.isFinite(remainingSec)) return undefined
  return Math.max(0, Math.ceil(remainingSec))
}

/**
 * 持久化 / 直出的终态运行没有活跃相位轨迹时，按服务消息文案推断失败或取消发生在哪一步。
 * 只影响步骤归属的展示，完整消息始终原样呈现。
 */
export function automationTerminalStageHint(message: string): AutomationStageKey {
  if (/取消后续账号加固|加固前/.test(message)) return 'harden'
  if (/处理失败/.test(message)) return 'process'
  // 加固链路的失败必含新凭据或删除语义；裸「会话」会误吞 preflight 失败（如浏览器会话读取失败），不用。
  if (/新 Token|删除|官网|入库/.test(message)) return 'harden'
  return 'prepare'
}

function toneOf(phase: AccountAutomationPhase): AutomationRunTone {
  if (phase === 'done') return 'done'
  if (phase === 'failed') return 'failed'
  if (phase === 'cancelled') return 'cancelled'
  return 'running'
}

function stageView(
  key: AutomationStageKey,
  state: AutomationStageState,
  detail?: string,
  countdown?: AutomationStageView['countdown']
): AutomationStageView {
  const copy = STAGE_COPY[key]
  const fallback = state === 'done' ? copy.done : state === 'skipped' ? '未执行' : copy.waiting
  return { key, title: copy.title, state, detail: detail || fallback, ...(countdown ? { countdown } : {}) }
}

/** 以某一步为界铺开四个阶段：之前完成、该步取给定状态、之后统一为 after。 */
function stagesAround(input: {
  at: AutomationStageKey
  state: AutomationStageState
  detail?: string
  after: AutomationStageState
  countdown?: AutomationStageView['countdown']
}): AutomationStageView[] {
  const index = AUTOMATION_STAGE_ORDER.indexOf(input.at)
  return AUTOMATION_STAGE_ORDER.map((key, position) => {
    if (position < index) return stageView(key, 'done')
    if (position === index) return stageView(key, input.state, input.detail, input.countdown)
    return stageView(key, input.after)
  })
}

function handoverView(run: AccountAutomationRun): AutomationHandoverView | undefined {
  const handover = run.handover
  if (!handover) return undefined
  let detail = HANDOVER_LABEL[handover.status]
  if (handover.status === 'done' && handover.finishedAt) {
    detail = `${detail} · ${(Math.max(0, handover.finishedAt - handover.startedAt) / 1_000).toFixed(1)} 秒`
  } else if (handover.status === 'failed' && handover.message) {
    detail = `${detail}：${handover.message}`
  } else if (handover.status === 'preparing') {
    // 「切换前等待」期间服务端消息形如「票据已就绪，4.5s 后切换」——只把秒数提上屏，其余术语留在悬停。
    const waiting = /(\d+(?:\.\d+)?)s 后切换/.exec(handover.message)
    if (waiting) detail = `${countdownSeconds(Number(waiting[1]))} 秒后切换`
  }
  return { label: handover.label, status: handover.status, detail, rawMessage: handover.message }
}

/** 活跃相位的当前步文案与倒计时：倒计时相位给整秒语句 + 进度环，其余直出服务端实时消息。 */
function runningStage(
  phase: ActiveAutomationPhase,
  run: AccountAutomationRun,
  totals: { beforeProcess: number; beforeHardening: number }
): Pick<AutomationStageView, 'detail' | 'countdown'> & { cancellable: boolean } {
  const remaining = countdownSeconds(run.remainingSec)
  if (phase === 'countdown') {
    // 倒计时归零后服务端会复核浏览器会话再进入处理；这一小段 remainingSec 已清空、消息仍是最后一个 tick。
    if (remaining === undefined) return { detail: '倒计时结束，正在复核会话', cancellable: false }
    return {
      detail: `${remaining} 秒后开始处理当前账号`,
      countdown: { remainingSec: run.remainingSec!, totalSec: totals.beforeProcess },
      cancellable: true
    }
  }
  if (phase === 'hardening-countdown') {
    if (remaining === undefined) return { detail: '倒计时结束，即将加固', cancellable: false }
    return {
      detail: `${remaining} 秒后加固账号`,
      countdown: { remainingSec: run.remainingSec!, totalSec: totals.beforeHardening },
      cancellable: true
    }
  }
  return { detail: run.message, cancellable: false }
}

export function automationRunView(input: {
  run: AccountAutomationRun
  /** 本轮最后一次观察到的活跃相位（组件在 render 期记录）；无轨迹时按消息推断。 */
  lastActivePhase: AccountAutomationPhase | null
  /** 两段倒计时的总时长，来自当前设置；用于进度环。 */
  countdownTotalSec: { beforeProcess: number; beforeHardening: number }
}): AutomationRunView {
  const { run, lastActivePhase, countdownTotalSec } = input
  const tone = toneOf(run.phase)
  const base = {
    tone,
    statusLabel: TONE_LABEL[tone],
    cancellable: false,
    durationText: automationDurationText(run),
    handover: handoverView(run)
  }

  if (run.phase === 'done') {
    return { ...base, stages: AUTOMATION_STAGE_ORDER.map((key) => stageView(key, 'done')), summary: run.message }
  }

  if (run.phase === 'failed' || run.phase === 'cancelled') {
    const tracked = lastActivePhase && isActiveAutomationPhase(lastActivePhase) ? RUNNING_STAGE[lastActivePhase] : undefined
    return {
      ...base,
      stages: stagesAround({
        at: tracked ?? automationTerminalStageHint(run.message),
        state: run.phase,
        detail: run.message,
        after: 'skipped'
      })
    }
  }

  if (!isActiveAutomationPhase(run.phase)) {
    return { ...base, stages: AUTOMATION_STAGE_ORDER.map((key) => stageView(key, 'waiting')) }
  }

  const current = runningStage(run.phase, run, countdownTotalSec)
  return {
    ...base,
    cancellable: current.cancellable,
    stages: stagesAround({
      at: RUNNING_STAGE[run.phase],
      state: 'running',
      detail: current.detail,
      countdown: current.countdown,
      after: 'waiting'
    })
  }
}
