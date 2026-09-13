import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  COMPOSER_SERVICE_LOCATE_FUNCTION,
  COMPOSER_SERVICE_PRESENT_EXPRESSION,
  SG_COMPOSER_BRIDGE_PRELUDE,
  SG_COMPOSER_SERVICE_GLOBAL,
  ensureComposerServiceLocated,
  locateComposerServiceViaCall,
  type CdpCall,
  type LocatorSocket
} from '../src/infrastructure/cursor/cursor-composer-service-locator'

/** 造一个可用的 composerService 假身（能力面与真实门面一致）。 */
function fakeService(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createComposer: () => ({}),
    composerDataService: { getComposerDataIfLoaded: () => undefined },
    ...overrides
  }
}

/** VS Code InstantiationService 形状的容器：_services._entries 存明文 identifier。 */
function fakeContainer(service: unknown, identifierName = 'composerService'): Record<string, unknown> {
  const key = { toString: () => identifierName }
  return {
    invokeFunction: (fn: (accessor: { get: (k: unknown) => unknown }) => unknown) =>
      fn({ get: (k) => (k === key ? service : undefined) }),
    createInstance: () => ({}),
    _services: { _entries: new Map<unknown, unknown>([[key, { descriptor: true }], [{ toString: () => 'editorService' }, {}]]) }
  }
}

describe('COMPOSER_SERVICE_LOCATE_FUNCTION（页面内定位算法）', () => {
  function locate(maps: unknown[]): { located: unknown; sandbox: Record<string, unknown> } {
    const sandbox: Record<string, unknown> = { maps }
    const located = runInNewContext(`(${COMPOSER_SERVICE_LOCATE_FUNCTION}).call(maps)`, sandbox)
    return { located, sandbox }
  }

  it('从 Map 值中嗅探 InstantiationService，按明文 composerService 取回并挂载全局', () => {
    const service = fakeService()
    const { located, sandbox } = locate([
      new Map([['noise', 1]]),
      new Map([['di', fakeContainer(service)]])
    ])
    expect(located).toBe(true)
    expect(sandbox[SG_COMPOSER_SERVICE_GLOBAL]).toBe(service)
  })

  it('没有 composerService 注册项时返回 false 且不挂全局', () => {
    const { located, sandbox } = locate([new Map([['di', fakeContainer(fakeService(), 'chatService')]])])
    expect(located).toBe(false)
    expect(sandbox[SG_COMPOSER_SERVICE_GLOBAL]).toBeUndefined()
  })

  it('取回的实例能力不完备（缺 composerDataService）时不挂载', () => {
    const broken = { createComposer: () => ({}) }
    const { located, sandbox } = locate([new Map([['di', fakeContainer(broken)]])])
    expect(located).toBe(false)
    expect(sandbox[SG_COMPOSER_SERVICE_GLOBAL]).toBeUndefined()
  })

  it('超大 Map（数据缓存）被跳过，不影响其余容器命中', () => {
    const service = fakeService()
    const huge = new Map<number, unknown>()
    for (let index = 0; index < 20_001; index++) huge.set(index, fakeContainer(fakeService()))
    const { located, sandbox } = locate([huge, new Map([['di', fakeContainer(service)]])])
    expect(located).toBe(true)
    expect(sandbox[SG_COMPOSER_SERVICE_GLOBAL]).toBe(service)
  })

  it('present 表达式验证全局能力面（挂载前 false / 挂载后 true）', () => {
    const sandbox: Record<string, unknown> = {}
    expect(runInNewContext(COMPOSER_SERVICE_PRESENT_EXPRESSION, sandbox)).toBe(false)
    sandbox[SG_COMPOSER_SERVICE_GLOBAL] = fakeService()
    expect(runInNewContext(COMPOSER_SERVICE_PRESENT_EXPRESSION, sandbox)).toBe(true)
  })
})

