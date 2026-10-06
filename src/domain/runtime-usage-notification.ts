import { validateNotificationDraft, type NotificationDraft } from './notification'
import type { RuntimeUsageReadResult } from './runtime-usage-observation'

export interface RuntimeUsageInput { key: string; scope?: string; id: string; at: number; result: RuntimeUsageReadResult | { state: 'scope' } }
export interface RuntimeUsageState {
  version: 1
  key: string
  scope?: string
  incident?: { key: string; scope: string; active: boolean; monitoring: boolean; reason: 'read' | 'record' }
}
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function readRuntimeUsageState(value: unknown, key: string): RuntimeUsageState | undefined {
  if (value === undefined) return
  const state = value as RuntimeUsageState, incident = state?.incident
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || state.key !== key
    || state.scope !== undefined && !hash(state.scope)
    || incident !== undefined && (!incident || typeof incident !== 'object' || Array.isArray(incident) || !hash(incident.scope)
      || !/^usage-runtime:[a-f0-9]{64}$/.test(incident.key) || typeof incident.active !== 'boolean' || typeof incident.monitoring !== 'boolean'
      || !['read', 'record'].includes(incident.reason) || incident.monitoring && (!incident.active || state.scope !== incident.scope))) throw Error('原生运行时用量观察检查点无效')
  return state
}

export function reduceRuntimeUsageNotifications(previous: RuntimeUsageState | undefined, input: RuntimeUsageInput, baseline: boolean, revision: number) {
  if (!hash(input.id) || input.scope !== undefined && !hash(input.scope) || !Number.isSafeInteger(input.at) || input.at < 0
    || !['scope', 'ready', 'waiting', 'failed'].includes(input.result.state)
    || input.result.state === 'failed' && !['read', 'record'].includes(input.result.reason)) throw Error('原生运行时用量观察无效')
  const state: RuntimeUsageState = { ...(previous ?? { version: 1, key: input.key }) }, drafts: NotificationDraft[] = []
  const draft = (phase: 'failed' | 'ready' | 'unmonitored', fresh: boolean): NotificationDraft => ({
    key: state.incident!.key, eventId: `${state.incident!.key}:${input.id}`, eventType: 'usage.runtime-source',
    subjectState: phase === 'ready' ? 'read-confirmed' : phase === 'failed' ? 'read-unconfirmed' : 'monitor-unconfirmed',
    category: 'maintenance', source: '统计 · 原生运行时入口', scope: {}, target: { kind: 'settings', section: 'stats' }, origin: { module: 'account', section: 'stats' },
    title: phase === 'ready' ? '用量补位读取已返回确认' : phase === 'failed' ? '用量补位读数尚未确认'
      : input.scope ? '原运行时用量监测范围已变化' : '暂未确认原用量监测范围',
    detail: phase === 'ready' ? '原入口已在同一监测范围读到可验证计数；仍可能只是原有的估算采样。\n这只确认本机补位读取，不回填之前未确认的读数，不证明全部历史、模型请求或官方账单。'
      : phase === 'failed' ? (state.incident!.reason === 'read' ? '原运行时读取曾连续遇到异常，新读数尚未确认。' : '原运行时读取曾连续返回无法验证的结构，新读数尚未确认。')
        + '\n当前本地统计仍可按原有读数和估算呈现；这不表示会话已停止，也不表示额度耗尽。通知不会额外探测、重试或发起模型请求。'
      : '当前没有同一绑定范围的可靠读取确认，原读取异常不据此算作恢复。\n范围变更或停止监测不表示原会话已停止，也不回填历史用量。',
    tone: phase === 'ready' ? 'success' : phase === 'failed' ? 'warning' : 'info', attention: 'notice',
    state: phase === 'ready' ? 'resolved' : phase === 'failed' ? 'active' : 'expired', sourceRevision: revision,
    occurredAt: input.at, timeBasis: 'observed', renewAttention: fresh, announce: !baseline && fresh
  })
  if (state.scope !== input.scope) {
    if (state.incident?.active && state.incident.monitoring) {
      state.incident = { ...state.incident, monitoring: false }; drafts.push(draft('unmonitored', false))
    }
    state.scope = input.scope
  }
  if (input.scope && input.result.state === 'failed') {
    const same = state.incident?.active && state.incident.scope === input.scope
    const fresh = !same || state.incident!.reason !== input.result.reason
    if (fresh || !state.incident?.monitoring) {
      state.incident = { key: same ? state.incident!.key : `usage-runtime:${input.id}`, scope: input.scope, active: true, monitoring: true, reason: input.result.reason }
      drafts.push(draft('failed', fresh))
    }
  }
  if (input.scope && input.result.state === 'ready' && state.incident?.active && state.incident.scope === input.scope) {
    state.incident = { ...state.incident, active: false, monitoring: false }; drafts.push(draft('ready', false))
  }
  drafts.forEach(validateNotificationDraft)
  return { state, drafts }
}
