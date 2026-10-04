import { describe, expect, it } from 'vitest'
import { ACCOUNT_AUTOMATION_STEPS, type AccountAutomationRun } from '../src/domain/account-automation'
import { automationObservedOutcome, automationNotificationEventId } from '../src/domain/automation-observation'
import { automationNotification } from '../src/domain/automation-notification'
import { automationRunView } from '../src/renderer/src/settings/automation-run-view'

const run = (patch: Partial<AccountAutomationRun> = {}): AccountAutomationRun => ({ operationId: 'operation-1', revision: 5, scope: { workspaceId: 'workspace-a', runId: 'run-a' },
  phase: 'done', message: 'old completion prose', startedAt: 100, finishedAt: 200, processingProvider: 'aozai',
  observations: Object.fromEntries(ACCOUNT_AUTOMATION_STEPS.map(key => [key, { status: key === 'handover' || key === 'refresh' ? 'skipped' : 'succeeded' }])) as NonNullable<AccountAutomationRun['observations']>, ...patch })
describe('structured automation notification outcomes', () => {
  it('does not equate done with all-green success when cleanup or handover is still uncertain', () => {
    const value = run(); value.observations!.cleanup = { status: 'unknown', detail: 'backend still pending' }
    expect(automationObservedOutcome(value)).toMatchObject({ kind: 'pending', requiresAction: false })
    expect(automationNotification(value, true, 300)).toMatchObject({ tone: 'warning', state: 'active', eventType: 'automation.unconfirmed' })
    const view = automationRunView({ run: value, lastActivePhase: null, countdownTotalSec: { beforeProcess: 5, beforeHardening: 5 } })
    expect(view.tone).toBe('warning'); expect(view.stages.find(stage => stage.key === 'finish')?.state).toBe('unknown')
    expect(view.summary).not.toBe(value.message)
  })
  it('shows confirmed success and explicit processing-only exclusions without pretending later effects ran', () => {
    expect(automationObservedOutcome(run())).toMatchObject({ kind: 'completed' })
    const value = run({ postProcessingEnabled: false }); for (const step of ['refresh', 'harden', 'localRecord', 'cleanup', 'handover'] as const) value.observations![step] = { status: 'skipped' }
    expect(automationNotification(value, true, 300)?.title).toBe('处理已完成，后续操作未执行')
    expect(automationNotification(value, true, 300)?.detail).toContain('账号加固：未执行')
  })
  it('post-process cancellation preserves actual effects and does not hide failed/in-flight handover', () => {
    const value = run({ phase: 'cancelled', cancelledStep: 'harden' }); value.observations!.harden = { status: 'cancelled' }; value.observations!.handover = { status: 'running' }
    expect(automationObservedOutcome(value)).toMatchObject({ kind: 'pending', title: '后续操作已取消，Cursor 接手结果待确认' })
    value.observations!.handover = { status: 'failed', detail: 'no confirmation' }
    expect(automationObservedOutcome(value)).toMatchObject({ kind: 'partial', requiresAction: true })
    expect(automationNotification(value, true, 300)?.detail).toContain('已经执行的结果不会撤销')
  })
  it('semantic identity is unaffected by countdown ticks or source revision, while real late outcomes differ', () => {
    const value = run({ phase: 'cleaning' })
    expect(automationNotificationEventId(value)).toBe(automationNotificationEventId({ ...value, revision: 90, remainingSec: 2, message: 'another tick' }))
    const newer = run(); newer.observations!.handover = { status: 'failed' }
    expect(automationNotificationEventId(value)).not.toBe(automationNotificationEventId(newer))
  })
  it('new notification details are redacted and never use raw success prose as outcome proof', () => {
    const value = run(); value.observations!.cleanup = { status: 'failed', detail: 'Bearer synthetic-secret; password=fake-password' }
    const draft = automationNotification(value, false, 300)!
    expect(draft.detail).not.toContain('synthetic-secret'); expect(draft.detail).not.toContain('fake-password')
    expect(draft.attention).toBe('action'); expect(draft.announce).toBe(false)
  })
})
