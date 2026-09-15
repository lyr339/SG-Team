import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  CURSOR_STREAM_HOOK_EXPRESSION,
  CURSOR_STREAM_HOOK_PROBE_EXPRESSION,
  CURSOR_STREAM_HOOK_VERSION,
  CursorStreamObserver,
  parseNativeResponse,
  type CursorNativeProcessEvent,
  type StreamObserverSocket
} from '../src/infrastructure/cursor/cursor-stream-observer'
import { CHANNEL_USER_DELIVERY_MARKER } from '../src/domain/channel-delivery-policy'

interface SentCall {
  id: number
  method: string
  params: Record<string, unknown>
}

class FakeSocket implements StreamObserverSocket {
  readonly sent: SentCall[] = []
  closed = false
  /** 模拟页面文档里的 hook：install 表达式一执行即就位；测试把它清零模拟文档重载/被清除。 */
  hookAlive = false
  /** 模拟 Cursor 工作台尚未暴露 composer 服务：install 只挂上自轮询链（'no-manager'），hook 不就位。 */
  installPending = false
  /** 自定义 evaluate 应答（返回 undefined 走默认模型）。 */
  evaluateResponder?: (expression: string) => { value?: unknown; exceptionDetails?: Record<string, unknown> } | undefined
  private listeners = new Map<string, Array<(arg: unknown) => void>>()

  send(text: string): void {
    const call = JSON.parse(text) as SentCall
    this.sent.push(call)
    // CDP 调用自动应答（Runtime.enable / addBinding 等无需真实结果）
    const result = call.method === 'Page.addScriptToEvaluateOnNewDocument'
      ? { identifier: `script-${call.id}` }
      : call.method === 'Runtime.evaluate'
        ? this.evaluateResult(String(call.params.expression))
        : {}
    queueMicrotask(() => this.emit('message', JSON.stringify({ id: call.id, result })))
  }

  /** 按表达式模拟页面 V8 的 Runtime.evaluate 结果（含页面脚本异常形态）。 */
  private evaluateResult(expression: string): Record<string, unknown> {
    const custom = this.evaluateResponder?.(expression)
    if (custom?.exceptionDetails) return { result: { type: 'object', subtype: 'error' }, exceptionDetails: custom.exceptionDetails }
    if (custom) return { result: { type: typeof custom.value, value: custom.value } }
    if (expression === CURSOR_STREAM_HOOK_PROBE_EXPRESSION) {
      return { result: { type: 'object', value: {
        hook: this.hookAlive,
        version: this.hookAlive ? CURSOR_STREAM_HOOK_VERSION : undefined,
        scheduler: this.hookAlive || this.installPending ? 'function' : 'undefined'
      } } }
    }
    if (expression === CURSOR_STREAM_HOOK_EXPRESSION) {
      if (this.installPending) return { result: { type: 'string', value: 'no-manager' } }
      this.hookAlive = true
      return { result: { type: 'number', value: 4 } }
    }
    return { result: { type: 'string', value: 'restored' } }
  }

  installCalls(): SentCall[] {
    return this.sent.filter((call) => call.method === 'Runtime.evaluate' && call.params.expression === CURSOR_STREAM_HOOK_EXPRESSION)
  }
  close(): void { this.closed = true }
  on(event: never, listener: never): void
  on(event: string, listener: (arg: unknown) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    // 模拟真实 ws：注册 open 监听即视为连接就绪
    if (event === 'open') queueMicrotask(() => listener(undefined))
  }
  emit(event: 'message' | 'close' | 'error', arg: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg)
  }
  findCall(method: string): SentCall | undefined {
    return this.sent.find((call) => call.method === method)
  }
}

function buildObserver(overrides: {
  onWriteSignal?: (composerId: string, at: number) => void
  onProcessEvent?: (event: CursorNativeProcessEvent) => void
  onStatus?: (status: { state: 'connected' | 'reconnecting' | 'unavailable'; detail: string; updatedAt: number }) => void
  locateComposerService?: () => Promise<boolean>
} = {}) {
  const socket = new FakeSocket()
  const locateCalls: number[] = []
  const observer = new CursorStreamObserver({
    fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
    openSocket: () => socket,
    // 默认桩：服务定位直接成功（真实 queryObjects 流程由 locator 单测覆盖）。
    locateComposerService: async () => {
      locateCalls.push(Date.now())
      return overrides.locateComposerService ? overrides.locateComposerService() : true
    },
    onWriteSignal: overrides.onWriteSignal ?? (() => {}),
    onProcessEvent: overrides.onProcessEvent,
    onStatus: overrides.onStatus
  })
  return { socket, observer, locateCalls }
}

