import type { Worker } from 'node:worker_threads'
import type {
  CursorStateDatabaseAnalysis,
  CursorStateDatabaseAnalysisInput,
  CursorStateDatabasePruneInput,
  CursorStateDatabasePruneResult
} from '../infrastructure/cursor/cursor-state-db-analysis'
import type { CursorStorageWorkerRequest, CursorStorageWorkerResponse } from './cursor-storage-worker'

type CreateWorker = (options: { workerData: CursorStorageWorkerRequest }) => Worker

/** 一次请求一个 worker：结果一到就结束线程，主线程只等一条消息。 */
function runInWorker<T>(createWorker: CreateWorker, request: CursorStorageWorkerRequest, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = createWorker({ workerData: request })
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
      void worker.terminate().catch(() => {})
    }
    const timer = setTimeout(() => finish(() => reject(new Error('数据库操作超时，请稍后重试'))), timeoutMs)
    worker.once('message', (response: CursorStorageWorkerResponse) => finish(() => {
      if (response.ok) resolve(response.result as T)
      else reject(new Error(response.error))
    }))
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) => finish(() => reject(new Error(`数据库工作线程异常退出（${code}）`))))
  })
}

/** 把 worker 工厂包成扫描器需要的两个端口。 */
export function cursorStorageDatabasePorts(createWorker: CreateWorker): {
  analyzeDatabase: (input: CursorStateDatabaseAnalysisInput) => Promise<CursorStateDatabaseAnalysis>
  pruneDatabase: (input: CursorStateDatabasePruneInput) => Promise<CursorStateDatabasePruneResult>
} {
  return {
    analyzeDatabase: (input) => runInWorker<CursorStateDatabaseAnalysis>(createWorker, { kind: 'analyze', input }, 120_000),
    // VACUUM 一个 20GB 的库要数分钟；删除本身秒级。
    pruneDatabase: (input) => runInWorker<CursorStateDatabasePruneResult>(createWorker, { kind: 'prune', input }, input.compact ? 30 * 60_000 : 10 * 60_000)
  }
}
