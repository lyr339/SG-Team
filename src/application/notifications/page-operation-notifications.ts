import { createHash, randomUUID } from 'node:crypto'
import type { NotificationService } from '../notification-service'
import type { NotificationReference } from '../../domain/notification-reference'
import { PAGE_NOTIFICATION_OPERATIONS, pageOperationNotification, pageOperationReference, type PageOperationDefinition, type PageOperationOutcome } from '../../domain/page-operation-notification'

export interface PageOperationObservation {
  reference: NotificationReference
  finish(outcome: PageOperationOutcome): NotificationReference
  fail(error: unknown): NotificationReference
}
export interface PageOperationObserver { begin(definition: Omit<PageOperationDefinition, 'id'> & { id?: string }): PageOperationObservation }
const scopedOperationKinds = new Set(['account-login', 'patch-install', 'patch-remove', 'model-policy', 'debug-enable', 'question-answer', 'question-skip'])

/** Fail-soft adapter boundary. An observer never gets a business thunk or permission to repeat its action. */
export function beginPageOperation(observer: PageOperationObserver | undefined, definition: Omit<PageOperationDefinition, 'id'> & { id?: string }): PageOperationObservation | undefined {
  try { return observer?.begin(definition) } catch { return undefined }
}
export function finishPageOperation(operation: PageOperationObservation | undefined, outcome: PageOperationOutcome): NotificationReference | undefined {
  try { return operation?.finish(outcome) } catch { return undefined }
}
export function failPageOperation(operation: PageOperationObservation | undefined, error: unknown): void { try { operation?.fail(error) } catch {} }
export function notificationOperationId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = (value as Record<string, unknown>).notificationId
  return typeof id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id) ? id : undefined
}