describe('CursorStreamObserver', () => {
  it('reports connected, reconnecting and unavailable process-stream health', async () => {
    const states: string[] = []
    const { socket, observer } = buildObserver({ onStatus: (status) => states.push(status.state) })
    expect(await observer.attach()).toBe(true)
    socket.emit('close', undefined)
    observer.dispose()
    expect(states).toEqual(['connected', 'reconnecting', 'unavailable'])
  })

  it('locates the composer service before installing the page hook（自带网关时序）', async () => {
    const installedAtLocate: number[] = []
    const socket = new FakeSocket()
    const observer = new CursorStreamObserver({
      fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
      openSocket: () => socket,
      locateComposerService: async () => {
        installedAtLocate.push(socket.installCalls().length)
        return true
      }
    })
    expect(await observer.attach()).toBe(true)
    // 定位是 installHook 的第一步：发生在 hook 注入 evaluate 之前。
    expect(installedAtLocate).toEqual([0])
    expect(socket.installCalls().length).toBeGreaterThanOrEqual(1)
    observer.dispose()
  })

  it('disarms the legacy patch only after the own service is located, and again after a document reload（晴天补丁缴械时序）', async () => {
    const events: string[] = []
    const outcomes = [false, true, true]
    const socket = new FakeSocket()
    const observer = new CursorStreamObserver({
      fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
      openSocket: () => socket,
      locateComposerService: async () => {
        const located = outcomes.shift() ?? true
        events.push(`locate:${located}`)
        return located
      },
      disarmLegacyPatch: async (call) => {
        events.push(`disarm:${socket.installCalls().length}`)
        // 缴械经同一持久 socket 走 CDP，且返回值不影响链路
        await call('Runtime.evaluate', { expression: '1', returnByValue: true })
        return { present: true, stopped: true, unwrapped: 10, already: false }
      }
    })
    vi.useFakeTimers()
    try {
      expect(await observer.attach()).toBe(true)
      // 首次定位失败 → 不缴械；hook 照常安装
      expect(events).toEqual(['locate:false'])
      expect(socket.installCalls()).toHaveLength(1)
      // 3s 后补试成功 → 紧随一次缴械（此时 hook 已装，缴械不阻断任何链路）
      await vi.advanceTimersByTimeAsync(3_000)
      expect(events).toEqual(['locate:false', 'locate:true', 'disarm:1'])
      // 文档重载：新文档里补丁随 bundle 重新启动，定位与缴械随 hook 重装再走一遍
      socket.hookAlive = false
      socket.emit('message', JSON.stringify({ method: 'Runtime.executionContextsCleared' }))
      socket.emit('message', JSON.stringify({ method: 'Runtime.executionContextCreated', params: { context: { auxData: { isDefault: true } } } }))
      await vi.advanceTimersByTimeAsync(400)
      expect(events).toEqual(['locate:false', 'locate:true', 'disarm:1', 'locate:true', 'disarm:1'])
      expect(socket.installCalls()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
      observer.dispose()
    }
  })

  it('a throwing disarm never blocks hook installation or the connected status', async () => {
    const states: string[] = []
    const socket = new FakeSocket()
    const observer = new CursorStreamObserver({
      fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
      openSocket: () => socket,
      locateComposerService: async () => true,
      disarmLegacyPatch: async () => { throw new Error('patch stop exploded') },
      onStatus: (status) => states.push(status.state)
    })
    expect(await observer.attach()).toBe(true)
    expect(socket.installCalls()).toHaveLength(1)
    expect(states).toEqual(['connected'])
    observer.dispose()
  })

  it('keeps retrying service location on a fixed cadence until located, then stops（重载后 workbench 未就绪）', async () => {
    vi.useFakeTimers()
    try {
      const outcomes = [false, false, true]
      let attempts = 0
      const socket = new FakeSocket()
      const observer = new CursorStreamObserver({
        fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
        openSocket: () => socket,
        locateComposerService: async () => {
          attempts += 1
          return outcomes.shift() ?? true
        }
      })
      expect(await observer.attach()).toBe(true)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(attempts).toBe(2)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(attempts).toBe(3)
      // 第三次成功 → 重试链停止，不再有后续定位调用。
      await vi.advanceTimersByTimeAsync(9_000)
      expect(attempts).toBe(3)
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits write signals after Cursor model mutation, never one frame before', async () => {
    class Manager {
      value = 0
      markDirty(input: { composerId: string }): number {
        this.value += 1
        return this.value
      }
      async updateWithoutMarkingDirty(input: { composerId: string }): Promise<number> {
        await Promise.resolve()
        this.value += 10
        return this.value
      }
    }
    const manager = new Manager()
    const observed: number[] = []
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __sgComposerService: { composerDataService: { composerDataHandleManager: manager } },
        sgTeamStream: () => observed.push(manager.value)
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    expect((context.globalThis as Record<string, unknown>).__sgTeamStreamHookVersion).toBe(CURSOR_STREAM_HOOK_VERSION)
    expect(manager.markDirty({ composerId: 'composer-1' })).toBe(1)
    expect(observed).toEqual([1])
    await manager.updateWithoutMarkingDirty({ composerId: 'composer-1' })
    await Promise.resolve()
    expect(observed).toEqual([1, 11])
  })

  it('extracts loaded Composer browser operations as native browser steps on install', async () => {
    class Manager {
      loadedComposers = { ids: ['composer-browser'] }
      markDirty(): void {}
    }
    const manager = new Manager()
    const frames: Array<Record<string, unknown>> = []
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __sgComposerService: {
          composerDataService: {
            composerDataHandleManager: manager,
            getComposerDataIfLoaded: () => ({
              fullConversationHeadersOnly: [
                { type: 1, bubbleId: 'user-1' },
                { type: 2, bubbleId: 'message-1' },
                { type: 2, bubbleId: 'tool-1' }
              ],
              conversationMap: {
                'message-1': { text: '先打开页面检查当前状态。', createdAt: '2026-09-02T09:55:48.694Z' },
                'tool-1': {
                  createdAt: '2026-09-02T09:55:48.702Z',
                  toolFormerData: {
                    name: 'mcp-cursor-ide-browser-browser_navigate',
                    status: 'completed',
                    rawArgs: '{"args":{"url":"http://localhost"}}',
                    params: { tools: [{ parameters: '{"url":"http://localhost"}' }] },
                    result: { content: [{ type: 'text', text: 'Page loaded' }, { type: 'image', data: 'AAAA' }] }
                  }
                }
              },
              generatingBubbleIds: [],
              modelConfig: { modelName: 'claude-sonnet-4-5' }
            })
          }
        },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    const process = frames[0]?.process as { items?: Array<Record<string, unknown>> } | undefined
    expect(process?.items?.map((item) => item.kind)).toEqual(['message', 'tool'])
    expect(process?.items?.[0]).toMatchObject({
      kind: 'message', text: '先打开页面检查当前状态。', startedAt: Date.parse('2026-09-02T09:55:48.694Z')
    })
    expect(process?.items?.[1]).toMatchObject({
      kind: 'tool', toolKind: 'browser', summary: 'http://localhost', status: 'done', output: 'Page loaded\n[image result]',
      startedAt: Date.parse('2026-09-02T09:55:48.702Z')
    })
  })

  it('re-broadcasts loaded Composers when the same-version hook is already in place (拾光重启后旧 hook 仍挂着)', async () => {
    class Manager {
      loadedComposers = { ids: ['composer-live'] }
      writes = 0
      markDirty(): void { this.writes += 1 }
    }
    const manager = new Manager()
    const frames: Array<Record<string, unknown>> = []
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __sgComposerService: {
          composerDataService: {
            composerDataHandleManager: manager,
            getComposerDataIfLoaded: () => ({
              fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'message-1' }],
              conversationMap: { 'message-1': { text: '正在进行中的回合。', createdAt: '2026-09-07T08:00:00.000Z' } },
              generatingBubbleIds: ['message-1'],
              modelConfig: { modelName: 'claude-sonnet-4-5' }
            })
          }
        },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    // 第一次安装：补发一帧。
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    expect(frames).toHaveLength(1)
    const wrapped = Object.getPrototypeOf(manager).markDirty
    // 拾光重启后重新 attach：hook 同版已在位——不重装 wrapper，但要再补发当前回合，
    // 否则直播过程要等到 Cursor 下一次模型写入才出现。
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    expect(frames).toHaveLength(2)
    expect(frames[1]).toMatchObject({ composerId: 'composer-live' })
    expect(Object.getPrototypeOf(manager).markDirty).toBe(wrapped)
    expect((context.globalThis as Record<string, unknown>).__sgTeamStreamHookVersion).toBe(CURSOR_STREAM_HOOK_VERSION)
  })

  it('extracts current Cursor thinking objects and discriminated toolCall payloads', async () => {
    class Manager {
      loadedComposers = { ids: ['composer-modern'] }
      markDirty(): void {}
    }
    const manager = new Manager()
    const frames: Array<Record<string, any>> = []
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __sgComposerService: {
          composerDataService: {
            composerDataHandleManager: manager,
            getComposerDataIfLoaded: () => ({
              fullConversationHeadersOnly: [
                { type: 1, bubbleId: 'user-modern' },
                { type: 2, bubbleId: 'thinking-modern' },
                { type: 2, bubbleId: 'tool-modern' }
              ],
              conversationMap: {
                'thinking-modern': { thinking: { text: '按当前 Cursor 对象结构思考' }, thinkingDurationMs: 1_800 },
                'tool-modern': {
                  toolFormerData: {
                    tool: 9,
                    toolCall: { tool: { case: 'shellToolCall', value: {
                      args: { command: 'echo MODERN_OK' },
                      result: { result: { case: 'success', value: { stdout: 'MODERN_OK' } } }
                    } } }
                  }
                }
              },
              todos: [{ content: '核对现代结构', status: 'completed' }],
              generatingBubbleIds: []
            })
          }
        },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload))
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    expect(frames[0]?.process).toMatchObject({
      turnId: 'user-modern',
      items: [
        { kind: 'thinking', text: '按当前 Cursor 对象结构思考', durationMs: 1_800 },
        { kind: 'tool', toolName: 'shellToolCall', toolKind: 'command', summary: 'echo MODERN_OK', status: 'done' }
      ],
      todos: [{ content: '核对现代结构', status: 'completed' }]
    })
  })

  it('clips oversized native process frames to protect the observer socket', async () => {
    class Manager {
      loadedComposers = { ids: ['composer-huge'] }
      markDirty(): void {}
    }
    const manager = new Manager()
    const frames: Array<Record<string, any>> = []
    // 110 个 thinking 块 × 10K 文本 ≈ 1.1M 字符 > 900K 粗判门；
    // vm 上下文无 TextEncoder → 走 length×3 字节估算 → 3.3MB > 3MB 触发裁剪。
    const bigText = 'x'.repeat(10_000)
    const bubbles = Array.from({ length: 110 }, (_, index) => `b-${index}`)
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __sgComposerService: {
          composerDataService: {
            composerDataHandleManager: manager,
            getComposerDataIfLoaded: () => ({
              fullConversationHeadersOnly: [
                { type: 1, bubbleId: 'user-huge' },
                ...bubbles.map((bubbleId) => ({ type: 2, bubbleId }))
              ],
              conversationMap: Object.fromEntries(bubbles.map((bubbleId) => [
                bubbleId, { thinking: bigText }
              ])),
              generatingBubbleIds: []
            })
          }
        },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload))
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    const frame = frames[0]
    expect(frame?.process?.items.length).toBeLessThan(110)
    expect(frame?.process?.items.length).toBeGreaterThan(8)
    expect(frame?.process?.truncatedItemCount).toBeGreaterThan(0)
    expect(JSON.stringify(frame).length).toBeLessThan(1_100_000)
  })

  it('attaches: binding + new-document hook + immediate install', async () => {
    const { socket, observer } = buildObserver()
    const attached = await observer.attach()
    expect(attached).toBe(true)
    expect(observer.connected).toBe(true)
    expect(socket.findCall('Runtime.enable')).toBeDefined()
    const bindings = socket.sent.filter((call) => call.method === 'Runtime.addBinding')
    expect(bindings.map((call) => call.params.name)).toEqual(['sgTeamStream', '__sgTeamUsage', 'sgTeamProcess'])
    const newDocument = socket.findCall('Page.addScriptToEvaluateOnNewDocument')
    expect(typeof newDocument?.params.source).toBe('string')
    expect(String(newDocument?.params.source)).toContain('composerDataHandleManager')
    // 幂等双保险 + 可还原：wrapped 标记 / manager 身份 / originals 存档
    expect(String(newDocument?.params.source)).toContain('__sgTeamStreamWrapped')
    expect(String(newDocument?.params.source)).toContain('__sgTeamStreamHookManager')
    expect(String(newDocument?.params.source)).toContain('__sgTeamStreamOriginals')
    expect(String(newDocument?.params.source)).toContain('__sgTeamStreamHookVersion')
    const evaluate = socket.findCall('Runtime.evaluate')
    expect(typeof evaluate?.params.expression).toBe('string')
    observer.dispose()
  })

  it('enables the Page domain before registering the new-document hook and verifies the install with a read-only probe', async () => {
    const states: Array<{ state: string; detail: string }> = []
    const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
    await observer.attach()
    const methods = socket.sent.map((call) => call.method)
    // Page 域不启用时 addScriptToEvaluateOnNewDocument 只登记不执行：顺序必须是 enable → add
    expect(methods).toContain('Page.enable')
    expect(methods.indexOf('Page.enable')).toBeLessThan(methods.indexOf('Page.addScriptToEvaluateOnNewDocument'))
    expect(methods.indexOf('Page.enable')).toBeGreaterThan(methods.lastIndexOf('Runtime.addBinding'))
    // 安装（1 次）之后紧跟一次只读探针；connected 只在探针确认 hook 就位后才上报
    expect(socket.installCalls()).toHaveLength(1)
    const probes = socket.sent.filter((call) => call.method === 'Runtime.evaluate' && call.params.expression === CURSOR_STREAM_HOOK_PROBE_EXPRESSION)
    expect(probes).toHaveLength(1)
    expect(socket.sent.indexOf(probes[0]!)).toBeGreaterThan(socket.sent.indexOf(socket.installCalls()[0]!))
    expect(states).toEqual([{ state: 'connected', detail: 'Cursor 原生过程流已连接' }])
    observer.dispose()
  })

  it('reinstalls the hook after an in-place page reload and only reports connected again once verified (2026-09-05 事故)', async () => {
    vi.useFakeTimers()
    try {
      const states: Array<{ state: string; detail: string }> = []
      const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
      await observer.attach()
      expect(states.at(-1)?.state).toBe('connected')
      const installsBefore = socket.installCalls().length

      // Cursor 窗口原地重载（Reload Window / 同窗口切换文件夹）：target 与 socket 不变，
      // 文档换新——hook 随旧文档消失，binding 由 Runtime 域自动注入新文档。
      socket.hookAlive = false
      socket.emit('message', JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }))
      expect(states.at(-1)).toEqual({ state: 'reconnecting', detail: 'Cursor 工作台已重载，正在重新安装过程 hook' })
      expect(observer.connected).toBe(true)

      // 隔离世界的上下文不触发重装；主世界上下文就位后合并一次重装
      socket.emit('message', JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 8, origin: '', name: '', auxData: { isDefault: false, type: 'isolated' } } }
      }))
      socket.emit('message', JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 9, origin: '', name: '', auxData: { isDefault: true, type: 'default' } } }
      }))
      socket.emit('message', JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 10, origin: '', name: '', auxData: { isDefault: true, type: 'default' } } }
      }))
      expect(socket.installCalls()).toHaveLength(installsBefore)
      await vi.advanceTimersByTimeAsync(400)
      expect(socket.installCalls()).toHaveLength(installsBefore + 1)
      expect(socket.hookAlive).toBe(true)
      expect(states.at(-1)).toEqual({ state: 'connected', detail: 'Cursor 原生过程流已连接' })
      // 已验证就位后，后续 iframe 上下文创建不再触发重装
      socket.emit('message', JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { id: 11, origin: '', name: '', auxData: { isDefault: true, type: 'default' } } }
      }))
      await vi.advanceTimersByTimeAsync(400)
      expect(socket.installCalls()).toHaveLength(installsBefore + 1)
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a page-script exception during hook install as an attach failure instead of a false connected', async () => {
    vi.useFakeTimers()
    try {
      const states: Array<{ state: string; detail: string }> = []
      const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
      socket.evaluateResponder = (expression) => expression === CURSOR_STREAM_HOOK_EXPRESSION
        ? { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: boom is not defined' } } }
        : undefined
      const attached = await observer.attach()
      expect(attached).toBe(false)
      expect(observer.connected).toBe(false)
      expect(socket.closed).toBe(true)
      expect(states).toHaveLength(1)
      expect(states[0]!.state).toBe('reconnecting')
      expect(states[0]!.detail).toContain('ReferenceError: boom is not defined')
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('health check reinstalls a hook that disappeared without any event, and never repeats identical status', async () => {
    vi.useFakeTimers()
    try {
      const states: Array<{ state: string; detail: string }> = []
      const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
      await observer.attach()
      const installsBefore = socket.installCalls().length
      const probesBefore = socket.sent.filter((call) => call.params.expression === CURSOR_STREAM_HOOK_PROBE_EXPRESSION).length

      // hook 健在：自检只探针、不重装、不重复上报 connected
      await vi.advanceTimersByTimeAsync(20_500)
      expect(socket.installCalls()).toHaveLength(installsBefore)
      expect(socket.sent.filter((call) => call.params.expression === CURSOR_STREAM_HOOK_PROBE_EXPRESSION).length).toBe(probesBefore + 1)
      expect(states.filter((status) => status.state === 'connected')).toHaveLength(1)

      // 未知路径把 hook 清掉且没有任何 CDP 事件：下一拍自检发现缺席并重装
      socket.hookAlive = false
      await vi.advanceTimersByTimeAsync(20_500)
      expect(socket.installCalls()).toHaveLength(installsBefore + 1)
      expect(socket.hookAlive).toBe(true)
      expect(states.at(-1)?.state).toBe('connected')

      // dispose 后自检停止
      observer.dispose()
      const sentAfterDispose = socket.sent.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(socket.sent.length).toBe(sentAfterDispose)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports reconnecting while the workbench composer service is not ready, then connected once the in-page install chain lands', async () => {
    vi.useFakeTimers()
    try {
      const states: Array<{ state: string; detail: string }> = []
      const { socket, observer } = buildObserver({ onStatus: (status) => states.push({ state: status.state, detail: status.detail }) })
      socket.installPending = true
      expect(await observer.attach()).toBe(true)
      expect(observer.connected).toBe(true)
      expect(states.at(-1)).toEqual({ state: 'reconnecting', detail: '等待 Cursor 工作台就绪后安装过程 hook' })

      // 页面内 2s 自轮询链等到 manager 后自行装上（不经拾光再注入）
      socket.installPending = false
      socket.hookAlive = true
      await vi.advanceTimersByTimeAsync(20_500)
      expect(states.at(-1)).toEqual({ state: 'connected', detail: 'Cursor 原生过程流已连接' })
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispatches bindingCalled payloads as write signals', async () => {
    const signals: Array<{ composerId: string }> = []
    const { socket, observer } = buildObserver({
      onWriteSignal: (composerId) => signals.push({ composerId })
    })
    await observer.attach()
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: 'sgTeamStream', payload: 'composer-abc-123' }
    }))
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: 'otherBinding', payload: 'ignored' }
    }))
    expect(signals).toEqual([{ composerId: 'composer-abc-123' }])
    observer.dispose()
  })

  it('dispatches ordered Cursor-native process frames with outputs and todos', async () => {
    const events: CursorNativeProcessEvent[] = []
    const { socket, observer } = buildObserver({ onProcessEvent: (event) => events.push(event) })
    await observer.attach()
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: {
        name: 'sgTeamProcess',
        payload: JSON.stringify({
          composerId: 'composer-native', observedAt: 1234, isGenerating: true,
          process: {
            turnId: 'user-turn-1',
            items: [
              { kind: 'thinking', id: 'th-1', text: '先分析', status: 'done', durationMs: 2500 },
              { kind: 'tool', id: 'tool-1', toolName: 'run_terminal_cmd', toolKind: 'command', summary: 'npm test', status: 'done', output: '42 passed' }
            ],
            todos: [{ content: '验证结果', status: 'in_progress' }],
            generatingBubbleCount: 1
          }
        })
      }
    }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ composerId: 'composer-native', observedAt: 1234, isGenerating: true })
    expect(events[0]?.process?.turnId).toBe('user-turn-1')
    expect(events[0]?.process?.items.map((item) => item.id)).toEqual(['th-1', 'tool-1'])
    expect(events[0]?.process?.items[1]).toMatchObject({ output: '42 passed', toolKind: 'command' })
    expect(events[0]?.process?.todos).toEqual([{ content: '验证结果', status: 'in_progress' }])
    observer.dispose()
  })

  it('dispatches the streaming final answer carried by write-after snapshots (阶段 G 数据层)', async () => {
    const events: CursorNativeProcessEvent[] = []
    const { socket, observer } = buildObserver({ onProcessEvent: (event) => events.push(event) })
    await observer.attach()
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: {
        name: 'sgTeamProcess',
        payload: JSON.stringify({
          composerId: 'composer-native', observedAt: 1300, isGenerating: true,
          response: { id: 'bubble-final', text: '正在逐字生成的正文', generating: true },
          process: { turnId: 'user-turn-1', items: [], generatingBubbleCount: 1, snapshotComplete: true }
        })
      }
    }))
    // 非法正文载荷（缺 id / 缺 text）静默忽略，不影响过程帧本身。
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: {
        name: 'sgTeamProcess',
        payload: JSON.stringify({
          composerId: 'composer-native', observedAt: 1400, isGenerating: false,
          response: { text: '没有 id' },
          process: { turnId: 'user-turn-1', items: [], generatingBubbleCount: 0, snapshotComplete: true }
        })
      }
    }))
    expect(events).toHaveLength(2)
    // 气泡级 generating 随正文透传（v31：帧级 isGenerating 是回合存活，正文生命周期看它自己）。
    expect(events[0]?.response).toEqual({ id: 'bubble-final', text: '正在逐字生成的正文', generating: true })
    expect(events[1]?.response).toBeUndefined()
    expect(events[1]?.process).toMatchObject({ turnId: 'user-turn-1', snapshotComplete: true })
    observer.dispose()
  })

  it('keeps an authoritative empty snapshot as an explicit process event (RC-3)', async () => {
    // 页面侧快照过滤掉全部内部协议工具后仍是完整帧：snapshotComplete 标记
    // 权威空集，服务层据此撤下旧占位块；不得坍缩成 process: undefined。
    const events: CursorNativeProcessEvent[] = []
    const { socket, observer } = buildObserver({ onProcessEvent: (event) => events.push(event) })
    await observer.attach()
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: {
        name: 'sgTeamProcess',
        payload: JSON.stringify({
          composerId: 'composer-empty', observedAt: 2345, isGenerating: true,
          process: {
            turnId: 'user-turn-quiet',
            items: [
              { kind: 'tool', id: 'cursor:poll', toolName: 'mcp-SG Team-check_messages', toolKind: 'mcp', summary: '', status: 'done' }
            ],
            generatingBubbleCount: 1,
            snapshotComplete: true
          }
        })
      }
    }))
    expect(events).toHaveLength(1)
    expect(events[0]?.process).toMatchObject({ turnId: 'user-turn-quiet', items: [], snapshotComplete: true })
    observer.dispose()
  })

  it('ignores unknown pages, garbage messages and empty payloads', async () => {
    const signals: string[] = []
    const { socket, observer } = buildObserver({
      onWriteSignal: (composerId) => signals.push(composerId)
    })
    await observer.attach()
    socket.emit('message', 'not json')
    socket.emit('message', JSON.stringify({ method: 'Runtime.bindingCalled', params: {} }))
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: 'sgTeamStream', payload: '' }
    }))
    socket.emit('message', JSON.stringify({ method: 'something.else' }))
    expect(signals).toEqual([])
    observer.dispose()
  })

  it('解析 usage binding 载荷并转发结构化事件；坏载荷静默丢弃', async () => {
    const events: Array<Record<string, unknown>> = []
    const samples: Array<Record<string, unknown>> = []
    const socket = new FakeSocket()
    const observer = new CursorStreamObserver({
      fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
      openSocket: () => socket,
      onWriteSignal: () => {},
      onUsageEvent: (event) => events.push({ ...event }),
      onUsageSample: (sample) => samples.push({ ...sample })
    })
    await observer.attach()

    socket.emit('message', JSON.stringify({ method: 'Runtime.bindingCalled', params: {
      name: '__sgTeamUsage', payload: JSON.stringify({ kind: 'sample', c: 'comp-1', g: 'generation-1', m: 'gpt-5', used: 12000, t: 1000 })
    } }))
    expect(samples).toEqual([{ composerId: 'comp-1', generationId: 'generation-1', modelId: 'gpt-5', used: 12000, occurredAt: 1000 }])

    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__sgTeamUsage', payload: '{"c":"comp-1","i":12168,"o":42,"r":3968,"w":0,"t":1788021941352}' }
    }))
    // 非法值丢弃，不把损坏的事件变成一次零值结算。
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__sgTeamUsage', payload: '{"c":"comp-2","i":"bad","o":-5}' }
    }))
    // 坏 JSON / 空 composerId 丢弃
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__sgTeamUsage', payload: 'not-json' }
    }))
    socket.emit('message', JSON.stringify({
      method: 'Runtime.bindingCalled',
      params: { name: '__sgTeamUsage', payload: '{"c":"","i":10}' }
    }))

    expect(events).toEqual([
      { composerId: 'comp-1', inputTokens: 12168, outputTokens: 42, cacheReadTokens: 3968, cacheWriteTokens: 0, occurredAt: 1788021941352 }
    ])
    observer.dispose()
  })

  it('reattaches after socket close and removes the stale new-document script', async () => {
    vi.useFakeTimers()
    try {
      const sockets: FakeSocket[] = []
      const observer = new CursorStreamObserver({
        fetchPageSocketUrl: async () => 'ws://127.0.0.1:9333/devtools/page/abc',
        openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
        onWriteSignal: () => {}
      })
      await observer.attach()
      const first = sockets[0]!
      expect(observer.connected).toBe(true)
      const firstAdd = first.sent.filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')
      expect(firstAdd).toHaveLength(1)
      expect(first.sent.some((call) => call.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(false)

      first.emit('close', undefined)
      expect(observer.connected).toBe(false)
      await vi.advanceTimersByTimeAsync(5_500)
      expect(observer.connected).toBe(true)
      const second = sockets[1]!
      // 重连后必须先移除旧脚本再注册新脚本（防 target 上脚本累积）
      const secondRemove = second.sent.filter((call) => call.method === 'Page.removeScriptToEvaluateOnNewDocument')
      expect(secondRemove).toHaveLength(1)
      expect(secondRemove[0]!.params.identifier).toBe(`script-${firstAdd[0]!.id}`)
      const secondAdd = second.sent.filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')
      expect(secondAdd).toHaveLength(1)
      // 旧 socket 的迟到 close 不得清掉已经连上的新 socket。
      first.emit('close', undefined)
      expect(observer.connected).toBe(true)
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('attach failure schedules retry and stays degraded (polling fallback)', async () => {
    vi.useFakeTimers()
    try {
      const sockets: FakeSocket[] = []
      const observer = new CursorStreamObserver({
        fetchPageSocketUrl: async () => undefined,
        openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
        onWriteSignal: () => {}
      })
      const first = await observer.attach()
      expect(first).toBe(false)
      expect(observer.connected).toBe(false)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(observer.connected).toBe(false)
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose restores page hooks (fire-and-forget evaluate) and removes the script', async () => {
    const { socket, observer } = buildObserver()
    await observer.attach()
    const sentBefore = socket.sent.length
    observer.dispose()
    expect(socket.closed).toBe(true)
    // 还原 evaluate 必须先于 close 发出（离场不留痕）
    const restoreCall = socket.sent.slice(sentBefore).find((call) => (
      call.method === 'Runtime.evaluate'
      && String(call.params.expression).includes('__sgTeamStreamOriginals')
    ))
    expect(restoreCall).toBeDefined()
    const removeCall = socket.sent.slice(sentBefore).find((call) => (
      call.method === 'Page.removeScriptToEvaluateOnNewDocument'
    ))
    expect(removeCall).toBeDefined()
  })

  it('dispose closes socket and stops retries', async () => {
    vi.useFakeTimers()
    try {
      const { socket, observer } = buildObserver()
      await observer.attach()
      observer.dispose()
      expect(socket.closed).toBe(true)
      expect(observer.connected).toBe(false)
      socket.emit('close', undefined)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(observer.connected).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('阶段 D：Bubble 级内部协议相位分组（RC-5 / RC-5.1 / RC-6）', () => {
  function hookContext(data: () => Record<string, unknown>) {
    class Manager {
      loadedComposers = { ids: ['composer-d'] }
      markDirty(): void {}
    }
    const frames: Array<Record<string, any>> = []
    const context = {
      Promise,
      queueMicrotask,
      setTimeout,
      globalThis: {
        __sgComposerService: {
          composerDataService: {
            composerDataHandleManager: new Manager(),
            getComposerDataIfLoaded: () => data()
          }
        },
        // 测试默认逐帧全量（0 = 关闭节流）；节流行为由专项用例覆盖。
        __sgTeamProcessThrottleMs: 0,
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    return { context, frames }
  }

  async function collect(context: ReturnType<typeof hookContext>['context'], frames: Array<Record<string, any>>): Promise<Array<Record<string, any>>> {
    const schedule = (context.globalThis as Record<string, any>).__sgTeamProcessSchedule as (id: string) => void
    frames.length = 0
    schedule('composer-d')
    await Promise.resolve()
    return (frames[0]?.process as { items?: Array<Record<string, any>> })?.items ?? []
  }

  it('defers MCP tool placeholders until the real tool name hydrates (RC-5.1: 从未出现 mcp--)', async () => {
    let bubble: Record<string, any>
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'b-1' }],
      conversationMap: { 'b-1': bubble },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)

    // 首帧：toolCase 已到、真实工具名未水合 → 暂缓展示，不产生占位块
    bubble = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: {} } } } }
    let items = await collect(context, frames)
    expect(items).toEqual([])

    // 水合为内部协议工具（check_messages）→ 隐藏
    bubble = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: { args: { server: 'SG Team', toolName: 'check_messages' } } } } } }
    items = await collect(context, frames)
    expect(items).toEqual([])

    // 水合为业务 MCP 工具 → 以真实名称展示
    bubble = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: { args: { server: 'SG Team', toolName: 'team_task' }, result: { result: { case: 'success' } } } } } } }
    items = await collect(context, frames)
    expect(items.map((item) => `${item.kind}:${item.toolName}`)).toEqual(['tool:mcp-SG Team-team_task'])
  })

  it('hides transport bubbles as a group and keeps the final answer out of process messages (RC-5/RC-6)', async () => {
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'msg-interim' },
        { type: 2, bubbleId: 'tool-read' },
        { type: 2, bubbleId: 'msg-final' },
        { type: 2, bubbleId: 'cap-1' },
        { type: 2, bubbleId: 'th-keep' },
        { type: 2, bubbleId: 'tool-check' }
      ],
      conversationMap: {
        'msg-interim': { text: '我先读取文件。' },
        'tool-read': { toolFormerData: { name: 'read_file', status: 'completed' } },
        'msg-final': { text: '这是最终回答。' },
        'cap-1': { capabilityType: 30, simulatedMessageMetadata: { title: '正在调用 check_messages' } },
        'th-keep': { thinking: '没有新消息，继续等待。' },
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    const items = await collect(context, frames)

    // 传输相位整组隐藏：capability:30、keepalive thinking、check_messages 工具。
    expect(items.map((item) => item.id)).toEqual(['cursor-msg:msg-interim', 'cursor:tool-read'])
    // 最终正文之后只剩传输噪声 → 不作为 cursor-msg（不与 record_reply 正文重复）
    expect(items.some((item) => item.id === 'cursor-msg:msg-final')).toBe(false)
  })

  it('keeps business MCP bubbles, their thinking and interim messages fully visible', async () => {
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'msg-interim' },
        { type: 2, bubbleId: 'th-biz' },
        { type: 2, bubbleId: 'tool-team' },
        { type: 2, bubbleId: 'msg-final' }
      ],
      conversationMap: {
        'msg-interim': { text: '先梳理任务。' },
        'th-biz': { thinking: '领取任务前先确认看板状态。' },
        'tool-team': { toolFormerData: { name: 'mcp-SG Team-team_task', status: 'completed' } },
        'msg-final': { text: '任务已领取。' }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    const items = await collect(context, frames)

    expect(items.map((item) => item.id)).toEqual([
      'cursor-msg:msg-interim',
      'cursor-th:th-biz',
      'cursor:tool-team'
    ])
    expect(items.find((item) => item.id === 'cursor:tool-team')).toMatchObject({
      toolName: 'mcp-SG Team-team_task', toolKind: 'mcp'
    })
  })

  it('carries the final answer as a write-cadence response payload, never as a process message (阶段 G 数据层)', async () => {
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'msg-interim' },
        { type: 2, bubbleId: 'tool-read' },
        { type: 2, bubbleId: 'msg-final' },
        { type: 2, bubbleId: 'cap-1' },
        { type: 2, bubbleId: 'tool-check' }
      ],
      conversationMap: {
        'msg-interim': { text: '我先读取文件。' },
        'tool-read': { toolFormerData: { name: 'read_file', status: 'completed' } },
        'msg-final': { text: '这是最终回答。' },
        'cap-1': { capabilityType: 30 },
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } }
      },
      generatingBubbleIds: ['msg-final']
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    const items = await collect(context, frames)
    // 中间消息仍是过程；最终正文改由 response 载荷承载（与 inspect 的 responseId 同一 bubbleId）。
    expect(items.map((item) => item.id)).toEqual(['cursor-msg:msg-interim', 'cursor:tool-read'])
    expect(frames[0]?.response).toEqual({ id: 'msg-final', text: '这是最终回答。', generating: true })

    // 正文之后仍有业务工具：尚无最终正文，不携带 response。
    const working = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'msg-1' },
        { type: 2, bubbleId: 'tool-read' }
      ],
      conversationMap: {
        'msg-1': { text: '我先读取文件。' },
        'tool-read': { toolFormerData: { name: 'read_file', status: 'completed' } }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, working.context)
    await collect(working.context, working.frames)
    expect(working.frames[0]?.response).toBeUndefined()
  })

  it('hides trailing polling scaffolding but keeps thinking that leads to a final answer', async () => {
    // 回合尾部余波：check_messages 之后只剩 capability/thinking、无消息跟随 → 隐藏
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'tool-check' },
        { type: 2, bubbleId: 'cap-trail' },
        { type: 2, bubbleId: 'th-trail' }
      ],
      conversationMap: {
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } },
        'cap-trail': { capabilityType: 30 },
        'th-trail': { thinking: '暂无新消息。' }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    expect(await collect(context, frames)).toEqual([])

    // 轮询后取到新消息：thinking 之后跟着最终正文（消息跟随）→ 业务思考保留
    const second = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'tool-check' },
        { type: 2, bubbleId: 'th-biz' },
        { type: 2, bubbleId: 'msg-final' }
      ],
      conversationMap: {
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } },
        'th-biz': { thinking: '收到新任务，先整理思路再作答。' },
        'msg-final': { text: '这是针对新任务的回答。' }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, second.context)
    const items = await collect(second.context, second.frames)
    expect(items.map((item) => item.id)).toEqual(['cursor-th:th-biz'])
  })

  // Cursor 落盘的 MCP 工具结果形态（2026-09-04 从 state.vscdb 实取）：
  // toolFormerData.result 是双层 JSON 字符串：{"result":"{\"content\":[{\"type\":\"text\",\"text\":…}]}"}
  function mcpResult(text: string): string {
    return JSON.stringify({ result: JSON.stringify({ content: [{ type: 'text', text }] }) })
  }
  const deliveredUserMessage = [
    '如图这里流式过程呈现的有点问题，请你来深度分析根因',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    CHANNEL_USER_DELIVERY_MARKER,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '- 思考、工具调用与输出由拾光直接读取 Cursor 原生会话事件',
    '',
    '[轮次 #321 · 队列剩余 0 条]'
  ].join('\n')

  it('keeps the business thinking that follows a delivered user message visible while it is still running (2026-09-04：38s Thought 被隐藏到正文出现)', async () => {
    // 实机形态：record_reply → check_messages（投递了真实用户消息）→ 模型开始长思考。
    // 旧的尾部兜底把「前一工具是内部协议、其后暂无正文」的 thinking 一律判成轮询余波
    // 隐藏，直到后面出现正文才整段蹦出——投递后的首段业务思考因此整段不可见。
    const headers: Array<Record<string, unknown>> = [
      { type: 1, bubbleId: 'user-1' },
      { type: 2, bubbleId: 'tool-record' },
      { type: 2, bubbleId: 'tool-check' },
      { type: 2, bubbleId: 'th-biz' }
    ]
    const map: Record<string, Record<string, unknown>> = {
      'tool-record': { toolFormerData: { name: 'mcp-SG Team-record_reply', status: 'completed', result: mcpResult('{"ok":true}') } },
      'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed', result: mcpResult(deliveredUserMessage) } },
      'th-biz': { thinking: { text: 'Looking at the screenshots, I notice the same message text appears duplicated…' } }
    }
    let generating = ['th-biz']
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: headers, conversationMap: map, generatingBubbleIds: generating
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)

    // 思考进行中、其后还没有任何工具或正文：必须实时可见（running）。
    let items = await collect(context, frames)
    expect(items.map((item) => `${item.id}:${item.status}`)).toEqual(['cursor-th:th-biz:running'])

    // 思考结束 → 业务工具（Shell），仍无正文：思考继续可见，不因「其后无正文」被回收。
    headers.push({ type: 2, bubbleId: 'tool-shell' })
    map['th-biz'] = { thinking: { text: 'Looking at the screenshots, I notice the same message text appears duplicated…', thinkingDurationMs: 38429 } }
    map['tool-shell'] = { toolFormerData: { name: 'run_terminal_command_v2', status: 'completed', params: { command: 'git status --short' } } }
    generating = []
    items = await collect(context, frames)
    expect(items.map((item) => item.id)).toEqual(['cursor-th:th-biz', 'cursor:tool-shell'])
    expect(items[0]).toMatchObject({ status: 'done', durationMs: 38429 })
  })

  /**
   * Cursor 3.6.31 内存模型里 MCP 工具气泡的真实形态（2026-09-07 经 CDP 从运行中的 Composer 实取）：
   * 两套结果并存，toolInfo 优先取现代形态——
   * - toolFormerData.result：落盘同款 {selectedTool:'', result:'<双层 JSON 字符串>'}
   * - toolFormerData.toolCall.tool.value.result：protobuf 判别联合
   *   {result:{case:'success', value:{content:[{content:{case:'text', value:{text}}}, {content:{case:'image', value:{data,mimeType}}}], isError:false}}}
   * 现代 args 里服务器名字段是 providerIdentifier。
   */
  function mcpToolFormerData(server: string, toolName: string, text: string, options: { images?: number } = {}) {
    const content = [
      { content: { case: 'text', value: { text } } },
      ...Array.from({ length: options.images ?? 0 }, () => ({ content: { case: 'image', value: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } } }))
    ]
    return {
      name: `mcp-${server}-${toolName}`,
      status: 'completed',
      result: { selectedTool: '', result: JSON.stringify({ content: [{ type: 'text', text }] }) },
      toolCall: {
        tool: {
          case: 'mcpToolCall',
          value: {
            args: { name: `user-${server}-${toolName}`, args: {}, providerIdentifier: server, toolName },
            result: { result: { case: 'success', value: { content, isError: false } } }
          }
        }
      }
    }
  }

  it('recognises the delivered user message in the modern (case/value) MCP result shape, so the opening thinking streams live (2026-09-07：投递后首段思考直到正文出现才蹦出)', async () => {
    // 实机形态：record_reply → check_messages（带 2 张图的真实用户消息）→ 模型开始思考，
    // 整个回合都还没有任何正文。旧扫描只认 result/output/content/contents 与 .text，
    // 现代形态里文本藏在 value/content.value → 标记找不到 → isUserDelivery 恒 false →
    // 首段思考被尾部兜底判成轮询余波，后面来了业务工具依然隐藏，直到最终正文出现。
    const headers: Array<Record<string, unknown>> = [
      { type: 1, bubbleId: 'user-1' },
      { type: 2, bubbleId: 'tool-record' },
      { type: 2, bubbleId: 'tool-check' },
      { type: 2, bubbleId: 'th-first' }
    ]
    const map: Record<string, Record<string, unknown>> = {
      'tool-record': { toolFormerData: mcpToolFormerData('SG Team', 'record_reply', '{"ok":true}') },
      'tool-check': { toolFormerData: mcpToolFormerData('SG Team', 'check_messages', deliveredUserMessage, { images: 2 }) },
      'th-first': { thinking: { text: "I'm thinking through why the opening thought never shows…", signature: 'sig' }, capabilityType: 30 }
    }
    let generating = ['th-first']
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: headers, conversationMap: map, generatingBubbleIds: generating
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)

    // completed 先到，结果后水合：第一帧未识别投递不得永久缓存 false。
    const delivered = map['tool-check']!
    map['tool-check'] = { toolFormerData: mcpToolFormerData('SG Team', 'check_messages', '') }
    expect(await collect(context, frames)).toEqual([])
    map['tool-check'] = delivered
    // 思考正在流式生成、其后还没有任何工具或正文：必须实时可见。
    let items = await collect(context, frames)
    expect(items.map((item) => `${item.id}:${item.status}`)).toEqual(['cursor-th:th-first:running'])

    // 思考结束 → 业务工具，仍无正文：首段思考继续可见，不因「其后无正文」被尾部兜底回收。
    headers.push({ type: 2, bubbleId: 'tool-shell' })
    map['th-first'] = { thinking: { text: "I'm thinking through why the opening thought never shows…", thinkingDurationMs: 43128 }, capabilityType: 30 }
    map['tool-shell'] = { toolFormerData: { name: 'run_terminal_command_v2', status: 'completed', params: { command: 'git status --short' } } }
    generating = []
    items = await collect(context, frames)
    expect(items.map((item) => item.id)).toEqual(['cursor-th:th-first', 'cursor:tool-shell'])
    expect(items[0]).toMatchObject({ status: 'done', durationMs: 43128 })

    // keepalive 结果（现代形态）之后的思考仍是轮询余波 → 隐藏；两种形态判定一致。
    const keepalive = hookContext(() => ({
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'tool-check' }, { type: 2, bubbleId: 'th-keep' }],
      conversationMap: {
        'tool-check': { toolFormerData: mcpToolFormerData('SG Team', 'check_messages', '<sg_team_keepalive n="7"/>') },
        'th-keep': { thinking: { text: '没有新消息，继续静默等待。' }, capabilityType: 30 }
      },
      generatingBubbleIds: ['th-keep']
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, keepalive.context)
    expect(await collect(keepalive.context, keepalive.frames)).toEqual([])
  })

  it('throttles heavy process payloads to a trailing 100ms window while response/state frames stay immediate (2026-09-12 卡顿根治)', async () => {
    vi.useFakeTimers()
    try {
      let generating: string[] = ['msg-1']
      const map: Record<string, Record<string, unknown>> = {
        'tool-read': { toolFormerData: { name: 'read_file', status: 'running', params: { path: '/a.ts' } } },
        'msg-1': { text: '正文片段' }
      }
      const frames: Array<Record<string, any>> = []
      const context = {
        Promise,
        queueMicrotask,
        setTimeout,
        globalThis: {
          __sgComposerService: {
            composerDataService: {
              composerDataHandleManager: new (class {
                loadedComposers = { ids: ['composer-d'] }
                markDirty(): void {}
              })(),
              getComposerDataIfLoaded: () => ({
                fullConversationHeadersOnly: [
                  { type: 1, bubbleId: 'user-1' },
                  { type: 2, bubbleId: 'tool-read' },
                  { type: 2, bubbleId: 'msg-1' }
                ],
                conversationMap: map,
                generatingBubbleIds: generating
              })
            }
          },
          __sgTeamProcessThrottleMs: 100,
          sgTeamStream: () => {},
          sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
        }
      }
      runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
      const schedule = (context.globalThis as Record<string, any>).__sgTeamProcessSchedule as (id: string) => void
      const push = async () => { schedule('composer-d'); await Promise.resolve() }

      // 首帧（leading edge）：全量携带过程块。
      frames.length = 0
      await push()
      expect(frames).toHaveLength(1)
      expect(frames[0]?.process).toBeDefined()
      expect(frames[0]?.isGenerating).toBe(true)

      // 窗口内的写入：正文/状态小载荷即时直推（打字机粒度不变），过程块不重复携带。
      map['msg-1'] = { text: '正文片段更新' }
      await push()
      expect(frames).toHaveLength(2)
      expect(frames[1]?.process).toBeUndefined()
      expect(frames[1]?.response).toMatchObject({ id: 'msg-1', text: '正文片段更新' })

      // 窗口尾帧（trailing flush）：用最新数据补一帧全量，过程最迟 100ms 收敛。
      await vi.advanceTimersByTimeAsync(120)
      expect(frames).toHaveLength(3)
      expect(frames[2]?.process).toBeDefined()

      // 回合终结帧（isGenerating=false）：不等窗口，立即全量。
      generating = []
      map['tool-read'] = { toolFormerData: { name: 'read_file', status: 'completed', params: { path: '/a.ts' } } }
      frames.length = 0
      await push()
      expect(frames).toHaveLength(1)
      expect(frames[0]?.process).toBeDefined()
      expect(frames[0]?.isGenerating).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('回合存活以 composer status 为权威（v31，2026-09-12 名册活动条闪烁根因）', () => {
    // Cursor 3.6.31 ComposerData：无 isGenerating 字段；status ∈ generating / aborted / …；
    // generatingBubbleIds 只在气泡吐 token 时非空，工具执行期恒为空（CDP 只读探针实证）。
    const harness = (dataOf: () => Record<string, unknown>) => {
      const frames: Array<Record<string, any>> = []
      const context = {
        Promise,
        queueMicrotask,
        setTimeout,
        globalThis: {
          __sgComposerService: {
            composerDataService: {
              composerDataHandleManager: new (class {
                loadedComposers = { ids: [] as string[] }
                markDirty(): void {}
              })(),
              getComposerDataIfLoaded: () => dataOf()
            }
          },
          __sgTeamProcessThrottleMs: 100,
          sgTeamStream: () => {},
          sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
        }
      }
      runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
      const schedule = (context.globalThis as Record<string, any>).__sgTeamProcessSchedule as (id: string) => void
      return { frames, push: async () => { schedule('composer-s'); await Promise.resolve() } }
    }
    const turn = (patch: Record<string, unknown>, tool: { status: string; additional?: string }, generating: string[]) => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'th-1' },
        { type: 2, bubbleId: 'tool-shell' }
      ],
      conversationMap: {
        'th-1': { thinking: { text: '先跑一遍测试' } },
        'tool-shell': {
          toolFormerData: {
            name: 'run_terminal_command_v2', status: tool.status,
            params: { command: 'npm test' },
            ...(tool.additional ? { additionalData: { status: tool.additional } } : {})
          }
        }
      },
      generatingBubbleIds: generating,
      ...patch
    })

    it('工具执行中：status=generating 且气泡集为空 → isGenerating=true、工具保持 running、帧按节流窗口走（不是终结帧）', async () => {
      const { frames, push } = harness(() => turn({ status: 'generating' }, { status: 'running', additional: 'running' }, []))
      await push()
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ isGenerating: true })
      expect(frames[0]?.process).toMatchObject({ generatingBubbleCount: 0 })
      const shell = (frames[0]?.process.items as Array<Record<string, unknown>>).find((item) => item.id === 'cursor:tool-shell')
      expect(shell).toMatchObject({ kind: 'tool', status: 'running' })
      // 紧接着的第二次写入落在 100ms 窗口内：非终结帧只带小载荷——证明它不再被当成回合终结。
      await push()
      expect(frames).toHaveLength(2)
      expect(frames[1]?.process).toBeUndefined()
      expect(frames[1]?.isGenerating).toBe(true)
    })

    it('回合真正结束：status=completed / aborted 且气泡集为空 → isGenerating=false，终结帧立即全量', async () => {
      for (const status of ['completed', 'aborted']) {
        const { frames, push } = harness(() => turn({ status }, { status: 'completed', additional: 'success' }, []))
        await push()
        await push()
        expect(frames).toHaveLength(2)
        expect(frames.every((frame) => frame.isGenerating === false && frame.process !== undefined)).toBe(true)
      }
    })

    it('气泡在吐 token 时回合必然存活：status 缺省或异常值都不压过 generatingBubbleIds', async () => {
      const streaming = harness(() => turn({}, { status: 'completed' }, ['th-1']))
      await streaming.push()
      expect(streaming.frames[0]?.isGenerating).toBe(true)
      const odd = harness(() => turn({ status: 'none' }, { status: 'completed' }, ['th-1']))
      await odd.push()
      expect(odd.frames[0]?.isGenerating).toBe(true)
    })

    it('旧形态（无 status 字段）回退到气泡级：工具执行期仍判为未生成（v30 语义，供旧 Cursor 版本）', async () => {
      const { frames, push } = harness(() => turn({}, { status: 'running', additional: 'running' }, []))
      await push()
      expect(frames[0]?.isGenerating).toBe(false)
    })

    it('正文气泡自带气泡级 generating：回合存活期间正文写完即为 false，供服务层判定 streaming → complete', async () => {
      const withText = (generating: string[]) => ({
        status: 'generating',
        fullConversationHeadersOnly: [
          { type: 1, bubbleId: 'user-1' },
          { type: 2, bubbleId: 'msg-final' }
        ],
        conversationMap: { 'msg-final': { text: '结论：可以合并。' } },
        generatingBubbleIds: generating
      })
      const live = harness(() => withText(['msg-final']))
      await live.push()
      expect(live.frames[0]).toMatchObject({ isGenerating: true, response: { id: 'msg-final', generating: true } })
      const settled = harness(() => withText([]))
      await settled.push()
      expect(settled.frames[0]).toMatchObject({ isGenerating: true, response: { id: 'msg-final', generating: false } })
    })
  })

  describe('hook v32：每帧携带 Cursor 会话列表副标题 statusLine（名册常驻状态行数据源）', () => {
    const harness = (dataOf: () => Record<string, unknown>, throttleMs = 0) => {
      const frames: Array<Record<string, any>> = []
      const context = {
        Promise,
        queueMicrotask,
        setTimeout,
        clearTimeout,
        globalThis: {
          __sgComposerService: {
            composerDataService: {
              composerDataHandleManager: new (class {
                loadedComposers = { ids: [] as string[] }
                markDirty(): void {}
              })(),
              getComposerDataIfLoaded: () => dataOf()
            }
          },
          __sgTeamProcessThrottleMs: throttleMs,
          sgTeamStream: () => {},
          sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
        }
      }
      runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
      const schedule = (context.globalThis as Record<string, any>).__sgTeamProcessSchedule as (id: string) => void
      return { frames, push: async () => { schedule('composer-v32'); await Promise.resolve() } }
    }
    const mcp = (toolName: string, status: 'loading' | 'completed') => ({
      toolFormerData: { status, toolCall: { tool: { case: 'mcpToolCall', value: { args: { providerIdentifier: 'SG Team', toolName } } } } }
    })

    it('待命席位：items 为空（传输噪音已过滤）但 statusLine=Thinking——check_messages 被跳过，扫到轮询前的思考；composerStatus 一并携带', async () => {
      const { frames, push } = harness(() => ({
        status: 'generating',
        fullConversationHeadersOnly: [
          { type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'text' }, { type: 2, bubbleId: 'rr' },
          { type: 2, bubbleId: 'th' }, { type: 2, bubbleId: 'cm' }
        ],
        conversationMap: {
          text: { text: '已完成。' },
          rr: mcp('record_reply', 'completed'),
          th: { thinking: { text: '没有新消息，继续等待。' } },
          cm: mcp('check_messages', 'loading')
        },
        generatingBubbleIds: []
      }))
      await push()
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ isGenerating: true, composerStatus: 'generating', statusLine: { kind: 'thinking', label: 'Thinking' } })
      expect(frames[0]?.process.items).toEqual([])
      // v34：帧携带整个 composer 的气泡数（含用户气泡与被过滤的传输噪音），席位轮换以它为阈值
      expect(frames[0]?.bubbleCount).toBe(5)
    })

    it('回复后直接轮询（无思考）：statusLine 是正文首行片段；工具执行期是动词 + 对象', async () => {
      const polling = harness(() => ({
        status: 'generating',
        fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'text' }, { type: 2, bubbleId: 'cm' }],
        conversationMap: { text: { text: '**结论**：可以合并。\n\n细节如下。' }, cm: mcp('check_messages', 'loading') },
        generatingBubbleIds: []
      }))
      await polling.push()
      expect(polling.frames[0]?.statusLine).toEqual({ kind: 'text', label: '结论：可以合并。' })

      const reading = harness(() => ({
        status: 'generating',
        fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'th' }, { type: 2, bubbleId: 'read' }],
        conversationMap: {
          th: { thinking: { text: '先看入口' } },
          read: { toolFormerData: { status: 'loading', toolCall: { tool: { case: 'readToolCall', value: { args: { path: 'src/main/index.ts', offset: 1, limit: 40 } } } } } }
        },
        generatingBubbleIds: []
      }))
      await reading.push()
      expect(reading.frames[0]?.statusLine).toEqual({ kind: 'tool', label: 'Reading index.ts L1-41', detail: 'index.ts L1-41', toolKind: 'read' })
    })

    it('节流窗内的小帧（无 process）同样携带 statusLine；回合结束帧不携带（Cursor 非生成态不扫气泡）', async () => {
      let status = 'generating'
      const { frames, push } = harness(() => ({
        status,
        fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'th' }],
        conversationMap: { th: { thinking: { text: '想' } } },
        generatingBubbleIds: []
      }), 100)
      await push()
      await push()
      expect(frames).toHaveLength(2)
      expect(frames[1]?.process).toBeUndefined()
      expect(frames[1]?.statusLine).toEqual({ kind: 'thinking', label: 'Thinking' })
      status = 'aborted'
      await push()
      expect(frames[2]).toMatchObject({ isGenerating: false, composerStatus: 'aborted' })
      expect(frames[2]?.statusLine).toBeUndefined()
    })
  })

  it('parseNativeResponse 保留气泡级 generating，缺省时不编造', () => {
    expect(parseNativeResponse({ id: 'b1', text: '正文', generating: false })).toEqual({ id: 'b1', text: '正文', generating: false })
    expect(parseNativeResponse({ id: 'b1', text: '正文', generating: true })).toEqual({ id: 'b1', text: '正文', generating: true })
    expect(parseNativeResponse({ id: 'b1', text: '正文' })).toEqual({ id: 'b1', text: '正文' })
    expect(parseNativeResponse({ id: 'b1', text: '正文', generating: 'yes' })).toEqual({ id: 'b1', text: '正文' })
  })

  it('incremental fact cache is byte-identical to full recompute across a growing turn (等价性防线)', async () => {
    const headers: Array<Record<string, unknown>> = [{ type: 1, bubbleId: 'user-1' }]
    const map: Record<string, Record<string, unknown>> = {}
    let generating: string[] = []
    const dataOf = () => ({
      fullConversationHeadersOnly: headers,
      conversationMap: map,
      generatingBubbleIds: generating
    })
    const mk = (factCache: boolean) => {
      const frames: Array<Record<string, any>> = []
      const context = {
        Promise,
        queueMicrotask,
        setTimeout,
        globalThis: {
          __sgComposerService: {
            composerDataService: {
              composerDataHandleManager: new (class {
                loadedComposers = { ids: [] as string[] }
                markDirty(): void {}
              })(),
              getComposerDataIfLoaded: () => dataOf()
            }
          },
          __sgTeamProcessThrottleMs: 0,
          __sgTeamFactCache: factCache,
          sgTeamStream: () => {},
          sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
        }
      }
      runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
      return { context, frames }
    }
    const cached = mk(true)   // 增量化（缓存开）
    const fresh = mk(false)   // 全量重算（缓存关）
    const step = async () => {
      for (const side of [cached, fresh]) {
        const schedule = (side.context.globalThis as Record<string, any>).__sgTeamProcessSchedule as (id: string) => void
        schedule('composer-d')
        await Promise.resolve()
      }
      expect(cached.frames.length).toBe(fresh.frames.length)
      // observedAt 是两帧各自的挂钟时间，不参与等价比较。
      const strip = (frame: Record<string, any> | undefined) => {
        if (!frame) return frame
        const { observedAt, ...rest } = frame
        return rest
      }
      expect(strip(cached.frames.at(-1))).toEqual(strip(fresh.frames.at(-1)))
    }

    // 1. 思考流式增长（同气泡内容原地变长）
    headers.push({ type: 2, bubbleId: 'th-1' })
    map['th-1'] = { thinking: { text: '先想' } }
    generating = ['th-1']
    await step()
    map['th-1'] = { thinking: { text: '先想清楚整个方案，再动手实现它。' } }
    await step()

    // 2. MCP 工具 pending → 水合真实名（RC-5.1：args.toolName 后出现）
    headers.push({ type: 2, bubbleId: 'tool-mcp' })
    map['tool-mcp'] = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: {} } } } }
    generating = ['tool-mcp']
    await step()
    map['tool-mcp'] = { toolFormerData: mcpToolFormerData('SG Team', 'check_messages', '<sg_team_keepalive n="1"/>') }
    await step()

    // 3. 业务工具 running → completed + 结果到齐
    headers.push({ type: 2, bubbleId: 'tool-read' })
    map['tool-read'] = { toolFormerData: { name: 'read_file', status: 'loading', params: { path: '/x.ts' } } }
    generating = ['tool-read']
    await step()
    map['tool-read'] = { toolFormerData: { name: 'read_file', status: 'completed', params: { path: '/x.ts' }, result: 'file content here' } }
    await step()

    // 4. edit 流式 diff 增长（params.streamingContent 原地变长）
    headers.push({ type: 2, bubbleId: 'tool-edit' })
    map['tool-edit'] = { toolFormerData: { toolCall: { tool: { case: 'editToolCall', value: { args: { path: '/y.ts' } } } }, status: 'loading', params: { streamingContent: '@@ -1 +1 @@\n-a' } } }
    generating = ['tool-edit']
    await step()
    map['tool-edit'] = { toolFormerData: { toolCall: { tool: { case: 'editToolCall', value: { args: { path: '/y.ts' } } } }, status: 'loading', params: { streamingContent: '@@ -1 +1 @@\n-a\n+b\n+bb' } } }
    await step()

    // 5. 正文流式（最终正文候选逐帧变长）
    headers.push({ type: 2, bubbleId: 'msg-1' })
    map['msg-1'] = { text: '完成' }
    generating = ['msg-1']
    await step()
    map['msg-1'] = { text: '完成了全部工作。' }
    await step()

    // 6. 终结帧（freshAll 路径：归档内容全量重算）
    generating = []
    await step()
  })

  it('renders modern MCP tool results as text (not a JSON dump of the case/value union) and names them by providerIdentifier', async () => {
    const { context, frames } = hookContext(() => ({
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'tool-nav' }],
      conversationMap: {
        'tool-nav': { toolFormerData: mcpToolFormerData('playwright', 'browser_navigate', 'Page loaded: http://127.0.0.1:5174', { images: 1 }) }
      },
      generatingBubbleIds: []
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    const items = await collect(context, frames)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'tool', toolName: 'mcp-playwright-browser_navigate', toolKind: 'browser', status: 'done',
      output: 'Page loaded: http://127.0.0.1:5174\n[image result]'
    })
  })

  it('still hides the polling aftermath after a keepalive result or a silent collaboration notification', async () => {
    const keepalive = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'tool-check' },
        { type: 2, bubbleId: 'th-keep' }
      ],
      conversationMap: {
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed', result: mcpResult('<sg_team_keepalive n="4"/>') } },
        'th-keep': { thinking: { text: '没有新消息，继续静默等待。' } }
      },
      generatingBubbleIds: ['th-keep']
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, keepalive.context)
    expect(await collect(keepalive.context, keepalive.frames)).toEqual([])

    const silent = hookContext(() => ({
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'tool-check' },
        { type: 2, bubbleId: 'th-internal' }
      ],
      conversationMap: {
        'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed', result: mcpResult('【拾光内部协作通知】有新的团队消息\n\n---\n【内部协作通知协议】\n- 不要向用户输出可见文字') } },
        'th-internal': { thinking: { text: '先读一下收件箱。' } }
      },
      generatingBubbleIds: ['th-internal']
    }))
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, silent.context)
    expect(await collect(silent.context, silent.frames)).toEqual([])
  })
})

