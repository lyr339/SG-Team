import type { NotificationHistoryIntegrity } from './notification-history'
export const NOTIFICATION_CATEGORIES = ['sessions', 'run', 'team', 'accounts', 'automation', 'processing', 'maintenance', 'storage', 'updates', 'usage'] as const
export const NOTIFICATION_SOURCE_BATCH_LIMIT = 100
/** Compact, bounded identity checkpoints only; conversation bodies are not source state. */
export const NOTIFICATION_SOURCE_PAYLOAD_LIMIT = 2 * 1024 * 1024
export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number]
export type NotificationAttention = 'activity' | 'notice' | 'action'
export type NotificationTone = 'info' | 'success' | 'warning' | 'error'
export type NotificationState = 'active' | 'resolved' | 'expired'
export type NotificationSettingsSection = 'stats' | 'accounts' | 'import' | 'automation' | 'aozai' | 'maintenance' | 'cleanup' | 'update'

export interface NotificationScope {
  workspaceId?: string
  runId?: string
  groupId?: string
  slotId?: string
  sessionId?: string
  generation?: string
  bindingGeneration?: string
  channelId?: string
  composerId?: string
  accountId?: string
  providerId?: string
  operationFamilyId?: string
  /** Native model/limit domain for a context alert; never an estimated billing domain. */
  contextDomain?: string
  installationId?: string
  cursorVersion?: string
  memoryId?: string
  memoryVersion?: string
  /** Identity returned by the original coordinator, not a UI confirmation or Agent receipt. */
  operatorRequestId?: string
  groupOperationId?: string
}

/** Navigation references only. Installing, restarting, answering or processing remain original workflow actions. */
export type NotificationTarget =
  | { kind:'memory';workspaceId:string;runId:string;groupId?:string;memoryId:string;version:number }
  | { kind: 'settings'; section: NotificationSettingsSection }
  | { kind: 'run'; runId?: string; groupId?: string }
  | { kind: 'collaboration'; runId: string; groupId: string; messageId?: string }
  | { kind: 'session'; scope: NotificationScope; entryId?: string; toolCallId?: string; blockId?: string; surface?: 'queue' | 'context' }

export interface NotificationDraft {
  /** Semantic identity (operation, session incident, or source event), never the display title. */
  key: string
  category: NotificationCategory
  source: string
  eventId?: string
  eventType?: string
  subjectState?: string
  title: string
  detail?: string
  tone: NotificationTone
  attention: NotificationAttention
  state: NotificationState
  scope: NotificationScope
  target?: NotificationTarget
  occurredAt: number
  timeBasis?: 'occurred' | 'observed'
  /** Source-local sequence; stale writes must not roll back an already newer result. */
  sourceRevision: number
  /** Updating data silently must not re-open an already read result. */
  renewAttention?: boolean
  /** Live delivery only; never persisted or replayed when reopening the center. */
  announce?: boolean
  /** Optional background-only opt-in signals; activity records do not become artificial unread work. */
  liveSignal?: 'connection' | 'reply'
  /** Metadata repair must not resurrect a result the human already cleared. */
  respectCleared?: boolean
  origin?: { module: 'sessions' | 'run' | 'account'; section?: NotificationSettingsSection; sessionId?: string }
}

export interface NotificationRecord extends Omit<NotificationDraft, 'renewAttention' | 'announce' | 'respectCleared' | 'liveSignal'> {
  /** Worker-owned and monotone: prior diagnostic/action importance cannot be lost on recovery. */
  retentionProtected?: boolean
  id: string
  createdAt: number
  updatedAt: number
  revision: number
  attentionRevision: number
  readRevision: number
  readAt?: number
  archivedAt?: number
}

export interface NotificationSummary {
  revision: number
  total: number
  unread: number
  pending: number
  clearable: number
}

export interface NotificationQuery {
  runId?: string
  memoryId?: string
  installationId?: string
  contextDomain?: string
  generation?: string
  key?: string
  eventType?: string
  operationFamilyId?: string
  filter?: 'all' | 'unread' | 'pending'
  workspaceId?: string
  category?: NotificationCategory
  sessionId?: string
  toolCallId?: string
  entryId?: string
  limit?: number
  cursor?: { revision: number; offset: number }
}

