import type { NotificationTarget } from '../../../domain/notification'

export function notificationTargetLabel(target?: NotificationTarget, subjectState?: string): string {
  if(target?.kind==='memory')return'查看原记忆'
  if (target?.kind === 'session') return target.surface === 'context' ? '查看上下文' : subjectState === 'legacy-comparison' && target.mcpWrite ? '对照工具结果'
    : subjectState === 'call-error-unattributed' && target.blockId ? '查看原工具' : subjectState?.startsWith('original-') && target.toolCallId ? '核对原问卷'
      : subjectState === 'legacy-comparison' && target.replyBody ? '对照当前回复' : target.replyBody ? '查看回复' : '打开会话'
  if (target?.kind === 'run') return '查看运行'
  if (target?.kind === 'collaboration') return '查看协作记录'
  if (target?.kind === 'settings') return ({ update: '查看更新', automation: '查看自动化', cleanup: '查看清理', accounts: '查看账号', import: '查看导入', aozai: '查看处理服务', maintenance: '查看维护', stats: '查看统计' } as const)[target.section]
  return '查看通知'
}