describe('阶段 X：MCP pending 首帧不得把最终正文误判为中间过程（2026-09-03 双渲染事故）', () => {
  it('keeps the final answer out of cursor-msg when a pending MCP bubble follows it', async () => {
    // 事故形态：正文 → keepalive thinking → MCP 工具首帧（toolCase 已到、真实名
    // 未水合 = pending）。旧前向规则只认 transport，thinking 被当业务思考构成
    // 「后续工作」→ 最终正文进 cursor-msg → 封口固化 → 与回复正文双渲染。
    class Manager {
      loadedComposers = { ids: ['composer-x'] }
      markDirty(): void {}
    }
    let mcpBubble: Record<string, unknown> = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: {} } } } }
    const frames: Array<Record<string, any>> = []
    const context = {
      Promise, queueMicrotask, setTimeout,
      globalThis: {
        __sgComposerService: { composerDataService: {
          composerDataHandleManager: new Manager(),
          getComposerDataIfLoaded: () => ({
            fullConversationHeadersOnly: [
              { type: 1, bubbleId: 'user-1' },
              { type: 2, bubbleId: 'final-1' },
              { type: 2, bubbleId: 'th-keep' },
              { type: 2, bubbleId: 'mcp-pending' }
            ],
            conversationMap: {
              'final-1': { text: '这是微信（WeChat）的应用图标：绿色圆角方块，中间两个白色对话气泡叠在一起。' },
              'th-keep': { thinking: '暂无新消息，继续等待。' },
              'mcp-pending': mcpBubble
            },
            generatingBubbleIds: ['mcp-pending']
          })
        } },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    let items = (frames[0]?.process as { items?: Array<Record<string, any>> })?.items ?? []
    // 最终正文不进 cursor-msg（由 response 载荷 / record_reply 承载）：工作判定对
    // pending 按传输倾向，th-keep 不构成「后续工作」。
    expect(items.some((item) => item.id === 'cursor-msg:final-1')).toBe(false)
    expect(frames[0]?.response).toMatchObject({ id: 'final-1' })
    // 显示层对 pending 不预判：th-keep 在真实工具名水合前保持可见——否则每个业务
    // MCP 调用开始时其前置思考都会消失一帧再重播（打字机从头再来）。
    expect(items.map((item) => item.id)).toEqual(['cursor-th:th-keep'])

    // 水合为 check_messages：整组传输相位隐藏，最终正文依旧不是过程消息。
    mcpBubble = { toolFormerData: { toolCall: { tool: { case: 'mcpToolCall', value: { args: { server: 'SG Team', toolName: 'check_messages' } } } } } }
    frames.length = 0
    ;(context.globalThis as Record<string, any>).__sgTeamProcessSchedule('composer-x')
    await Promise.resolve()
    items = (frames[0]?.process as { items?: Array<Record<string, any>> })?.items ?? []
    expect(items).toEqual([])
    expect(frames[0]?.response).toMatchObject({ id: 'final-1' })
  })

  it('keeps the business thinking that produced the final answer visible when record_reply follows (message resets the transport phase)', async () => {
    class Manager {
      loadedComposers = { ids: ['composer-y'] }
      markDirty(): void {}
    }
    const frames: Array<Record<string, any>> = []
    const context = {
      Promise, queueMicrotask, setTimeout,
      globalThis: {
        __sgComposerService: { composerDataService: {
          composerDataHandleManager: new Manager(),
          getComposerDataIfLoaded: () => ({
            fullConversationHeadersOnly: [
              { type: 1, bubbleId: 'user-1' },
              { type: 2, bubbleId: 'th-answer' },
              { type: 2, bubbleId: 'final-1' },
              { type: 2, bubbleId: 'tool-record' },
              { type: 2, bubbleId: 'th-keep' },
              { type: 2, bubbleId: 'tool-check' }
            ],
            conversationMap: {
              'th-answer': { thinking: '用户问的是图标含义，直接描述即可。' },
              'final-1': { text: '这是微信的应用图标。' },
              'tool-record': { toolFormerData: { name: 'mcp-SG Team-record_reply', status: 'completed' } },
              'th-keep': { thinking: '暂无新消息，继续等待。' },
              'tool-check': { toolFormerData: { name: 'mcp-SG Team-check_messages', status: 'completed' } }
            },
            generatingBubbleIds: []
          })
        } },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    const items = (frames[0]?.process as { items?: Array<Record<string, any>> })?.items ?? []
    // 产出答案的 Thought 不被其后的 record_reply/check_messages 回溯吞掉；
    // 正文之后的 keepalive thinking 仍是传输相位；正文本身由 response 载荷承载。
    expect(items.map((item) => item.id)).toEqual(['cursor-th:th-answer'])
    expect(frames[0]?.response).toMatchObject({ id: 'final-1', text: '这是微信的应用图标。' })
  })
})