export interface NotificationPage {
  historyIntegrity?: NotificationHistoryIntegrity
  historyGapUnconfirmed?: boolean
  records: NotificationRecord[]
  summary: NotificationSummary
  nextCursor?: { revision: number; offset: number }
  /** Caller must replace previous pages rather than append across different revisions. */
  reset: boolean
  health?: NotificationPush['health']
  historyIncomplete?: boolean
  delivery?: NotificationDeliveryStatus
  openRequested?: NotificationOpenRequest
}

export interface NotificationChange {
  summary: NotificationSummary
  record?: NotificationRecord
  changed: boolean
}

export interface NotificationMarker { sourceRevision: number; signature?: string; cleared?: boolean }
export interface NotificationSourceState { revision: number; data?: unknown }
export interface NotificationSourceResult {
  applied: boolean
  source: NotificationSourceState
  changes: NotificationChange[]
}

export interface NotificationPush {
  historyIntegrity?: NotificationHistoryIntegrity
  historyGapUnconfirmed?: boolean
  /** Storage was rebuilt; refresh history without replaying presentations or replacing an opened detail. */
  historyReload?: boolean
  change?: NotificationChange
  preferences?: NotificationPreferences
  health: 'ready' | 'degraded'
  /** Sticky for this process: recovery of storage does not pretend missing history was recovered too. */
  historyIncomplete: boolean
  delivery?: NotificationDeliveryStatus
  openRequested?: NotificationOpenRequest
  announcement?: { id: string; expiresAt: number; signal?: 'connection' | 'reply'; group?: { source: string; title: string; detail: string; tone?: NotificationTone; target?: NotificationTarget; recordIds: string[] } }
}
export interface NotificationDeliveryStatus { nativeSupported: boolean; state: 'ready' | 'unsupported' | 'failed'; message?: string }
export interface NotificationOpenRequest { token: string; key: string; recordId: string; revision: number; grouped?: boolean }
export interface NotificationSessionPreference { scope: NotificationScope; mode: 'focus' | 'quiet' }
export interface NotificationGroupPresentation {
  keys: string[]
  source: string
  titleSuffix: string
  tone?: NotificationTone
  target?: NotificationTarget
}

export class NotificationActionError extends Error {
  readonly code = 'notification_action_invalid'
}

export interface NotificationPreferences {
  enabled: boolean
  nativeEnabled: boolean
  sound: boolean
  preview: boolean
  quiet: boolean
  mutedCategories: NotificationCategory[]
  nativeMutedCategories?: NotificationCategory[]
  inAppMutedCategories?: NotificationCategory[]
  connectionUpdates?: boolean
  replyUpdates?: boolean
  quietHours?: { enabled: boolean; startMinute: number; endMinute: number }
  sessionPreferences?: NotificationSessionPreference[]
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true, nativeEnabled: false, sound: false, preview: false, quiet: false, mutedCategories: [], nativeMutedCategories: [], inAppMutedCategories: [],
  connectionUpdates: false, replyUpdates: false, quietHours: { enabled: false, startMinute: 1_320, endMinute: 480 }, sessionPreferences: []
}

