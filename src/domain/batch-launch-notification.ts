import type { AgentLaunchPlan } from './agent-launch'
import type { NotificationDraft, NotificationScope } from './notification'
import { notificationSafeText } from './notification'

export function batchLaunchNotification(plan: AgentLaunchPlan, scope: NotificationScope, live: boolean, now: number): Omit<NotificationDraft, 'sourceRevision'> {
  const total = plan.items.length
  const ready = plan.items.filter(item => item.stage === 'done').length
  const failed = plan.items.filter(item => item.stage === 'failed').length
  const existing = plan.items.filter(item => item.creation === 'existing').length
  const submitted = plan.items.filter(item => item.submitted === true).length
  const finished = plan.state !== 'running'
  const allReused = total > 0 && existing === total && ready === total
  const unknownResult = finished && (!total || plan.state === 'failed' && failed === 0)
  const title = unknownResult ? '会话发起结果待核对' : !finished ? `正在接入 ${total} 个会话` : allReused ? `${total} 个已有会话保持可用`
    : failed > 0 ? ready > 0 ? `${ready} 个会话已接入，${failed} 个未就绪` : '会话发起未完成' : `${ready} 个会话已接入`
  const phases = { trigger: '尚未确认提交', composer: '已提交，等待绑定', waiting: '已绑定，等待协议接入', done: '已在岗', failed: '未就绪' } as const
  const details = plan.items.map(item => `CH-${item.channelId}：${item.creation === 'existing' ? '复用已有在岗会话' : phases[item.stage]}${item.stage === 'failed' ? ` · ${notificationSafeText(item.message).slice(0, 160)}` : ''}`).join('\n')
  const header = unknownResult ? '来源未给出可核验的完整成员结果；不会将其当作全部成功。' : allReused ? '沿用已有会话，没有新增创建或触发账号自动化。' : `新创建并确认提交 ${submitted} 个，复用已有 ${existing} 个；协议在岗 ${ready} 个。`
  return {
    key: `launch:${plan.id}`, eventId: `launch:${plan.id}:${plan.state}${finished ? `:${plan.finishedAt ?? plan.startedAt}` : ''}`,
    category: 'run', source: '批量发起', scope, ...(scope.runId ? { target: { kind: 'run', runId: scope.runId } as const } : {}),
    origin: { module: 'run' }, title, detail: `${header}\n${details}${finished && failed && submitted > 0 ? '\n有会话已经提交，重复创建前请先查看对应失败阶段。' : ''}`.slice(0, 3_800),
    tone: failed || unknownResult ? 'warning' : finished ? 'success' : 'info', attention: finished && !allReused ? 'notice' : 'activity', state: !finished || failed || unknownResult ? 'active' : 'resolved',
    occurredAt: finished ? plan.finishedAt ?? now : plan.startedAt, ...(finished && plan.finishedAt === undefined ? { timeBasis: 'observed' as const } : {}),
    renewAttention: finished && !allReused, announce: live && finished && !allReused
  }
}