describe('hook v26：工具呈现与 ask_question 结构化载荷', () => {
  /** 与 Cursor 3.6.31 内存模型同构的 fixture（现代 toolCall.tool.case + 旧字段并存）。 */
  function composerData(input: { questionStatus: 'pending' | 'submitted'; blocking: boolean }) {
    const questionParams = {
      title: '设置页改造方向',
      questions: [{
        id: 'direction', prompt: '账号与 Cursor 页改造方向选择：', allowMultiple: false,
        options: [{ id: 'a', label: '方案 A：左侧导航标准设置页（推荐）' }, { id: 'b', label: '方案 B：单页分区卡片轻改' }]
      }]
    }
    return {
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'shell-1' },
        { type: 2, bubbleId: 'read-1' },
        { type: 2, bubbleId: 'edit-1' },
        { type: 2, bubbleId: 'question-1' }
      ],
      conversationMap: {
        'shell-1': {
          createdAt: '2026-09-09T05:00:00.000Z',
          toolFormerData: {
            toolCallId: 'toolu_shell', status: 'completed', name: 'run_terminal_command_v2', tool: 15,
            toolCall: { tool: { case: 'shellToolCall', value: {
              args: {
                command: 'cd /tmp/sg-probe && python3 - <<EOF\nprint(1)\nEOF', description: '查看新消息提交时对待答问卷的处理逻辑',
                simpleCommands: '["cd","python3"]', workingDirectory: '', timeout: '30000',
                parsingResult: '{"executableCommands":[{"name":"cd"}]}'
              },
              result: { result: { case: 'success', value: { exitCode: 1, stdout: 'hello', stderr: 'warn', interleavedOutput: 'hello\nwarn\n' } } }
            } } },
            additionalData: { status: 'success', startedAtMs: 1 }
          }
        },
        'read-1': {
          toolFormerData: {
            toolCallId: 'toolu_read', status: 'completed', name: 'read_file_v2', tool: 40,
            toolCall: { tool: { case: 'readToolCall', value: {
              args: { path: '/workspace/src/a.ts', offset: '1', limit: '120' },
              result: { result: { case: 'success', value: { output: 'const a = 1', totalLines: 500, readRange: { startLine: 1, endLine: 120 } } } }
            } } }
          }
        },
        'edit-1': {
          toolFormerData: {
            toolCallId: 'toolu_edit', status: 'completed', name: 'edit_file_v2', tool: 38,
            toolCall: { tool: { case: 'editToolCall', value: {
              args: { path: '/workspace/src/a.ts', streamContent: 'x'.repeat(5_000) },
              result: { result: { case: 'success', value: { linesAdded: 12, linesRemoved: 3, diffString: '@@ -1 +1 @@', afterFullFileContent: 'y'.repeat(5_000) } } }
            } } }
          }
        },
        'question-1': {
          createdAt: '2026-09-09T05:01:00.000Z',
          toolFormerData: {
            toolCallId: '3752a71b-a419-4cea-9f6b-ab13cf39de13', status: 'completed', name: 'ask_question', tool: 51,
            params: questionParams,
            additionalData: input.questionStatus === 'pending'
              ? { status: 'pending' }
              : { status: 'submitted', currentSelections: { direction: ['a'] } },
            toolCall: { tool: { case: 'askQuestionToolCall', value: {
              args: questionParams,
              ...(input.questionStatus === 'submitted'
                ? { result: { result: { case: 'success', value: { answers: [{ questionId: 'direction', selectedOptionIds: ['a'], freeformText: '' }] } } } }
                : {})
            } } }
          }
        }
      },
      generatingBubbleIds: [],
      capabilities: [{ type: 15, getIsBlockingUserDecision: () => () => input.blocking }]
    }
  }

  async function frameFor(data: ReturnType<typeof composerData>): Promise<Record<string, any>> {
    class Manager { loadedComposers = { ids: ['composer-q'] }; markDirty(): void {} }
    const frames: Array<Record<string, unknown>> = []
    const context = {
      Promise, queueMicrotask, setTimeout,
      globalThis: {
        __sgComposerService: { composerDataService: { composerDataHandleManager: new Manager(), getComposerDataIfLoaded: () => data } },
        sgTeamStream: () => {},
        sgTeamProcess: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>)
      }
    }
    runInNewContext(CURSOR_STREAM_HOOK_EXPRESSION, context)
    await Promise.resolve()
    return frames[0] ?? {}
  }

  it('presents tools the way Cursor does: description as title, program names / line ranges / diff stats as hints', async () => {
    const frame = await frameFor(composerData({ questionStatus: 'pending', blocking: true }))
    const items = (frame.process as { items: Array<Record<string, any>> }).items
    expect(items.map((item) => item.toolKind)).toEqual(['command', 'read', 'edit', 'question'])
    // 原生 case 名随块下发：分组算法据此区分 read/ls、grep/glob（toolKind 粒度不够）。
    expect(items.map((item) => item.toolCase)).toEqual(['shellToolCall', 'readToolCall', 'editToolCall', 'askQuestionToolCall'])
    expect(items[0]).toMatchObject({
      title: '查看新消息提交时对待答问卷的处理逻辑',
      summary: expect.stringContaining('cd /tmp/sg-probe && python3'),
      hint: 'cd, python3 · exit 1',
      output: 'hello\nwarn',
      status: 'done'
    })
    expect(items[0]!.input.parsingResult).toBe('[omitted]')
    expect(items[1]).toMatchObject({ summary: '/workspace/src/a.ts', hint: 'L1-120', output: 'const a = 1' })
    expect(items[2]).toMatchObject({ summary: '/workspace/src/a.ts', hint: '+12 −3', output: '@@ -1 +1 @@' })
    expect(items[2]!.input.streamContent).toBe('[omitted]')
    expect(items[2]!.output).not.toContain('yyyy')
  })

  it('keeps a shell running while Cursor flushes partial output into the legacy result (RC-A, 3.6.31 实测形态)', async () => {
    const shellBubble = (input: { status: 'loading' | 'completed'; additional: 'running' | 'success'; legacy?: Record<string, unknown>; modern?: boolean }) => ({
      toolFormerData: {
        toolCallId: 'toolu_tick', status: input.status, name: 'run_terminal_command_v2', tool: 15,
        toolCall: { tool: { case: 'shellToolCall', value: {
          args: { command: 'for i in 1 2 3; do echo tick $i; sleep 1; done', description: '持续输出的命令', simpleCommands: '["for","echo","sleep"]' },
          ...(input.modern ? { result: { result: { case: 'success', value: { exitCode: 0, stdout: 'tick 1\ntick 2\ntick 3\n', stderr: '', interleavedOutput: 'tick 1\ntick 2\ntick 3\n', executionTime: 3_100 } } } } : {})
        } } },
        ...(input.legacy ? { result: input.legacy } : {}),
        additionalData: { status: input.additional, startedAtMs: 1 }
      }
    })
    const dataWith = (bubble: Record<string, unknown>) => ({
      isGenerating: false,
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'shell-tick' }],
      conversationMap: { 'shell-tick': bubble },
      generatingBubbleIds: [],
      capabilities: []
    })
    // 1) 运行中、尚无任何输出：旧形态 result 还不存在。
    const silent = await frameFor(dataWith(shellBubble({ status: 'loading', additional: 'running' })) as never)
    expect((silent.process as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ status: 'running', toolKind: 'command' })
    // 2) 运行中、部分输出已 flush 进 legacy result（exitCode 0 / notInterrupted false 是运行期形态）：
    //    必须仍为 running，且部分输出可见——旧规则「有 result 即完成」会在此刻误判完成。
    const partial = await frameFor(dataWith(shellBubble({
      status: 'loading', additional: 'running',
      legacy: { output: 'tick 1\ntick 2\n', exitCode: 0, endedReason: 0, notInterrupted: false, rejected: false, outputRaw: '' }
    })) as never)
    const partialItem = (partial.process as { items: Array<Record<string, unknown>> }).items[0]!
    expect(partialItem).toMatchObject({ status: 'running', output: 'tick 1\ntick 2', hint: 'for, echo, sleep' })
    // 3) 完成：现代 result 到齐，输出取 interleavedOutput。
    const done = await frameFor(dataWith(shellBubble({
      status: 'completed', additional: 'success', modern: true,
      legacy: { output: 'tick 1\ntick 2\ntick 3\n', exitCode: 0, endedReason: 0, notInterrupted: true, rejected: false, outputRaw: '' }
    })) as never)
    expect((done.process as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ status: 'done', output: 'tick 1\ntick 2\ntick 3' })
    // 4) 旧形态（无 additionalData 运行标记、status 缺省）但已有 result：保留「有 result 即完成」回退。
    const legacyShape = await frameFor(dataWith({
      toolFormerData: {
        toolCallId: 'toolu_old', name: 'run_terminal_command_v2', tool: 15,
        params: { command: 'ls' }, result: { output: 'a.ts\n', exitCode: 0 }
      }
    }) as never)
    expect((legacyShape.process as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ status: 'done', output: 'a.ts' })
  })

  it('ships a structured diff for edits: precomputedDiff lines when present, otherwise parsed from the unified diffString (hook v29)', async () => {
    const editBubble = (id: string, extra: Record<string, unknown>, additional?: Record<string, unknown>) => ({
      toolFormerData: {
        toolCallId: id, status: 'completed', name: 'edit_file_v2', tool: 38,
        toolCall: { tool: { case: 'editToolCall', value: {
          args: { path: '/workspace/src/a.ts', streamContent: 'x' },
          result: { result: { case: 'success', value: { path: '/workspace/src/a.ts', linesAdded: 2, linesRemoved: 1, message: 'The file /workspace/src/a.ts has been updated.', afterFullFileContent: 'y'.repeat(3_000), ...extra } } }
        } } },
        ...(additional ? { additionalData: additional } : {})
      }
    })
    const unified = [
      '--- a//workspace/src/a.ts',
      '+++ b//workspace/src/a.ts',
      '@@ -10,4 +10,5 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '+const c = 4',
      ' export { a }'
    ].join('\n')
    const frame = await frameFor({
      isGenerating: false,
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'e-unified' }, { type: 2, bubbleId: 'e-pre' }, { type: 2, bubbleId: 'e-hunk-only' }],
      conversationMap: {
        // 替换式编辑：precomputedDiff.lines 为空（3.6.31 实测），只能解析 diffString。
        'e-unified': editBubble('toolu_e1', { diffString: unified }, { precomputedDiff: { lines: [], hasChanges: true } }),
        // 整文件写入：precomputedDiff.lines 直接可用。
        'e-pre': editBubble('toolu_e2', { diffString: '@@ -0,0 +1,2 @@\n+one\n+two' }, {
          precomputedDiff: { hasChanges: true, lines: [
            { type: 'added', content: 'one', modifiedLineNumber: 1 },
            { type: 'added', content: 'two', modifiedLineNumber: 2 }
          ] }
        }),
        // 只有 hunk 头：无信息量，不产出结构化 diff，output 保持 diffString 文本回退。
        'e-hunk-only': editBubble('toolu_e3', { diffString: '@@ -1 +1 @@' })
      },
      generatingBubbleIds: [],
      capabilities: []
    } as never)
    const items = (frame.process as { items: Array<Record<string, any>> }).items
    expect(items[0]!.diff).toEqual({
      lines: [
        { type: 'hunk', text: '@@ -10,4 +10,5 @@' },
        { type: 'context', text: 'const a = 1', oldLine: 10, newLine: 10 },
        { type: 'removed', text: 'const b = 2', oldLine: 11 },
        { type: 'added', text: 'const b = 3', newLine: 11 },
        { type: 'added', text: 'const c = 4', newLine: 12 },
        { type: 'context', text: 'export { a }', oldLine: 12, newLine: 13 }
      ]
    })
    // 有结构化 diff 时 output 只留结果消息，不再重复携带 diffString 原文。
    expect(items[0]).toMatchObject({ hint: '+2 −1', output: 'The file /workspace/src/a.ts has been updated.' })
    expect(items[1]!.diff).toEqual({ lines: [
      { type: 'added', text: 'one', newLine: 1 },
      { type: 'added', text: 'two', newLine: 2 }
    ] })
    expect(items[2]!.diff).toBeUndefined()
    expect(items[2]).toMatchObject({ output: '@@ -1 +1 @@' })
  })

  it('streams an in-progress edit from args.streamContent and keeps the same block identity until completion', async () => {
    const editBubble = (streamingContent: string, completed = false) => ({
      toolFormerData: {
        toolCallId: 'toolu_live_edit', status: completed ? 'completed' : 'loading', name: 'edit_file_v2', tool: 38,
        // 3.6.31 真实增量落在 bubble.params.streamingContent；modern args 保持起始形态。
        params: { relativeWorkspacePath: '/workspace/src/live.ts', streamingContent },
        toolCall: { tool: { case: 'editToolCall', value: {
          args: { path: '/workspace/src/live.ts' },
          ...(completed ? { result: { result: { case: 'success', value: {
            path: '/workspace/src/live.ts', linesAdded: 2, linesRemoved: 1,
            diffString: '@@ -40,2 +40,3 @@\n before\n-old\n+new\n+tail', message: 'updated'
          } } } } : {})
        } } }
      }
    })
    const frame = async (streamContent: string, completed = false) => frameFor({
      isGenerating: !completed,
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'edit-live' }],
      conversationMap: { 'edit-live': editBubble(streamContent, completed) },
      generatingBubbleIds: completed ? [] : ['edit-live'], capabilities: []
    } as never)

    const first = (await frame('@@ -40,2 +40,2 @@\n before\n+new')).process as { items: Array<Record<string, any>> }
    const growing = (await frame('@@ -40,2 +40,3 @@\n before\n+new\n+tail\n')).process as { items: Array<Record<string, any>> }
    const long = (await frame(Array.from({ length: 300 }, (_, index) => `+line ${index}`).join('\n'))).process as { items: Array<Record<string, any>> }
    const done = (await frame('', true)).process as { items: Array<Record<string, any>> }

    expect(first.items[0]).toMatchObject({ id: 'cursor:edit-live', status: 'running', hint: '+1 −0' })
    expect(first.items[0]!.diff.lines.at(-1)).toMatchObject({ type: 'added', text: 'new', newLine: 41 })
    expect(growing.items[0]).toMatchObject({ id: 'cursor:edit-live', status: 'running', hint: '+2 −0' })
    expect(growing.items[0]!.diff.lines.at(-2)).toMatchObject({ type: 'added', text: 'tail', newLine: 42 })
    expect(growing.items[0]!.input.streamContent).toBe('[omitted]')
    expect(long.items[0]!.diff).toMatchObject({ truncatedLineCount: 60 })
    expect(long.items[0]!.diff.lines).toHaveLength(240)
    expect(long.items[0]!.diff.lines[0]).toMatchObject({ type: 'added', text: 'line 60', newLine: 61 })
    expect(long.items[0]!.diff.lines.at(-1)).toMatchObject({ type: 'added', text: 'line 299', newLine: 300 })
    expect(done.items[0]).toMatchObject({ id: 'cursor:edit-live', status: 'done', hint: '+2 −1', output: 'updated' })
    expect(done.items[0]!.diff.lines.some((line: Record<string, unknown>) => line.type === 'removed')).toBe(true)
  })

  it('truncates very long diffs by line count and discloses the dropped lines', async () => {
    const body = Array.from({ length: 300 }, (_, index) => `+line ${index}`).join('\n')
    const frame = await frameFor({
      isGenerating: false,
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'e-long' }],
      conversationMap: {
        'e-long': { toolFormerData: {
          toolCallId: 'toolu_long', status: 'completed', name: 'edit_file_v2', tool: 38,
          toolCall: { tool: { case: 'editToolCall', value: {
            args: { path: '/workspace/big.ts' },
            result: { result: { case: 'success', value: { linesAdded: 300, linesRemoved: 0, diffString: `@@ -0,0 +1,300 @@\n${body}`, message: 'ok' } } }
          } } }
        } }
      },
      generatingBubbleIds: [],
      capabilities: []
    } as never)
    const diff = (frame.process as { items: Array<Record<string, any>> }).items[0]!.diff
    expect(diff.lines).toHaveLength(240)
    expect(diff.truncatedLineCount).toBe(61)
  })

  it('summarizes grep results as matches · files and lists the hits per file', async () => {
    const frame = await frameFor({
      isGenerating: false,
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'g-1' }, { type: 2, bubbleId: 'g-running' }],
      conversationMap: {
        'g-1': { toolFormerData: {
          toolCallId: 'toolu_g1', status: 'completed', name: 'ripgrep_raw_search', tool: 30,
          toolCall: { tool: { case: 'grepToolCall', value: {
            args: { pattern: 'toolKind', path: '/workspace/src', outputMode: 'content' },
            result: { result: { case: 'success', value: {
              pattern: 'toolKind', path: '/workspace/src', outputMode: 'content',
              workspaceResults: { '/workspace': { result: { case: 'content', value: {
                matches: [
                  { file: 'src/a.ts', matches: [{ lineNumber: 12, content: '  toolKind: item.toolKind,', isContextLine: false }, { lineNumber: 13, content: '  next', isContextLine: true }] },
                  { file: 'src/b.ts', matches: [{ lineNumber: 4, content: 'toolKind?: ProcessToolKind', isContextLine: false }] }
                ],
                totalLines: 3, totalMatchedLines: 2, clientTruncated: false, ripgrepTruncated: false
              } } } }
            } } }
          } } }
        } },
        'g-running': { toolFormerData: {
          toolCallId: 'toolu_g2', status: 'loading', name: 'ripgrep_raw_search', tool: 30,
          toolCall: { tool: { case: 'grepToolCall', value: { args: { pattern: 'foo', path: '/workspace/src/renderer' } } } },
          additionalData: { status: 'running' }
        } }
      },
      generatingBubbleIds: [],
      capabilities: []
    } as never)
    const items = (frame.process as { items: Array<Record<string, any>> }).items
    expect(items[0]).toMatchObject({ summary: 'toolKind', hint: '2 处匹配 · 2 个文件', status: 'done' })
    expect(items[0]!.output).toBe('src/a.ts\n  L12: toolKind: item.toolKind,\nsrc/b.ts\n  L4: toolKind?: ProcessToolKind')
    // 尚无结果：提示回退到路径 basename。
    expect(items[1]).toMatchObject({ summary: 'foo', hint: 'renderer', status: 'running' })
  })

  it('presents awaitToolCall as a background-command wait (command kind, runtime hint), not a subagent task (RC-B)', async () => {
    const frame = await frameFor({
      isGenerating: false,
      fullConversationHeadersOnly: [{ type: 1, bubbleId: 'user-1' }, { type: 2, bubbleId: 'await-1' }, { type: 2, bubbleId: 'await-2' }],
      conversationMap: {
        'await-1': { toolFormerData: {
          toolCallId: 'toolu_await1', status: 'completed', name: 'await', tool: 60,
          toolCall: { tool: { case: 'awaitToolCall', value: {
            args: { taskId: '837682' },
            result: { result: { case: 'success', value: { awaitResult: { case: 'complete', value: { runtimeMs: 12_400, exitCode: 0, outputFilePath: '/tmp/x.txt' } } } } }
          } } }
        } },
        'await-2': { toolFormerData: {
          toolCallId: 'toolu_await2', status: 'loading', name: 'await', tool: 60,
          toolCall: { tool: { case: 'awaitToolCall', value: { args: { taskId: '145470' } } } },
          additionalData: { status: 'running' }
        } }
      },
      generatingBubbleIds: [],
      capabilities: []
    } as never)
    const items = (frame.process as { items: Array<Record<string, unknown>> }).items
    expect(items[0]).toMatchObject({ toolKind: 'command', toolCase: 'awaitToolCall', summary: '837682', hint: '12s', status: 'done' })
    expect(items[1]).toMatchObject({ toolKind: 'command', toolCase: 'awaitToolCall', summary: '145470', status: 'running' })
  })

  it('presents generateImageToolCall as an image step: file name as the object, local path in `image`, no base64 in the frame (hook v35)', async () => {
    const imageData = 'A'.repeat(6_000)
    const frame = await frameFor({
      isGenerating: true,
      fullConversationHeadersOnly: [
        { type: 1, bubbleId: 'user-1' },
        { type: 2, bubbleId: 'img-done' },
        { type: 2, bubbleId: 'img-running' },
        { type: 2, bubbleId: 'img-legacy' },
        { type: 2, bubbleId: 'img-failed' }
      ],
      conversationMap: {
        // 现代形态（3.6.31 内存实测）：result 带 filePath + base64 imageData。
        'img-done': { toolFormerData: {
          toolCallId: 'toolu_img1', status: 'completed', name: 'generate_image', tool: 53,
          toolCall: { tool: { case: 'generateImageToolCall', value: {
            args: { description: 'Design board for the 拾光 app icon', filePath: 'shiguang-sg-v1.png' },
            result: { result: { case: 'success', value: { filePath: '/Users/lyr/.cursor/projects/x/assets/shiguang-sg-v1.png', imageData } } }
          } } }
        } },
        'img-running': { toolFormerData: {
          toolCallId: 'toolu_img2', status: 'loading', name: 'generate_image', tool: 53,
          toolCall: { tool: { case: 'generateImageToolCall', value: { args: { description: 'second board', filePath: 'shiguang-sg-v2.png' } } } }
        } },
        // 落盘 / 重启水合形态：没有 toolCall 判别联合，result 是 '{"success":{"filePath":…}}' 字符串，
        // Cursor 落盘时已把 imageData 清空。
        'img-legacy': { toolFormerData: {
          toolCallId: 'toolu_img3', status: 'completed', name: 'generate_image', tool: 53,
          params: { description: 'third board', filePath: 'shiguang-sg-v3.png' },
          result: '{"success":{"filePath":"/Users/lyr/.cursor/projects/x/assets/shiguang-sg-v3.png"}}'
        } },
        'img-failed': { toolFormerData: {
          toolCallId: 'toolu_img4', status: 'error', name: 'generate_image', tool: 53,
          toolCall: { tool: { case: 'generateImageToolCall', value: {
            args: { description: 'fourth board', filePath: 'shiguang-sg-v4.png' },
            result: { result: { case: 'error', value: { error: 'image generation api unavailable' } } }
          } } }
        } }
      },
      generatingBubbleIds: ['img-running'],
      capabilities: []
    } as never)
    const items = (frame.process as { items: Array<Record<string, any>> }).items
    expect(items.map((item) => [item.toolKind, item.status])).toEqual([
      ['image', 'done'], ['image', 'running'], ['image', 'done'], ['image', 'failed']
    ])
    expect(items[0]).toMatchObject({
      toolCase: 'generateImageToolCall',
      summary: 'shiguang-sg-v1.png',
      image: { path: '/Users/lyr/.cursor/projects/x/assets/shiguang-sg-v1.png' },
      output: ''
    })
    expect(items[0]!.input).toMatchObject({ filePath: 'shiguang-sg-v1.png' })
    expect(items[1]!.image).toBeUndefined()
    // 旧形态没有 case 名：按 generate_image 名称归 image 类，路径从双层 JSON 里取。
    expect(items[2]).toMatchObject({ image: { path: '/Users/lyr/.cursor/projects/x/assets/shiguang-sg-v3.png' }, output: '' })
    expect(items[2]!.toolCase).toBeUndefined()
    expect(items[3]!.image).toBeUndefined()
    expect(items[3]!.error).toContain('image generation api unavailable')
    // base64 与「已省略」JSON 文本都不进帧：图片以文件为事实源。
    const serialized = JSON.stringify(frame)
    expect(serialized).not.toContain('AAAAAAAA')
    expect(serialized).not.toContain('binary/image payload omitted')
  })

  it('keeps a pending ask_question running with its full options and flags the composer as awaiting the user', async () => {
    const frame = await frameFor(composerData({ questionStatus: 'pending', blocking: true }))
    const question = (frame.process as { items: Array<Record<string, any>> }).items[3]!
    expect(frame.awaitingUser).toBe(true)
    // Cursor 把等待用户的气泡标成 completed 并停止生成；回合视角它仍在进行。
    expect(question).toMatchObject({ toolKind: 'question', status: 'running', title: '设置页改造方向' })
    expect(question.question).toMatchObject({
      toolCallId: '3752a71b-a419-4cea-9f6b-ab13cf39de13',
      status: 'pending',
      questions: [{
        id: 'direction', allowMultiple: false,
        options: [{ id: 'a', label: '方案 A：左侧导航标准设置页（推荐）' }, { id: 'b', label: '方案 B：单页分区卡片轻改' }]
      }]
    })
    // 输入明细不再在第 4 层截成 "[nested]"。
    expect(question.input.questions[0].options[0]).toEqual({ id: 'a', label: '方案 A：左侧导航标准设置页（推荐）' })
  })

  it('reports the submitted answers once the questionnaire resolves and stops flagging awaitingUser', async () => {
    const frame = await frameFor(composerData({ questionStatus: 'submitted', blocking: false }))
    const question = (frame.process as { items: Array<Record<string, any>> }).items[3]!
    expect(frame.awaitingUser).toBe(false)
    expect(question).toMatchObject({ status: 'done' })
    expect(question.question).toMatchObject({
      status: 'submitted',
      answers: [{ questionId: 'direction', selectedOptionIds: ['a'] }]
    })
  })
})