export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const quietHours = raw.quietHours && typeof raw.quietHours === 'object' ? raw.quietHours as Record<string, unknown> : {}
  const minute = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 1_440 ? value : fallback
  const sessionPreferences: NotificationSessionPreference[] = []
  const knownSessions = new Set<string>()
  if (Array.isArray(raw.sessionPreferences)) for (const value of raw.sessionPreferences.slice(-256).reverse()) {
    if (!value || typeof value !== 'object') continue
    const item = value as NotificationSessionPreference
    try { validateScope(item.scope) } catch { continue }
    if (!item.scope.sessionId || item.scope.generation === undefined || !['focus', 'quiet'].includes(item.mode)) continue
    const key = notificationSessionPreferenceKey(item.scope)
    if (knownSessions.has(key)) continue
    knownSessions.add(key); sessionPreferences.push({ scope: { ...item.scope }, mode: item.mode })
  }
  return {
    enabled: raw.enabled !== false,
    nativeEnabled: raw.nativeEnabled === true,
    sound: raw.sound === true,
    preview: raw.preview === true,
    quiet: raw.quiet === true,
    mutedCategories: Array.isArray(raw.mutedCategories)
      ? [...new Set(raw.mutedCategories.filter((entry): entry is NotificationCategory => NOTIFICATION_CATEGORIES.includes(entry as NotificationCategory)))]
      : [],
    nativeMutedCategories: Array.isArray(raw.nativeMutedCategories)
      ? [...new Set(raw.nativeMutedCategories.filter((entry): entry is NotificationCategory => NOTIFICATION_CATEGORIES.includes(entry as NotificationCategory)))] : [],
    inAppMutedCategories: Array.isArray(raw.inAppMutedCategories)
      ? [...new Set(raw.inAppMutedCategories.filter((entry): entry is NotificationCategory => NOTIFICATION_CATEGORIES.includes(entry as NotificationCategory)))] : [],
    connectionUpdates: raw.connectionUpdates === true, replyUpdates: raw.replyUpdates === true,
    quietHours: { enabled: quietHours.enabled === true, startMinute: minute(quietHours.startMinute, 1_320), endMinute: minute(quietHours.endMinute, 480) }, sessionPreferences
  }
}
/** Exact generation/binding identity, never channel alone. Group changes do not change who the session is. */
export function notificationSessionPreferenceKey(scope: NotificationScope): string {
  return JSON.stringify([scope.workspaceId ?? null, scope.runId ?? null, scope.sessionId ?? null, scope.generation ?? null, scope.composerId ?? null, scope.bindingGeneration ?? null])
}

export function notificationIsPending(record: NotificationRecord): boolean {
  return record.attention === 'action' && record.state === 'active'
}

export function notificationIsUnread(record: NotificationRecord): boolean {
  return record.archivedAt === undefined && record.attention !== 'activity' && record.readRevision < record.attentionRevision
}

export function validateNotificationDraft(input: NotificationDraft): void {
  if (!input.key.trim() || input.key.length > 300 || !NOTIFICATION_CATEGORIES.includes(input.category)) throw new Error('通知来源身份无效')
  if (!input.title.trim() || input.title.length > 160 || input.source.length > 120 || (input.detail?.length ?? 0) > 4_000) throw new Error('通知内容无效或过长')
  if (input.eventId !== undefined && (typeof input.eventId !== 'string' || input.eventId.length > 300)) throw new Error('通知事件身份无效')
  if (input.eventType !== undefined && (typeof input.eventType !== 'string' || !/^[a-z][a-z0-9_.-]{0,60}$/.test(input.eventType))) throw new Error('通知事件类型无效')
  if (input.subjectState !== undefined && (typeof input.subjectState !== 'string' || input.subjectState.length > 80)) throw new Error('通知来源状态无效')
  if (input.respectCleared !== undefined && typeof input.respectCleared !== 'boolean') throw new Error('通知清理策略无效')
  if (input.liveSignal !== undefined && !['connection', 'reply'].includes(input.liveSignal)) throw new Error('通知实时信号无效')
  if (!['info', 'success', 'warning', 'error'].includes(input.tone) || !['activity', 'notice', 'action'].includes(input.attention)
    || !['active', 'resolved', 'expired'].includes(input.state)) throw new Error('通知状态无效')
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0 || !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0 || input.occurredAt > 8_640_000_000_000_000) throw new Error('通知事件版本或时间无效')
  if (input.timeBasis !== undefined && !['occurred', 'observed'].includes(input.timeBasis)) throw new Error('通知时间依据无效')
  validateScope(input.scope)
  if (input.origin && (!['sessions', 'run', 'account'].includes(input.origin.module)
    || input.origin.section !== undefined && !['stats', 'accounts', 'import', 'automation', 'aozai', 'maintenance', 'cleanup', 'update'].includes(input.origin.section)
    || input.origin.sessionId !== undefined && (typeof input.origin.sessionId !== 'string' || input.origin.sessionId.length > 300))) throw new Error('通知原页面无效')
  const target = input.target
  if (target) {
    if (target.kind === 'settings') {
      if (!['stats', 'accounts', 'import', 'automation', 'aozai', 'maintenance', 'cleanup', 'update'].includes(target.section)) throw new Error('通知目标无效')
    } else if (target.kind === 'session') {
      validateScope(target.scope)
      for (const value of [target.entryId, target.toolCallId, target.blockId]) if (value !== undefined && (typeof value !== 'string' || value.length > 300)) throw new Error('通知目标无效')
      if (target.surface !== undefined && !['queue','context'].includes(target.surface)) throw new Error('通知目标区域无效')
    } else if (target.kind === 'run' || target.kind === 'collaboration') {
      for (const value of [target.runId, target.groupId]) if (value !== undefined && (typeof value !== 'string' || value.length > 300)) throw new Error('通知目标无效')
      if (target.kind === 'collaboration' && (!target.runId || !target.groupId || target.messageId !== undefined && (typeof target.messageId !== 'string' || target.messageId.length > 300))) throw new Error('协作通知目标无效')
    } else if(target.kind==='memory'){
      for(const value of[target.workspaceId,target.runId,target.memoryId,target.groupId])if(value!==undefined&&(typeof value!=='string'||!value||value.length>300))throw Error('记忆通知目标无效')
      if(!Number.isSafeInteger(target.version)||target.version<1)throw Error('记忆通知版本无效')
    }else throw new Error('通知目标无效')
  }
}

