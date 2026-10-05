import { groupEffectsProblem, groupEffectsLines } from './group-effects'
import { notificationSafeText, type NotificationDraft } from './notification'
import type { MembershipTransferOutcome } from './team-handoff'
import type { TeamControlSnapshot } from './team-control'

export function membershipTransferNotification(outcome: MembershipTransferOutcome, team: TeamControlSnapshot): Omit<NotificationDraft, 'sourceRevision'> {
  const transfer = outcome.transfer, key = `membership-transfer:${transfer.failover.id}`
  const effects = transfer.groupEffects, effectProblem = Boolean(effects && groupEffectsProblem(effects))
  const partial = outcome.contextHandoff?.ok === false || effectProblem
  const context = outcome.contextHandoff
  return { key, eventId: `${key}:${effectProblem ? 'effects-unconfirmed' : partial ? 'context-failed' : context ? 'context-accepted' : 'identity-complete'}`, eventType: 'membership.transfer', category: 'team', source: '成员身份迁移',
    title: effectProblem ? '身份已迁移，部分后续事项待核对' : partial ? '身份已迁移，上下文交接未完成' : context ? '身份已迁移，附带交接已受理' : '成员身份迁移已完成',
    detail: `目标接过角色 ${notificationSafeText(transfer.roleName)}，${effects?.effects.some(effect=>effect.kind==='release'&&effect.status!=='confirmed')?'任务释放结果尚未确认':`释放 ${transfer.releasedTaskIds.length} 个任务`}${transfer.transferredLead ? '，主控身份随迁' : ''}。`
      + (context?.ok === false ? `\n上下文交接异常：${notificationSafeText(context.error).slice(0, 800)}。身份迁移已完成，不会自动回滚或重复迁移。`
        : context ? '\n交接受理不等于已取走或已读完。原传输没有可关联的完整队列观察，后续请以目标回复确认。' : '') + (effectProblem&&effects?`\n${groupEffectsLines(effects).join('\n')}`:''),
    scope: { runId: transfer.failover.runId, groupId: transfer.groupId, workspaceId: transfer.failover.workspaceId ?? team.runs.find(run => run.id === transfer.failover.runId)?.workspaceId,...(effects?{groupOperationId:effects.id}:{}) },
    target: { kind: 'run', runId: transfer.failover.runId, groupId: transfer.groupId }, origin: { module: 'run' },
    tone: partial ? 'warning' : 'info', attention: 'notice', state: effectProblem?'active':'resolved', occurredAt: transfer.failover.completedAt ?? transfer.failover.updatedAt,
    announce: false, renewAttention: true }
}
