import type { CdpCall } from './cursor-composer-service-locator'

/**
 * 晴天时代 bundle 补丁的运行时缴械（零文件修改，可逆，页面内幂等）。
 *
 * 自带网关（cursor-composer-service-locator.ts）就位后，拾光不再经 `__qtComposerBridge`
 * 取任何数据，补丁尾段（`__QINGTIAN_SEAMLESS__`，5025 行）却仍在每个 Cursor 窗口里
 * 常驻运转（bundle 只读反查 2026-09-12）：
 *
 * - 8 个周期任务：350ms 全 DOM `querySelectorAll("button,[role='button'],a")`、
 *   500ms / 700ms / 2s 向已死的 36530 端口 fetch（各带退避）、260ms 起的命令轮询、
 *   1s 的两个 installer 与 watch tick；每条 `_qtLog` 再向死端口 POST 一次；
 * - `_installComposerBridgeTraceWrappers` 把桥的 10 个方法包成 trace 包装：每次调用
 *   先对返回值做完整 `JSON.stringify`（replacer + O(n²) 环检测）再判断开关——
 *   `__QT_TRACE_CURSOR_INTERNALS=false` 只能关日志，关不掉这一步。
 *
 * 补丁自己留了两个口子，本模块只用它们，不改任何 Cursor 内部对象：
 * - `window.__qingtianSeamlessRuntime.stop(reason)`：晴天插件重装时停旧运行时的 API，
 *   清掉全部 `_qtSetInterval` / `_qtSetTimeout` 登记的定时器并置 `_qtStopped`；
 * - 每个包装函数保留 `__qtOriginal`：据此把桥方法换回原函数；`bridge.__qtTraceWrapped`
 *   保持为 true，installer 即便还在也会短路不再重包。
 *
 * 被动全局（`__qtComposerService`、`__qtComposerBridge` 本体）原样保留——它们没有
 * 运行成本，过渡期仍可作兜底。补丁不存在（清洁安装 / 已真摘）时本表达式是纯只读探测。
 */

export const LEGACY_PATCH_DISARMED_GLOBAL = '__sgLegacyPatchDisarmed'

export interface LegacyPatchDisarmResult {
  /** 页面里有补丁运行时或补丁桥。 */
  present: boolean
  /** 本次或此前已成功调用补丁的 stop()。 */
  stopped: boolean
  /** 本次或此前换回原函数的桥方法数。 */
  unwrapped: number
  /** 早已缴械（同一文档内第二次及以后的调用）。 */
  already: boolean
}

export const LEGACY_PATCH_DISARM_EXPRESSION = `(() => {
  const w = globalThis;
  const done = w.${LEGACY_PATCH_DISARMED_GLOBAL};
  if (done && typeof done === 'object' && done.at) {
    return { present: true, stopped: done.stopped === true, unwrapped: Number(done.unwrapped) || 0, already: true };
  }
  const result = { present: false, stopped: false, unwrapped: 0, already: false };
  const runtime = w.__qingtianSeamlessRuntime;
  if (runtime && typeof runtime.stop === 'function') {
    result.present = true;
    try { runtime.stop('shiguang own gateway active'); result.stopped = true } catch (e) {}
  }
  const bridge = w.__qtComposerBridge;
  if (bridge && typeof bridge === 'object') {
    result.present = true;
    for (const key of Object.keys(bridge)) {
      const fn = bridge[key];
      if (typeof fn === 'function' && fn.__qtTraceWrapped === true && typeof fn.__qtOriginal === 'function') {
        try { bridge[key] = fn.__qtOriginal; result.unwrapped += 1 } catch (e) {}
      }
    }
    try { bridge.__qtTraceWrapped = true } catch (e) {}
  }
  if (result.present) {
    try { w.__QT_TRACE_CURSOR_INTERNALS = false } catch (e) {}
    try { w.${LEGACY_PATCH_DISARMED_GLOBAL} = { at: Date.now(), stopped: result.stopped, unwrapped: result.unwrapped } } catch (e) {}
  }
  return result;
})()`

export function parseLegacyPatchDisarmResult(value: unknown): LegacyPatchDisarmResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.present !== 'boolean') return undefined
  const unwrapped = Number(raw.unwrapped)
  return {
    present: raw.present,
    stopped: raw.stopped === true,
    unwrapped: Number.isFinite(unwrapped) && unwrapped > 0 ? Math.floor(unwrapped) : 0,
    already: raw.already === true
  }
}

/**
 * 在目标页面执行缴械并返回结果；任何协议 / 脚本异常都收敛为 undefined，绝不向上抛——
 * 缴械是锦上添花，不能阻断 hook 安装链路。
 */
export async function disarmLegacyPatchViaCall(call: CdpCall): Promise<LegacyPatchDisarmResult | undefined> {
  try {
    const result = await call('Runtime.evaluate', { expression: LEGACY_PATCH_DISARM_EXPRESSION, returnByValue: true })
    if (!result || typeof result !== 'object') return undefined
    const record = result as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (record.exceptionDetails !== undefined) return undefined
    return parseLegacyPatchDisarmResult(record.result?.value)
  } catch {
    return undefined
  }
}
