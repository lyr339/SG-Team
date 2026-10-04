import { ACCOUNT_AUTOMATION_STEPS, type AccountAutomationRun, type AccountAutomationStep, type AccountAutomationStepObservation } from './account-automation'

export const AUTOMATION_OBSERVATION_LABELS: Record<AccountAutomationStep, string> = {
  prepare: '准备', process: '服务处理', refresh: '备用凭据轮换', harden: '账号加固', localRecord: '本地记录移除', cleanup: '浏览器清场', handover: 'Cursor 接手'
}
export const AUTOMATION_OBSERVATION_STATUS: Record<AccountAutomationStepObservation['status'], string> = {
  not_started: '尚未执行', running: '进行中', succeeded: '已确认完成', failed: '未完成', unknown: '结果待确认', skipped: '未执行', cancelled: '已取消'
}
export interface AutomationObservedOutcome {
  kind: 'running' | 'completed' | 'partial' | 'pending' | 'failed' | 'cancelled' | 'legacy'
  title: string
  requiresAction: boolean
}

/** This is result presentation, not an executor or another workflow state machine. */
export function automationObservedOutcome(run: AccountAutomationRun): AutomationObservedOutcome {
  if (!['done', 'failed', 'cancelled'].includes(run.phase)) return { kind: 'running', title: '自动化进行中', requiresAction: false }
  if (run.phase === 'failed') return { kind: 'failed', title: run.failureStep ? `自动化中止，${AUTOMATION_OBSERVATION_LABELS[run.failureStep]}${run.observations?.[run.failureStep].status === 'unknown' ? '结果待确认' : '未完成'}` : '自动化已中止', requiresAction: true }
  if (run.phase === 'cancelled') {
    if (run.observations?.handover.status === 'failed' || run.observations?.handover.warning) return { kind: 'partial', title: '后续操作已取消，Cursor 接手需处理', requiresAction: true }
    if (run.observations?.handover.status === 'unknown' || run.observations?.handover.status === 'running') return { kind: 'pending', title: '后续操作已取消，Cursor 接手结果待确认', requiresAction: false }
    return { kind: 'cancelled', title: run.cancellationReason === 'replaced' ? '本轮自动化已被新操作取代'
      : run.observations?.process.status === 'succeeded' ? '后续操作已取消，处理结果保留' : '本轮自动化已取消', requiresAction: false }
  }
  if (!run.observations) return { kind: 'legacy', title: '自动化流程已结束，步骤结果待核对', requiresAction: false }
  const steps = ACCOUNT_AUTOMATION_STEPS.map(key => ({ key, ...run.observations![key] }))
  const pending = steps.find(value => value.status === 'unknown' || value.status === 'running')
  const failed = steps.find(value => value.status === 'failed')
  const warning = steps.find(value => value.warning)
  if (failed) return { kind: 'partial', title: `流程已收束，${AUTOMATION_OBSERVATION_LABELS[failed.key]}未完成`, requiresAction: true }
  if (pending) return { kind: 'pending', title: `流程已收束，${AUTOMATION_OBSERVATION_LABELS[pending.key]}结果待确认`, requiresAction: false }
  if (warning) return { kind: 'partial', title: '自动化已结束，存在附带警告', requiresAction: true }
  const necessary = run.postProcessingEnabled === false ? ['prepare', 'process'] as const : ACCOUNT_AUTOMATION_STEPS
  if (necessary.some(key => !['succeeded', 'skipped', 'cancelled'].includes(run.observations![key].status))) return { kind: 'pending', title: '流程已结束，部分步骤尚无完成证据', requiresAction: false }
  return { kind: 'completed', title: run.postProcessingEnabled === false ? '处理已完成，后续操作未执行' : '自动化已完成', requiresAction: false }
}

/** Stable on ticks and progress prose, distinct on real step outcomes or warnings. */
export function automationNotificationEventId(run: AccountAutomationRun): string | undefined {
  if (!run.operationId) return undefined
  const states = run.observations ? ACCOUNT_AUTOMATION_STEPS.map(key => `${run.observations![key].status}${run.observations![key].warning ? '!' : ''}`).join(',') : 'legacy'
  return `automation:${run.operationId}:${run.phase}:${states}`.slice(0, 300)
}
