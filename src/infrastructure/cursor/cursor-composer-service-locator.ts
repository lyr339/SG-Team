import WebSocket from 'ws'

/**
 * 自带网关（路线 B）：纯 CDP 定位 Cursor 的 composerService，零文件修改。
 *
 * 晴天时代补丁靠改写 Cursor bundle（ComposerService 构造函数里内联
 * `window.__qtComposerService=this`）暴露内部服务；拾光的会话创建、状态读取、
 * 问卷提交、过程 hook 全部依赖这个补丁全局。本模块用 CDP 在运行时定位同一服务：
 *
 *   queryObjects(Map.prototype)
 *     → 按形状找到 InstantiationService 容器（invokeFunction/createInstance 是
 *       VS Code 保留的明文 API 名；服务注册表 _services._entries 的 identifier
 *       toString() 也是明文，含 'composerService'）
 *     → invokeFunction(a => a.get(id)) 取回 Cursor 对外正式暴露的服务门面
 *       （延迟实例化代理：方法按访问绑定到底层唯一实例，字段访问直接穿透——
 *       stream hook 需要的 composerDataHandleManager、模型配置链全部可达）
 *     → 挂到 window.__sgComposerService
 *
 * 全链路只读、零文件修改：不触发 Cursor 校验和告警、免疫升级抹补丁、
 * Windows 清洁安装同样可用。可行性实证见 docs/SELF-GATEWAY-CDP-LOCATOR-RESEARCH.md
 * （2026-09-12，五版只读探针，本机 Cursor 3.6.31）。
 *
 * 时序约定：
 * - 定位是异步的（queryObjects 遍历堆约 1–5s），页面侧消费者（stream hook 的
 *   install 自轮询）以「等到 __sgComposerService 出现」为就绪信号；
 * - 文档重载后全局随旧文档消失，需要重新定位——观察器在 hook 重装链路里触发；
 * - 已定位时 locate 走单次 evaluate 探测短路，成本可忽略，放心幂等调用。
 */

export const SG_COMPOSER_SERVICE_GLOBAL = '__sgComposerService'

const LOCATE_OBJECT_GROUP = 'sg-composer-service-locator'
const DEFAULT_CALL_TIMEOUT_MS = 8_000
/** queryObjects 遍历整个 V8 堆，1h+ 的重窗口实测约 5s；上限放宽到 30s。 */
const QUERY_OBJECTS_TIMEOUT_MS = 30_000
const SCAN_TIMEOUT_MS = 15_000
const SOCKET_HANDSHAKE_TIMEOUT_MS = 5_000

/** 服务已定位且能力完备（建会话 + 读 composer 数据）。 */
export const COMPOSER_SERVICE_PRESENT_EXPRESSION = `(() => {
  const s = globalThis.${SG_COMPOSER_SERVICE_GLOBAL};
  return !!(s && typeof s.createComposer === 'function'
    && s.composerDataService && typeof s.composerDataService.getComposerDataIfLoaded === 'function');
})()`

/**
 * callFunctionOn 的页面内定位函数（this = queryObjects(Map.prototype) 返回的 Map 数组）。
 * 与探针 v5 同一算法：形状嗅探 InstantiationService → 明文 identifier 精确匹配 →
 * accessor.get 取回门面 → 能力校验通过才挂全局。只读数据属性防 getter 副作用；
 * 超大 Map（>2 万条）是数据缓存不是服务注册表，跳过。
 */
