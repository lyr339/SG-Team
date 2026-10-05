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
      const lifecycle = vi.fn(); port.subscribeLifecycle(lifecycle)
      const reading = port.page(); const assertion = expect(reading).rejects.toThrow('初始化未及时返回')
      await vi.advanceTimersByTimeAsync(60); await assertion
      expect(worker.terminate).not.toHaveBeenCalled()
      worker.emit('message', { id: 0, ok: true })
      expect(lifecycle).toHaveBeenLastCalledWith({ state: 'recovered', generation: 1 })
      const next = port.page(); await Promise.resolve(); await Promise.resolve()
      const request = worker.postMessage.mock.calls.at(-1)![0] as { id: number }
      worker.emit('message', { id: request.id, ok: true, result: { records: [] } }); await next
      const closing = port.close(); await Promise.resolve(); await Promise.resolve()
      worker.emit('message', { id: (worker.postMessage.mock.calls.at(-1)![0] as { id: number }).id, ok: true }); await closing
    } finally { vi.useRealTimers() }
  })
})

const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }
const acknowledgeClose = async (port: NotificationWorkerPort, worker: FakeWorker) => {
  const closing = port.close(); await settle()
  worker.emit('message', { id: (worker.postMessage.mock.calls.at(-1)![0] as { id: number }).id, ok: true })
  await closing
}

