import type { AccountAutomationService } from '../account-automation-service'
import type { NotificationService } from '../notification-service'
import type { NotificationRecord } from '../../domain/notification'
import { notificationContentSignature } from '../../domain/notification'
import { automationNotification } from '../../domain/automation-notification'
import { automationObservedOutcome } from '../../domain/automation-observation'
import { ACCOUNT_AUTOMATION_STEPS } from '../../domain/account-automation'

export function connectAutomationNotifications(automation: Pick<AccountAutomationService, 'getRun' | 'subscribe'>, notifications: NotificationService, now: () => number = Date.now): () => void {
  const previous = new Map<string, { revision: number; signature: string; terminal: boolean; outcome: string; issues: string }>()
  let stopped = false
  const publish = (run: ReturnType<AccountAutomationService['getRun']>, live: boolean): void => {
    const draft = automationNotification(run, live, now())
    if (!draft) return
    const old = previous.get(draft.key)
    if (old && draft.sourceRevision <= old.revision) return
    const signature = notificationContentSignature(draft)
    const terminal = ['done', 'failed', 'cancelled'].includes(run.phase)
    const outcome = automationObservedOutcome(run).kind
    const issues = run.observations ? JSON.stringify(ACCOUNT_AUTOMATION_STEPS.map(key => {
      const step = run.observations![key]
      return [key, step.status === 'failed' || step.status === 'unknown' ? step.status : null, step.warning ?? null]
    })) : ''
    const significant = terminal && (!old || !old.terminal || old.outcome !== outcome)
    const renew = significant || terminal && old?.issues !== issues
    previous.set(draft.key, { revision: draft.sourceRevision, signature, terminal, outcome, issues })
    if (previous.size > 32) previous.delete(previous.keys().next().value!)
    if (old?.signature !== signature) notifications.offer({ ...draft, renewAttention: renew, announce: live && significant })
  }
  const stop = automation.subscribe(run => publish(run, true))
  publish(automation.getRun(), false)
  // A previous process's active attempt cannot be silently called successful or automatically resumed.
  void (async () => {
    let cursor: { revision: number; offset: number } | undefined; let resets = 0
    const records = new Map<string, NotificationRecord>()
    do {
      const page = await notifications.page({ category: 'automation', limit: 100, ...(cursor ? { cursor } : {}) })
      if (stopped) return
      if (page.reset) { records.clear(); if (++resets > 1) return }
      for (const record of page.records) records.set(record.id, record)
      cursor = page.nextCursor
    } while (cursor)
    const current = automation.getRun().operationId
    for (const record of records.values()) {
      if (!['automation.running', 'automation.unconfirmed'].includes(record.eventType ?? '') || record.key === `automation:${current}` || previous.has(record.key)) continue
      const branch = record.eventType === 'automation.unconfirmed'
      notifications.offerCurrent({ ...record, eventType: 'automation.interrupted', eventId: `${record.key}:interrupted`, title: branch ? '上次自动化有未确认的步骤结果' : '上次自动化结果待核对',
        detail: ((branch ? '上次流程已收束，但部分支线没有可恢复的最终回执；已确认结果保留。' : '上次运行只保存了未结束的观察。')
          + ' 本次不会自动重跑，也不会将未知步骤当作成功。\n' + (record.detail ?? '')).slice(0, 3_800),
        tone: 'warning', attention: 'notice', state: 'active', announce: false, renewAttention: true })
    }
  })().catch(() => {})
  return () => { stopped = true; stop() }
}