export class PageOperationNotifications implements PageOperationObserver {
  private readonly current = new Set<string>()
  private stopped = false
  private readonly restoring: Promise<void>
  private readonly reconciliation = new Set<Promise<void>>()
  constructor(private readonly owner: NotificationService, private readonly now: () => number = Date.now) {
    this.restoring = this.restoreInterrupted().catch(() => owner.reportHistoryGap())
  }
  begin(input: Omit<PageOperationDefinition, 'id'> & { id?: string }): PageOperationObservation {
    if (!PAGE_NOTIFICATION_OPERATIONS.includes(input.kind)) throw Error('页面通知类型无效')
    const definition: PageOperationDefinition = { ...input, id: input.id ?? randomUUID(), scope: input.scope ? { ...input.scope } : {} }
    if (!definition.id || definition.id.length > 100) throw Error('页面通知身份无效')
    if (this.current.has(pageOperationReference(definition.kind, definition.id).key)) definition.id = randomUUID()
    const session = definition.scope
    const family = [definition.kind, session?.workspaceId, session?.runId, session?.accountId,
      session?.sessionId, session?.generation, session?.composerId, session?.bindingGeneration,
      definition.target?.kind === 'session' ? definition.target.toolCallId : undefined]
    // Only the new memory operations extend their identity. Inserting empty
    // fields into every kind would orphan existing saved login/question attempts.
    if (definition.kind === 'memory-accept' || definition.kind === 'memory-reject') family.push(session?.memoryId, session?.memoryVersion)
    definition.familyId = input.familyId ?? createHash('sha256').update(JSON.stringify(family)).digest('hex')
    if (scopedOperationKinds.has(definition.kind) && !input.familyId && !session?.accountId && !session?.sessionId && !session?.composerId) {
      // A global patch/version, selected browser or unbound Composer can change
      // between calls. Without exact object evidence, do not auto-resolve the old attempt.
      definition.familyId = createHash('sha256').update(JSON.stringify([definition.kind, definition.id])).digest('hex')
    }
    const reference = pageOperationReference(definition.kind, definition.id)
    this.current.add(reference.key)
    if (this.current.size > 512) this.current.delete(this.current.values().next().value!)
    if (!this.stopped) this.owner.offerCurrent(pageOperationNotification(definition, undefined, this.now()))
    let finished = false
    const finish = (outcome: PageOperationOutcome): NotificationReference => {
      if (finished || this.stopped) return reference
      finished = true
      this.owner.offerCurrent(pageOperationNotification(definition, outcome, this.now()))
      const task = this.resolvePreviousUnknown(definition, outcome).catch(() => this.owner.reportHistoryGap())
      this.reconciliation.add(task); void task.finally(() => { this.reconciliation.delete(task) })
      return reference
    }
    return { reference, finish, fail: error => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      const reasons: Record<string, string> = { EACCES: '原入口报告访问权限不足。', ENOSPC: '原入口报告存储空间不足。', EROFS: '原入口报告目标只读。', ETIMEDOUT: '原入口报告请求未及时返回。' }
      // Raw diagnostics can echo passwords, tokens or card text without a label.
      // Keep the original error at its source, not in another persistent store.
      return finish({ state: 'failed', facts: [typeof code === 'string' && Object.hasOwn(reasons, code) ? reasons[code]! : '原入口未确认本次操作完成，请查看原入口给出的具体原因。',
        '原输入与诊断未复制到通知。未据此推测全部动作都未发生，也不会自动重试。'] })
    } }
  }
  private async resolvePreviousUnknown(definition: PageOperationDefinition, outcome: PageOperationOutcome): Promise<void> {
    if (this.stopped || outcome.state !== 'success' || outcome.verifiedOnly) return
    if (!scopedOperationKinds.has(definition.kind)) return
    const records = new Map<string, import('../../domain/notification').NotificationRecord>()
    for (const eventType of ['page.operation.result', 'page.operation.interrupted']) {
      let cursor: { revision: number; offset: number } | undefined
      do {
        const page = await this.owner.page({ eventType, operationFamilyId: definition.familyId, limit: 100, ...(cursor ? { cursor } : {}) })
        if (this.stopped) return
        if (page.reset) return
        for (const record of page.records) records.set(record.key, record)
        cursor = page.nextCursor
      } while (cursor)
    }
    for (const record of records.values()) {
      if (record.scope.operationFamilyId !== definition.familyId || record.key === pageOperationReference(definition.kind, definition.id).key
        || !['failed', 'unconfirmed', 'waiting'].includes(record.subjectState ?? '')) continue
      const latest = (await this.owner.page({ key: record.key, limit: 1 })).records[0]
      if (!latest || latest.revision !== record.revision || this.stopped) continue
      this.owner.offerCurrent({ ...record, eventType: 'page.operation.superseded', subjectState: 'superseded', eventId: `${record.key}:superseded`, attention: 'activity', state: 'expired',
        title: '同一原对象已有后续确认结果', detail: '后续由原入口发起的操作已返回确认结果。旧尝试不被改写为成功，原业务与历史仍各自保留。\n' + (record.detail ?? ''),
        tone: 'info', renewAttention: false, announce: false, respectCleared: true })
    }
  }
  private async restoreInterrupted(): Promise<void> {
    let cursor: { revision: number; offset: number } | undefined, resets = 0
    const known = new Map<string, import('../../domain/notification').NotificationRecord>()
    do {
      const page = await this.owner.page({ eventType: 'page.operation.running', limit: 100, ...(cursor ? { cursor } : {}) })
      if (this.stopped) return
      if (page.reset) { known.clear(); if (++resets > 2) { this.owner.reportHistoryGap(); return } }
      for (const record of page.records) known.set(record.key, record)
      cursor = page.nextCursor
    } while (cursor)
    for (const record of known.values()) {
      if (this.stopped || this.current.has(record.key) || record.subjectState !== 'running') continue
      const latest = (await this.owner.page({ key: record.key, limit: 1 })).records[0]
      if (this.stopped || this.current.has(record.key) || !latest || latest.id !== record.id || latest.revision !== record.revision || latest.eventType !== 'page.operation.running') continue
      this.owner.offerCurrent({ ...record, eventType: 'page.operation.interrupted', eventId: `${record.key}:interrupted`, subjectState: 'unconfirmed',
        title: '上次页面操作结果待核对', detail: `上次只保存了入口受理状态，没有最终回执。不能据此确认操作已开始、已完成或完全没有执行；本次不会自动重跑。\n${record.source}`,
        tone: 'warning', attention: 'notice', state: 'active', timeBasis: 'observed', occurredAt: this.now(), announce: false, renewAttention: true })
    }
  }
  async flush(): Promise<void> { await this.restoring; while (this.reconciliation.size) await Promise.allSettled([...this.reconciliation]); await this.owner.flush() }
  dispose(): void { this.stopped = true; this.current.clear() }
}
