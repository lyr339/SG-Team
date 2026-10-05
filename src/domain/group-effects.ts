/** Original operator group call observations. No body, goal, thunk, retry or permission. */
export const GROUP_OPERATION_KINDS = [
  'create',
  'add',
  'remove',
  'lead',
  'goal',
  'policy',
  'transfer',
  'dissolve'
] as const
export type GroupOperationKind = (typeof GROUP_OPERATION_KINDS)[number]
export const GROUP_EFFECT_KINDS = [
  'membership',
  'release',
  'orphan',
  'close-tasks',
  'lead-notice',
  'goal-notice',
  'policy-notice'
] as const
export type GroupEffectKind = (typeof GROUP_EFFECT_KINDS)[number]
export type GroupEffectStatus = 'confirmed' | 'queued' | 'recorded' | 'unconfirmed' | 'not-attempted'
export interface GroupEffectFact {
  kind: GroupEffectKind
  slotId?: string
  channelId?: string
  notice?: 'joined' | 'left' | 'dissolved' | 'lead_changed'
  status: GroupEffectStatus
  count?: number
  reason?:
    | 'no-channel'
    | 'no-binding'
    | 'scope-changed'
    | 'no-receipt'
    | 'permission'
    | 'storage'
    | 'timeout'
    | 'unconfirmed'
}
export interface GroupEffectsFrame {
  version: 1
  id: string
  owner: string
  kind: GroupOperationKind
  scope: { workspaceId?: string; runId: string; groupId: string }
  name: string
  observedAt: number
  sequence: number
  /** Set only after the original repository returned. Not a claim about current restored data. */
  primary: 'returned'
  projection: 'unconfirmed' | 'confirmed'
  phase: 'live' | 'completed' | 'interrupted'
  effects: GroupEffectFact[]
  truncated?: boolean
}
export interface GroupEffectsSummary extends Omit<GroupEffectsFrame, 'owner'> {}
/** Queue checkpoints carry a bounded description, not another copy of all effect targets. */
export interface GroupEffectsDigest {
  id: string
  problem: boolean
  releaseConfirmed: boolean
  detail: string
}
export function groupEffectsDigest(value: GroupEffectsSummary): GroupEffectsDigest {
  validateGroupEffects(value)
  return {
    id: value.id,
    problem: groupEffectsProblem(value),
    releaseConfirmed: value.effects.some(
      (effect) => effect.kind === 'release' && effect.status === 'confirmed'
    ),
    detail: groupEffectsLines(value).join('\n').slice(0, 1600)
  }
}
export function validateGroupEffectsDigest(value: GroupEffectsDigest): void {
  if (
    !value ||
    !uuid.test(value.id) ||
    typeof value.problem !== 'boolean' ||
    typeof value.releaseConfirmed !== 'boolean' ||
    typeof value.detail !== 'string' ||
    value.detail.length > 1600 ||
    Object.keys(value).some((key) => !['id', 'problem', 'releaseConfirmed', 'detail'].includes(key))
  )
    throw Error('组后续事项摘要无效')
}
export interface GroupEffectsObserver {
  observe(frame: GroupEffectsFrame): void
  unavailable?(): void
}
export function groupEffectsProblem(value: GroupEffectsSummary | GroupEffectsFrame): boolean {
  return (
    value.phase !== 'completed' ||
    value.projection !== 'confirmed' ||
    Boolean(value.truncated) ||
    value.effects.some((effect) => effect.status === 'unconfirmed' || effect.status === 'not-attempted')
  )
}
export const groupEffectsKey = (id: string) => `group-effects:${id}`
export const groupEffectsEvent = (id: string) => `${groupEffectsKey(id)}:result`
export const groupOperationName: Record<GroupOperationKind, string> = {
  create: '建组',
  add: '加人',
  remove: '移出成员',
  lead: '调整主控',
  goal: '更新目标',
  policy: '调整规划策略',
  transfer: '迁移成员',
  dissolve: '解散协作组'
}
export const groupEffectName: Record<GroupEffectKind, string> = {
  membership: '成员关系通知',
  release: '任务与验收释放',
  orphan: '待回应消息收尾',
  'close-tasks': '本组未完成任务收尾',
  'lead-notice': '主控知情记录',
  'goal-notice': '目标知情记录',
  'policy-notice': '规划权限知情记录'
}
export function groupEffectsLines(value: GroupEffectsSummary | GroupEffectsFrame): string[] {
  const lines = value.effects.map(
    (effect) =>
      `${groupEffectName[effect.kind]}${effect.channelId ? ` · CH-${effect.channelId}` : ''}：${effect.status === 'queued' ? '原队列已受理（不等于送达）' : effect.status === 'recorded' ? '原协作记录已返回（不等于已读）' : effect.status === 'confirmed' ? `原服务已返回${effect.count !== undefined ? ` · ${effect.count} 项` : ''}` : effect.reason === 'no-binding' ? '原绑定未确认，未发起释放' : effect.reason === 'no-channel' ? '原通道未确认，未发起通知' : '原入口未确认结果（不推断完全未执行）'}`
  )
  if (value.projection !== 'confirmed')
    lines.unshift('原组状态刷新未确认；保留原仓储已返回的事实，不推测当前成员状态。')
  if (value.phase !== 'completed')
    lines.push('没有保存本次全部后续步骤的最终回执，不重做成员关系或自动重跑副作用。')
  if (value.truncated) lines.push('本次观察超过有界记录容量；未记录的部分不被宣称完成。')
  return lines
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
export function validateGroupEffects(value: GroupEffectsSummary | GroupEffectsFrame): void {
  if (
    !value ||
    value.version !== 1 ||
    !uuid.test(value.id) ||
    !GROUP_OPERATION_KINDS.includes(value.kind) ||
    value.primary !== 'returned' ||
    !['confirmed', 'unconfirmed'].includes(value.projection) ||
    !['live', 'completed', 'interrupted'].includes(value.phase) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt < 0 ||
    typeof value.name !== 'string' ||
    value.name.length > 120 ||
    !value.scope ||
    !value.scope.runId ||
    !value.scope.groupId ||
    Object.values(value.scope).some(
      (id) => id !== undefined && (typeof id !== 'string' || !id || id.length > 300)
    ) ||
    !Array.isArray(value.effects) ||
    value.effects.length > 64 ||
    (value.truncated !== undefined && typeof value.truncated !== 'boolean') ||
    Object.keys(value).some(
      (key) =>
        ![
          'version',
          'id',
          'owner',
          'kind',
          'scope',
          'name',
          'observedAt',
          'sequence',
          'primary',
          'projection',
          'phase',
          'effects',
          'truncated'
        ].includes(key)
    ) ||
    typeof value.scope !== 'object' ||
    Array.isArray(value.scope) ||
    Object.keys(value.scope).some((key) => !['workspaceId', 'runId', 'groupId'].includes(key))
  )
    throw Error('组操作观察无效')
  if ('owner' in value && !uuid.test(value.owner)) throw Error('组操作原实例无效')
  for (const fact of value.effects)
    if (
      !fact ||
      !GROUP_EFFECT_KINDS.includes(fact.kind) ||
      !['confirmed', 'queued', 'recorded', 'unconfirmed', 'not-attempted'].includes(fact.status) ||
      (fact.slotId !== undefined &&
        (typeof fact.slotId !== 'string' || !fact.slotId || fact.slotId.length > 300)) ||
      (fact.channelId !== undefined &&
        (typeof fact.channelId !== 'string' || !fact.channelId || fact.channelId.length > 30)) ||
      (fact.count !== undefined && (!Number.isSafeInteger(fact.count) || fact.count < 0)) ||
      (fact.notice !== undefined && !['joined', 'left', 'dissolved', 'lead_changed'].includes(fact.notice)) ||
      (fact.reason !== undefined &&
        ![
          'no-channel',
          'no-binding',
          'scope-changed',
          'no-receipt',
          'permission',
          'storage',
          'timeout',
          'unconfirmed'
        ].includes(fact.reason)) ||
      Object.keys(fact).some(
        (key) => !['kind', 'slotId', 'channelId', 'notice', 'status', 'count', 'reason'].includes(key)
      )
    )
      throw Error('组后续步骤观察无效')
}
