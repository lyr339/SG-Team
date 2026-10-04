import { notificationSafeText, type NotificationDraft } from './notification'

interface ColdResult { switched: boolean; runtimeVerified: boolean; killedCursor: boolean; relaunchMode: 'cdp' | 'plain' | 'failed'; cdpPortReady?: boolean; machineIdentityApplied: boolean; tokenExpired?: boolean }
interface HotResult { switched: boolean; warning?: string; reason?: string }
export function accountSwitchNotification(input: { id: string; accountId: string; mode: 'cold' | 'hot'; cold?: ColdResult; hot?: HotResult; error?: string; now: number }): Omit<NotificationDraft, 'sourceRevision'> {
  const confirmed = input.mode === 'cold' ? input.cold?.switched === true && input.cold.runtimeVerified && input.cold.relaunchMode !== 'failed' : input.hot?.switched === true
  const warning = input.mode === 'cold' ? input.cold?.relaunchMode === 'cdp' && input.cold.cdpPortReady !== true || input.cold?.tokenExpired === true : Boolean(input.hot?.warning)
  const title = confirmed ? warning ? '账号已切换，附带状态需查看' : input.mode === 'cold' ? '账号切换并重启已完成' : '账号已无感切换' : '账号切换未确认完成'
  const detail = input.error ? notificationSafeText(input.error) + '\n原切换和恢复结果仍保留，未自动重试；请先核对实际登录状态。'
    : input.mode === 'hot' ? confirmed ? `Cursor 运行时已确认接手，不代表机器码已对齐。${input.hot?.warning ? `\n附带警告：${notificationSafeText(input.hot.warning)}` : ''}`
      : notificationSafeText(input.hot?.reason ?? '没有取得成功接手的回执。')
      : `运行态确认：${input.cold?.runtimeVerified ? '已取得' : '未取得'}；机器码应用：${input.cold?.machineIdentityApplied ? '已确认' : '未确认'}。`
        + `\nCursor ${input.cold?.killedCursor ? '发生过重启' : '原先未运行或没有取得停止确认'}；调试连接${input.cold?.cdpPortReady ? '已就绪' : '以维护页的当前状态为准'}。`
        + (input.cold?.tokenExpired ? '\n来源报告凭据过期，请到账号页查看。' : '')
  return { key: `account-switch:${input.mode}:${input.id}`, eventId: `account-switch:${input.id}:result`, eventType: 'account.switch.finished',
    category: 'accounts', source: input.mode === 'cold' ? '切换并重启' : '无感切换', title, detail: detail.slice(0, 3_800),
    scope: { accountId: input.accountId }, origin: { module: 'account', section: 'accounts' }, target: { kind: 'settings', section: 'accounts' },
    tone: confirmed && !warning ? 'success' : 'warning', attention: 'notice', state: confirmed && !warning ? 'resolved' : 'active', occurredAt: input.now, timeBasis: 'observed', renewAttention: true, announce: true }
}
