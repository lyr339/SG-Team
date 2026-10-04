import type { AppUpdateStatus } from './app-update'
import type { NotificationDraft } from './notification'

/** Only meaningful milestones; percent/tick/checking changes remain the original update page's responsibility. */
export function appUpdateNotification(status: AppUpdateStatus, live: boolean): Omit<NotificationDraft, 'sourceRevision'> | undefined {
  const state = status.state
  const common = { category: 'updates' as const, source: '软件更新', scope: {}, target: { kind: 'settings' as const, section: 'update' as const },
    origin: { module: 'account' as const, section: 'update' as const } }
  if (state.phase === 'available') return { ...common, key: `app-update:${state.release.version}`, eventId: `update:available:${state.release.version}`,
    title: `拾光 ${state.release.version} 可用`, detail: '新版本已就绪，可到软件更新查看。', tone: 'info', attention: 'notice', state: 'active',
    occurredAt: state.checkedAt, announce: live && status.reminderVersion === state.release.version }
  if (state.phase === 'downloaded') return { ...common, key: `app-update:${state.release.version}`, eventId: `update:downloaded:${state.release.version}:${state.downloadedAt}`,
    title: `拾光 ${state.release.version} 已下载好`, detail: '到软件更新选择安装，运行中的会话仍按原规则检查。', tone: 'success', attention: 'notice', state: 'active',
    occurredAt: state.downloadedAt, renewAttention: true, announce: live && status.reminderVersion === state.release.version }
  if (state.phase === 'failed') return { ...common, key: state.release ? `app-update:${state.release.version}` : `app-update-error:${state.step}`,
    eventId: `update:failed:${state.step}:${state.at}`, title: ({ check: '更新检查未完成', download: '更新下载未完成', install: '更新安装未完成', rollback: '回滚未完成' } as const)[state.step],
    detail: state.message, tone: 'warning', attention: 'notice', state: 'active', occurredAt: state.at, renewAttention: true, announce: live }
  return undefined
}

/** Startup receipts are independent from later available/download/failure milestones. */
export function appUpdateReceiptNotification(status: AppUpdateStatus): Omit<NotificationDraft, 'sourceRevision'> | undefined {
  const common = { category: 'updates' as const, source: '软件更新', scope: {}, target: { kind: 'settings' as const, section: 'update' as const }, origin: { module: 'account' as const, section: 'update' as const } }
  const result = status.applyResult
  if (result) {
    const failed = result.status === 'apply_failed' || result.status === 'rollback_failed'
    if (!failed && result.to !== status.currentVersion) return { ...common, key: `app-update-result:${result.status}:${result.from}:${result.to}`,
      eventId: `update:result:${result.status}:${result.from}:${result.to}`, title: '已读取历史更新结果',
      detail: `记录目标为拾光 ${result.to}，本次运行 ${status.currentVersion}；当前状态以软件更新页为准。`,
      tone: 'info', attention: 'activity', state: 'resolved', occurredAt: Date.now(), timeBasis: 'observed', announce: false }
    return { ...common, key: `app-update-result:${result.status}:${result.from}:${result.to}`, eventId: `update:result:${result.status}:${result.from}:${result.to}`,
      title: result.status === 'applied' ? `拾光已更新到 ${result.to}` : result.status === 'rolled_back' ? `拾光已回滚到 ${result.to}` : result.status === 'apply_failed' ? '上次更新安装未完成' : '上次回滚未完成',
      detail: failed ? '本次启动读取到上次操作未完成的结果，可到软件更新查看原诊断。' : '本次启动已确认版本结果，原更新入口仍可查看详情。',
      tone: failed ? 'warning' : 'success', attention: 'notice', state: 'resolved', occurredAt: Date.now(), timeBasis: 'observed', announce: false }
  }
  if (status.launchedAfterUpdate) return { ...common, key: `app-update-result:installed:${status.currentVersion}`, eventId: `update:installed:${status.currentVersion}`,
    title: `拾光已更新到 ${status.currentVersion}`, detail: '本次启动已确认版本。', tone: 'success', attention: 'notice', state: 'resolved', occurredAt: Date.now(), timeBasis: 'observed', announce: false }
  return undefined
}
