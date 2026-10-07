import type { NotificationSourceListPage, NotificationSourceListQuery } from '../domain/native-scope-availability'
import type { NotificationDeliveryClaim } from '../domain/notification-delivery-claim'
import type { Worker } from 'node:worker_threads'
import type { NotificationRepository, NotificationRepositoryLifecycle } from '../application/notification-repository'
import type { NotificationChange, NotificationDraft, NotificationMarker, NotificationPage, NotificationPreferences, NotificationQuery, NotificationSourceResult, NotificationSourceState } from '../domain/notification'
import type { NotificationWorkerCommand, NotificationWorkerReply } from './notification-worker'
import type { NotificationHistoryIntegrity, NotificationHistoryStatus } from '../domain/notification-history'
import type { OperatorMessageRecordMetadata } from '../domain/team-message-notification'
import type { McpWriteRecordMetadata } from '../domain/mcp-write-notification'
import type { ReplyIdentityBatch, ReplyIdentityMatch } from '../domain/reply-identity-index'
import type { QuestionTerminalBatch, QuestionTerminalReceipt } from '../domain/question-terminal-receipt'

type WorkerFactory = (options: { workerData: { databasePath: string } }) => Worker
type Waiter = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
interface WorkerSession {
  worker: Worker
  generation: number
  ready: Promise<void>
  pending: Map<number, Waiter>
  preparing: number
  initialized: boolean
  initializationObservedLate: boolean
  exited: boolean
  failure?: Error
}
export interface NotificationWorkerRecoveryOptions { delaysMs?: readonly number[]; windowMs?: number }
const requestLimit = 64

/** One live SQLite owner. Only a confirmed exit permits bounded replacement; unknown RPCs are never replayed. */
export class NotificationWorkerPort implements NotificationRepository {
  private session?: WorkerSession
  private readonly listeners = new Set<(event: NotificationRepositoryLifecycle) => void>()
  private readonly restarts: number[] = []
  private readonly delays: readonly number[]
  private readonly windowMs: number
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private sequence = 0
  private generation = 0
  private closed = false
  private stopping = false
  private failure?: Error
  private closing?: Promise<void>

