import { validateNotificationDraft, type NotificationDraft } from './notification'
import type { RuntimeUsageReadResult } from './runtime-usage-observation'

export type LocalReadKind = 'runtime' | 'context'
export const LOCAL_READ_SOURCES = {
  runtime: { key: 'runtime-usage-health', prefix: 'usage-runtime', eventType: 'usage.runtime-source', source: '统计 · 原生运行时入口', section: 'stats' },
  context: { key: 'composer-context-health', prefix: 'composer-context', eventType: 'cursor.context-source', source: 'Cursor · 本机上下文详情', section: 'maintenance' }
} as const

export interface RuntimeUsageInput { key: string; scope?: string; id: string; at: number; result: RuntimeUsageReadResult | { state: 'scope' } }
export interface RuntimeUsageState {
  version: 1
  key: string
  scope?: string
  incident?: { key: string; scope: string; active: boolean; monitoring: boolean; reason: 'read' | 'record' }
}
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function localReadCopy(kind: LocalReadKind, phase: 'failed' | 'ready' | 'unmonitored', scopeKnown: boolean, reason: 'read' | 'record') {
  if (kind === 'context') {
    if (phase === 'ready') return {
      title: '上下文详情读取已返回确认',
      detail: '原本机详情读取已在同一绑定范围返回可验证的上下文读数。\n这只确认此读取入口，不回填之前未确认的资料，不反推 Token、Cost 或官方账单。'
    }
    if (phase === 'failed') return {
      title: '本机上下文详情尚未确认',
      detail: (reason === 'read' ? '原本机详情读取曾连续遇到读取异常。' : '原本机详情读取曾连续遇到无法验证的记录或结构。')
        + '\n页面可能仍显示先前读数或原头部兼容指标，不能据此判断详情已恢复。请在 Cursor 原会话核对；通知不会额外读盘、重试、改模型或修改统计。'
    }
    return {
      title: scopeKnown ? '原上下文监测范围已变化' : '暂未确认原上下文监测范围',
      detail: '当前未确认同一绑定范围的本机上下文读取，原问题不据此算作恢复。\n这不表示原会话已停止，也不修改历史统计。'
    }
  }
  if (phase === 'ready') return {
    title: '用量补位读取已返回确认',
    detail: '原入口已在同一监测范围读到可验证计数；仍可能只是原有的估算采样。\n这只确认本机补位读取，不回填之前未确认的读数，不证明全部历史、模型请求或官方账单。'
  }
  if (phase === 'failed') return {
    title: '用量补位读数尚未确认',
    detail: (reason === 'read' ? '原运行时读取曾连续遇到异常，新读数尚未确认。' : '原运行时读取曾连续返回无法验证的结构，新读数尚未确认。')
      + '\n当前本地统计仍可按原有读数和估算呈现；这不表示会话已停止，也不表示额度耗尽。通知不会额外探测、重试或发起模型请求。'
  }
  return {
    title: scopeKnown ? '原运行时用量监测范围已变化' : '暂未确认原用量监测范围',
    detail: '当前没有同一绑定范围的可靠读取确认，原读取异常不据此算作恢复。\n范围变更或停止监测不表示原会话已停止，也不回填历史用量。'
  }
}
export function readRuntimeUsageState(value: unknown, key: string, kind: LocalReadKind = 'runtime'): RuntimeUsageState | undefined {
  if (value === undefined) return
  const state = value as RuntimeUsageState, incident = state?.incident
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || state.key !== key
    || state.scope !== undefined && !hash(state.scope)
    || incident !== undefined && (!incident || typeof incident !== 'object' || Array.isArray(incident) || !hash(incident.scope)
      || !new RegExp(`^${LOCAL_READ_SOURCES[kind].prefix}:[a-f0-9]{64}$`).test(incident.key) || typeof incident.active !== 'boolean' || typeof incident.monitoring !== 'boolean'
      || !['read', 'record'].includes(incident.reason) || incident.monitoring && (!incident.active || state.scope !== incident.scope))) throw Error('原生运行时用量观察检查点无效')
  return state
}

export function reduceRuntimeUsageNotifications(previous: RuntimeUsageState | undefined, input: RuntimeUsageInput, baseline: boolean, revision: number, kind: LocalReadKind = 'runtime') {
  if (!hash(input.id) || input.scope !== undefined && !hash(input.scope) || !Number.isSafeInteger(input.at) || input.at < 0
    || !['scope', 'ready', 'waiting', 'failed'].includes(input.result.state)
    || input.result.state === 'failed' && !['read', 'record'].includes(input.result.reason)) throw Error('原生运行时用量观察无效')
  const state: RuntimeUsageState = { ...(previous ?? { version: 1, key: input.key }) }, drafts: NotificationDraft[] = []
  const source = LOCAL_READ_SOURCES[kind]
  const draft = (phase: 'failed' | 'ready' | 'unmonitored', fresh: boolean): NotificationDraft => ({
    key: state.incident!.key, eventId: `${state.incident!.key}:${input.id}`, eventType: source.eventType,
    subjectState: phase === 'ready' ? 'read-confirmed' : phase === 'failed' ? 'read-unconfirmed' : 'monitor-unconfirmed',
    category: 'maintenance', source: source.source, scope: {}, target: { kind: 'settings', section: source.section }, origin: { module: 'account', section: source.section },
    ...localReadCopy(kind, phase, Boolean(input.scope), state.incident!.reason),
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
      state.incident = { key: same ? state.incident!.key : `${source.prefix}:${input.id}`, scope: input.scope, active: true, monitoring: true, reason: input.result.reason }
      drafts.push(draft('failed', fresh))
    }
  }
  if (input.scope && input.result.state === 'ready' && state.incident?.active && state.incident.scope === input.scope) {
    state.incident = { ...state.incident, active: false, monitoring: false }; drafts.push(draft('ready', false))
  }
  drafts.forEach(validateNotificationDraft)
  return { state, drafts }
}
