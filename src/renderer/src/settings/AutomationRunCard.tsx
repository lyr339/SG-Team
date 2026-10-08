import { useRef, useState } from 'react'
import { FeedbackIcon } from '../feedback/FeedbackIcon'
import type {
  AccountAutomationPhase,
  AccountAutomationRun,
  AccountAutomationSettings
} from '../../../domain/account-automation'
import {
  AUTOMATION_STAGE_STATE_LABEL,
  automationRunView,
  type AutomationStageView
} from './automation-run-view'
import { isActiveAutomationPhase } from './settings-view'
import { automationNotificationEventId } from '../../../domain/automation-observation'
import { useNotificationResultRead } from '../notifications/use-notification-result-read'

interface AutomationRunCardProps {
  run: AccountAutomationRun
  settings?: AccountAutomationSettings
  onCancel?: () => void
}

const RING_RADIUS = 9.5
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/**
 * 阶段节点：等待 = 细描空环；进行中 = 实心信息蓝 + 呼吸光晕，倒计时期间光晕换成随剩余时间
 * 线性排空的进度环；完成 / 失败 / 取消 = 描边空心环 + 同色勾 / 叉 / 横。没有序号、没有旋转弧。
 */
function StageNode({ state, countdown }: Pick<AutomationStageView, 'state' | 'countdown'>): React.JSX.Element {
  const fraction = countdown && countdown.totalSec > 0
    ? Math.min(1, Math.max(0, countdown.remainingSec / countdown.totalSec))
    : 0
  return (
    <span className={`automation-run__node is-${state}${countdown ? ' has-countdown' : ''}`} aria-hidden="true">
      {state === 'done' ? (
        <FeedbackIcon tone="success" className="automation-run__completion" />
      ) : state === 'failed' ? (
        <svg viewBox="0 0 20 20"><path d="m6.2 6.2 7.6 7.6M13.8 6.2l-7.6 7.6" /></svg>
      ) : state === 'cancelled' ? (
        <svg viewBox="0 0 20 20"><path d="M5.5 10h9" /></svg>
      ) : state === 'unknown' || state === 'warning' ? (
        <svg viewBox="0 0 20 20"><path d="M10 5.5v5M10 14v.1" /></svg>
      ) : countdown ? (
        <svg viewBox="0 0 22 22" className="automation-run__ring">
          <circle cx="11" cy="11" r={RING_RADIUS} />
          <circle
            cx="11"
            cy="11"
            r={RING_RADIUS}
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - fraction)}
          />
        </svg>
      ) : null}
    </span>
  )
}

/**
 * 自动化运行卡：卡头（标题 + 状态徽标 + 取消 / 耗时）、横向四阶段轨道（节点 + 标题 + 一行说明）、
 * 无感切换分支行、完成摘要。只投影 AccountAutomationRun，不承载任何链路逻辑；空闲相位由父级决定不渲染。
 */
export function AutomationRunCard({ run, settings, onCancel }: AutomationRunCardProps): React.JSX.Element {
  const resultRef = useRef<HTMLElement>(null)
  useNotificationResultRead(resultRef, run.operationId ? `automation:${run.operationId}` : undefined, automationNotificationEventId(run))
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
    <section ref={resultRef} className={`automation-run is-${view.tone}`} aria-label="账号自动化运行状态" data-notification-result
      data-notification-key={run.operationId ? `automation:${run.operationId}` : undefined} data-notification-event={automationNotificationEventId(run)}>
      <header className="automation-run__head">
        <strong>自动处理账号</strong>
        <span className={`automation-run__badge is-${view.tone}`}>{view.statusLabel}</span>
        {view.cancellable && onCancel ? (
          <button type="button" className="secondary-button automation-run__cancel" onClick={onCancel}>取消</button>
        ) : view.durationText ? (
          <span className="automation-run__duration">耗时 {view.durationText}</span>
        ) : null}
      </header>

      <div className="automation-run__stages" role="list" aria-label="账号自动化流程">
        {view.stages.map((stage, index) => (
          <div
            key={stage.key}
            role="listitem"
            className={`automation-run__stage is-${stage.state}`}
            aria-current={stage.state === 'running' ? 'step' : undefined}
            aria-label={`第 ${index + 1} 步：${stage.title}，${AUTOMATION_STAGE_STATE_LABEL[stage.state]}`}
          >
            <StageNode state={stage.state} countdown={stage.countdown} />
            <span className="automation-run__stage-title">{stage.title}</span>
            <span
              className={`automation-run__stage-detail${stage.countdown ? ' is-countdown' : ''}`}
              title={run.observations && stage.detail.length > 64 ? stage.detail : undefined}
              role={stage.state === 'failed' ? 'alert' : undefined}
              aria-live={stage.state === 'running' ? 'polite' : undefined}
            >{stage.detail}</span>
          </div>
        ))}
        {view.handover ? (
          <div
            className={`automation-run__handover is-${view.handover.status}`}
            title={view.handover.rawMessage || undefined}
          >
            <span>接手账号</span>
            <strong>{view.handover.label}</strong>
            <em>{view.handover.detail}</em>
          </div>
        ) : null}
      </div>

      {view.summary ? <p className="automation-run__summary">{view.summary}</p> : null}
    </section>
  )
}