export const COMPOSER_SERVICE_LOCATE_FUNCTION = `function () {
  const asData = (o, n) => { try { const d = Object.getOwnPropertyDescriptor(o, n); return d && ('value' in d) ? d.value : undefined } catch (e) { return undefined } }
  const containers = []
  for (const m of this) {
    let size = 0
    try { size = m.size } catch (e) { continue }
    if (typeof size !== 'number' || size > 20000) continue
    try {
      for (const [, v] of m) {
        if (v && typeof v === 'object' && typeof v.invokeFunction === 'function'
          && typeof v.createInstance === 'function' && containers.indexOf(v) < 0) containers.push(v)
      }
    } catch (e) {}
  }
  for (const c of containers) {
    try {
      const services = asData(c, '_services') !== undefined ? asData(c, '_services') : c._services
      const entries = services && (asData(services, '_entries') !== undefined ? asData(services, '_entries') : services._entries)
      if (!entries || typeof entries[Symbol.iterator] !== 'function') continue
      for (const [key] of entries) {
        let name = ''
        try { name = String(key) } catch (e) { continue }
        if (name !== 'composerService') continue
        const inst = c.invokeFunction(function (accessor) { return accessor.get(key) })
        if (inst && typeof inst.createComposer === 'function'
          && inst.composerDataService && typeof inst.composerDataService.getComposerDataIfLoaded === 'function') {
          globalThis.${SG_COMPOSER_SERVICE_GLOBAL} = inst
          return true
        }
      }
    } catch (e) {}
  }
  return false
}`

/**
 * 拾光自有的页面内薄桥：与晴天补丁 __qtComposerBridge 同名方法、同返回契约，
 * 但全部由 __sgComposerService 及其子服务派生——没有 trace 包装、没有 DOM 查询、
 * 没有轮询死重。注入进各业务表达式后以局部常量 sgBridge 使用；服务未定位时为
 * undefined，表达式据此返回 bridge_not_ready 类错误。
 *
 * 与补丁的有意差异（均有依据）：
 * - getStatus 纯数据源派生（headers/conversationMap），不再读 DOM 选择器——
 *   补丁的 DOM 兜底只覆盖「数据未加载但已渲染」这个不存在的组合（渲染必先加载）；
 * - listComposers 不再扫 DOM 与七种遗留 store 形态，以 allComposersData 为准
 *   （3.6.x 的权威来源，补丁自己也以它为第一优先）；
 * - createAgent 不再经 updateComposerDataAsync 二次改名——partialState.name
 *   已生效（现行逐会话选模路径长期以此为唯一命名途径）。
 */
