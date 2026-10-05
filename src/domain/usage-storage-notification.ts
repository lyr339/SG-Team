import { validateNotificationDraft, type NotificationDraft } from './notification'
import type { UsageStorageObservation } from './usage-storage-observation'
export interface UsageStorageInput { key: string; id: string; fact: UsageStorageObservation; at: number }
interface Episode { key: string; at: number }
export interface UsageStorageState {
  version: 1; key: string
  history?: Episode & { reasons: Array<'read' | 'structure' | 'records'>; backupAvailable?: boolean }
  write?: Episode & { active: boolean; reason: Extract<UsageStorageObservation, { result: 'unconfirmed' }>['reason'] }
}
export function readUsageStorageState(value: unknown, key: string): UsageStorageState | undefined {
  if (value === undefined) return
  const s = value as UsageStorageState
  const episode = (e: Episode, kind: string) => e && typeof e === 'object' && !Array.isArray(e) && typeof e.key === 'string' && new RegExp(`^usage-storage:${kind}:[a-f0-9]{64}$`).test(e.key) && Number.isSafeInteger(e.at) && e.at >= 0
  if (!s || typeof s !== 'object' || Array.isArray(s) || s.version !== 1 || s.key !== key || s.history !== undefined && (!episode(s.history, 'history') || !Array.isArray(s.history.reasons) || s.history.reasons.length < 1 || s.history.reasons.length > 3 || s.history.reasons.some(reason => !['read','structure','records'].includes(reason))
    || s.history.backupAvailable !== undefined && typeof s.history.backupAvailable !== 'boolean')
    || s.write !== undefined && (!episode(s.write, 'write') || typeof s.write.active !== 'boolean' || !['permission','readonly','capacity','unclassified'].includes(s.write.reason)))
    throw Error('用量保存观察检查点无效')
  return s
}
const reasons = { permission: '原保存入口报告访问权限不足。', readonly: '原保存入口报告存储只读。', capacity: '原保存入口报告空间不足。', unclassified: '原保存入口没有返回成功确认。' }
export function reduceUsageStorageNotifications(previous: UsageStorageState | undefined, input: UsageStorageInput, baseline: boolean, revision: number) {
  if (!/^[a-f0-9]{64}$/.test(input.id) || !Number.isSafeInteger(input.at) || input.at < 0) throw Error('用量保存观察身份无效')
  const state: UsageStorageState = { ...(previous ?? { version: 1, key: input.key }) }, drafts: NotificationDraft[] = []
  const draft = (e: Episode, eventType: string, subjectState: string, title: string, detail: string, active: boolean, attention: boolean): NotificationDraft => ({
    key: e.key, eventId: `${e.key}:${input.id}`, eventType, subjectState, category: 'storage', source: '统计 · 本机用量记录', title, detail,
    scope: {}, target: { kind: 'settings', section: 'stats' }, origin: { module: 'account', section: 'stats' },
    attention: 'notice', tone: active ? 'warning' : 'success', state: active ? 'active' : 'resolved',
    occurredAt: input.at, timeBasis: 'observed', sourceRevision: revision, renewAttention: attention, announce: !baseline && attention
  })
  const f = input.fact
  if (f.kind === 'load' && f.result === 'history-unconfirmed' && (!state.history || !state.history.reasons.includes(f.reason)
    || f.backupAvailable !== undefined && f.backupAvailable !== state.history.backupAvailable)) {
    state.history = { ...(state.history ?? { key: `usage-storage:history:${input.id}`, at: input.at }), reasons: [...new Set([...(state.history?.reasons ?? []), f.reason])],
      ...(f.backupAvailable === undefined ? {} : { backupAvailable: f.backupAvailable }) }
    drafts.push(draft(state.history, 'usage.storage-history', 'history-unconfirmed', '用量历史未能完整读取',
      (state.history.reasons.includes('records') ? '原加载流程跳过了无法验证的记录，当前历史统计可能不完整。\n' : '')
      + (state.history.reasons.some(reason => reason !== 'records') ? '原用量文件曾未能正常读取或解析，不能把空统计当作历史用量为零。\n' : '')
      + (state.history.backupAvailable === true ? '最近一次异常文件留档已有返回确认。' : state.history.backupAvailable === false ? '最近一次异常文件留档未得到确认。' : '')
      + '\n后续保存或阅读通知都不表示原历史已经恢复。', true, true))
  }
  if (f.kind === 'save' && f.result === 'unconfirmed' && (!state.write?.active || f.reason !== state.write.reason)) {
    state.write = { ...(state.write?.active ? state.write : { key: `usage-storage:write:${input.id}`, at: input.at }), active: true, reason: f.reason }
    drafts.push(draft(state.write, 'usage.storage-write', 'unconfirmed', '用量记录保存未确认',
      `${reasons[f.reason]}\n本次内存统计仍可显示；重启后不能保证保留最新记录。`, true, true))
  }
  if (f.kind === 'save' && f.result === 'confirmed' && state.write?.active) {
    state.write = { ...state.write, active: false }
    drafts.push(draft(state.write, 'usage.storage-write', 'confirmed', '用量记录保存已恢复',
      '新的保存已返回确认，不据此把之前未确认的尝试算作保存成功。\n先前历史读取问题不会因此被抹掉。', false, false))
  }
  // A valid load, empty first-install file, or normal estimate is not proof that
  // an earlier unconfirmed save/history loss has been recovered.
  drafts.forEach(validateNotificationDraft)
  return { state, drafts }
}
