import { CURSOR_STORAGE_CATALOG, type CursorStorageCleanupResult } from './cursor-storage-cleanup'
import { notificationSafeText, type NotificationDraft } from './notification'
import { formatFileSize } from '../shared/format-file-size'

export function storageCleanupNotification(operationId: string, result: CursorStorageCleanupResult | undefined, error: string | undefined, now: number): Omit<NotificationDraft, 'sourceRevision'> {
  const partial = result?.ok === false && result.done.length > 0
  const success = result?.ok === true
  const details = result ? `${notificationSafeText(result.message)}\n按返回结果确认释放 ${formatFileSize(result.freedBytes)}，完成 ${result.done.length} 项。`
    + (result.skipped.length ? '\n跳过：' + result.skipped.map(item => `${CURSOR_STORAGE_CATALOG.find(spec => spec.id === item.id)?.label ?? item.id} · ${notificationSafeText(item.reason)}`).join('\n') : '')
    : `未取得完整清理结果：${notificationSafeText(error ?? '未知返回状态')}。这不证明所有清理项都未执行；请先重新盘点。`
  return { key: `storage-cleanup:${operationId}`, eventId: `storage-cleanup:${operationId}:result`, eventType: 'storage.finished', category: 'storage', source: '存储清理',
    title: success ? '存储清理已完成' : partial ? '部分项目已清理，仍有项目未完成' : result ? '存储清理未完成' : '存储清理结果待核对',
    detail: details.slice(0, 3_800), tone: success ? 'success' : 'warning', attention: success ? 'notice' : 'action', state: success ? 'resolved' : 'active', scope: {},
    origin: { module: 'account', section: 'cleanup' }, target: { kind: 'settings', section: 'cleanup' }, occurredAt: now, timeBasis: 'observed', announce: true, renewAttention: true }
}