describe('confirmed exit recovery without unknown RPC replay', () => {
  it('an error alone is not permission to replace a live worker; a confirmed exit recovers fresh queries only', async () => {
    vi.useFakeTimers()
    try {
      const old = new FakeWorker(), next = new FakeWorker(), factory = vi.fn().mockReturnValueOnce(old).mockReturnValue(next)
      const port = new NotificationWorkerPort(factory, 'file.sqlite', 50, { delaysMs: [10, 20, 30] }), lifecycle = vi.fn()
      port.subscribeLifecycle(lifecycle); old.emit('message', { id: 0, ok: true })
      const request = port.commitSource('source:test', 0, { checked: true }, [], 1)
      const rejected = expect(request).rejects.toThrow('lost'); await settle()
      old.emit('error', Error('ack lost')); await rejected; await vi.advanceTimersByTimeAsync(100)
      expect(factory).toHaveBeenCalledOnce(); expect(old.terminate).not.toHaveBeenCalled()
      old.emit('exit', 1); old.emit('exit', 1); await vi.advanceTimersByTimeAsync(10)
      expect(factory).toHaveBeenCalledTimes(2); expect(next.postMessage).not.toHaveBeenCalled()
      next.emit('message', { id: 0, ok: true })
      const reading = port.page(); await settle(); const message = next.postMessage.mock.calls[0]![0] as { id: number; command: { kind: string } }
      expect(message.command.kind).toBe('page')
      // Old acks/ready events cannot settle any request owned by the replacement.
      old.emit('message', { id: message.id, ok: true, result: { old: true } })
      next.emit('message', { id: message.id, ok: true, result: { records: [] } }); expect(await reading).toEqual({ records: [] })
      expect(lifecycle).toHaveBeenLastCalledWith({ state: 'recovered', generation: 2 })
      expect(old.listenerCount('message')).toBe(0); await acknowledgeClose(port, next)
    } finally { vi.useRealTimers() }
  })
  it('ready failure still waits for actual exit before rebuilding; a pending initializer is not sent on the next worker', async () => {
    vi.useFakeTimers()
    try {
      const old = new FakeWorker(), next = new FakeWorker(), factory = vi.fn().mockReturnValueOnce(old).mockReturnValue(next)
      const port = new NotificationWorkerPort(factory, 'file.sqlite', 50, { delaysMs: [10] })
      const writing = port.commitSource('source:accepted', 0, {}, [], 1), rejected = expect(writing).rejects.toThrow('disk')
      old.emit('message', { id: 0, ok: false, error: 'disk not ready' }); await rejected
      await vi.advanceTimersByTimeAsync(100); expect(factory).toHaveBeenCalledOnce()
      old.emit('exit', 0); await vi.advanceTimersByTimeAsync(10); next.emit('message', { id: 0, ok: true }); await settle()
      expect(old.postMessage).not.toHaveBeenCalled(); expect(next.postMessage).not.toHaveBeenCalled()
      await acknowledgeClose(port, next)
    } finally { vi.useRealTimers() }
  })
  it('restart failures have a strict rolling budget; cooldown does not itself run another restart loop', async () => {
    vi.useFakeTimers()
    try {
      const workers: FakeWorker[] = []
      const factory = vi.fn(() => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker })
      const port = new NotificationWorkerPort(factory, 'file.sqlite', 50, { delaysMs: [10, 20, 30], windowMs: 1_000 })
      for (const delay of [10, 20, 30]) { workers.at(-1)!.emit('exit', 1); await vi.advanceTimersByTimeAsync(delay) }
      workers.at(-1)!.emit('exit', 1); await vi.advanceTimersByTimeAsync(2_000)
      expect(factory).toHaveBeenCalledTimes(4)
      await expect(port.page()).rejects.toThrow('已退出'); await vi.advanceTimersByTimeAsync(10)
      expect(factory).toHaveBeenCalledTimes(5); const next = workers.at(-1)!; next.emit('message', { id: 0, ok: true })
      await acknowledgeClose(port, next); await vi.advanceTimersByTimeAsync(2_000); expect(factory).toHaveBeenCalledTimes(5)
    } finally { vi.useRealTimers() }
  })
  it('a synchronous spawn failure is bounded and recoverable without crashing the notification owner', async () => {
    vi.useFakeTimers()
    try {
      const worker = new FakeWorker(), factory = vi.fn().mockImplementationOnce(() => { throw Error('spawn failed') }).mockReturnValue(worker)
      const port = new NotificationWorkerPort(factory, 'file.sqlite', 50, { delaysMs: [10] }), lifecycle = vi.fn()
      port.subscribeLifecycle(lifecycle); expect(lifecycle).toHaveBeenCalledWith({ state: 'unavailable', generation: 1 })
      await vi.advanceTimersByTimeAsync(10); worker.emit('message', { id: 0, ok: true })
      expect(lifecycle).toHaveBeenLastCalledWith({ state: 'recovered', generation: 2 }); await acknowledgeClose(port, worker)
    } finally { vi.useRealTimers() }
  })
  it('timed-out live RPCs retain bounded capacity until acknowledgement or exit, without killing their worker', async () => {
    vi.useFakeTimers()
    try {
      const worker = new FakeWorker(), factory = vi.fn(() => worker as unknown as Worker)
      const port = new NotificationWorkerPort(factory, 'file.sqlite', 50); worker.emit('message', { id: 0, ok: true })
      const requests = Array.from({ length: 64 }, () => port.page().catch(error => error))
      await settle(); await vi.advanceTimersByTimeAsync(60); expect((await Promise.all(requests)).every(value => value instanceof Error)).toBe(true)
      await expect(port.page()).rejects.toThrow('请求过多'); expect(worker.postMessage).toHaveBeenCalledTimes(64)
      expect(factory).toHaveBeenCalledOnce(); expect(worker.terminate).not.toHaveBeenCalled()
      worker.emit('message', { id: (worker.postMessage.mock.calls[0]![0] as { id: number }).id, ok: true, result: { records: [] } })
      const next = port.page(); await settle(); worker.emit('message', { id: (worker.postMessage.mock.calls.at(-1)![0] as { id: number }).id, ok: true, result: { records: [] } }); await next
      await acknowledgeClose(port, worker)
    } finally { vi.useRealTimers() }
  })
  it('waiting initializers are capped too, and closing during backoff cannot reopen storage', async () => {
    vi.useFakeTimers()
    try {
      const worker = new FakeWorker(), factory = vi.fn(() => worker as unknown as Worker)
      const port = new NotificationWorkerPort(factory, 'file.sqlite', 50, { delaysMs: [10] })
      const requests = Array.from({ length: 64 }, () => port.page().catch(error => error)); await expect(port.page()).rejects.toThrow('请求过多')
      worker.emit('exit', 1); await Promise.all(requests)
      await expect(port.close()).rejects.toThrow('已退出'); await vi.advanceTimersByTimeAsync(2_000)
      expect(factory).toHaveBeenCalledOnce(); await expect(port.page()).rejects.toThrow('已关闭')
    } finally { vi.useRealTimers() }
  })
})