export const SG_COMPOSER_BRIDGE_PRELUDE = `const sgBridge = (() => {
  const svc = window.${SG_COMPOSER_SERVICE_GLOBAL};
  if (!svc || typeof svc.createComposer !== 'function') return undefined;
  const dsOf = () => { try { return svc.composerDataService || null } catch (e) { return null } };
  const allComposersOf = () => {
    try {
      const ds = dsOf();
      const all = ds && ds.allComposersData && ds.allComposersData.allComposers;
      if (Array.isArray(all)) return all;
    } catch (e) {}
    return [];
  };
  const dataOf = (composerId) => {
    try {
      const ds = dsOf();
      return ds && typeof ds.getComposerDataIfLoaded === 'function'
        ? (ds.getComposerDataIfLoaded(composerId) || null)
        : null;
    } catch (e) { return null }
  };
  const rowOf = (composerId, data) => ({
    composerId: composerId,
    name: (data && data.name) || '',
    status: (data && data.status) || 'unknown',
    unifiedMode: (data && data.unifiedMode) || '',
    text: (data && data.text) || '',
    isGenerating: !!(data && (data.isGenerating === true || String(data.status || '').toLowerCase() === 'generating')),
    createdAt: (data && data.createdAt) || 0
  });
  return {
    ready: true,
    listComposers: function () {
      const metaById = new Map();
      for (const item of allComposersOf()) {
        const id = String(item && item.composerId || '').trim();
        if (id && !metaById.has(id)) metaById.set(id, item);
      }
      const ids = [...metaById.keys()];
      try {
        const ds = dsOf();
        for (const raw of (ds && ds.selectedComposerIds) || []) {
          const id = String(raw || '').trim();
          if (id && !metaById.has(id)) { metaById.set(id, null); ids.push(id); }
        }
      } catch (e) {}
      return ids.map((id) => rowOf(id, dataOf(id) || metaById.get(id) || null));
    },
    createAgent: async function (prompt, name, opts) {
      opts = opts || {};
      const partialState = { unifiedMode: 'agent' };
      if (prompt) { partialState.text = prompt; partialState.richText = prompt; }
      if (name) partialState.name = name;
      try {
        const created = await svc.createComposer({
          skipShowAndFocus: opts.skipShowAndFocus !== false,
          skipFocus: opts.skipFocus !== false,
          skipSelect: opts.skipSelect !== false,
          autoSubmit: !!opts.autoSubmit,
          partialState: partialState
        });
        if (!created || !created.composerId) return { error: created ? 'createComposer returned no composerId' : 'createComposer returned null' };
        return { composerId: String(created.composerId) };
      } catch (e) {
        return { error: String(e && e.message || e).slice(0, 300) };
      }
    },
    submitByComposerId: function (composerId, text, opts) {
      opts = opts || {};
      let cs = null;
      try { cs = svc.composerChatService || null } catch (e) { cs = null }
      if (!cs || typeof cs.submitChatMaybeAbortCurrent !== 'function') {
        return Promise.resolve({ ok: false, error: 'chatService not ready' });
      }
      const submitOpts = {};
      for (const key of ['forceBubbleId', 'isResume', 'bubbleId', 'ignoreQueuing']) {
        if (opts[key] !== undefined) submitOpts[key] = opts[key];
      }
      try {
        return Promise.resolve(cs.submitChatMaybeAbortCurrent(composerId, text, submitOpts)).then(
          function () { return { ok: true } },
          function (e) { return { ok: false, error: String(e && e.message || e).slice(0, 300) } }
        );
      } catch (e) {
        return Promise.resolve({ ok: false, error: String(e && e.message || e).slice(0, 300) });
      }
    },
    getStatus: function (composerId) {
      const data = dataOf(composerId);
      const headers = (data && data.fullConversationHeadersOnly) || [];
      const map = (data && data.conversationMap) || {};
      let lastHuman = null, lastHumanId = '', lastAi = null, lastAiId = '', aiCount = 0;
      for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        if (!header) continue;
        const bubble = map[header.bubbleId] || null;
        if (header.type === 1) { lastHuman = bubble; lastHumanId = String(header.bubbleId || ''); }
        else if (header.type === 2) { aiCount += 1; lastAi = bubble; lastAiId = String(header.bubbleId || ''); }
      }
      return {
        composerId: composerId,
        found: !!data,
        status: (data && data.status) || '',
        text: (data && data.text) || '',
        lastUpdatedAt: (data && data.lastUpdatedAt) || 0,
        chatGenerationUUID: (data && (data.chatGenerationUUID || data.latestChatGenerationUUID)) || '',
        lastHumanText: (lastHuman && typeof lastHuman.text === 'string' && lastHuman.text) || '',
        lastHumanBubbleId: lastHumanId,
        lastAiText: (lastAi && typeof lastAi.text === 'string' && lastAi.text) || '',
        lastAiBubbleId: lastAiId,
        aiBubbleCount: aiCount,
        hasError: !!(lastAi && lastAi.errorDetails),
        errorText: lastAi && lastAi.errorDetails ? String(lastAi.errorDetails.message || lastAi.errorDetails.name || 'error').slice(0, 300) : ''
      };
    },
    getComposerData: function (composerId) {
      return dataOf(composerId);
    },
    getRecentlyCreatedComposers: function (sinceMs) {
      const cutoff = Date.now() - (sinceMs || 60000);
      return this.listComposers().filter(function (row) { return row.createdAt && row.createdAt > cutoff });
    }
  };
})();`

/** 通用 CDP 调用面：观察器持久 socket 与一次性定位 socket 共用同一定位逻辑。 */
export type CdpCall = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function remoteObjectId(result: unknown, key: 'result' | 'objects'): string | undefined {
  if (!isRecord(result)) return undefined
  const remote = result[key]
  if (!isRecord(remote)) return undefined
  return typeof remote.objectId === 'string' && remote.objectId ? remote.objectId : undefined
}

function remoteValue(result: unknown): unknown {
  if (!isRecord(result)) return undefined
  if (result.exceptionDetails !== undefined) return undefined
  const remote = result.result
  return isRecord(remote) ? remote.value : undefined
}

/**
 * 在目标页面上确保 __sgComposerService 已挂载（幂等）：
 * 已在位 → 一次 evaluate 短路；缺席 → queryObjects 定位并挂载。
 * 任何一步异常都收敛为 false，绝不向上抛——消费方（hook 自轮询 / 业务表达式的
 * bridge_not_ready 门）自带兜底语义。
 */
