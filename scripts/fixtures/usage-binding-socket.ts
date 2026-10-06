import { EventEmitter } from 'node:events'
import { CURSOR_STREAM_HOOK_EXPRESSION, CURSOR_STREAM_HOOK_PROBE_EXPRESSION, CURSOR_STREAM_HOOK_VERSION, type StreamObserverSocket } from '../../src/infrastructure/cursor/cursor-stream-observer'

/** Only a fake protocol adapter for isolated verification. No port/network connection. */
export class UsageBindingFixtureSocket extends EventEmitter implements StreamObserverSocket {
  readonly sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  closed = false
  send(text: string): void {
    const call = JSON.parse(text) as typeof this.sent[number]; this.sent.push(call)
    let result: unknown = {}
    if (call.method === 'Page.addScriptToEvaluateOnNewDocument') result = { identifier: 'fixture-script' }
    if (call.method === 'Runtime.evaluate') result = { result: { value: call.params.expression === CURSOR_STREAM_HOOK_EXPRESSION ? 4
      : call.params.expression === CURSOR_STREAM_HOOK_PROBE_EXPRESSION ? { hook: true, version: CURSOR_STREAM_HOOK_VERSION, scheduler: 'function' } : 'restored' } }
    queueMicrotask(() => {
      if (call.method === 'Runtime.enable') this.context(1)
      this.emit('message', JSON.stringify({ id: call.id, result }))
    })
  }
  on(event: string, listener: (...args: any[]) => void): this {
    super.on(event, listener)
    if (event === 'open') queueMicrotask(() => listener())
    return this
  }
  context(id: number): void { this.emit('message', JSON.stringify({ method: 'Runtime.executionContextCreated', params: { context: { id, auxData: { isDefault: true } } } })) }
  usage(payload: unknown, executionContextId = 1): void {
    this.emit('message', JSON.stringify({ method: 'Runtime.bindingCalled', params: {
      name: '__sgTeamUsage', executionContextId, payload: typeof payload === 'string' ? payload : JSON.stringify(payload)
    } }))
  }
  close(): void { this.closed = true }
}