  constructor(private readonly createWorker: WorkerFactory, private readonly databasePath: string, private readonly timeoutMs = 5_000, recovery: NotificationWorkerRecoveryOptions = {}) {
    this.delays = recovery.delaysMs ?? [100, 500, 1_500]
    this.windowMs = recovery.windowMs ?? 60_000
    if (this.delays.some(delay => !Number.isSafeInteger(delay) || delay < 1) || this.delays.length > 10 || !Number.isSafeInteger(this.windowMs) || this.windowMs < 1) throw Error('通知恢复配置无效')
    this.spawn()
  }
  subscribeLifecycle(listener: (event: NotificationRepositoryLifecycle) => void): () => void {
    this.listeners.add(listener)
    if (this.failure) { try { listener({ state: 'unavailable', generation: this.generation }) } catch {} }
    return () => { this.listeners.delete(listener) }
  }
  private emit(state: NotificationRepositoryLifecycle['state'], generation: number): void {
    if (this.stopping || this.closed) return
    for (const listener of this.listeners) { try { listener({ state, generation }) } catch { /* Storage diagnostics cannot fail business callbacks. */ } }
  }
  private spawn(): void {
    if (this.session || this.stopping || this.closed) return
    const generation = ++this.generation
    let worker: Worker
    try { worker = this.createWorker({ workerData: { databasePath: this.databasePath } }) }
    catch (error) {
      // No worker was created, so there is no live owner to kill or unknown command to replay.
      this.failure = error instanceof Error ? error : Error('通知线程未能创建')
      this.emit('unavailable', generation); this.scheduleRecovery(); return
    }
    let readyResolve!: () => void, readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    void ready.catch(() => {})
    const session: WorkerSession = { worker, generation, ready, pending: new Map(), preparing: 0, initialized: false, initializationObservedLate: false, exited: false }
    this.session = session
    const fail = (error: Error): void => {
      session.failure = error; this.failure = error; readyReject(error)
      for (const waiter of session.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
      // On error alone the worker may still be alive; retain capacity until reply/exit.
      this.emit('unavailable', generation)
    }
    const message = (reply: NotificationWorkerReply): void => {
      if (session !== this.session || session.exited) return
      if (reply.id === 0) {
        if (session.initialized || session.failure) return
        if (!reply.ok) { fail(Error(reply.error)); return }
        session.initialized = true; this.failure = undefined; readyResolve()
        if (generation > 1 || session.initializationObservedLate) this.emit('recovered', generation)
        return
      }
      const waiter = session.pending.get(reply.id)
      if (!waiter) return
      session.pending.delete(reply.id); clearTimeout(waiter.timer)
      if (reply.ok) waiter.resolve(reply.result)
      else waiter.reject(Object.assign(Error(reply.error), { retryable: reply.retryable, code: reply.code }))
    }
    const exit = (code: number): void => {
      session.exited = true
      worker.off('message', message); worker.off('error', fail); worker.off('exit', exit)
      if (session !== this.session) return
      if (!this.stopping && !this.closed) fail(Error(`通知工作线程已退出（${code}）`))
      else {
        readyReject(Error('通知存储已关闭'))
        for (const waiter of session.pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('通知存储已关闭')) }
      }
      session.pending.clear(); this.session = undefined
      this.scheduleRecovery()
    }
    worker.on('message', message); worker.on('error', fail); worker.on('exit', exit)
  }
  private scheduleRecovery(): void {
    if (this.session || this.recoveryTimer || this.stopping || this.closed) return
    const now = Date.now()
    while (this.restarts.length && this.restarts[0]! <= now - this.windowMs) this.restarts.shift()
    const delay = this.delays[this.restarts.length]
    // Exhaustion remains fail-soft. After the window, a new caller may request
    // another bounded recovery; no periodic restart loop is left running.
    if (delay === undefined) return
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined
      if (this.session || this.stopping || this.closed) return
      this.restarts.push(Date.now()); this.spawn()
    }, delay)
    this.recoveryTimer.unref?.()
  }
  private async request<T>(command: NotificationWorkerCommand): Promise<T> {
    if (this.closed || this.stopping && command.kind !== 'close') throw Error('通知存储已关闭')
    const session = this.session
    if (!session) { this.scheduleRecovery(); throw this.failure ?? Error('通知存储正在恢复，请稍后重试') }
    if (session.failure) throw session.failure
    if (command.kind !== 'close' && session.pending.size + session.preparing >= requestLimit) throw Error('通知存储请求过多，请稍后重试')
    ++session.preparing
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { session.initializationObservedLate = true; reject(Error('通知存储初始化未及时返回')) }, this.timeoutMs)
        session.ready.then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error) })
      })
    } finally { --session.preparing }
    if (session.failure || session.exited || session !== this.session) throw session.failure ?? Error('通知线程已更换，原请求不重放')
    if (this.closed || this.stopping && command.kind !== 'close') throw Error('通知存储已关闭')
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Keep the unknown RPC occupying its capacity until its real reply or
        // exit. A caller timeout cannot create an unbounded queue in a live worker.
        reject(Error('通知存储未及时返回，操作结果待确认'))
      }, this.timeoutMs)
      session.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try { session.worker.postMessage({ id, command }) }
      catch (error) { clearTimeout(timer); session.pending.delete(id); reject(error) }
    })
  }
  private async call<T>(command: NotificationWorkerCommand): Promise<T> {
    const session = this.session
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0 && this.session !== session) throw Error('通知线程已更换，已回滚的旧请求仍不重放到新历史')
      try { return await this.request<T>(command) }
      catch (error) {
        // Only a worker's explicit rolled-back BUSY/LOCKED result is retryable.
        // Ready/RPC timeouts, errors and exits never carry this permission.
        if (!(error && typeof error === 'object' && 'retryable' in error && error.retryable === true) || attempt >= 2) throw error
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
  }
  put(draft: NotificationDraft, now: number): Promise<NotificationChange> { return this.call({ kind: 'put', draft, now }) }
  historyGap(id?: string): Promise<NotificationHistoryStatus> { return this.call({ kind: 'historyGap', id }) }
  recordHistoryGap(id: string, now: number): Promise<NotificationHistoryIntegrity> { return this.call({ kind: 'recordHistoryGap', id, now }) }
  acknowledgeHistoryGap(revision: number, now: number): Promise<NotificationHistoryIntegrity> { return this.call({ kind: 'acknowledgeHistoryGap', revision, now }) }
  pruneRoutine(now: number): Promise<NotificationChange & { removed: number; more: boolean }> { return this.call({ kind: 'pruneRoutine', now }) }
  marker(key: string): Promise<NotificationMarker> { return this.call({ kind: 'marker', key }) }
  sourceState(key: string): Promise<NotificationSourceState> { return this.call({ kind: 'sourceState', key }) }
  claimDelivery(claim: NotificationDeliveryClaim, now: number): Promise<boolean> { return this.call({ kind: 'claimDelivery', claim, now }) }
  listNativeSources(query: NotificationSourceListQuery): Promise<NotificationSourceListPage> { return this.call({ kind: 'listNativeSources', query }) }
  operatorMessageRecords(keys: string[]): Promise<OperatorMessageRecordMetadata[]> { return this.call({ kind: 'operatorMessageRecords', keys }) }
  mcpWriteRecords(keys: string[]): Promise<McpWriteRecordMetadata[]> { return this.call({ kind: 'mcpWriteRecords', keys }) }
  replyIdentities(sourceKey: string, aliases: string[]): Promise<ReplyIdentityMatch[]> { return this.call({ kind: 'replyIdentities', sourceKey, aliases }) }
  questionTerminals(sourceKey: string, identities: string[]): Promise<QuestionTerminalReceipt[]> { return this.call({ kind: 'questionTerminals', sourceKey, identities }) }
  commitSource(key: string, expectedRevision: number, data: unknown, drafts: NotificationDraft[], now: number, replyIdentities?: ReplyIdentityBatch, questionTerminals?: QuestionTerminalBatch): Promise<NotificationSourceResult> {
    return this.call({ kind: 'commitSource', key, expectedRevision, data, drafts, now, replyIdentities, questionTerminals })
  }
  page(query?: NotificationQuery): Promise<NotificationPage> { return this.call({ kind: 'page', query }) }
  read(id: string, revision: number, now: number): Promise<NotificationChange> { return this.call({ kind: 'read', id, revision, now }) }
  readAll(query: NotificationQuery, revision: number, now: number): Promise<NotificationChange> { return this.call({ kind: 'readAll', query, revision, now }) }
  archive(id: string, now: number): Promise<NotificationChange> { return this.call({ kind: 'archive', id, now }) }
  clearRead(query: NotificationQuery, now: number): Promise<NotificationChange> { return this.call({ kind: 'clearRead', query, now }) }
  preferences(): Promise<NotificationPreferences> { return this.call({ kind: 'preferences' }) }
  savePreferences(preferences: NotificationPreferences): Promise<NotificationPreferences> { return this.call({ kind: 'savePreferences', preferences }) }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopping = true
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined }
    const session = this.session
    this.closing = (async () => {
      try { await this.request({ kind: 'close' }) }
      finally {
        this.closed = true; this.listeners.clear()
        if (session) {
          for (const waiter of session.pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('通知存储已关闭')) }
          session.pending.clear()
          // Explicit app shutdown only; runtime timeouts never reach terminate.
          if (!session.exited) await session.worker.terminate()
        }
      }
    })()
    return this.closing
  }
}