function validateScope(scope: NotificationScope): void {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('通知作用域无效')
  const keys = ['workspaceId', 'runId', 'groupId', 'slotId', 'sessionId', 'generation', 'bindingGeneration', 'channelId', 'composerId', 'accountId', 'providerId', 'operationFamilyId', 'contextDomain', 'installationId', 'cursorVersion','memoryId','memoryVersion','operatorRequestId','groupOperationId']
  for (const [key, value] of Object.entries(scope)) {
    if (!keys.includes(key) || value !== undefined && (typeof value !== 'string' || value.length > 300)) throw new Error('通知作用域无效')
  }
}

/** Defense in depth for diagnostic excerpts; adapters must still avoid passing credentials or full conversation text. */
export function notificationSafeText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[隐藏]@')
    .replace(/([?&](?:token|api[_-]?key|secret|password)=)[^&#\s]+/gi, '$1[隐藏]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[隐藏凭据]')
    .replace(/\b(?:CTI|CTK)-[A-Fa-f0-9]{16,}\b/g, '[隐藏卡密]')
    .replace(/((?:access[_ -]?token|refresh[_ -]?token|WorkosCursorSessionToken|password|cookie|卡密|密码)\s*[:=]\s*)[^\s,;]+/gi, '$1[隐藏]')
}

/** Source-local version and observation time are not changes worth another notification. */
export function notificationContentSignature(draft: NotificationDraft): string {
  const scope = (value: NotificationScope): Array<[string, string]> => Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined).sort(([a], [b]) => a.localeCompare(b))
  const reference = draft.target
  const target = reference?.kind === 'session' ? { kind: reference.kind, scope: scope(reference.scope), entryId: reference.entryId, toolCallId: reference.toolCallId, blockId: reference.blockId, surface: reference.surface }
    : reference?.kind === 'settings' ? { kind: reference.kind, section: reference.section }
      : reference?.kind === 'collaboration' ? { kind: reference.kind, runId: reference.runId, groupId: reference.groupId, messageId: reference.messageId }
        :reference?.kind==='memory'?{kind:reference.kind,workspaceId:reference.workspaceId,runId:reference.runId,groupId:reference.groupId,memoryId:reference.memoryId,version:reference.version}
        : reference ? { kind: reference.kind, runId: reference.runId, groupId: reference.groupId } : undefined
  return JSON.stringify([draft.category, draft.source, draft.eventId, draft.eventType, draft.subjectState, draft.title, draft.detail ?? '', draft.tone, draft.attention, draft.state, draft.timeBasis, scope(draft.scope), target, draft.origin])
}
