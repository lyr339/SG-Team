import type { AccountAutomationRun } from './account-automation'
import { ACCOUNT_AUTOMATION_STEPS } from './account-automation'
import { AUTOMATION_OBSERVATION_LABELS, AUTOMATION_OBSERVATION_STATUS, automationObservedOutcome, automationNotificationEventId } from './automation-observation'
import { notificationSafeText, type NotificationDraft } from './notification'

export function automationNotification(run: AccountAutomationRun, live: boolean, now: number): NotificationDraft | undefined {
  if (!run.operationId || run.phase === 'idle' || !Number.isSafeInteger(run.revision) || (run.revision ?? 0) < 1) return undefined
  const outcome = automationObservedOutcome(run)
  const terminal = ['done', 'failed', 'cancelled'].includes(run.phase)
  const unconfirmed = terminal && run.observations && ACCOUNT_AUTOMATION_STEPS.some(key => ['running', 'unknown'].includes(run.observations![key].status))
  const details = run.observations ? ACCOUNT_AUTOMATION_STEPS.map(key => {
    const step = run.observations![key]
    return `${AUTOMATION_OBSERVATION_LABELS[key]}：${AUTOMATION_OBSERVATION_STATUS[step.status]}${step.detail ? ` · ${notificationSafeText(step.detail)}` : ''}${step.warning ? ` · 警告：${notificationSafeText(step.warning)}` : ''}`
  }).join('\n') : '没有分步骤确认记录，原链路结果保留。'
  const cancellation = run.phase === 'cancelled' ? '\n取消仅停止本轮尚未发出的后续操作，已经执行的结果不会撤销。' : ''
  return { key: `automation:${run.operationId}`, eventId: automationNotificationEventId(run), eventType: terminal ? unconfirmed ? 'automation.unconfirmed' : 'automation.finished' : 'automation.running',
    category: 'automation', source: '账号自动化', title: outcome.title, detail: `${details}${cancellation}${terminal ? '\n无需重复执行已确认完成的步骤；具体处理入口仍在原功能。' : ''}`.slice(0, 3_800),
    scope: { ...run.scope, ...(run.processedAccountId ? { accountId: run.processedAccountId } : {}), ...(run.processingProvider ? { providerId: run.processingProvider } : {}) },
    origin: { module: 'account', section: 'automation' }, target: { kind: 'settings', section: 'automation' },
    tone: outcome.kind === 'completed' ? 'success' : outcome.kind === 'failed' ? 'error' : outcome.kind === 'partial' || outcome.kind === 'pending' ? 'warning' : 'info',
    attention: !terminal ? 'activity' : outcome.requiresAction ? 'action' : 'notice', state: !terminal || outcome.kind === 'pending' || outcome.requiresAction ? 'active' : 'resolved',
    sourceRevision: run.revision!, occurredAt: run.finishedAt ?? run.startedAt ?? now,
    renewAttention: terminal, announce: live && terminal }
}
