import type { NotificationHistoryIntegrity } from '../../../domain/notification-history'
import type { SgDesktopApi } from '../../../shared/desktop-api'
import type { AppUpdateStatus } from '../../../domain/app-update'
import { appUpdateNotification, appUpdateReceiptNotification } from '../../../domain/app-update-notification'
import { DEFAULT_NOTIFICATION_PREFERENCES, normalizeNotificationPreferences, notificationIsPending, notificationIsUnread, notificationContentSignature,
  type NotificationDraft, type NotificationPage, type NotificationPush, type NotificationQuery, type NotificationRecord } from '../../../domain/notification'

/** Browser-only fixtures. No native notifications, account operations or network connections. */
export function createNotificationPreview() {
  const records = new Map<string, NotificationRecord>(); const listeners = new Set<(event: NotificationPush) => void>()
  const scenario = new URLSearchParams(window.location.search).get('notifications')
  let history: NotificationHistoryIntegrity = scenario?.startsWith('history') ? { revision: 1, acknowledgedRevision: 0, latestGapId: '11111111-1111-4111-8111-111111111111', observedAt: Date.now() - 120_000 } : { revision: 0, acknowledgedRevision: 0 }
  let revision = 0; let preferences = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES)
  const filtered = (query: NotificationQuery = {}) => [...records.values()].filter(record => record.archivedAt === undefined
    && (!query.key || query.key === record.key)
    && (!query.eventType || query.eventType === record.eventType)
    && (!query.operationFamilyId || query.operationFamilyId === record.scope.operationFamilyId)
    && (!query.workspaceId || !record.scope.workspaceId || record.scope.workspaceId === query.workspaceId)
    && (!query.sessionId || record.scope.sessionId === query.sessionId)
    && (!query.generation || record.scope.generation === query.generation)
    && (!query.contextDomain || record.scope.contextDomain === query.contextDomain)
    && (!query.installationId || record.scope.installationId === query.installationId)
    && (!query.runId || record.scope.runId === query.runId)
    && (!query.memoryId || record.scope.memoryId === query.memoryId)
    && (!query.entryId || record.target?.kind === 'session' && record.target.entryId === query.entryId)
    && (!query.toolCallId || record.target?.kind === 'session' && record.target.toolCallId === query.toolCallId)
    && (!query.category || query.category === record.category))
  const summary = (query: NotificationQuery = {}) => {
    const rows = filtered(query)
    return { revision, total: rows.length, unread: rows.filter(notificationIsUnread).length, pending: rows.filter(notificationIsPending).length,
      clearable: rows.filter(record => record.attention !== 'activity' && !notificationIsUnread(record) && !notificationIsPending(record)).length }
  }
  const emit = (record?: NotificationRecord, announcement?: NotificationPush['announcement']) => {
    const change = { changed: true, summary: summary(), ...(record ? { record: structuredClone(record) } : {}) }
    for (const listener of listeners) listener({ change, health: 'ready', historyIncomplete: history.revision > 0, historyIntegrity: structuredClone(history), historyGapUnconfirmed: false, ...(announcement ? { announcement } : {}) })
    return change
  }
  const offer = (draft: Omit<NotificationDraft, 'sourceRevision'>) => {
    const old = [...records.values()].find(record => record.key === draft.key)
    if (old && notificationContentSignature(old) === notificationContentSignature({ ...draft, sourceRevision: 0 })) return
    const { announce, renewAttention, liveSignal: _liveSignal, respectCleared: _respectCleared, ...content } = draft; const next = ++revision
    const record: NotificationRecord = { ...content, id: old?.id ?? `notification-preview-${next}`, sourceRevision: (old?.sourceRevision ?? 0) + 1,
      revision: next, attentionRevision: draft.attention === 'activity' ? 0 : !old || renewAttention ? next : old.attentionRevision,
      readRevision: old?.readRevision ?? 0, createdAt: old?.createdAt ?? Date.now(), updatedAt: Date.now() }
    records.set(record.id, record)
    emit(record, announce ? { id: `${record.id}:${record.attentionRevision}`, expiresAt: Date.now() + 60_000 } : undefined)
  }
  const page = async (query: NotificationQuery = {}): Promise<NotificationPage> => {
    const rows = filtered(query).filter(record => query.filter === 'unread' ? notificationIsUnread(record) : query.filter === 'pending' ? notificationIsPending(record) : true)
      .sort((a, b) => Number(notificationIsPending(b)) - Number(notificationIsPending(a)) || Number(a.attention === 'activity') - Number(b.attention === 'activity') || b.revision - a.revision)
    if (query.readCursor !== undefined) {
      const cursor = query.readCursor, reset = cursor !== 'start' && cursor.ceiling > revision
      const ceiling = cursor === 'start' || reset ? revision : cursor.ceiling, after = cursor === 'start' || reset ? undefined : cursor
      const values = rows.filter(record => record.revision <= ceiling && (!after || record.revision < after.revision || record.revision === after.revision && record.id < after.id))
        .sort((a, b) => b.revision - a.revision || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)), limit = Math.min(100, query.limit ?? 30), entries = values.slice(0, limit), last = entries.at(-1)
      return { records: structuredClone(entries), summary: summary(query), reset, health: 'ready', historyIncomplete: history.revision > 0, historyIntegrity: structuredClone(history), historyGapUnconfirmed: false,
        ...(values.length > limit && last ? { nextReadCursor: { revision: last.revision, id: last.id, ceiling } } : {}) }
    }
    const reset = query.cursor !== undefined && query.cursor.revision !== revision
    const offset = reset ? 0 : query.cursor?.offset ?? 0; const limit = query.limit ?? 30
    return { records: structuredClone(rows.slice(offset, offset + limit)), summary: summary(query), reset, health: 'ready', historyIncomplete: history.revision > 0, historyIntegrity: structuredClone(history), historyGapUnconfirmed: false,
      delivery: { nativeSupported: true, state: 'ready' }, // Pure preview capability; never calls Electron or system settings.
      ...(rows.length > offset + limit ? { nextCursor: { revision, offset: offset + limit } } : {}) }
  }
  const api: Pick<SgDesktopApi, 'getNotificationPage' | 'readNotification' | 'readAllNotifications' | 'archiveNotification' | 'clearReadNotifications' | 'getNotificationPreferences' | 'saveNotificationPreferences' | 'onNotificationChanged' | 'acknowledgeNotificationHistory'> = {
    getNotificationPage: page,
    acknowledgeNotificationHistory: async shown => {
      const before = { ...history, acknowledgedRevision: Math.max(history.acknowledgedRevision, shown), acknowledgedAt: Date.now() }
      history = before
      if (scenario === 'history-late' && shown === 1) history = { ...before, revision: 2, latestGapId: '22222222-2222-4222-8222-222222222222', observedAt: Date.now() }
      for (const listener of listeners) listener({ health: 'ready', historyIncomplete: true, historyIntegrity: { ...history }, historyGapUnconfirmed: false })
      return before
    },
    readNotification: async ({ id, revision: observed }) => {
      const record = records.get(id)
      if (record && record.attention !== 'activity' && observed >= record.attentionRevision && notificationIsUnread(record)) {
        record.readRevision = record.attentionRevision; record.readAt = Date.now(); ++revision; return emit(record)
      }
      return { changed: false, summary: summary() }
    },
    readAllNotifications: async ({ query = {}, revision: observed }) => {
      for (const record of filtered(query)) if (record.attentionRevision <= observed && notificationIsUnread(record) && (query.filter !== 'pending' || notificationIsPending(record))) {
        record.readRevision = record.attentionRevision; record.readAt = Date.now()
      }
      ++revision; return emit()
    },
    archiveNotification: async id => {
      const record = records.get(id)
      if (record && notificationIsPending(record)) throw Error('此事项仍待处理')
      if (record) record.archivedAt = Date.now()
      ++revision; return emit(record)
    },
    clearReadNotifications: async ({ query, confirmed }) => {
      if (!confirmed) throw Error('请先确认清理')
      for (const record of filtered(query)) if (record.attention !== 'activity' && !notificationIsUnread(record) && !notificationIsPending(record)) records.delete(record.id)
      ++revision; return emit()
    },
    getNotificationPreferences: async () => structuredClone(preferences),
    saveNotificationPreferences: async input => {
      preferences = normalizeNotificationPreferences(input)
      for (const listener of listeners) listener({ preferences: structuredClone(preferences), health: 'ready', historyIncomplete: history.revision > 0, historyIntegrity: structuredClone(history), historyGapUnconfirmed: false })
      return structuredClone(preferences)
    },
    onNotificationChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback) } }
  }
  if (scenario && !['empty','human','context','memory','restore','compatibility','operator-memory','group-effects','mcp-write','source-history','usage-store','model-catalog','usage-runtime','context-source','usage-binding','native-content'].includes(scenario)) {
    const templates = [
      { key: 'preview:automation', category: 'automation' as const, source: '自动化', title: '主要步骤已完成，浏览器清场未完成', detail: '处理和加固已经完成；浏览器清场未结束。请查看本轮详情，不要重复执行已完成的步骤。', tone: 'warning' as const, attention: 'action' as const, state: 'active' as const, target: { kind: 'settings' as const, section: 'automation' as const } },
      { key: 'preview:batch', category: 'run' as const, source: '运行 · 接口重构', title: '6 个会话已就绪，2 个尚未接入', detail: '批量发起已结束。未接入成员的结果可在运行页逐项查看；已就绪会话保持可用。', tone: 'warning' as const, attention: 'notice' as const, state: 'resolved' as const, target: { kind: 'run' as const } },
      { key: 'preview:cleanup', category: 'storage' as const, source: '存储清理', title: '清理完成，运行中的会话数据已保留', detail: '已完成所选项目，跳过仍被本轮会话绑定的历史数据。', tone: 'success' as const, attention: 'notice' as const, state: 'resolved' as const, target: { kind: 'settings' as const, section: 'cleanup' as const } },
      { key: 'preview:online', category: 'sessions' as const, source: '会话 · 前端体验', title: 'CH-3 已上线', detail: '通信已接入，正常生命周期只安静记录。', tone: 'info' as const, attention: 'activity' as const, state: 'resolved' as const }
    ]
    for (let index = (scenario === 'many' ? 72 : templates.length) - 1; index >= 0; index--) {
      const item = templates[index % templates.length]!
      offer({ ...item, key: `${item.key}:${index}`, scope: {}, occurredAt: Date.now() - (index + 1) * 240_000,
        ...(scenario === 'long' ? { title: item.title + ' · 跨工作区与成员身份校验', detail: `${item.detail}\n\n${'src/long_unbroken_workspace_path/'.repeat(18)}` } : {}) })
    }
    if (scenario === 'toast') setTimeout(() => {
      offer({ ...templates[2]!, key: 'preview:live-cleanup', scope: {}, occurredAt: Date.now(), announce: true })
    }, 1_200)
    if (scenario === 'native') setTimeout(() => {
      const record = [...records.values()].find(record => record.key.startsWith('preview:cleanup:'))
      if (record) for (const listener of listeners) listener({ health: 'ready', historyIncomplete: history.revision > 0, historyIntegrity: structuredClone(history), historyGapUnconfirmed: false, openRequested: {
        token: 'preview-native-open:1', key: record.key, recordId: record.id, revision: record.revision
      } })
    }, 1_200)
  }
  return { api, offer, observeUpdate: (status: AppUpdateStatus, live = false) => { const draft = appUpdateNotification(status, live); const receipt = appUpdateReceiptNotification(status); if (draft) offer(draft); if (receipt) offer(receipt) } }
}
