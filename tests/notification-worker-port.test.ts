import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { NotificationWorkerPort } from '../src/main/notification-worker-port'

class FakeWorker extends EventEmitter {
  postMessage = vi.fn()
  terminate = vi.fn(async () => 0)
}

describe('notification worker RPC boundary', () => {
  it('waits for database readiness, maps responses and gracefully terminates the worker', async () => {
    const worker = new FakeWorker(); const port = new NotificationWorkerPort(() => worker as unknown as Worker, 'file.sqlite')
    const reading = port.page()
    expect(worker.postMessage).not.toHaveBeenCalled()
    worker.emit('message', { id: 0, ok: true }); await Promise.resolve(); await Promise.resolve()
    const request = worker.postMessage.mock.calls[0]![0] as { id: number }
    worker.emit('message', { id: request.id, ok: true, result: { records: [], reset: false } })
    expect(await reading).toMatchObject({ records: [] })
    const closing = port.close(); await Promise.resolve(); await Promise.resolve()
    const last = worker.postMessage.mock.calls.at(-1)![0] as { id: number }
    worker.emit('message', { id: last.id, ok: true })
    await closing; expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it('an observation timeout does not kill or retry a worker transaction', async () => {
    vi.useFakeTimers()
    try {
      const worker = new FakeWorker(); const port = new NotificationWorkerPort(() => worker as unknown as Worker, 'file.sqlite', 50)
      worker.emit('message', { id: 0, ok: true })
      const reading = port.page(); const assertion = expect(reading).rejects.toThrow('结果待确认')
      await vi.advanceTimersByTimeAsync(60); await assertion
      expect(worker.terminate).not.toHaveBeenCalled(); expect(worker.postMessage).toHaveBeenCalledTimes(1)
      // Resolve subsequent close, not the timed-out read.
      const closing = port.close(); await Promise.resolve(); await Promise.resolve()
      const request = worker.postMessage.mock.calls.at(-1)![0] as { id: number }
      worker.emit('message', { id: request.id, ok: true }); await closing
    } finally { vi.useRealTimers() }
  })
  it('postMessage exceptions reject the call and release its timeout rather than leak pending requests', async () => {
    const worker = new FakeWorker(); const port = new NotificationWorkerPort(() => worker as unknown as Worker, 'file.sqlite')
    worker.emit('message', { id: 0, ok: true }); worker.postMessage.mockImplementation(() => { throw Error('clone failure') })
    await expect(port.page()).rejects.toThrow('clone failure')
    await expect(port.close()).rejects.toThrow('clone failure')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it('a late ready response remains usable after an initialization observation timed out', async () => {
    vi.useFakeTimers()
    try {
      const worker = new FakeWorker(); const port = new NotificationWorkerPort(() => worker as unknown as Worker, 'file.sqlite', 50)
      const reading = port.page(); const assertion = expect(reading).rejects.toThrow('初始化未及时返回')
      await vi.advanceTimersByTimeAsync(60); await assertion
      expect(worker.terminate).not.toHaveBeenCalled()
      worker.emit('message', { id: 0, ok: true })
      const next = port.page(); await Promise.resolve(); await Promise.resolve()
      const request = worker.postMessage.mock.calls.at(-1)![0] as { id: number }
      worker.emit('message', { id: request.id, ok: true, result: { records: [] } }); await next
      const closing = port.close(); await Promise.resolve(); await Promise.resolve()
      worker.emit('message', { id: (worker.postMessage.mock.calls.at(-1)![0] as { id: number }).id, ok: true }); await closing
    } finally { vi.useRealTimers() }
  })
})