describe('locateComposerServiceViaCall（CDP 命令序列）', () => {
  interface Script {
    present?: boolean | 'throw'
    protoObjectId?: string | null
    objectsObjectId?: string | null
    scanValue?: unknown
  }

  function fakeCall(script: Script) {
    const calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }> = []
    const call: CdpCall = async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs })
      if (method === 'Runtime.evaluate' && params.expression === COMPOSER_SERVICE_PRESENT_EXPRESSION) {
        if (script.present === 'throw') throw new Error('socket down')
        return { result: { type: 'boolean', value: script.present === true } }
      }
      if (method === 'Runtime.evaluate' && params.expression === 'Map.prototype') {
        return script.protoObjectId === null ? { result: {} } : { result: { objectId: script.protoObjectId ?? 'proto-1' } }
      }
      if (method === 'Runtime.queryObjects') {
        return script.objectsObjectId === null ? {} : { objects: { objectId: script.objectsObjectId ?? 'maps-1' } }
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { type: 'boolean', value: script.scanValue } }
      }
      return {}
    }
    return { call, calls }
  }

  it('已定位时单次 evaluate 短路，不触发 queryObjects', async () => {
    const { call, calls } = fakeCall({ present: true })
    expect(await locateComposerServiceViaCall(call)).toBe(true)
    expect(calls.map((item) => item.method)).toEqual(['Runtime.evaluate'])
  })

  it('缺席时执行完整定位序列并释放 objectGroup', async () => {
    const { call, calls } = fakeCall({ present: false, scanValue: true })
    expect(await locateComposerServiceViaCall(call)).toBe(true)
    expect(calls.map((item) => item.method)).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Runtime.queryObjects',
      'Runtime.callFunctionOn',
      'Runtime.releaseObjectGroup'
    ])
    const query = calls.find((item) => item.method === 'Runtime.queryObjects')
    expect(query?.params.prototypeObjectId).toBe('proto-1')
    expect(typeof query?.timeoutMs).toBe('number')
    const scan = calls.find((item) => item.method === 'Runtime.callFunctionOn')
    expect(scan?.params.objectId).toBe('maps-1')
    expect(scan?.params.functionDeclaration).toBe(COMPOSER_SERVICE_LOCATE_FUNCTION)
  })

  it('定位未命中 → false，objectGroup 仍被释放', async () => {
    const { call, calls } = fakeCall({ present: false, scanValue: false })
    expect(await locateComposerServiceViaCall(call)).toBe(false)
    expect(calls.at(-1)?.method).toBe('Runtime.releaseObjectGroup')
  })

  it('协议返回缺 objectId 或调用异常时收敛为 false，绝不抛出', async () => {
    expect(await locateComposerServiceViaCall(fakeCall({ present: false, protoObjectId: null }).call)).toBe(false)
    expect(await locateComposerServiceViaCall(fakeCall({ present: false, objectsObjectId: null }).call)).toBe(false)
    expect(await locateComposerServiceViaCall(fakeCall({ present: 'throw' }).call)).toBe(false)
  })
})

describe('ensureComposerServiceLocated（一次性定位会话）', () => {
  class FakeSocket implements LocatorSocket {
    readonly sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
    closed = false
    private listeners = new Map<string, Array<(arg: unknown) => void>>()
    constructor(
      private readonly respond: (call: { id: number; method: string; params: Record<string, unknown> }) => unknown,
      private readonly failOpen = false
    ) {}

    send(text: string): void {
      const call = JSON.parse(text) as { id: number; method: string; params: Record<string, unknown> }
      this.sent.push(call)
      const result = this.respond(call)
      queueMicrotask(() => this.emit('message', JSON.stringify({ id: call.id, result })))
    }

    close(): void { this.closed = true }
    on(event: never, listener: never): void
    on(event: string, listener: (arg: unknown) => void): void {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
      if (event === 'open' && !this.failOpen) queueMicrotask(() => listener(undefined))
      if (event === 'error' && this.failOpen) queueMicrotask(() => listener(new Error('refused')))
    }
    emit(event: string, arg: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(arg)
    }
  }

  it('enable → 定位（已在位短路）→ 关闭 socket，返回 true', async () => {
    const socket = new FakeSocket((call) => (
      call.method === 'Runtime.evaluate' && call.params.expression === COMPOSER_SERVICE_PRESENT_EXPRESSION
        ? { result: { type: 'boolean', value: true } }
        : {}
    ))
    const located = await ensureComposerServiceLocated('ws://fake', { openSocket: () => socket })
    expect(located).toBe(true)
    expect(socket.sent.map((call) => call.method)).toEqual(['Runtime.enable', 'Runtime.evaluate'])
    expect(socket.closed).toBe(true)
  })

  it('连接失败收敛为 false 且不抛出', async () => {
    const socket = new FakeSocket(() => ({}), true)
    expect(await ensureComposerServiceLocated('ws://fake', { openSocket: () => socket })).toBe(false)
  })
})

