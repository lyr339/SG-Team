import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  LEGACY_PATCH_DISARM_EXPRESSION,
  LEGACY_PATCH_DISARMED_GLOBAL,
  disarmLegacyPatchViaCall,
  parseLegacyPatchDisarmResult
} from '../src/infrastructure/cursor/cursor-legacy-patch-disarm'

/** 按 bundle 实测形态（2026-09-12）搭一个最小的晴天补丁运行时：stop API + trace 包装的桥。 */
function legacyPatchPage() {
  const timers: Array<ReturnType<typeof setInterval>> = []
  const stop = vi.fn((reason: string) => {
    void reason
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
  })
  const originals = {
    getComposerData: vi.fn(() => ({ big: 'payload' })),
    getStatus: vi.fn(() => ({ found: true })),
    listComposers: vi.fn(() => [])
  }
  const bridge: Record<string, unknown> = {}
  for (const [name, original] of Object.entries(originals)) {
    const wrapped = Object.assign(function wrapped(this: unknown, ...args: unknown[]) {
      // 补丁的包装：先对返回值做全量 stringify 再决定是否记 trace
      const result = (original as (...input: unknown[]) => unknown).apply(this, args)
      JSON.stringify(result)
      return result
    }, { __qtTraceWrapped: true, __qtOriginal: original })
    bridge[name] = wrapped
  }
  bridge.__qtTraceWrapped = true
  bridge.activeComposerId = 'c1'
  // runInNewContext 把该对象当作页面 globalThis：表达式里的 w.* 读写都落在这里。
  const page: Record<string, unknown> = {
    __qingtianSeamlessRuntime: { version: '20260624-native-stream-v4', port: 36530, stop },
    __qtComposerBridge: bridge
  }
  return { page, stop, originals, bridge }
}

describe('晴天补丁运行时缴械（cursor-legacy-patch-disarm）', () => {
  it('stops the patch runtime, restores the 10 trace-wrapped bridge methods to their originals and silences the trace switch', () => {
    const { page, stop, originals, bridge } = legacyPatchPage()
    const result = runInNewContext(LEGACY_PATCH_DISARM_EXPRESSION, page) as Record<string, unknown>
    expect(result).toEqual({ present: true, stopped: true, unwrapped: 3, already: false })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(bridge.getComposerData).toBe(originals.getComposerData)
    expect(bridge.getStatus).toBe(originals.getStatus)
    expect(bridge.listComposers).toBe(originals.listComposers)
    // installer 若仍在，据此短路不再重包
    expect(bridge.__qtTraceWrapped).toBe(true)
    expect(page.__QT_TRACE_CURSOR_INTERNALS).toBe(false)
    const marker = page[LEGACY_PATCH_DISARMED_GLOBAL] as Record<string, unknown>
    expect(marker.stopped).toBe(true)
    expect(marker.unwrapped).toBe(3)
    expect(typeof marker.at).toBe('number')
  })

  it('is idempotent within one document: the second run reports already and does not call stop again', () => {
    const { page, stop } = legacyPatchPage()
    runInNewContext(LEGACY_PATCH_DISARM_EXPRESSION, page)
    const second = runInNewContext(LEGACY_PATCH_DISARM_EXPRESSION, page) as Record<string, unknown>
    expect(second).toEqual({ present: true, stopped: true, unwrapped: 3, already: true })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('is a pure read on a clean Cursor (no patch): nothing is written, present=false', () => {
    const page: Record<string, unknown> = {}
    const result = runInNewContext(LEGACY_PATCH_DISARM_EXPRESSION, page) as Record<string, unknown>
    expect(result).toEqual({ present: false, stopped: false, unwrapped: 0, already: false })
    expect(page[LEGACY_PATCH_DISARMED_GLOBAL]).toBeUndefined()
    expect(page.__QT_TRACE_CURSOR_INTERNALS).toBeUndefined()
  })

  it('survives a throwing stop() and a bridge without originals: partial result, still marked', () => {
    const { page } = legacyPatchPage()
    ;(page.__qingtianSeamlessRuntime as { stop: unknown }).stop = () => { throw new Error('boom') }
    const bridge = page.__qtComposerBridge as Record<string, unknown>
    bridge.getStatus = Object.assign(() => ({}), { __qtTraceWrapped: true }) // 无 __qtOriginal → 保持原样
    const result = runInNewContext(LEGACY_PATCH_DISARM_EXPRESSION, page) as Record<string, unknown>
    expect(result).toEqual({ present: true, stopped: false, unwrapped: 2, already: false })
    expect((bridge.getStatus as { __qtTraceWrapped?: boolean }).__qtTraceWrapped).toBe(true)
  })

  it('parses tolerant results and never throws through the CDP call face', async () => {
    expect(parseLegacyPatchDisarmResult(undefined)).toBeUndefined()
    expect(parseLegacyPatchDisarmResult('restored')).toBeUndefined()
    expect(parseLegacyPatchDisarmResult({ present: true, unwrapped: '7', stopped: 'yes' }))
      .toEqual({ present: true, stopped: false, unwrapped: 7, already: false })

    const calls: string[] = []
    const ok = await disarmLegacyPatchViaCall(async (method, params) => {
      calls.push(method)
      expect(params.expression).toBe(LEGACY_PATCH_DISARM_EXPRESSION)
      return { result: { type: 'object', value: { present: true, stopped: true, unwrapped: 10, already: false } } }
    })
    expect(ok).toEqual({ present: true, stopped: true, unwrapped: 10, already: false })
    expect(calls).toEqual(['Runtime.evaluate'])

    expect(await disarmLegacyPatchViaCall(async () => ({ exceptionDetails: { text: 'boom' } }))).toBeUndefined()
    expect(await disarmLegacyPatchViaCall(async () => { throw new Error('socket closed') })).toBeUndefined()
  })
})
