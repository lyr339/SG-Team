import type { ProcessingProviderId, ProcessingResult } from './processing-provider'
import { PROCESSING_PROVIDER_LABEL } from './processing-provider'
import type { NotificationDraft } from './notification'
import { notificationSafeText } from './notification'

export function processingNotification(input: { providerId: ProcessingProviderId; requestId: string; accountId?: string; result?: ProcessingResult; error?: string; submitted?: boolean; now: number }): Omit<NotificationDraft, 'sourceRevision'> {
  const result = input.result; const success = result?.ok === true; const notSubmitted = input.submitted === false
  return { key: `processing:${input.providerId}:${input.requestId}`, eventId: `processing:${input.requestId}:result`, eventType: 'processing.finished',
    category: 'processing', source: `${PROCESSING_PROVIDER_LABEL[input.providerId]}处理`, title: success ? `${PROCESSING_PROVIDER_LABEL[input.providerId]}处理已完成`
      : notSubmitted ? '处理请求尚未提交' : `${PROCESSING_PROVIDER_LABEL[input.providerId]}处理结果需核对`,
    detail: notificationSafeText(result?.message ?? input.error ?? '未取得可核验的返回结果。').slice(0, 2_000)
      + (success ? '\n这是独立处理结果，不代表后续加固、换号或清场已经执行。' : notSubmitted ? '\n前置准备未完成，此请求没有进入处理服务。请在原功能修正后再决定是否提交。' : '\n尚未确认成功，不代表请求没有执行；请先核对原服务结果，不会自动重提。'),
    scope: { providerId: input.providerId, ...(input.accountId ? { accountId: input.accountId } : {}) },
    origin: { module: 'account', section: input.accountId ? 'accounts' : 'aozai' }, target: { kind: 'settings', section: input.accountId ? 'accounts' : 'aozai' },
    tone: success ? 'success' : 'warning', attention: 'notice', state: success ? 'resolved' : 'active', occurredAt: input.now, timeBasis: 'observed', renewAttention: true, announce: true }
}
