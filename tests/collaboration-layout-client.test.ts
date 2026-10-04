import { describe, expect, it, vi } from 'vitest'
import { GraphLayoutClient, type GraphLayoutJob, type GraphLayoutReply } from '../src/renderer/src/team/collaboration-layout-client'
import { graphLayout } from '../src/renderer/src/team/collaboration-layout'

describe('latest-wins diagram layout broker', () => {
  const job = (key: string): GraphLayoutJob => ({ key, membershipKey: 'run:group', layout: graphLayout(['slot-1'], 'slot-1', 640), edges: [] })
  const reply = (key: string): GraphLayoutReply => ({ key, routes: [], ports: [], crossings: 0, hasUnrouted: false })
  const fake = () => ({ onmessage: null as ((event: MessageEvent<GraphLayoutReply>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null, postMessage: vi.fn(), terminate: vi.fn() })
  it('replaces pending resize requests, verifies response identity and terminates deterministically', () => {
    const worker = fake(), received = vi.fn(), client = new GraphLayoutClient(worker as unknown as Worker, received)
    client.request(job('one')); client.request(job('two')); client.request(job('three'))
    expect(worker.postMessage.mock.calls.map(args => args[0].key)).toEqual(['one'])
    worker.onmessage!({ data: reply('foreign') } as MessageEvent<GraphLayoutReply>)
    expect(received).not.toHaveBeenCalled()
    worker.onmessage!({ data: reply('one') } as MessageEvent<GraphLayoutReply>)
    expect(worker.postMessage.mock.calls.map(args => args[0].key)).toEqual(['one', 'three'])
    worker.onmessage!({ data: reply('three') } as MessageEvent<GraphLayoutReply>)
    expect(received.mock.calls.map(args => args[0].key)).toEqual(['one', 'three'])
    client.destroy(); client.request(job('late'))
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(worker.onmessage).toBeNull(); expect(worker.postMessage).toHaveBeenCalledTimes(2)
  })
  it('falls back only to the newest request when a worker fails', () => {
    const worker = fake(), received = vi.fn(), client = new GraphLayoutClient(worker as unknown as Worker, received)
    client.request(job('old')); client.request(job('latest'))
    worker.onerror!({ preventDefault: vi.fn() } as unknown as ErrorEvent)
    expect(received).toHaveBeenCalledOnce(); expect(received.mock.calls[0]![0].key).toBe('latest')
    expect(received.mock.calls[0]![1].hasUnrouted).toBe(false)
    client.destroy()
  })
  it('postMessage transport errors never crash the surrounding application', () => {
    const worker = fake(), received = vi.fn(), client = new GraphLayoutClient(worker as unknown as Worker, received)
    worker.postMessage.mockImplementation(() => { throw new DOMException('worker transport unavailable') })
    expect(() => client.request(job('safe-fallback'))).not.toThrow()
    expect(received).toHaveBeenCalledOnce()
    expect(received.mock.calls[0]![0].key).toBe('safe-fallback')
    expect(worker.terminate).toHaveBeenCalledOnce()
    client.destroy()
  })
})
