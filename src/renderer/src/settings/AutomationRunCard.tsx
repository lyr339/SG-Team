import { useState } from 'react'
import type {
  AccountAutomationPhase,
  AccountAutomationRun,
  AccountAutomationSettings
} from '../../../domain/account-automation'
import { FlowStatusIcon, type FlowStatusVisualState } from '../lobby/FlowStatusIcon'
import {
  AUTOMATION_STAGE_STATE_LABEL,
  automationRunView,
  countdownSeconds,
  type AutomationStageState,
  type AutomationStageView
} from './automation-run-view'
import { isActiveAutomationPhase } from './settings-view'

interface AutomationRunCardProps {
  run: AccountAutomationRun
  settings?: AccountAutomationSettings
  onCancel?: () => void
}

/** 阶段状态 → 共用流程节点的视觉态；未执行步骤沿用运行页的 off 态（灰底序号）。 */
const NODE_STATE: Record<AutomationStageState, FlowStatusVisualState> = {
  waiting: 'waiting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'off'
}

const RING_RADIUS = 7
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/** 倒计时进度环 + 整秒读数：环随剩余时间线性排空，读数每秒变化一次。 */
function CountdownChip({ remainingSec, totalSec }: NonNullable<AutomationStageView['countdown']>): React.JSX.Element {
  const seconds = countdownSeconds(remainingSec) ?? 0
  const fraction = totalSec > 0 ? Math.min(1, Math.max(0, remainingSec / totalSec)) : 0
  return (
    <span className="automation-run__countdown" aria-live="polite" aria-label={`倒计时 ${seconds} 秒`}>
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={RING_RADIUS} />
        <circle
          cx="9"
          cy="9"
          r={RING_RADIUS}
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - fraction)}
        />
      </svg>
      <b>{seconds}</b>
      <span>秒</span>
    </span>
  )
}

/**
 * 自动化运行卡：卡头（标题 + 状态徽标 + 取消 / 耗时）、四阶段纵向时间线、完成摘要。
 * 只投影 AccountAutomationRun，不承载任何链路逻辑；空闲相位由父级决定不渲染。
 */
export function AutomationRunCard({ run, settings, onCancel }: AutomationRunCardProps): React.JSX.Element {
  // 失败 / 取消归属：记住本轮最后一个活跃相位（render 期派生状态，React 官方模式）；
  // 挂载时已是终态（持久化恢复）则没有轨迹，视图模型退化为按消息推断。
  const [lastActivePhase, setLastActivePhase] = useState<AccountAutomationPhase | null>(null)
  if (isActiveAutomationPhase(run.phase) && run.phase !== lastActivePhase) setLastActivePhase(run.phase)

  const view = automationRunView({
    run,
    lastActivePhase,
    countdownTotalSec: {
      beforeProcess: settings?.delaySec ?? 0,
      beforeHardening: settings?.postProcessDelaySec ?? 0
    }
  })

  return (
    <section className={`automation-run is-${view.tone}`} aria-label="账号自动化运行状态">
      <header className="automation-run__head">
        <strong>自动处理账号</strong>
        <span className={`automation-run__badge is-${view.tone}`}>{view.statusLabel}</span>
        {view.cancellable && onCancel ? (
          <button type="button" className="secondary-button automation-run__cancel" onClick={onCancel}>取消</button>
        ) : view.durationText ? (
          <span className="automation-run__duration">耗时 {view.durationText}</span>
        ) : null}
      </header>

      <ol className="automation-run__stages" aria-label="账号自动化流程">
        {view.stages.map((stage, index) => (
          <li
            key={stage.key}
            className={`automation-run__stage is-${stage.state}`}
            aria-current={stage.state === 'running' ? 'step' : undefined}
            aria-label={`第 ${index + 1} 步：${stage.title}，${AUTOMATION_STAGE_STATE_LABEL[stage.state]}`}
          >
            <FlowStatusIcon state={NODE_STATE[stage.state]} index={index + 1} />
            <span className="automation-run__stage-title">{stage.title}</span>
            {stage.countdown ? <CountdownChip {...stage.countdown} /> : null}
            <span
              className="automation-run__stage-detail"
              role={stage.state === 'failed' ? 'alert' : undefined}
              aria-live={stage.state === 'running' && !stage.countdown ? 'polite' : undefined}
            >{stage.detail}</span>
            {stage.key === 'process' && view.handover ? (
              <span
                className={`automation-run__handover is-${view.handover.status}`}
                title={view.handover.rawMessage || undefined}
              >
                <span>接手账号</span>
                <strong>{view.handover.label}</strong>
                <em>{view.handover.detail}</em>
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {view.summary ? <p className="automation-run__summary">{view.summary}</p> : null}
    </section>
  )
}
