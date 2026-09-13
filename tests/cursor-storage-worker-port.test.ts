import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cursorStorageDatabasePorts } from '../src/main/cursor-storage-worker-port'
import type { CursorStorageWorkerRequest } from '../src/main/cursor-storage-worker'

class FakeWorker extends EventEmitter {
  terminated = 0
  constructor(readonly workerData: CursorStorageWorkerRequest) {
    super()
  }

  async terminate(): Promise<number> {
    this.terminated += 1
    return 0
  }
}

function harness() {
  const workers: FakeWorker[] = []
  const ports = cursorStorageDatabasePorts(({ workerData }) => {
    const worker = new FakeWorker(workerData)
    workers.push(worker)
    return worker as unknown as Worker
  })
  return { workers, ports }
}

const ANALYZE_INPUT = { databasePath: '/db/state.vscdb', olderThanDays: 90, protectedComposerIds: [] }

describe('存储清理 worker 端口', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('一次请求一个 worker：workerData 携带请求，首条消息即结果，随后终止线程', async () => {
    const { workers, ports } = harness()
    const pending = ports.analyzeDatabase(ANALYZE_INPUT)
    expect(workers).toHaveLength(1)
    expect(workers[0]!.workerData).toEqual({ kind: 'analyze', input: ANALYZE_INPUT })
    workers[0]!.emit('message', { ok: true, result: { candidateIds: ['a'] } })
    await expect(pending).resolves.toEqual({ candidateIds: ['a'] })
    // 结果到达后 exit 事件不再产生第二次结算。
    workers[0]!.emit('exit', 1)
    expect(workers[0]!.terminated).toBe(1)
  })

  it('worker 报告失败 / 抛错 / 异常退出 都变成带原因的 reject，且只结算一次', async () => {
    const { workers, ports } = harness()
    const failed = ports.pruneDatabase({ databasePath: '/db', composerIds: ['a'] })
    workers[0]!.emit('message', { ok: false, error: 'database is locked' })
    await expect(failed).rejects.toThrow('database is locked')

    const crashed = ports.analyzeDatabase(ANALYZE_INPUT)
    workers[1]!.emit('error', new Error('SQLITE_CORRUPT'))
    await expect(crashed).rejects.toThrow('SQLITE_CORRUPT')

    const exited = ports.analyzeDatabase(ANALYZE_INPUT)
    workers[2]!.emit('exit', 137)
    await expect(exited).rejects.toThrow('数据库工作线程异常退出（137）')
    expect(workers.map((worker) => worker.terminated)).toEqual([1, 1, 1])
  })

  it('分析 2 分钟、删除 10 分钟、含压实 30 分钟超时；超时终止 worker 并提示重试', async () => {
    const { workers, ports } = harness()
    const analyze = ports.analyzeDatabase(ANALYZE_INPUT)
    const analyzeRejected = expect(analyze).rejects.toThrow('数据库操作超时，请稍后重试')
    await vi.advanceTimersByTimeAsync(120_000)
    await analyzeRejected
    expect(workers[0]!.terminated).toBe(1)

    const prune = ports.pruneDatabase({ databasePath: '/db', composerIds: ['a'] })
    const compact = ports.pruneDatabase({ databasePath: '/db', composerIds: ['a'], compact: true })
    let pruneSettled = false
    let compactSettled = false
    prune.catch(() => { pruneSettled = true })
    compact.catch(() => { compactSettled = true })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(pruneSettled).toBe(true)
    expect(compactSettled).toBe(false)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(compactSettled).toBe(true)
    expect(workers.map((worker) => worker.terminated)).toEqual([1, 1, 1])
  })
})
