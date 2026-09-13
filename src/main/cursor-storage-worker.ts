import { parentPort, workerData } from 'node:worker_threads'
import {
  analyzeCursorStateDatabase,
  pruneCursorStateDatabase,
  type CursorStateDatabaseAnalysisInput,
  type CursorStateDatabasePruneInput
} from '../infrastructure/cursor/cursor-state-db-analysis'

/**
 * 存储清理的数据库工作线程：一次请求一个 worker（workerData 进、一条 message 出）。
 * 22GB 的 state.vscdb 上索引遍历要数秒、VACUUM 要数分钟，同步 node:sqlite 不能落在主线程。
 */
export type CursorStorageWorkerRequest =
  | { kind: 'analyze'; input: CursorStateDatabaseAnalysisInput }
  | { kind: 'prune'; input: CursorStateDatabasePruneInput }

export type CursorStorageWorkerResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

function run(request: CursorStorageWorkerRequest): unknown {
  switch (request.kind) {
    case 'analyze': return analyzeCursorStateDatabase(request.input)
    case 'prune': return pruneCursorStateDatabase(request.input)
  }
}

const request = workerData as CursorStorageWorkerRequest | undefined
if (parentPort && request) {
  let response: CursorStorageWorkerResponse
  try {
    response = { ok: true, result: run(request) }
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  parentPort.postMessage(response)
}
