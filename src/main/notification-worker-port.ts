import type { Worker } from 'node:worker_threads'
import type { NotificationRepository } from '../application/notification-repository'
import type { NotificationChange, NotificationDraft, NotificationMarker, NotificationPage, NotificationPreferences, NotificationQuery, NotificationSourceResult, NotificationSourceState } from '../domain/notification'
import type { NotificationWorkerCommand, NotificationWorkerReply } from './notification-worker'

type WorkerFactory = (options: { workerData: { databasePath: string } }) => Worker
type Waiter = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Long-lived worker, bounded RPCs; SQLite never waits for a lock in the Electron main thread. */
export class NotificationWorkerPort implements NotificationRepository {
  private readonly worker: Worker
  private readonly ready: Promise<void>
  private readonly pending = new Map<number, Waiter>()
  private sequence = 0
  private closed = false
  private failure?: Error
  private closing?: Promise<void>

  constructor(createWorker: WorkerFactory, databasePath: string, private readonly timeoutMs = 5_000) {
    this.worker = createWorker({ workerData: { databasePath } })
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.on('message', (reply: NotificationWorkerReply) => {
        if (reply.id === 0) {
          if (reply.ok) resolve()
          else { this.failure = new Error(reply.error); reject(this.failure) }
          return
        }
        const waiter = this.pending.get(reply.id)
        if (!waiter) return
        this.pending.delete(reply.id); clearTimeout(waiter.timer)
        if (reply.ok) waiter.resolve(reply.result)
        else waiter.reject(Object.assign(new Error(reply.error), { retryable: reply.retryable, code: reply.code }))
      })
      const fail = (error: Error): void => {
        this.failure = error; reject(error)
        for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
        this.pending.clear()
      }
      this.worker.on('error', fail)
      this.worker.on('exit', code => { if (!this.closed) fail(new Error(`通知工作线程已退出（${code}）`)) })
    })
    // Initialization failures are reported by subsequent reads; they must not crash unrelated business callbacks.
    void this.ready.catch(() => {})
  }

  private async request<T>(command: NotificationWorkerCommand): Promise<T> {
    if (this.closed) throw new Error('通知存储已关闭')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('通知存储初始化未及时返回')), this.timeoutMs)
      this.ready.then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error) })
    })
    if (this.failure) throw this.failure
    if (this.pending.size >= 64) throw new Error('通知存储请求过多，请稍后重试')
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A timeout is not proof the transaction failed. Do not replay writes or terminate a live worker.
        reject(new Error('通知存储未及时返回，操作结果待确认'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try { this.worker.postMessage({ id, command }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  private async call<T>(command: NotificationWorkerCommand): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.request<T>(command) }
      catch (error) {
        if (!(error && typeof error === 'object' && 'retryable' in error && error.retryable === true) || attempt >= 2) throw error
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
  }
  put(draft: NotificationDraft, now: number): Promise<NotificationChange> { return this.call({ kind: 'put', draft, now }) }
  marker(key: string): Promise<NotificationMarker> { return this.call({ kind: 'marker', key }) }
  sourceState(key: string): Promise<NotificationSourceState> { return this.call({ kind: 'sourceState', key }) }
  commitSource(key: string, expectedRevision: number, data: unknown, drafts: NotificationDraft[], now: number): Promise<NotificationSourceResult> {
    return this.call({ kind: 'commitSource', key, expectedRevision, data, drafts, now })
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
    this.closing = (async () => {
      try { await this.request({ kind: 'close' }) }
      finally {
        this.closed = true
        for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('通知存储已关闭')) }
        this.pending.clear()
        await this.worker.terminate()
      }
    })()
    return this.closing
  }
}
