import { validateNotificationDraft, type NotificationDraft, type NotificationScope } from './notification'
import type { UsageBindingResult } from './usage-binding-observation'

type Cause = { identity: string; channel: string; reason: 'record' | 'callback' }
export interface UsageBindingInput {
  key: string; scope?: string; scopeRef: Pick<NotificationScope, 'workspaceId' | 'runId'>; id: string; at: number
  fact: { state: 'scope' } | UsageBindingResult & { identity: string; channel: string; confirmationFor?: string }
}
export interface UsageBindingState {
  version: 1; key: string; scope?: string
  episode?: { key: string; scope: string; scopeRef: Pick<NotificationScope, 'workspaceId' | 'runId'>; monitoring: boolean; causes: Cause[] }
}
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const scopeRef = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([key, id]) => ['workspaceId', 'runId'].includes(key) && (id === undefined || typeof id === 'string' && id.length <= 300))
export function readUsageBindingState(value: unknown, key: string): UsageBindingState | undefined {
  if (value === undefined) return
  const state = value as UsageBindingState, episode = state?.episode
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || state.key !== key
    || state.scope !== undefined && !hash(state.scope) || episode !== undefined && (!episode || typeof episode !== 'object' || Array.isArray(episode)
      || !/^usage-binding:[a-f0-9]{64}$/.test(episode.key) || !hash(episode.scope) || !scopeRef(episode.scopeRef)
      || typeof episode.monitoring !== 'boolean' || episode.monitoring && episode.scope !== state.scope
      || !Array.isArray(episode.causes) || episode.causes.length > 128 || new Set(episode.causes.map(c => c?.identity)).size !== episode.causes.length
      || episode.causes.some(c => !c || !hash(c.identity) || !/^\d{1,12}$/.test(c.channel) || !['record', 'callback'].includes(c.reason)))) throw Error('写后用量通知检查点无效')
  return state
}
export function reduceUsageBindingNotifications(previous: UsageBindingState | undefined, input: UsageBindingInput, baseline: boolean, revision: number) {
  const fact = input.fact
  if (!hash(input.id) || input.scope !== undefined && !hash(input.scope) || !scopeRef(input.scopeRef) || !Number.isSafeInteger(input.at) || input.at < 0
    || !['scope', 'ready', 'waiting', 'failed'].includes(fact.state) || fact.state !== 'scope' && (!hash(fact.identity) || !/^\d{1,12}$/.test(fact.channel))
    || fact.state !== 'scope' && fact.confirmationFor !== undefined && !hash(fact.confirmationFor)
    || fact.state === 'failed' && !['record', 'callback'].includes(fact.reason)) throw Error('写后用量来源无效')
  const state: UsageBindingState = { ...(previous ?? { version: 1, key: input.key }) }, drafts: NotificationDraft[] = []
  const draft = (phase: 'failed' | 'ready' | 'unmonitored', fresh: boolean): NotificationDraft => {
    const episode = state.episode!, causes = [...episode.causes].sort((a, b) => Number(a.channel) - Number(b.channel))
    return {
      key: episode.key, eventId: `${episode.key}:${input.id}`, eventType: 'usage.binding-source', category: 'maintenance', source: '统计 · 写后用量通道',
      scope: { ...episode.scopeRef }, target: { kind: 'settings', section: 'stats' }, origin: { module: 'account', section: 'stats' },
      subjectState: phase === 'failed' ? 'receive-unconfirmed' : phase === 'ready' ? 'receive-confirmed' : 'monitor-unconfirmed',
      title: phase === 'failed' ? '写后用量接收尚未确认' : phase === 'ready' ? '写后用量接收已返回确认'
        : input.scope ? '原写后用量监测已变化' : '暂未确认原写后用量监测',
      detail: phase === 'failed' ? `${causes.length} 个绑定来源的原接收流程曾连续报告异常：\n`
        + causes.slice(0, 64).map(cause => `CH-${cause.channel} · ${cause.reason === 'record' ? '载荷无法验证' : '原计数回调没有正常返回'}`).join('\n')
        + (causes.length > 64 ? `\n另有 ${causes.length - 64} 个来源，请在原会话逐项核对。` : '')
        + '\n其他正常读数保持原流程；通知不会重放载荷、重试回调或更改统计。'
        : phase === 'ready' ? '此前受影响的绑定来源已重新收到可验证载荷，原回调也已返回。\n这只确认接收入口，不保证载荷已入账或落盘，不补回之前未确认的读数，也不证明官方账单。'
        : (input.scope ? '原文档、绑定或监测范围已变化，' : '目前未确认原文档与绑定范围，')
          + '之前的接收问题不据此算作恢复。\n新范围的正常载荷不会代替旧范围的证据。',
      tone: phase === 'failed' ? 'warning' : phase === 'ready' ? 'success' : 'info', attention: 'notice',
      state: phase === 'failed' ? 'active' : phase === 'ready' ? 'resolved' : 'expired', occurredAt: input.at, timeBasis: 'observed',
      sourceRevision: revision, renewAttention: fresh, announce: !baseline && fresh
    }
  }
  if (state.scope !== input.scope) {
    if (state.episode?.monitoring && state.episode.causes.length) {
      state.episode = { ...state.episode, monitoring: false }; drafts.push(draft('unmonitored', false))
    }
    state.scope = input.scope
  }
  if (input.scope && fact.state === 'failed') {
    const old = state.episode?.scope === input.scope && state.episode.monitoring && state.episode.causes.length ? state.episode : undefined
    const cause = old?.causes.find(cause => cause.identity === fact.identity)
    if (!cause || cause.reason !== fact.reason) {
      state.episode = { ...(old ?? { key: `usage-binding:${input.id}`, scope: input.scope, scopeRef: { ...input.scopeRef }, monitoring: true, causes: [] }),
        causes: [...(old?.causes ?? []).filter(cause => cause.identity !== fact.identity), { identity: fact.identity, channel: fact.channel, reason: fact.reason }] }
      if (state.episode.causes.length > 128) throw Error('写后用量来源超出当前绑定上限')
      drafts.push(draft('failed', true))
    }
  }
  if (input.scope && fact.state === 'ready' && state.episode?.monitoring && state.episode.scope === input.scope
    && state.episode.causes.some(cause => cause.identity === fact.identity)) {
    state.episode = { ...state.episode, causes: state.episode.causes.filter(cause => cause.identity !== fact.identity) }
    drafts.push(draft(state.episode.causes.length ? 'failed' : 'ready', false))
  }
  drafts.forEach(validateNotificationDraft)
  return { state, drafts }
}
