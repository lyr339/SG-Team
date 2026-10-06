import { validateNotificationDraft, type NotificationDraft } from './notification'
import type { ModelCatalogObservation } from './model-catalog-observation'

export interface ModelCatalogInput { key: string; id: string; fact: ModelCatalogObservation }
type FailureReason = Extract<ModelCatalogObservation, { state: 'failed' }>['reason']
export interface ModelCatalogState {
  version: 1
  key: string
  incident?: { key: string; active: boolean; reason: FailureReason }
}
const reasons: Record<FailureReason, string> = {
  read: '原读取入口连续未能完成本机目录读取。',
  record: '原读取入口连续遇到无法验证的目录记录。',
  size: '原目录记录连续超过已有读取上限。'
}

export function readModelCatalogState(value: unknown, key: string): ModelCatalogState | undefined {
  if (value === undefined) return
  const state = value as ModelCatalogState, incident = state?.incident
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || state.key !== key
    || incident !== undefined && (!incident || typeof incident !== 'object' || Array.isArray(incident)
      || typeof incident.key !== 'string' || !/^model-catalog:[a-f0-9]{64}$/.test(incident.key)
      || typeof incident.active !== 'boolean' || !Object.hasOwn(reasons, incident.reason))) {
    throw Error('模型目录观察检查点无效')
  }
  return state
}

export function reduceModelCatalogNotifications(previous: ModelCatalogState | undefined, input: ModelCatalogInput, baseline: boolean, revision: number) {
  const state: ModelCatalogState = { ...(previous ?? { version: 1, key: input.key }) }
  const drafts: NotificationDraft[] = [], fact = input.fact
  if (!/^[a-f0-9]{64}$/.test(input.id) || !Number.isSafeInteger(fact.at) || fact.at < 0
    || !['ready', 'waiting', 'fallback', 'failed'].includes(fact.state)
    || fact.state === 'failed' && !Object.hasOwn(reasons, fact.reason)) throw Error('模型目录观察无效')
  const draft = (active: boolean, fresh: boolean): NotificationDraft => ({
    key: state.incident!.key, eventId: `${state.incident!.key}:${input.id}`, eventType: 'cursor.model-catalog', subjectState: active ? 'unconfirmed' : 'confirmed',
    category: 'maintenance', source: 'Cursor · 模型目录', title: active ? '本机模型目录持续读取异常' : '本机模型目录读取已恢复',
    detail: active ? `${reasons[state.incident!.reason]}\n这不表示已有会话已停止，也不表示额度耗尽。请在原维护与模型配置入口核对，通知不会切换模型或重跑读取。`
      : '原读取已经返回可验证的模型目录。只确认本机目录恢复，不据此确认会话在线、模型请求成功或历史账单。',
    scope: {}, target: { kind: 'settings', section: 'maintenance' }, origin: { module: 'account', section: 'maintenance' },
    tone: active ? 'warning' : 'success', attention: 'notice', state: active ? 'active' : 'resolved', occurredAt: fact.at, timeBasis: 'observed',
    sourceRevision: revision, renewAttention: fresh, announce: !baseline && fresh
  })
  if (fact.state === 'failed' && (!state.incident?.active || state.incident.reason !== fact.reason)) {
    state.incident = { key: state.incident?.active ? state.incident.key : `model-catalog:${input.id}`, active: true, reason: fact.reason }
    drafts.push(draft(true, true))
  }
  if (fact.state === 'ready' && state.incident?.active) {
    state.incident = { ...state.incident, active: false }
    drafts.push(draft(false, false))
  }
  // Waiting/compatible fallback is not a new fault, nor proof that the failed source returned.
  drafts.forEach(validateNotificationDraft)
  return { state, drafts }
}