export async function locateComposerServiceViaCall(call: CdpCall): Promise<boolean> {
  try {
    const present = remoteValue(await call('Runtime.evaluate', {
      expression: COMPOSER_SERVICE_PRESENT_EXPRESSION,
      returnByValue: true
    }))
    if (present === true) return true
  } catch {
    return false
  }
  try {
    const proto = await call('Runtime.evaluate', { expression: 'Map.prototype', objectGroup: LOCATE_OBJECT_GROUP })
    const prototypeObjectId = remoteObjectId(proto, 'result')
    if (!prototypeObjectId) return false
    const objects = await call(
      'Runtime.queryObjects',
      { prototypeObjectId, objectGroup: LOCATE_OBJECT_GROUP },
      QUERY_OBJECTS_TIMEOUT_MS
    )
    const objectId = remoteObjectId(objects, 'objects')
    if (!objectId) return false
    const scan = await call('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: COMPOSER_SERVICE_LOCATE_FUNCTION,
      returnByValue: true
    }, SCAN_TIMEOUT_MS)
    return remoteValue(scan) === true
  } catch {
    return false
  } finally {
    try {
      await call('Runtime.releaseObjectGroup', { objectGroup: LOCATE_OBJECT_GROUP })
    } catch {
      // 释放失败只影响该 socket 生命周期内的对象句柄占用，不影响定位结论
    }
  }
}

/** 测试可注入的最小 socket 面（与 stream-observer 的注入形状一致）。 */
export interface LocatorSocket {
  send(text: string): void
  close(): void
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export interface EnsureComposerServiceOptions {
  openSocket?: (webSocketDebuggerUrl: string) => LocatorSocket
}

function defaultLocatorSocket(webSocketDebuggerUrl: string): LocatorSocket {
  const socket = new WebSocket(webSocketDebuggerUrl, {
    handshakeTimeout: SOCKET_HANDSHAKE_TIMEOUT_MS,
    maxPayload: 4 * 1024 * 1024
  })
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
    on: (event, listener) => {
      if (event === 'open') socket.on('open', listener as () => void)
      else if (event === 'message') socket.on('message', listener as (data: unknown) => void)
      else if (event === 'close') socket.on('close', listener as () => void)
      else socket.on('error', listener as (error: Error) => void)
    }
  }
}

/**
 * 一次性多命令定位会话：开独立 socket → Runtime.enable → 定位 → 关闭。
 * 供无持久连接的调用方（会话创建器冷启动兜底）使用；观察器请直接以自身
 * socket 的 call 走 locateComposerServiceViaCall，避免重复建连。
 */
export async function ensureComposerServiceLocated(
  webSocketDebuggerUrl: string,
  options: EnsureComposerServiceOptions = {}
): Promise<boolean> {
  const openSocket = options.openSocket ?? defaultLocatorSocket
  let socket: LocatorSocket
  try {
    socket = openSocket(webSocketDebuggerUrl)
  } catch {
    return false
  }
  let seq = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let closed = false
  const failAll = (reason: string): void => {
    if (closed) return
    closed = true
    for (const entry of pending.values()) entry.reject(new Error(reason))
    pending.clear()
  }
  socket.on('message', (data) => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.id !== 'number' || !pending.has(message.id)) return
    const entry = pending.get(message.id)!
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  socket.on('close', () => failAll('locator socket closed'))
  socket.on('error', () => failAll('locator socket error'))

  const call: CdpCall = (method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) => {
    if (closed) return Promise.reject(new Error('locator socket closed'))
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`locator call timeout: ${method}`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('locator socket 未在时限内建立')), SOCKET_HANDSHAKE_TIMEOUT_MS + 1_000)
      socket.on('open', () => { clearTimeout(timer); resolve() })
      socket.on('error', () => { clearTimeout(timer); reject(new Error('locator socket 连接失败')) })
    })
    await call('Runtime.enable', {})
    return await locateComposerServiceViaCall(call)
  } catch {
    return false
  } finally {
    failAll('locator session finished')
    try { socket.close() } catch { /* 尽力而为 */ }
  }
}
