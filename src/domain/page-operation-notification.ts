import { notificationSafeText, type NotificationCategory, type NotificationDraft, type NotificationScope, type NotificationSettingsSection } from './notification'

export const PAGE_NOTIFICATION_OPERATIONS = ['import-token', 'import-card', 'import-local', 'import-browser', 'import-fingerprint', 'account-login', 'login-window', 'checkout',
  'fingerprint-cleanup', 'model-policy', 'patch-install', 'patch-remove', 'question-answer', 'question-skip', 'image-save', 'debug-enable','memory-accept','memory-reject'] as const
export type PageNotificationOperation = typeof PAGE_NOTIFICATION_OPERATIONS[number]
export interface PageOperationDefinition { kind: PageNotificationOperation; id: string; scope?: NotificationScope; target?: NotificationDraft['target']; origin?: NotificationDraft['origin']; localOnly?: boolean; familyId?: string }
export interface PageOperationOutcome {
  state: 'success' | 'partial' | 'waiting' | 'unconfirmed' | 'failed' | 'cancelled'
  /** Call sites explicitly supply result facts, not a business object for the observer to reinterpret. */
  facts?: string[]
  scope?: NotificationScope
  unchanged?: boolean
  verifiedOnly?: boolean
}
const specs: Record<PageNotificationOperation, { source: string; title: string; category: NotificationCategory; section?: NotificationSettingsSection; quietSuccess?: boolean }> = {
  'memory-accept':{source:'共享记忆审核',title:'采纳原记忆',category:'team',quietSuccess:true},
  'memory-reject':{source:'共享记忆审核',title:'驳回原记忆',category:'team',quietSuccess:true},
  'import-token': { source: '账号导入', title: '保存账号', category: 'accounts', section: 'import', quietSuccess: true },
  'import-card': { source: '账号导入', title: '导入账号卡', category: 'accounts', section: 'import' },
  'import-local': { source: '账号导入', title: '导入本机账号', category: 'accounts', section: 'import', quietSuccess: true },
  'import-browser': { source: '账号导入', title: '导入浏览器账号', category: 'accounts', section: 'import' },
  'import-fingerprint': { source: '账号导入', title: '导入指纹浏览器账号', category: 'accounts', section: 'import' },
  'account-login': { source: '账号登录', title: '重新登录已保存账号', category: 'accounts', section: 'accounts' },
  'login-window': { source: '账号登录', title: '打开登录窗口', category: 'accounts', section: 'import' },
  checkout: { source: '账号账单', title: '准备账号结账入口', category: 'accounts', section: 'accounts' },
  'fingerprint-cleanup': { source: '浏览器环境', title: '清理浏览器环境', category: 'maintenance', section: 'import' },
  'model-policy': { source: '模型数据政策', title: '确认模型数据政策', category: 'accounts', section: 'maintenance' },
  'patch-install': { source: 'Cursor 维护', title: '安装切号补丁', category: 'maintenance', section: 'maintenance' },
  'patch-remove': { source: 'Cursor 维护', title: '卸载切号补丁', category: 'maintenance', section: 'maintenance' },
  'question-answer': { source: '会话问卷', title: '提交问卷答案', category: 'sessions', quietSuccess: true },
  'question-skip': { source: '会话问卷', title: '跳过这组问卷', category: 'sessions', quietSuccess: true },
  'image-save': { source: '图片文件', title: '保存图片附件', category: 'storage', quietSuccess: true },
  'debug-enable': { source: 'Cursor 调试连接', title: '启用调试端口', category: 'maintenance', section: 'maintenance' }
}
const completed: Record<PageNotificationOperation, string> = { 'import-token': '账号已保存', 'import-card': '账号卡已保存', 'import-local': '本机账号已导入',
  'import-browser': '浏览器账号已导入', 'import-fingerprint': '指纹浏览器账号已导入', 'account-login': '网页登录已完成', 'login-window': '登录窗口已打开', checkout: '结账资料已复核，尚未提交付款',
  'fingerprint-cleanup': '浏览器环境清理已返回', 'model-policy': '模型数据政策已确认', 'patch-install': '切号补丁已确认就绪', 'patch-remove': '切号补丁管理已返回',
  'question-answer': '问卷答案已确认提交', 'question-skip': '这组问卷已确认跳过', 'image-save': '图片附件已保存', 'debug-enable': '原入口已确认调试端口就绪','memory-accept':'原记忆已确认采纳','memory-reject':'原记忆已确认驳回' }
export const pageOperationKey = (kind: PageNotificationOperation, id: string) => `page-operation:${kind}:${id}`
export const pageOperationReference = (kind: PageNotificationOperation, id: string) => ({ key: pageOperationKey(kind, id), eventId: `${pageOperationKey(kind, id)}:result` })

/** A display projection only; states come from the actual call-site return, never success-text regex. */
export function pageOperationNotification(definition: PageOperationDefinition, outcome: PageOperationOutcome | undefined, now: number): Omit<NotificationDraft, 'sourceRevision'> {
  const spec = specs[definition.kind], key = pageOperationKey(definition.kind, definition.id)
  const state = outcome?.state, scope = { ...definition.scope, ...outcome?.scope }
  const good = state === 'success', cancel = state === 'cancelled', running = outcome === undefined
  const facts = (outcome?.facts ?? []).map(value => notificationSafeText(value).slice(0, 900)).slice(0, 5)
  return { key, eventId: running ? `${key}:accepted` : `${key}:result`, eventType: running ? 'page.operation.running' : 'page.operation.result', subjectState: state ?? 'running',
    category: spec.category, source: spec.source,
    title: running ? `${spec.title}请求已受理` : good ? outcome?.unchanged && definition.kind.startsWith('patch-') ? '本次补丁无需改动' : completed[definition.kind]
      : cancel ? `${spec.title}已取消` : state === 'waiting' ? definition.kind === 'checkout' ? '结账入口已准备，支付尚未确认' : '登录窗口已打开，尚待登录'
        : state === 'partial' ? definition.kind === 'import-card' ? '账号卡已保存，登录仍未完成' : `${spec.title}有结果仍需处理` : state === 'failed' ? `${spec.title}未完成` : `${spec.title}结果待核对`,
    detail: running ? '原入口已受理，不据此证明操作已开始或已完成。通知不控制原链路。'
      : facts.join('\n') || (cancel ? '用户取消了原入口；未据此声称原先已有的动作已回滚。' : good ? '原操作已返回完成结果，可在原入口核对。' : '原入口没有确认全部结果；通知不会自动重跑或回滚业务。'),
    scope: { ...scope, ...(definition.familyId ? { operationFamilyId: definition.familyId } : {}) }, target: definition.target ?? (spec.section ? { kind: 'settings', section: spec.section } : undefined),
    origin: definition.origin ?? (spec.section ? { module: 'account', section: spec.section } : { module: 'sessions', sessionId: scope.sessionId }),
    tone: running || state === 'waiting' || cancel || outcome?.verifiedOnly ? 'info' : good ? 'success' : 'warning',
    attention: running || cancel || good && (spec.quietSuccess || definition.localOnly) ? 'activity' : 'notice',
    state: cancel ? 'expired' : running || state === 'waiting' || state === 'unconfirmed' ? 'active' : 'resolved',
    occurredAt: now, announce: !running && !cancel && (!good || !spec.quietSuccess && !definition.localOnly), renewAttention: !running && !cancel }
}
