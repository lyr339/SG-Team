import { validateNotificationDraft, type NotificationDraft, type NotificationScope } from './notification'

export const NATIVE_SCOPE_SOURCE_PREFIXES = ['group-topology:', 'memory-issues:', 'task-notifications:'] as const
export type NativeScopeSourcePrefix = typeof NATIVE_SCOPE_SOURCE_PREFIXES[number]
export interface NativeScopeRef { workspaceId: string; runId: string }
/** Original complete TeamControl state only; omission or a clipped projection is not a missing-scope verdict. */
export interface NativeScopeCatalogue { workspaceIds: readonly string[]; runs: ReadonlyArray<NativeScopeRef> }
export interface NativeScopeMissing { episode: string; at: number; after?: string; rowsClosed: boolean; summaryClosed: boolean }
export interface NativeScopeMetadata { observedScope?: NativeScopeRef; scopeMissing?: NativeScopeMissing }
export interface NotificationSourceListQuery { prefix: NativeScopeSourcePrefix; after?: string; limit?: number }
export interface NotificationSourceListPage { rows: Array<{ key: string; revision: number; scope?: NativeScopeRef }>; nextKey?: string }

const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 300
export function validNativeScope(value: unknown): value is NativeScopeRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const scope = value as NativeScopeRef
  return id(scope.workspaceId) && id(scope.runId) && Object.keys(scope).every(key => ['workspaceId', 'runId'].includes(key))
}
export function validateNativeScopeMetadata(value: NativeScopeMetadata): void {
  if (value.observedScope !== undefined && !validNativeScope(value.observedScope)) throw Error('原通知范围身份无效')
  const missing = value.scopeMissing
  if (missing !== undefined && (!missing || typeof missing !== 'object' || Array.isArray(missing) || !/^[a-f0-9]{64}$/.test(missing.episode)
    || !Number.isSafeInteger(missing.at) || missing.at < 0 || missing.at > 8_640_000_000_000_000 || typeof missing.summaryClosed !== 'boolean' || typeof missing.rowsClosed !== 'boolean'
    || (missing.after !== undefined && !id(missing.after)) || missing.summaryClosed && !missing.rowsClosed || !value.observedScope)) throw Error('原范围核对标记无效')
}
export function validateNativeScopeCatalogue(value: NativeScopeCatalogue): void {
  if (!value || !Array.isArray(value.workspaceIds) || !Array.isArray(value.runs) || value.workspaceIds.length > 65536 || value.runs.length > 65536
    || Array.from(value.workspaceIds).some(workspaceId => !id(workspaceId)) || Array.from(value.runs).some(scope => !validNativeScope(scope))
    || new Set(value.workspaceIds).size !== value.workspaceIds.length || new Set(value.runs.map(scope => scope.runId)).size !== value.runs.length)
    throw Error('原完整范围目录无法验证')
  const workspaces = new Set(value.workspaceIds)
  if (value.runs.some(scope => !workspaces.has(scope.workspaceId))) throw Error('原完整范围目录含未知工作区')
}
/** One old native-record notice, never a cancellation, deletion, stopped-session or successful restoration. */
export function missingNativeScopeDraft(input: {
  key: string; eventType: string; scope: NotificationScope; activity: boolean; title: string; episode: string; at: number; revision: number
}): NotificationDraft {
  const draft: NotificationDraft = { key: input.key, eventId: `${input.key}:scope-missing:${input.episode}`, eventType: input.eventType,
    subjectState: 'scope-unconfirmed', category: 'team', source: input.activity ? '协作组' : input.eventType === 'task.state' ? '组任务' : '共享记忆',
    title: input.title, detail: '本次原完整范围读取没有确认这条提醒所属的工作区或运行范围。\n先前结果仍属历史，不据此判断任务完成、取消、提案已审核、会话停止或数据已删除；通知没有重放原操作。',
    scope: { ...input.scope }, tone: 'info', attention: input.activity ? 'activity' : 'notice', state: 'expired', occurredAt: input.at, timeBasis: 'observed',
    sourceRevision: input.revision, announce: false, renewAttention: false, respectCleared: true }
  validateNotificationDraft(draft)
  return draft
}