describe('SG_COMPOSER_BRIDGE_PRELUDE（自有薄桥的派生契约）', () => {
  function bridgeIn(window: Record<string, unknown>): Record<string, any> | undefined {
    return runInNewContext(`(() => { ${SG_COMPOSER_BRIDGE_PRELUDE} return sgBridge })()`, { window, Date }) as
      Record<string, any> | undefined
  }

  function serviceWindow(input: {
    dataById?: Record<string, Record<string, unknown>>
    allComposers?: Array<Record<string, unknown>>
    selectedComposerIds?: string[]
    createComposer?: (options: Record<string, unknown>) => unknown
    submitChat?: (...args: unknown[]) => unknown
  }): Record<string, unknown> {
    const dataById = input.dataById ?? {}
    return {
      [SG_COMPOSER_SERVICE_GLOBAL]: {
        createComposer: input.createComposer ?? (async () => ({ composerId: 'composer-new' })),
        composerDataService: {
          getComposerDataIfLoaded: (id: string) => dataById[id],
          allComposersData: {
            allComposers: input.allComposers ?? Object.keys(dataById).map((composerId) => ({ composerId }))
          },
          ...(input.selectedComposerIds ? { selectedComposerIds: input.selectedComposerIds } : {})
        },
        ...(input.submitChat ? { composerChatService: { submitChatMaybeAbortCurrent: input.submitChat } } : {})
      }
    }
  }

  it('服务缺席 → sgBridge 为 undefined（表达式据此报 bridge_not_ready）', () => {
    expect(bridgeIn({})).toBeUndefined()
    expect(bridgeIn({ [SG_COMPOSER_SERVICE_GLOBAL]: {} })).toBeUndefined()
  })

  it('listComposers 由 allComposersData 派生，已加载数据优先、selected 兜底、v31 状态口径', () => {
    const window = serviceWindow({
      dataById: {
        'composer-a': { name: '甲', status: 'generating', unifiedMode: 'agent', text: 'hi', createdAt: 1_000 }
      },
      allComposers: [
        { composerId: 'composer-a', name: '旧名', status: 'completed', createdAt: 900 },
        { composerId: 'composer-b', name: '乙', status: 'completed', isGenerating: false, createdAt: 2_000 }
      ],
      selectedComposerIds: ['composer-c']
    })
    const rows = bridgeIn(window)!.listComposers()
    expect(rows).toEqual([
      { composerId: 'composer-a', name: '甲', status: 'generating', unifiedMode: 'agent', text: 'hi', isGenerating: true, createdAt: 1_000 },
      { composerId: 'composer-b', name: '乙', status: 'completed', unifiedMode: '', text: '', isGenerating: false, createdAt: 2_000 },
      { composerId: 'composer-c', name: '', status: 'unknown', unifiedMode: '', text: '', isGenerating: false, createdAt: 0 }
    ])
  })

  it('createAgent 与补丁同契约：partialState + skip 选项，返回 {composerId} / {error}', async () => {
    const createCalls: Array<Record<string, unknown>> = []
    const window = serviceWindow({
      createComposer: async (options) => { createCalls.push(options); return { composerId: 'composer-real' } }
    })
    const created = await bridgeIn(window)!.createAgent('', 'CH-2 · 拾光会话', {
      skipShowAndFocus: true, skipFocus: true, skipSelect: true, autoSubmit: false
    })
    expect(created).toEqual({ composerId: 'composer-real' })
    expect(createCalls[0]).toEqual({
      skipShowAndFocus: true,
      skipFocus: true,
      skipSelect: true,
      autoSubmit: false,
      partialState: { unifiedMode: 'agent', name: 'CH-2 · 拾光会话' }
    })

    const failing = serviceWindow({ createComposer: async () => null })
    expect(await bridgeIn(failing)!.createAgent('p', 'n', {})).toEqual({ error: 'createComposer returned null' })
    const throwing = serviceWindow({ createComposer: async () => { throw new Error('denied') } })
    expect(await bridgeIn(throwing)!.createAgent('p', 'n', {})).toEqual({ error: 'denied' })
  })

  it('submitByComposerId 只透传白名单选项，返回 {ok} 契约', async () => {
    const submits: unknown[][] = []
    const window = serviceWindow({
      submitChat: (...args) => { submits.push(args); return Promise.resolve('accepted') }
    })
    const result = await bridgeIn(window)!.submitByComposerId('composer-a', '正文', {
      ignoreQueuing: true, forceBubbleId: 'b-1', unknownOption: 'dropped'
    })
    expect(result).toEqual({ ok: true })
    expect(submits[0]).toEqual(['composer-a', '正文', { forceBubbleId: 'b-1', ignoreQueuing: true }])

    const rejecting = serviceWindow({ submitChat: () => Promise.reject(new Error('chat backend down')) })
    expect(await bridgeIn(rejecting)!.submitByComposerId('composer-a', 't', {}))
      .toEqual({ ok: false, error: 'chat backend down' })

    const noChat = serviceWindow({})
    expect(await bridgeIn(noChat)!.submitByComposerId('composer-a', 't', {}))
      .toEqual({ ok: false, error: 'chatService not ready' })
  })

  it('getStatus 纯数据派生：found / 首尾气泡 / hasError / chatGenerationUUID', () => {
    const window = serviceWindow({
      dataById: {
        'composer-a': {
          status: 'generating',
          text: '草稿',
          lastUpdatedAt: 42,
          latestChatGenerationUUID: 'generation-9',
          fullConversationHeadersOnly: [
            { type: 1, bubbleId: 'user-1' },
            { type: 2, bubbleId: 'ai-1' },
            { type: 1, bubbleId: 'user-2' },
            { type: 2, bubbleId: 'ai-2' }
          ],
          conversationMap: {
            'user-1': { text: '第一问' },
            'ai-1': { text: '第一答' },
            'user-2': { text: '第二问' },
            'ai-2': { text: '第二答', errorDetails: { message: 'model exploded' } }
          }
        }
      }
    })
    const bridge = bridgeIn(window)!
    expect(bridge.getStatus('composer-a')).toEqual({
      composerId: 'composer-a',
      found: true,
      status: 'generating',
      text: '草稿',
      lastUpdatedAt: 42,
      chatGenerationUUID: 'generation-9',
      lastHumanText: '第二问',
      lastHumanBubbleId: 'user-2',
      lastAiText: '第二答',
      lastAiBubbleId: 'ai-2',
      aiBubbleCount: 2,
      hasError: true,
      errorText: 'model exploded'
    })
    expect(bridge.getStatus('composer-missing')).toMatchObject({ found: false, lastHumanText: '', aiBubbleCount: 0, hasError: false })
  })

  it('getRecentlyCreatedComposers 按 createdAt 截断', () => {
    const now = Date.now()
    const window = serviceWindow({
      allComposers: [
        { composerId: 'fresh', createdAt: now - 5_000 },
        { composerId: 'stale', createdAt: now - 120_000 },
        { composerId: 'no-timestamp' }
      ]
    })
    const recent = bridgeIn(window)!.getRecentlyCreatedComposers(60_000)
    expect(recent.map((row: { composerId: string }) => row.composerId)).toEqual(['fresh'])
  })
})
