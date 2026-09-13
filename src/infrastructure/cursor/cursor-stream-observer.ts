import WebSocket from 'ws'
import type { CursorUsageEvent, CursorUsageSample } from '../../domain/cursor-usage'
import { nativeUsagePayload } from './cursor-native-usage'
import { CHANNEL_USER_DELIVERY_MARKER } from '../../domain/channel-delivery-policy'
import { cursorStatusLineOf, parseCursorStatusLine, type CursorStatusLine } from '../../domain/cursor-status-line'
import {
  CURSOR_CDP_DEFAULT_PORT,
  CURSOR_CDP_PORT_ENV,
  parseProcessStream,
  STREAM_DIFF_MAX_LINE_CHARS,
  STREAM_DIFF_MAX_LINES,
  TRANSPORT_TOOL_NAMES,
  type CursorProcessStream
} from './cursor-cdp-session-creator'
import {
  SG_COMPOSER_SERVICE_GLOBAL,
  locateComposerServiceViaCall,
  type CdpCall
} from './cursor-composer-service-locator'
import { disarmLegacyPatchViaCall, type LegacyPatchDisarmResult } from './cursor-legacy-patch-disarm'

/**
 * Cursor 过程流写信号观察者（事件驱动层）。
 *
 * 在 Cursor workbench 渲染进程内 hook composerDataHandleManager 的写路径
 * （markDirty / markMessageDirty / updateWithoutMarkingDirty / pushComposer——
 * 每次模型写入与持久化批次必经），经 CDP Runtime binding「sgTeamStream」
 * 把写信号推回主进程：真正的事件推送，空闲期零事件（实测 0/3s）、
 * 投递延迟 p50=0ms。
 *
 * 页面内同时推送 composerId 写信号与当前 Composer 的原生有序过程快照；
 * thinking、工具参数/结果、todo 均在写后同一微任务读取，不再经过主进程
 * 二次 evaluate，也不读取 transcript 或 Agent 主动上报的过程。
 *
 * hook 的生命周期必须跟随「文档」而不是「socket」：Cursor 窗口原地重载
 *（Reload Window / 同窗口切换文件夹 / 切号重启后重开工作区）时 CDP target 与
 * socket 都不变，旧文档里的 hook 却随文档消失；binding 由 Runtime 域自动注入新
 * 文档，于是出现「binding 在、hook 不在、状态 connected、永远零帧」（2026-09-05
 * 事故）。因此三重保障：
 * 1. Page.enable + Page.addScriptToEvaluateOnNewDocument——不启用 Page 域时
 *    该脚本只登记不执行（Chromium 语义，Electron 43 实测）；
 * 2. Runtime.executionContextsCleared / executionContextCreated 事件驱动重装；
 * 3. 低频健康自检（探针只读；hook 缺席才重装），兜住一切未知路径。
 * 状态 connected 的含义是「hook 已在当前文档验证就位」，不是「socket 开着」。
 * 连接断开按退避重连。运行时轮询只承担会话存活与正文状态核验，不承担过程
 * 重建；observer 缺席时明确没有过程帧，避免用低保真来源伪装成 Cursor 原生体验。
 *
 * 用量通道（usage）：bundle 补丁（patch-cursor-usage-hook.ts）在
 * turnEnded 消费点调用 __sgTeamUsage(JSON)——本 observer 注册同名 binding
 * 接收每回合真实计费 token 并解析转发（onUsageEvent）。
 */

export const CURSOR_STREAM_BINDING_NAME = 'sgTeamStream'
export const CURSOR_USAGE_BINDING_NAME = '__sgTeamUsage'
export const CURSOR_PROCESS_BINDING_NAME = 'sgTeamProcess'
/**
 * 页面内 hook 版本：不一致时 install 会先还原旧 wrapper 再重装（拾光强退后遗留的旧版）。
 * v27（2026-09-11）：shell 运行态以 loading/running 标记为权威、旧形态部分输出接入（RC-A）；
 * await 归 command 类并给出运行时长提示；items 携带原生 toolCase。
 * v28（2026-09-11）：编辑块携带结构化 diff（precomputedDiff 或 diffString 解析）；grep 提示
 * 匹配数 / 文件数，输出按文件列出命中行。
 * v29（2026-09-11）：编辑运行中从 args.streamContent 提取流式 diff；不下发原始大字符串，
 * 同一 edit block 随 Cursor 约 250ms 的增量 flush 原地更新，完成后无缝切最终 diff。
 * v30（2026-09-12）：过程载荷 100ms 节流——生成期帧只带正文/状态小载荷，过程块在窗口
 * 边界与终结帧全量携带（Cursor 1h+ 卡顿根治：每次写入的 ~3MB stringify+IPC 风暴降为 ≤10/s）。
 * （isUserDelivery 阴性缓存经测试验证存在水合竞态，有意不做。）
 * v31（2026-09-12）：回合存活与 token 流式拆成两个信号。帧级 isGenerating 以 Cursor 自己的
 * 回合状态 `composerData.status === 'generating'` 为权威（3.6.31 的 ComposerData 没有
 * isGenerating 字段，旧式 `generatingBubbleIds.length > 0` 在每次工具执行期恒为空，
 * 把每个工具调用都当成了回合终结帧）；气泡级流式仍由 generatingBubbleCount /
 * response.generating 表达，供正文生命周期与打字机使用。
 * v32（2026-09-12）：每帧携带 Cursor 会话列表副标题 `statusLine`（`domain/cursor-status-line.ts`
 * 原样注入页面执行）：对未过滤的原始气泡从尾部扫描——thinking → "Thinking"、有详情的工具 →
 * "Reading foo.ts"、正文 → 首行 50 字，MCP / shell 等无详情工具跳过。它只喂名册活动行，
 * 不进 items、不进封口、不落库；节流窗内的小帧也带（约 100 字节）。同时携带 composerStatus
 * 供非生成态区分 Completed / Stopped。
 * v33（2026-09-12）：服务来源切换到拾光自带网关——页面内等待的全局从补丁的
 * __qtComposerService 换成 locator 挂载的 __sgComposerService（自有 CDP 定位，
 * 零 bundle 修改；见 cursor-composer-service-locator.ts）。attach / 文档重载重装链路
 * 先跑一次定位，未就绪时页面自轮询照旧等待，观察器侧另有低频定位重试兜底。
 * 定位成功后观察器顺手对晴天补丁运行时缴械（cursor-legacy-patch-disarm.ts：停其 8 个
 * 后台轮询、拆掉桥方法的 trace 包装），零文件修改；hook 版本不变。
 * v34（2026-09-13）：每帧携带 `bubbleCount`（整个 composer 的气泡数，读自已在遍历的
 * fullConversationHeadersOnly，零额外成本；小帧同样携带）。它是席位自动轮换的阈值事实：
 * 持续会话的回合永不结束，Cursor 每次写入的持久化与重分组成本随气泡数线性增长。
 */
export const CURSOR_STREAM_HOOK_VERSION = 34
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000
const ATTACH_TIMEOUT_MS = 8_000
/** hook 健康自检周期：探针只读一次 evaluate，缺席才重装；成本可忽略。 */
const HOOK_HEALTH_INTERVAL_MS = 20_000
/** executionContextCreated 成批到达（主帧 + 各 iframe），合并后再装。 */
const HOOK_CONTEXT_SETTLE_MS = 300
/**
 * 服务定位重试：文档重载后 composerService 要等 workbench 启动才注册，
 * 首次定位（上下文创建 +300ms）几乎必然扑空——按 3s 间隔补试，窗口与
 * hook 页面自轮询（2s×60）同量级。已定位时每次重试只是单次 evaluate 短路。
 */
const LOCATE_RETRY_INTERVAL_MS = 3_000
const LOCATE_RETRY_MAX_ATTEMPTS = 40

/**
 * 页面内注入的 hook 源码：幂等守卫（manager 身份 + wrapped 标记双保险）+
 * 透明包装写方法 + binding 推送 composerId + 原始函数存档（供 dispose 还原）。
 * 服务异步就绪：__sgComposerService 由 locator 经 CDP 定位后挂载（文档重载后
 * 需重新定位），manager 也可能晚于文档就绪——页面内自轮询重试（2s 间隔，
 * 上限 60 次），配合观察器侧的定位重试，保证重载后 hook 自动恢复。
 */
export const CURSOR_STREAM_HOOK_EXPRESSION = `(() => {
  const HOOK_VERSION = ${CURSOR_STREAM_HOOK_VERSION}
  // Cursor 会话列表副标题算法（domain/cursor-status-line.ts 唯一实现，原样注入执行）。
  const statusLineOf = ${cursorStatusLineOf.toString()}
  let attempts = 0
  const pendingSnapshots = new Set()
  let snapshotQueued = false
  function classifyTool(name) {
    const n = String(name || '').toLowerCase()
    if (n.includes('todo')) return 'todo'
    if (n.includes('browser') || n.includes('computer') || n.includes('screenshot') || n.includes('navigate') || n.includes('click') || n.includes('fetch')) return 'browser'
    if (n.startsWith('mcp-') || n.startsWith('get_mcp_tools') || n.includes('_mcp_') || n.includes('mcptool')) return 'mcp'
    if (n.includes('read') || n.includes('lint') || n.includes('ls_tool') || n.includes('lstool')) return 'read'
    if (n.includes('glob') || n.includes('grep') || n.includes('search') || n.includes('find')) return 'search'
    if (n.includes('edit') || n.includes('apply') || n.includes('delete')) return 'edit'
    if (n.includes('write') || n.includes('create_file')) return 'write'
    if (n.includes('shell') || n.includes('terminal') || n.includes('command') || n.includes('run_') || n.includes('exec')) return 'command'
    return 'other'
  }
  function toolInfo(td) {
    const wrapped = td?.toolCall?.tool
    const value = wrapped?.value
    const toolCase = typeof wrapped?.case === 'string' ? wrapped.case : ''
    const legacy = typeof td?.name === 'string' ? td.name
      : typeof td?.tool === 'string' ? td.tool
      : ''
    let name = legacy || toolCase || (td?.tool !== undefined ? 'cursorTool:' + String(td.tool) : '')
    let args = value?.args || td?.params || (() => {
      try { return JSON.parse(String(td?.rawArgs || '{}')) } catch (e) { return {} }
    })()
    // Cursor 3.6.31 的 edit 增量由 editToolCallHandler 每帧 flush 到
    // bubble.params.streamingContent；现代 toolCall.value.args 往往仍是起始快照。
    // 只为 presenter 合并成 streamContent 别名，safePlain 随后按既有规则脱敏。
    if (toolCase === 'editToolCall' && typeof td?.params?.streamingContent === 'string') {
      args = { ...args, streamContent: td.params.streamingContent }
    }
    const result = value?.result || td?.result
    let mcpPending = false
    if (toolCase.toLowerCase() === 'mcptoolcall') {
      // Cursor 3.6 现代 args 里服务器名叫 providerIdentifier（"SG Team"）；旧字段保留兼容。
      const server = args?.server || args?.serverName || args?.providerIdentifier || value?.serverName || ''
      const called = args?.toolName || args?.name || value?.toolName || ''
      if (called) name = 'mcp-' + String(server || 'server') + '-' + String(called)
      // MCP ToolCall 首帧可能只有 toolCase、真实工具名下一帧才水合（RC-5.1）：
      // 占位名（mcpToolCall/mcp--）暂缓展示，水合后按真实名称分类展示或隐藏。
      else mcpPending = true
    }
    const rawStatus = String(td?.status || value?.status || '').toLowerCase()
    const additionalStatus = String(td?.additionalData?.status || '').toLowerCase()
    let status = rawStatus === 'completed' || rawStatus === 'success' || rawStatus === 'done'
      ? 'done'
      : rawStatus === 'error' || rawStatus === 'failed' ? 'failed' : 'running'
    const resultCase = String(result?.result?.case || result?.case || '').toLowerCase()
    // 运行权威（3.6.31 实测）：shell 执行期间 td.status='loading'、additionalData.status='running'，
    // 而 Cursor 的 shell UI 服务会把流式输出定时 flush 进旧形态 td.result（部分输出），现代
    // value.result 直到结束才出现。旧规则「有 result 即完成」会让一有输出的命令立刻变「完成」
    //（RC-A）。显式运行标记在场时 result 只是部分结果；旧形态（无标记）保留原回退。
    const explicitlyRunning = rawStatus === 'loading' || rawStatus === 'running' || additionalStatus === 'running'
    if (status === 'running' && !explicitlyRunning && result !== undefined) {
      status = resultCase === 'error' || resultCase === 'failure' ? 'failed' : 'done'
    }
    const error = td?.error || result?.error || (resultCase === 'error' || resultCase === 'failure' ? result : undefined)
    return { name, args, result, status, error, mcpPending, toolCase }
  }
  // ---- 工具呈现（与 Cursor 自身聊天面板同口径）----
  // Cursor 3.6 的现代 args 是 protobuf JSON：数字/布尔/嵌套 JSON 常以字符串到达
  //（"timeout":"30000"、"simpleCommands":"[\\"ls\\",\\"git\\"]"），先宽容解析。
  function parseJsonMaybe(value) {
    if (typeof value !== 'string') return value
    const text = value.trim()
    if (!text) return undefined
    try { return JSON.parse(text) } catch (e) { return undefined }
  }
  function baseName(path) {
    const text = String(path || '').replace(/[\\/]+$/, '')
    const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\\\'))
    return index >= 0 ? text.slice(index + 1) : text
  }
  function asCount(value) {
    const num = Number(value)
    return Number.isFinite(num) && num >= 0 ? num : undefined
  }
  // 结果载荷：现代形态 {result:{case:'success', value:{…}}}（外层无 case）或已解包形态。
  function resultPayload(result) {
    if (!result || typeof result !== 'object') return undefined
    const inner = result.result && typeof result.result === 'object' && typeof result.result.case === 'string'
      ? unwrapCase(result.result)
      : unwrapCase(result)
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : undefined
  }
  function joinStd(payload) {
    return [payload.stdout, payload.stderr].map(part => String(part || '').trim()).filter(Boolean).join('\\n')
  }
  // Shell 头部提示：与 Cursor 一致列出程序名（"cd, python3"），非零退出码追加 exit N。
  function shellHint(args, payload) {
    let programs = parseJsonMaybe(args?.simpleCommands)
    if (!Array.isArray(programs)) {
      const first = String(args?.command || '').trim().split(/\\s+/)[0]
      programs = first ? [first] : []
    }
    const unique = [...new Set(programs.map(item => String(item || '').trim()).filter(Boolean))]
    const parts = []
    if (unique.length) parts.push(unique.slice(0, 4).join(', ') + (unique.length > 4 ? ' +' + (unique.length - 4) : ''))
    const exitCode = asCount(payload?.exitCode)
    if (exitCode !== undefined && exitCode !== 0) parts.push('exit ' + exitCode)
    return parts.join(' · ')
  }
  function readHint(payload) {
    const range = payload?.readRange
    const start = asCount(range?.startLine), end = asCount(range?.endLine)
    if (start !== undefined && end !== undefined) return 'L' + start + '-' + end
    const total = asCount(payload?.totalLines)
    return total !== undefined ? total + ' 行' : ''
  }
  function editHint(payload) {
    const added = asCount(payload?.linesAdded), removed = asCount(payload?.linesRemoved)
    if (added === undefined && removed === undefined) return ''
    return '+' + (added || 0) + ' −' + (removed || 0)
  }
  // ---- 编辑 diff（3.6.31 实测）：整文件写入时 additionalData.precomputedDiff.lines 有
  // {type:'added'|…, content, originalLineNumber, modifiedLineNumber}；替换式编辑该数组为空，
  // 只有 result.diffString（标准 unified diff：--- a/ +++ b/ @@ -a,b +c,d @@ 与 ' '/'-'/'+' 行）。
  // 两种来源统一解析为 {type, text, oldLine, newLine}，渲染层按行着色。
  const DIFF_MAX_LINES = ${STREAM_DIFF_MAX_LINES}
  const DIFF_MAX_LINE_CHARS = ${STREAM_DIFF_MAX_LINE_CHARS}
  function parseUnifiedDiff(text) {
    const lines = []
    let oldLine = 0, newLine = 0, inHunk = false
    for (const raw of String(text).split(/\\r?\\n/)) {
      if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('diff ') || raw.startsWith('index ')) continue
      const hunk = raw.match(/^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/)
      if (hunk) {
        oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true
        lines.push({ type: 'hunk', text: raw })
        continue
      }
      if (!inHunk) continue
      if (raw.startsWith('\\\\')) continue
      const marker = raw[0]
      const body = raw.slice(1)
      if (marker === '+') { lines.push({ type: 'added', text: body, newLine }); newLine += 1 }
      else if (marker === '-') { lines.push({ type: 'removed', text: body, oldLine }); oldLine += 1 }
      else if (marker === ' ' || raw === '') { lines.push({ type: 'context', text: body, oldLine, newLine }); oldLine += 1; newLine += 1 }
    }
    return lines
  }
  // Cursor IfC/AfC 同款回退：流式内容尚无完整 @@ hunk 时，仍按行前缀解析；
  // 无 +/- 前缀的增量代码按 context 展示，等下一帧完整 diff 到齐后自然替换。
  function parseStreamingDiff(text) {
    const source = String(text || '')
    const unified = parseUnifiedDiff(source)
    if (unified.length) return unified
    const lines = []
    let oldLine = 1, newLine = 1
    for (const raw of source.split(/\\r?\\n/)) {
      if (raw.startsWith('\\\\ No newline at end of file') || raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) continue
      const marker = raw[0]
      const body = raw.length ? raw.slice(1) : ''
      if (marker === '+') { lines.push({ type: 'added', text: body, newLine }); newLine += 1 }
      else if (marker === '-') { lines.push({ type: 'removed', text: body, oldLine }); oldLine += 1 }
      else if (marker === ' ') { lines.push({ type: 'context', text: body, oldLine, newLine }); oldLine += 1; newLine += 1 }
      else { lines.push({ type: 'context', text: raw, oldLine, newLine }); oldLine += 1; newLine += 1 }
    }
    return lines
  }
  function diffFromEdit(td, payload, args) {
    let lines = []
    let streaming = false
    const pre = td?.additionalData?.precomputedDiff?.lines
    if (Array.isArray(pre) && pre.length) {
      lines = pre.map(line => {
        const type = line?.type === 'added' ? 'added'
          : line?.type === 'removed' || line?.type === 'deleted' ? 'removed' : 'context'
        const oldLine = asCount(line?.originalLineNumber), newLine = asCount(line?.modifiedLineNumber)
        return { type, text: String(line?.content ?? ''), ...(oldLine !== undefined ? { oldLine } : {}), ...(newLine !== undefined ? { newLine } : {}) }
      })
    } else if (typeof payload?.diffString === 'string' && payload.diffString) {
      lines = parseUnifiedDiff(payload.diffString)
    } else if (typeof args?.streamContent === 'string' && args.streamContent) {
      lines = parseStreamingDiff(args.streamContent)
      streaming = true
    }
    // 只有 hunk 头没有内容行的 diff 没有信息量：不产出结构化 diff，让 diffString 文本回退继续生效。
    if (!lines.some(line => line.type !== 'hunk')) return undefined
    // 完成态保留头部（正式 diff 阅读顺序）；直播态保留尾部，否则超过上限后
    // 前 240 行固定不变，视窗会停止跟随模型正在写入的新内容。
    const windowed = streaming ? lines.slice(-DIFF_MAX_LINES) : lines.slice(0, DIFF_MAX_LINES)
    const kept = windowed.map(line => ({ ...line, text: line.text.length > DIFF_MAX_LINE_CHARS ? line.text.slice(0, DIFF_MAX_LINE_CHARS) + '…' : line.text }))
    const truncatedLineCount = lines.length - kept.length
    return truncatedLineCount > 0 ? { lines: kept, truncatedLineCount } : { lines: kept }
  }
  // ---- grep 结果（3.6.31 实测）：{pattern, path, outputMode, workspaceResults:{[ws]:{result:{case:'content',
  // value:{matches:[{file, matches:[{lineNumber, content, isContextLine}]}], totalMatchedLines, clientTruncated,
  // ripgrepTruncated}}}}}；其它 case（files / counts）按可用字段计数。
  function grepWorkspaces(payload) {
    const results = payload?.workspaceResults
    if (!results || typeof results !== 'object') return []
    return (Array.isArray(results) ? results : Object.values(results)).map(item => unwrapCase(item?.result) || item).filter(Boolean)
  }
  function grepSummary(payload) {
    let matched = 0, files = 0, truncated = false, seen = false
    for (const ws of grepWorkspaces(payload)) {
      if (!ws || typeof ws !== 'object') continue
      if (Array.isArray(ws.matches)) {
        seen = true
        files += ws.matches.length
        const total = asCount(ws.totalMatchedLines)
        matched += total !== undefined ? total : ws.matches.reduce((sum, file) => sum + (Array.isArray(file?.matches) ? file.matches.filter(m => !m?.isContextLine).length : 0), 0)
      } else if (Array.isArray(ws.files)) {
        seen = true
        files += ws.files.length
      } else if (Array.isArray(ws.counts)) {
        seen = true
        files += ws.counts.length
        matched += ws.counts.reduce((sum, item) => sum + (asCount(item?.count) || 0), 0)
      }
      if (ws.clientTruncated === true || ws.ripgrepTruncated === true) truncated = true
    }
    return seen ? { matched, files, truncated } : undefined
  }
  function grepHint(args, payload) {
    const summary = grepSummary(payload)
    if (!summary) return args?.path ? baseName(args.path) : (args?.glob || '')
    const parts = []
    if (summary.matched) parts.push(summary.matched + ' 处匹配')
    parts.push(summary.files + ' 个文件')
    if (summary.truncated) parts.push('已截断')
    return parts.join(' · ')
  }
  function grepOutput(payload) {
    const chunks = []
    let lines = 0
    for (const ws of grepWorkspaces(payload)) {
      if (!ws || typeof ws !== 'object') continue
      if (Array.isArray(ws.matches)) {
        for (const file of ws.matches) {
          if (lines >= 200) break
          chunks.push(String(file?.file || ''))
          lines += 1
          for (const match of (Array.isArray(file?.matches) ? file.matches : [])) {
            if (lines >= 200) break
            if (match?.isContextLine) continue
            chunks.push('  L' + String(match?.lineNumber ?? '?') + ': ' + String(match?.content ?? '').trim().slice(0, 300))
            lines += 1
          }
        }
      } else if (Array.isArray(ws.files)) {
        for (const file of ws.files.slice(0, 200)) chunks.push(String(file))
      } else if (Array.isArray(ws.counts)) {
        for (const item of ws.counts.slice(0, 200)) chunks.push(String(item?.file || '') + ': ' + String(item?.count ?? ''))
      }
    }
    return chunks.join('\\n')
  }
  // await 结果：{awaitResult:{case:'complete', value:{runtimeMs, exitCode, outputFilePath}}} 或已解包形态。
  function awaitHint(payload) {
    const inner = unwrapCase(payload?.awaitResult) || payload
    if (!inner || typeof inner !== 'object') return ''
    const parts = []
    const runtime = asCount(inner.runtimeMs)
    if (runtime !== undefined) parts.push(runtime >= 1000 ? Math.round(runtime / 1000) + 's' : runtime + 'ms')
    const exitCode = asCount(inner.exitCode)
    if (exitCode !== undefined && exitCode !== 0) parts.push('exit ' + exitCode)
    return parts.join(' · ')
  }
  function fileCountHint(payload, fallback) {
    const total = asCount(payload?.totalFiles) ?? (Array.isArray(payload?.files) ? payload.files.length : undefined)
    return total !== undefined ? total + ' 个文件' : fallback
  }
  // ask_question 的结构化状态：题目/选项来自 params（部分水合帧只有前几题也照收），
  // 相位来自 additionalData.status（pending/submitted/cancelled），答案来自 result。
  function questionPayload(td, args, result) {
    const source = args && Array.isArray(args.questions) ? args : (td?.params && Array.isArray(td.params.questions) ? td.params : undefined)
    const questions = (source?.questions || []).slice(0, 20).flatMap(item => {
      if (!item || typeof item !== 'object') return []
      return [{
        id: String(item.id || ''),
        prompt: clipText(item.prompt, 2000),
        allowMultiple: item.allowMultiple === true || item.allowMultiple === 'true',
        options: (Array.isArray(item.options) ? item.options : []).slice(0, 30).map(option => ({
          id: String(option?.id || ''), label: clipText(option?.label, 2000)
        }))
      }]
    })
    const additional = td?.additionalData && typeof td.additionalData === 'object' ? td.additionalData : {}
    const status = additional.status === 'submitted' || additional.status === 'cancelled' ? additional.status : 'pending'
    const payload = resultPayload(result)
    const answers = Array.isArray(payload?.answers)
      ? payload.answers.slice(0, 20).map(answer => ({
          questionId: String(answer?.questionId || ''),
          selectedOptionIds: (Array.isArray(answer?.selectedOptionIds) ? answer.selectedOptionIds : []).map(String),
          freeformText: typeof answer?.freeformText === 'string' && answer.freeformText ? clipText(answer.freeformText, 2000) : undefined
        }))
      : undefined
    return {
      toolCallId: String(td?.toolCallId || ''),
      title: clipText(source?.title || '', 2000) || undefined,
      questions,
      status,
      answers,
      skipReason: typeof additional.skipReason === 'string' ? additional.skipReason : undefined
    }
  }
  // 按 toolCall.tool.case 的呈现表：kind 决定图标与动词；title 是模型给出的意图说明；
  // summary 是对象（路径/命令/模式）；hint 是结果侧紧凑提示。缺 case（旧形态）回退名称分类。
  const TOOL_PRESENTERS = {
    // output：完成后取现代 interleavedOutput / stdout+stderr；运行中只有旧形态的部分输出 p.output（实时面板数据源）。
    shellToolCall: { kind: 'command', title: a => a.description, summary: a => a.command, hint: (a, p) => shellHint(a, p), output: p => p.interleavedOutput || joinStd(p) || (typeof p.output === 'string' ? p.output : '') },
    readToolCall: { kind: 'read', summary: a => a.path || a.targetFile, hint: (a, p) => readHint(p) },
    lsToolCall: { kind: 'read', summary: a => a.path },
    readLintsToolCall: { kind: 'read', summary: a => Array.isArray(a.paths) ? a.paths.map(baseName).join(', ') : a.path },
    grepToolCall: { kind: 'search', summary: a => a.pattern, hint: (a, p) => grepHint(a, p), output: p => grepOutput(p) },
    globToolCall: { kind: 'search', summary: a => a.globPattern, hint: (a, p) => fileCountHint(p, baseName(a.targetDirectory)) },
    semSearchToolCall: { kind: 'search', summary: a => a.query },
    webSearchToolCall: { kind: 'browser', summary: a => a.searchTerm },
    fetchToolCall: { kind: 'browser', summary: a => a.url },
    webFetchToolCall: { kind: 'browser', summary: a => a.url },
    editToolCall: { kind: 'edit', summary: a => a.path, hint: (a, p) => editHint(p), output: p => p.diffString || p.message },
    deleteToolCall: { kind: 'edit', summary: a => a.path },
    applyAgentDiffToolCall: { kind: 'edit' },
    updateTodosToolCall: { kind: 'todo' },
    readTodosToolCall: { kind: 'todo' },
    taskToolCall: { kind: 'task', title: a => a.description, summary: a => a.model, hint: (a, p, td) => td?.additionalData?.terminationReason || '' },
    // await = 等待后台命令结束（Cursor 归入 "Monitoring background tasks"），不是子 Agent：
    // 归 command 类（终端图标），提示给出运行时长与非零退出码。
    awaitToolCall: { kind: 'command', summary: a => a.taskId, hint: (a, p) => awaitHint(p) },
    askQuestionToolCall: { kind: 'question', title: a => a.title },
    switchModeToolCall: { kind: 'other', title: a => a.explanation, summary: a => [a.fromModeId, a.toModeId].filter(Boolean).join(' → ') },
    getMcpToolsToolCall: { kind: 'mcp', summary: a => a.server || a.pattern }
  }
  function present(td, tool) {
    const presenter = TOOL_PRESENTERS[tool.toolCase]
    const args = tool.args && typeof tool.args === 'object' ? tool.args : {}
    const payload = resultPayload(tool.result)
    const text = (fn, ...params) => {
      if (!fn) return ''
      try { return String(fn(...params) || '').trim() } catch (e) { return '' }
    }
    const kind = presenter ? presenter.kind : classifyTool(tool.name)
    const summary = presenter ? text(presenter.summary, args) : toolSummary(td, tool.args)
    const output = presenter && presenter.output && payload ? text(presenter.output, payload) : ''
    let diff
    if (kind === 'edit') {
      try { diff = diffFromEdit(td, payload, args) } catch (e) { diff = undefined }
    }
    // 有结构化 diff 时不再把 diffString 原文当 output 重复携带（体积翻倍且渲染层不再用它），
    // 只留结果消息；无结构化 diff 的旧形态保持 diffString 文本回退。
    const shownOutput = kind === 'edit' && diff
      ? String(payload?.message || '').trim().slice(0, 2000)
      : output ? clipText(output, 12000) : outputText(tool.result)
    let hint = text(presenter?.hint, args, payload, td).slice(0, 160)
    if (kind === 'edit' && !hint && diff) {
      const added = diff.lines.filter(line => line.type === 'added').length
      const removed = diff.lines.filter(line => line.type === 'removed').length
      if (added || removed) hint = '+' + added + ' −' + removed
    }
    return {
      kind,
      title: clipText(text(presenter?.title, args), 300),
      summary: (summary || toolSummary(td, tool.args)).slice(0, 160),
      hint,
      output: shownOutput,
      question: kind === 'question' ? questionPayload(td, args, tool.result) : undefined,
      diff
    }
  }
  // Composer 是否阻塞在需要用户决策的工具上（ToolFormer capability 的待决策表）。
  function awaitingUserDecision(data) {
    try {
      const capability = (data?.capabilities || []).find(item => item && typeof item.getIsBlockingUserDecision === 'function')
      return capability ? capability.getIsBlockingUserDecision()() === true : false
    } catch (e) { return false }
  }
  function isTransportNoise(name) {
    const lower = String(name || '').toLowerCase()
    return ${JSON.stringify(TRANSPORT_TOOL_NAMES)}.some(item => (
      lower === item || lower.endsWith('-' + item) || lower.endsWith('_' + item)
    ))
  }
  // MCP 结果在 Cursor 内存里有两套形态并存，toolInfo 优先取现代形态：
  // - 落盘同款：toolFormerData.result = {selectedTool, result:"{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":…}]}"}（双层 JSON 字符串）
  // - 现代（protobuf 判别联合）：toolCall.tool.value.result =
  //   {result:{case:'success', value:{content:[{content:{case:'text', value:{text}}}, {content:{case:'image', value:{data,mimeType}}}], isError}}}
  // 2026-09-07 事故：旧扫描只认 result/output/content/contents 与 .text，现代形态的文本藏在
  // value / content.value 里，投递标记永远找不到 → isUserDelivery 恒 false → 投递后的首段业务
  // 思考被尾部兜底当成轮询余波隐藏，直到最终正文出现才整段蹦出（单测用落盘形态构造，假绿）。
  function unwrapCase(value) {
    let current = value
    for (let i = 0; i < 4; i++) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) break
      if (typeof current.case !== 'string' || !('value' in current)) break
      current = current.value
    }
    return current
  }
  // 判别联合形态的内容块 {content:{case:'text'|'image', value:{…}}} → {type, …value}；其它形态原样返回。
  function normalizeContentBlock(item) {
    const union = item && typeof item === 'object' && !Array.isArray(item) ? item.content : undefined
    if (!union || typeof union !== 'object' || Array.isArray(union) || typeof union.case !== 'string') return item
    const inner = union.value
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? { type: union.case, ...inner } : { type: union.case }
  }
  // 传输工具结果里的文本片段（不裁剪、不展开 image/base64）。
  function collectResultTexts(value, depth, out) {
    if (value === null || value === undefined || depth > 8 || out.length > 30) return
    value = unwrapCase(value)
    if (typeof value === 'string') {
      const text = value.trim()
      if ((text.startsWith('{') || text.startsWith('[')) && text.length < 2000000) {
        try { collectResultTexts(JSON.parse(text), depth + 1, out); return } catch (e) {}
      }
      out.push(value)
      return
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 30)) collectResultTexts(normalizeContentBlock(item), depth + 1, out); return }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') out.push(value.text)
      for (const key of ['result', 'output', 'content', 'contents']) {
        if (value[key] !== undefined) collectResultTexts(value[key], depth + 1, out)
      }
    }
  }
  // 「本次 check_messages 投递了真实用户消息」：结果文本含投递协议标题（正面证据）。
  // keepalive 返回体、内部协作通知、need_reply_sync、会话围栏文本都不含它。结果一旦到齐
  // 不再变化——按 bubbleId 记忆，长会话里不重复解析同一结果。
  const USER_DELIVERY_MARKER = ${JSON.stringify(CHANNEL_USER_DELIVERY_MARKER)}
  const deliveryByBubble = new Map()
  function isUserDelivery(bubbleId, tool) {
    if (!tool || !tool.name || tool.result === undefined || tool.result === null) return false
    const lower = String(tool.name).toLowerCase()
    if (!(lower === 'check_messages' || lower.endsWith('-check_messages') || lower.endsWith('_check_messages'))) return false
    const key = String(bubbleId || '')
    if (key && deliveryByBubble.get(key) === true) return true
    let delivered = false
    try {
      const texts = []
      collectResultTexts(tool.result, 0, texts)
      delivered = texts.some(text => text.includes(USER_DELIVERY_MARKER))
    } catch (e) { delivered = false }
    // 只缓存正面证据：completed 首帧也可能尚未水合结果（空结果 → 后到齐），
    // 阴性一旦误缓存会把真实投递永久判成轮询余波（2026-09-07 事故的测试在锁）。
    // keepalive 阴性结果体积小（~100 字符），重解析成本可忽略，不值得冒缓存风险。
    if (key && delivered && tool.status !== 'running') {
      if (deliveryByBubble.size > 2000) deliveryByBubble.clear()
      deliveryByBubble.set(key, delivered)
    }
    return delivered
  }
  // ---- 气泡级派生缓存（2026-09-12 Cursor 卡顿根治）----
  // toolInfo/present/safePlain/thinkingInfo 是每帧全量扫描里最贵的逐气泡派生
  //（JSON.parse、8–24KB 裁剪、diff 解析、思考拼接）。回合内气泡追加式变化——
  // 按 bubbleId 缓存派生结果，廉价版本指纹（长度/状态/水合标记）命中即复用。
  // 正在生成的气泡与回合终结帧（归档内容）永远新鲜重算；
  // globalThis.__sgTeamFactCache === false 整体关停（等价性测试与运维逃生门）。
  const toolPayloadStore = new Map()
  const thinkingStore = new Map()
  function cacheBucket(store, composerId, turnId) {
    let bucket = store.get(composerId)
    if (!bucket || bucket.turnId !== turnId) {
      bucket = { turnId, byBubble: new Map() }
      store.set(composerId, bucket)
      if (store.size > 32) {
        const oldest = store.keys().next().value
        if (oldest !== undefined && oldest !== composerId) store.delete(oldest)
      }
    }
    return bucket.byBubble
  }
  function cacheSet(map, key, version, value, ref) {
    if (map.size > 800 && !map.has(key)) {
      let evicted = 0
      for (const old of map.keys()) {
        map.delete(old)
        if (++evicted >= 200) break
      }
    }
    map.set(key, { version, value, ref })
  }
  // 工具载荷版本指纹：只读浅层字段（长度/状态/水合标记），不解析不裁剪。
  // 覆盖全部派生输入：名称水合（RC-5.1 的 args.toolName 后出现）、状态翻转、
  // 结果到齐（旧形态字符串增长 / 现代对象原子出现）、edit 流式 diff、问题作答。
  // 结果指纹必须深入一层：旧形态 {selectedTool, result:"<json>"} 的内层字符串
  // 随水合增长；现代 {result:{case, value:{content:[...]}}} 的 content 同样会
  // 从空水合出文本（2026-09-07 的 completed 首帧空结果 → 后到齐场景）。
  function resultFingerprint(result) {
    if (result === undefined || result === null) return '0'
    if (typeof result === 'string') return 's' + result.length
    const inner = result.result
    if (typeof inner === 'string') return 'r' + inner.length
    if (inner && typeof inner === 'object') {
      const content = inner.value && Array.isArray(inner.value.content) ? inner.value.content : undefined
      if (content) {
        let sig = 'c:' + String(inner.case || '') + ':' + content.length
        const limit = Math.min(content.length, 8)
        for (let i = 0; i < limit; i++) {
          const block = content[i]
          const union = block && block.content
          const text = union && union.case === 'text' ? union.value
            : block && typeof block.text === 'string' ? block.text : ''
          sig += '.' + (typeof text === 'string' ? text.length : 0)
        }
        return sig
      }
      return 'c:' + String(inner.case || 'obj')
    }
    return 'o'
  }
  function toolPayloadVersion(td) {
    const modern = td && td.toolCall && td.toolCall.tool && td.toolCall.tool.value
    const margs = modern && modern.args && typeof modern.args === 'object' ? modern.args : undefined
    const result = modern && modern.result !== undefined ? modern.result : td && td.result
    const params = td && td.params
    const additional = td && td.additionalData
    return [
      td.name || '', td.status || '', modern && modern.status || '',
      margs ? String(margs.toolName || margs.name || '') : '',
      margs ? String(margs.server || margs.serverName || margs.providerIdentifier || '') : '',
      resultFingerprint(result),
      params && typeof params.streamingContent === 'string' ? params.streamingContent.length : 0,
      td.rawArgs ? String(td.rawArgs).length : 0,
      additional && additional.status ? String(additional.status) : '',
      additional && additional.precomputedDiff ? 'd' : '',
      td.error ? (typeof td.error === 'string' ? td.error.length : 'e') : ''
    ].join('|')
  }
  function thinkingVersion(m) {
    const direct = typeof m.thinking === 'string' ? m.thinking
      : m.thinking && typeof m.thinking === 'object' && typeof m.thinking.text === 'string' ? m.thinking.text : ''
    const blocks = Array.isArray(m.allThinkingBlocks) ? m.allThinkingBlocks : []
    const last = blocks.length ? blocks[blocks.length - 1] : undefined
    const lastText = typeof last === 'string' ? last : (last && typeof last.text === 'string' ? last.text : '')
    let durations = 0
    for (const block of blocks) {
      if (block && typeof block === 'object') {
        const d = block.thinkingDurationMs ?? block.durationMs
        if (typeof d === 'number') durations += d
      }
    }
    return [
      direct.length, blocks.length, lastText.length, durations,
      m.thinkingDurationMs ?? (m.thinking && m.thinking.thinkingDurationMs) ?? ''
    ].join('|')
  }
  function thinkingInfo(message) {
    const direct = typeof message?.thinking === 'string'
      ? { text: message.thinking, durationMs: message.thinkingDurationMs }
      : message?.thinking && typeof message.thinking === 'object'
        ? { text: message.thinking.text, durationMs: message.thinking.thinkingDurationMs ?? message.thinking.durationMs ?? message.thinkingDurationMs }
        : undefined
    if (typeof direct?.text === 'string' && direct.text.length > 1) return direct
    const blocks = Array.isArray(message?.allThinkingBlocks) ? message.allThinkingBlocks : []
    const texts = blocks.flatMap(block => {
      const text = typeof block === 'string' ? block : block && typeof block.text === 'string' ? block.text : ''
      return text ? [text] : []
    })
    if (!texts.length) return undefined
    const durationMs = blocks.reduce((sum, block) => sum + (typeof block?.thinkingDurationMs === 'number'
      ? block.thinkingDurationMs
      : typeof block?.durationMs === 'number' ? block.durationMs : 0), 0)
    return { text: texts.join('\\n\\n'), durationMs: durationMs || message?.thinkingDurationMs }
  }
  function clipText(value, limit) {
    const text = String(value || '')
    return text.length > limit
      ? text.slice(0, limit) + '\\n…[Cursor 原生内容过长，另有 ' + (text.length - limit) + ' 字符未内联]'
      : text
  }
  // 整文件内容 / 解析树 / 子 Agent 全量会话数据不进「输入」明细：体积大且对用户无信息量
  //（编辑结果由 diff 呈现，Shell 命令由 command 呈现）。
  const OMITTED_INPUT_KEYS = new Set(['streamcontent', 'afterfullfilecontent', 'beforefullfilecontent', 'composerdata', 'parsingresult'])
  function safePlain(value, depth) {
    if (value === null || value === undefined) return value
    if (depth > 6) return '[nested]'
    if (typeof value === 'string') return clipText(value, 8000)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return String(value)
    if (Array.isArray(value)) return value.slice(0, 30).map(item => safePlain(item, depth + 1))
    if (typeof value === 'object') {
      const out = {}
      for (const key of Object.getOwnPropertyNames(value).slice(0, 60)) {
        try {
          if (typeof value[key] === 'function') continue
          const lower = key.toLowerCase()
          if (OMITTED_INPUT_KEYS.has(lower)) { out[key] = '[omitted]'; continue }
          out[key] = (lower === 'data' || lower.includes('base64') || lower.includes('imagedata'))
            && typeof value[key] === 'string' && value[key].length > 200
            ? '[binary/image payload omitted]'
            : safePlain(value[key], depth + 1)
        } catch (e) {}
      }
      return out
    }
    return clipText(value, 1000)
  }
  function outputText(result) {
    try {
      result = unwrapCase(result)
      if (!result) return ''
      if (typeof result === 'string') {
        const text = result.trim()
        if ((text.startsWith('{') || text.startsWith('[')) && text.length < 2000000) {
          try { return outputText(JSON.parse(text)) } catch (e) {}
        }
        return text.length > 12000 && /^[A-Za-z0-9+/=\\s]+$/.test(text)
          ? '[binary/image payload omitted]'
          : clipText(text, 12000)
      }
      if (Array.isArray(result)) {
        const parts = result.slice(0, 30).flatMap(entry => {
          const item = normalizeContentBlock(entry)
          if (item?.type === 'image') return ['[image result]']
          const text = outputText(item)
          return text ? [text] : []
        })
        return clipText(parts.join('\\n'), 12000)
      }
      if (Array.isArray(result.content)) return outputText(result.content)
      for (const key of ['output', 'contents', 'content', 'text', 'stdout', 'result']) {
        if (result[key]) {
          const text = outputText(result[key])
          if (text) return text
        }
      }
      const json = JSON.stringify(safePlain(result, 0), null, 2)
      return json && json !== '{}' ? clipText(json, 12000) : ''
    } catch (e) { return '' }
  }
  function toolSummary(td, parsedArgs) {
    const candidates = [parsedArgs?.args, parsedArgs, td?.params]
    try {
      const firstToolParams = td?.params?.tools?.[0]?.parameters
      if (typeof firstToolParams === 'string') candidates.unshift(JSON.parse(firstToolParams))
    } catch (e) {}
    for (const value of candidates) {
      const a = value && typeof value === 'object' ? value : {}
      for (const k of ['path','file_path','targetFile','target_file','command','query','pattern','url','filename','name','server']) {
        if (typeof a[k] === 'string' && a[k]) return a[k].slice(0, 160)
      }
    }
    return ''
  }
  function processSnapshot(data, composerId) {
    if (!data) return undefined
    const headers = data.fullConversationHeadersOnly || []
    const map = data.conversationMap || {}
    let lastUserIdx = -1
    for (let i = headers.length - 1; i >= 0; i--) {
      if (headers[i] && headers[i].type === 1) { lastUserIdx = i; break }
    }
    const turnId = lastUserIdx >= 0 ? String(headers[lastUserIdx]?.bubbleId || '') : ''
    const turnBubbles = headers.slice(lastUserIdx + 1)
    const generatingIds = data.generatingBubbleIds
    const generatingBubbleCount = Array.isArray(generatingIds)
      ? generatingIds.length
      : typeof generatingIds?.size === 'number'
        ? generatingIds.size
        : generatingIds && typeof generatingIds === 'object' ? Object.keys(generatingIds).length : 0
    const generatingBubbleSet = new Set(Array.isArray(generatingIds)
      ? generatingIds.map(String)
      : generatingIds && typeof generatingIds[Symbol.iterator] === 'function'
        ? [...generatingIds].map(String)
        : generatingIds && typeof generatingIds === 'object' ? Object.keys(generatingIds) : [])
    // 回合存活（帧级 isGenerating）与 token 流式（气泡级）是两件事：
    // - Cursor 3.6.31 的 ComposerData 用 status === 'generating' 表达「Agent 回合仍在进行」，
    //   工具执行、等待 MCP 长轮询期间它都为真；
    // - generatingBubbleIds 只在某个气泡正吐 token 时非空，工具执行期恒为空（CDP 只读探针
    //   2026-09-12 实证：tool=run_terminal_command td=loading 时 gCount=0）。
    // 旧实现只看气泡级，于是每个工具调用都成了「回合终结帧」：服务层把运行中的工具收成
    // done、archive 回合、名册活动条随之消失，下一个 thinking token 又把它拉回来。
    // 三者取或：status 缺席的旧/新形态自然回退到气泡级（与 v30 行为一致）；有气泡在吐 token
    // 时回合必然存活，status 只负责补上「工具执行期」这段气泡级看不见的存活。
    const composerStatus = typeof data.status === 'string' ? data.status.toLowerCase() : ''
    const isGenerating = composerStatus === 'generating' || data.isGenerating === true || generatingBubbleCount > 0
    const items = []
    let todos
    function bubbleStartedAt(header, message) {
      const raw = message?.createdAt ?? header?.createdAt
      const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw || ''))
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }
    // ---- 阶段 D：以 Bubble 为单位的内部协议相位分组（RC-5 / RC-6）----
    // pass 1：每个气泡的事实——工具分类（transport/business/pending）、思考、
    // capability/serviceStatus、消息文本。pending = MCP ToolCall 未水合真实名。
    // 增量化：贵的派生（toolInfo/present/safePlain/thinkingInfo）按 bubbleId + 版本指纹
    // 缓存复用；生成中的气泡与回合终结帧（!isGenerating，归档内容）永远新鲜重算。
    const factCacheOn = globalThis.__sgTeamFactCache !== false
    const freshAll = !isGenerating
    const toolCache = factCacheOn ? cacheBucket(toolPayloadStore, String(composerId || ''), turnId) : undefined
    const thinkCache = factCacheOn ? cacheBucket(thinkingStore, String(composerId || ''), turnId) : undefined
    const facts = turnBubbles.map(h => {
      const m = map[h && h.bubbleId] || {}
      const td = m.toolFormerData
      const key = String(h?.bubbleId || '')
      const liveBubble = generatingBubbleSet.has(key)
      let tool
      let toolClass = null
      let business
      if (td) {
        const version = toolPayloadVersion(td)
        const hit = toolCache && !liveBubble && !freshAll ? toolCache.get(key) : undefined
        // 双保险失效判定：引用变了必然重算（不可变更新）；引用不变靠版本指纹（原地突变）。
        if (hit && hit.ref === td && hit.version === version) {
          tool = hit.value.tool
          toolClass = hit.value.toolClass
          business = hit.value.business
        } else {
          tool = toolInfo(td)
          if (tool.mcpPending) toolClass = 'pending'
          else if (tool.name) toolClass = isTransportNoise(tool.name) ? 'transport' : 'business'
          business = toolClass === 'business'
            ? {
                presented: present(td, tool),
                input: safePlain(tool.args, 0),
                errorText: typeof tool.error === 'string' ? clipText(tool.error, 8000) : outputText(tool.error)
              }
            : undefined
          if (toolCache) cacheSet(toolCache, key, version, { tool, toolClass, business }, td)
        }
      } else {
        tool = toolInfo(td)
      }
      let thought
      const thinkVersion = thinkingVersion(m)
      const thinkHit = thinkCache && !liveBubble && !freshAll ? thinkCache.get(key) : undefined
      if (thinkHit && thinkHit.ref === m && thinkHit.version === thinkVersion) {
        thought = thinkHit.value
      } else {
        const raw = thinkingInfo(m)
        // 缓存裁剪后的文本：items 循环不再为每个思考块重复 24KB 截断。
        thought = raw ? { ...raw, text: clipText(raw.text, 24000) } : raw
        if (thinkCache) cacheSet(thinkCache, key, thinkVersion, thought, m)
      }
      return { m, td, tool, toolClass, thought, business, startedAt: bubbleStartedAt(h, m) }
    })
    // pass 2：传输相位归属（两套标记，用途不同）。
    // 前向规则：非工具气泡之后最近的工具是内部协议 → 该气泡属协议相位
    // （模型思考完直接轮询 check_messages → keepalive 思考、调用通告 capability）。
    // 带正文的 message 气泡重置相位：模型输出了用户可见文字，之后再来的
    // record_reply/check_messages 脚手架不得回溯吞掉正文之前的业务思考——
    // 否则每次落库回复时，产出答案的 Thought 会在过程卡上凭空消失。
    // - transportStrict：只认已水合的内部协议工具。用于 thinking 显示：pending
    //   （MCP ToolCall 首帧尚无真实名）不隐藏其前置思考，避免每个业务 MCP 调用
    //   开始时思考块消失一帧再重播（打字机从头再来）。
    // - transportBiased：pending 按传输倾向处理。用于工作判定与 capability/
    //   serviceStatus 显示：持续会话里 MCP 首帧几乎都是 check_messages 轮询，
    //   若按未知归组，其前的 thinking 会构成「后续工作」，最终正文被误判为
    //   中间过程（cursor-msg 与回复正文双渲染，2026-09-03 事故）；水合后自愈。
    // 后向兜底：其后再无正文、且前一工具是内部协议（回合尾部的轮询余波），两套
    // 标记同时生效。例外——前一工具是「投递了真实用户消息」的 check_messages：
    // 其后的 thinking 是新回合的业务思考，不是余波。结构上两者完全相同（前一
    // 工具都是 check_messages、其后都暂无正文），只能靠工具结果区分；不区分就会把
    // 投递后的首段（往往最长的）思考整段隐藏到正文出现才蹦出（2026-09-04 事故：
    // 38s Thought 全程只显示占位，随后无打字机整段出现）。
    function hasText(f) { return typeof f.m.text === 'string' && Boolean(f.m.text.trim()) }
    const transportStrict = new Array(facts.length).fill(false)
    const transportBiased = new Array(facts.length).fill(false)
    let nextToolClass = null
    for (let i = facts.length - 1; i >= 0; i--) {
      if (facts[i].toolClass) { nextToolClass = facts[i].toolClass; continue }
      if (hasText(facts[i])) { nextToolClass = null; continue }
      if (nextToolClass === 'transport') transportStrict[i] = true
      if (nextToolClass === 'transport' || nextToolClass === 'pending') transportBiased[i] = true
    }
    // 后缀预扫描（O(n)）：messageAhead[i] = 其后是否还有带正文的气泡。
    // 长持续回合的 turnBubbles 可达数千，逐气泡内层扫描会是 O(n²) 页面热点。
    const messageAhead = new Array(facts.length).fill(false)
    for (let i = facts.length - 2; i >= 0; i--) {
      messageAhead[i] = messageAhead[i + 1] || hasText(facts[i + 1])
    }
    let prevToolClass = null
    let prevToolIndex = -1
    for (let i = 0; i < facts.length; i++) {
      if (facts[i].toolClass) { prevToolClass = facts[i].toolClass; prevToolIndex = i; continue }
      if (transportBiased[i]) continue
      if (!messageAhead[i] && prevToolClass === 'transport'
        && !isUserDelivery(turnBubbles[prevToolIndex] && turnBubbles[prevToolIndex].bubbleId, facts[prevToolIndex].tool)) {
        transportStrict[i] = true
        transportBiased[i] = true
      }
    }
    // pass 3：工作判定（RC-6）。内部协议工具、待水合 MCP、传输相位思考与
    // capability/serviceStatus 都不算工作——最终正文之后只剩内部协议噪声时，
    // 正文仍被识别为最终回答，不再误入 cursor-msg 与回复正文重复。业务工具、
    // 业务思考、plan 更新算工作。
    const hasWork = facts.map((f, i) => (
      f.toolClass === 'business'
      || (!!f.thought?.text && !transportBiased[i])
      || (!f.toolClass && !f.thought?.text && !!f.m.planUpdate)
    ))
    const hasLaterWork = new Array(hasWork.length).fill(false)
    let workSeen = false
    for (let i = hasWork.length - 1; i >= 0; i--) {
      hasLaterWork[i] = workSeen
      workSeen = workSeen || hasWork[i]
    }
    for (let i = 0; i < facts.length; i++) {
      const h = turnBubbles[i]
      const { m, td, tool, toolClass, thought, business, startedAt } = facts[i]
      const bubbleGenerating = generatingBubbleSet.has(String(h?.bubbleId || ''))
      if (thought?.text && !transportStrict[i]) {
        items.push({
          kind: 'thinking', id: 'cursor-th:' + h.bubbleId, text: thought.text,
          status: bubbleGenerating && !tool.name ? 'running' : 'done',
          durationMs: typeof thought.durationMs === 'number' ? thought.durationMs : undefined,
          startedAt
        })
      }
      // Cursor 原生 assistant-message 只在其后仍有工作时属于过程；回合最后一段
      // 正文由 liveAgentResponse / record_reply 展示，避免重复。
      const messageText = typeof m.text === 'string' ? m.text.trim() : ''
      const laterWork = hasLaterWork[i] || toolClass === 'business'
      if (messageText && laterWork) {
        items.push({
          kind: 'message', id: 'cursor-msg:' + h.bubbleId,
          text: clipText(messageText, 12000), status: 'done', startedAt
        })
      }
      // 待水合 MCP（pending）暂缓展示；内部协议工具隐藏；业务工具完整保留。
      if (toolClass === 'business' && business) {
        const shown = business.presented
        // 等待用户作答的 ask_question：Cursor 把气泡标为 completed 并停止生成，但从
        // 回合视角它仍在进行——按 running 呈现，避免「完成」误导。
        const awaitingAnswer = shown.question && shown.question.status === 'pending' && tool.status !== 'failed'
        items.push({
          kind: 'tool', id: 'cursor:' + h.bubbleId,
          toolName: String(tool.name).slice(0, 120), toolKind: shown.kind,
          toolCase: tool.toolCase || undefined,
          title: shown.title || undefined,
          summary: shown.summary,
          hint: shown.hint || undefined,
          status: bubbleGenerating || awaitingAnswer ? 'running' : tool.status,
          input: business.input, output: shown.output,
          error: business.errorText,
          question: shown.question,
          diff: shown.diff,
          startedAt
        })
      }
      // capability/serviceStatus 属协议脚手架：传输相位内整组隐藏（含 pending 倾向，
      // 它们不是打字机内容，晚一帧出现无感）；业务侧保留。planUpdate 始终保留（业务）。
      if (!toolClass && !thought?.text && (!transportBiased[i] || m.planUpdate)
        && (m.capabilityType !== undefined || m.serviceStatusUpdate || m.planUpdate)) {
        const capabilityName = m.planUpdate ? 'planUpdate'
          : m.capabilityType !== undefined ? 'capability:' + String(m.capabilityType) : 'serviceStatus'
        items.push({
          kind: 'tool', id: 'cursor-capability:' + h.bubbleId,
          toolName: capabilityName, toolKind: m.planUpdate ? 'todo' : 'other',
          summary: typeof m.simulatedMessageMetadata?.title === 'string' ? m.simulatedMessageMetadata.title.slice(0, 160) : '',
          status: bubbleGenerating ? 'running' : 'done',
          input: safePlain(m.planUpdate || m.capabilityContexts || m.serviceStatusUpdate || {}, 0),
          output: outputText(m.subagentReturn || m.serviceStatusUpdate || m.planUpdate),
          startedAt
        })
      }
      if (Array.isArray(m.todos) && m.todos.length) {
        todos = m.todos.slice(0, 100).flatMap(t => t && typeof t.content === 'string'
          ? [{ content: t.content.slice(0, 500), status: String(t.status || 'pending').slice(0, 40) }]
          : [])
      }
    }
    if (!todos && Array.isArray(data.todos) && data.todos.length) {
      todos = data.todos.slice(0, 100).flatMap(t => t && typeof t.content === 'string'
        ? [{ content: t.content.slice(0, 500), status: String(t.status || 'pending').slice(0, 40) }]
        : [])
    }
    if (data.plan && !items.some(item => item.toolName === 'planUpdate')) {
      items.unshift({
        kind: 'tool', id: 'cursor:plan', toolName: 'planUpdate', toolKind: 'todo',
        summary: '执行计划', status: data.hasPendingPlan ? 'running' : 'done',
        input: safePlain(data.plan, 0), output: ''
      })
    }
    // 流式正文（阶段 G 数据层）：与 Cursor 自身 UI 同一写信号、同一微任务读取
    // 当前回合的最终正文候选——最后一个「其后没有业务工作」的正文气泡（与
    // runtime inspect 的定位规则一致）。此前正文只经 inspect 轮询到达
    //（120ms 节流 + CDP 往返 + 150ms 快循环），打字机输入是 150–250ms 的粗粒度
    // chunk；写后直推把输入粒度对齐到 Cursor 原生 token 批次，是匀速播放的前提。
    let response
    for (let i = facts.length - 1; i >= 0; i--) {
      const text = typeof facts[i].m.text === 'string' ? facts[i].m.text : ''
      if (!text.trim()) continue
      if (!hasLaterWork[i] && facts[i].toolClass !== 'business') {
        const bubbleId = String(turnBubbles[i]?.bubbleId || '')
        response = { id: bubbleId, text: clipText(text, 100000), generating: generatingBubbleSet.has(bubbleId) }
      }
      break
    }
    const totalItemCount = items.length
    const keptItems = items.slice(-256)
    // 名册副标题（v32）：与 Cursor 自己的侧栏同一算法、同一原始数据（不经传输噪音过滤），
    // 只在回合存活时计算（Cursor 非生成态显示 Completed / Stopped，不扫气泡）。O(1) 尾部扫描。
    let statusLine
    if (isGenerating) {
      try { statusLine = statusLineOf(data) } catch (e) { statusLine = undefined }
    }
    return {
      isGenerating,
      composerStatus: composerStatus || undefined,
      statusLine,
      // 会话体积事实（v34）：整个 composer 的气泡数。持续会话的 Cursor 回合永不结束，
      // 气泡只增不减，Cursor 每次写入的成本随之线性增长——席位自动轮换以它为阈值。
      bubbleCount: headers.length,
      awaitingUser: awaitingUserDecision(data),
      response,
      // 写后快照始终是当前回合可见窗口的完整集合（含空集）：snapshotComplete
      // 标记本帧权威，服务层据此撤下缺席块。空集不坍缩成 undefined——否则
      // 「过滤后无可见过程」与「本帧无过程载荷」不可区分，旧块永远无法撤回。
      process: {
        turnId, items: keptItems, todos, generatingBubbleCount, snapshotComplete: true,
        truncatedItemCount: Math.max(0, totalItemCount - keptItems.length) || undefined
      }
    }
  }
  // 过程载荷节流（2026-09-12 Cursor 卡顿根治）：生成期每次写入仍即时推帧，但重的
  // 过程块载荷（256 项 × 文本，可达 ~3MB）只在 100ms 窗口边界携带；窗口内的帧只带
  // 正文/状态小载荷——打字机粒度与「生成中」即时性不变。桌面端对缺 process 的帧
  // 保留上一帧过程视图（「本帧无过程」语义早已存在）。窗口尾帧（trailing flush）与
  // 回合终结帧（isGenerating=false）始终全量：过程视图最迟 100ms 收敛，回合边界
  // 语义与逐帧全量时代逐位一致。
  // 测试/运维逃生门：globalThis.__sgTeamProcessThrottleMs 可覆盖窗口（0 = 逐帧全量）。
  const PROCESS_PAYLOAD_INTERVAL_MS = (() => {
    const override = globalThis.__sgTeamProcessThrottleMs
    return typeof override === 'number' && override >= 0 ? override : 100
  })()
  const processThrottle = new Map()
  function sendProcessFrame(id, snapshot, includeProcess) {
    if (!globalThis.${CURSOR_PROCESS_BINDING_NAME}) return
    const frame = { composerId: id, observedAt: Date.now(), ...snapshot }
    if (!includeProcess) frame.process = undefined
    let payload = JSON.stringify(frame)
    // 线径守卫：observer socket maxPayload 4MB。超长回合帧（256 项 × 24K 文本）
    // 可达 6MB，超限会杀死 socket——重连后同一巨帧再次超限，形成永久断连循环。
    // 先按字符数粗判，再按 UTF-8 字节精算，从头部分批裁剪并如实计入
    // truncatedItemCount：截断披露，绝不伪装完整。
    if (includeProcess && payload.length > 900_000 && snapshot.process && Array.isArray(snapshot.process.items)) {
      const measure = (text) => (typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(text).length
        : text.length * 3)
      let bytes = measure(payload)
      while (bytes > 3_000_000 && snapshot.process.items.length > 8) {
        const drop = Math.max(1, Math.floor(snapshot.process.items.length / 4))
        snapshot.process.items = snapshot.process.items.slice(drop)
        snapshot.process.truncatedItemCount = (snapshot.process.truncatedItemCount || 0) + drop
        payload = JSON.stringify({ composerId: id, observedAt: Date.now(), ...snapshot })
        bytes = measure(payload)
      }
    }
    globalThis.${CURSOR_PROCESS_BINDING_NAME}(payload)
  }
  // 窗口尾帧：用最新数据补一帧全量——写入暂停时过程视图也最迟 100ms 收敛。
  function flushProcessTrailing(id) {
    const state = processThrottle.get(id)
    if (!state) return
    state.timer = undefined
    if (!state.dirty) return
    state.dirty = false
    try {
      const service = globalThis.${SG_COMPOSER_SERVICE_GLOBAL}?.composerDataService
      const snapshot = processSnapshot(service?.getComposerDataIfLoaded?.(id), id)
      if (!snapshot) return
      state.readyAt = Date.now() + PROCESS_PAYLOAD_INTERVAL_MS
      sendProcessFrame(id, snapshot, true)
    } catch (e) {}
  }
  function scheduleProcessSnapshot(composerId) {
    if (!composerId) return
    pendingSnapshots.add(composerId)
    if (snapshotQueued) return
    snapshotQueued = true
    queueMicrotask(() => {
      snapshotQueued = false
      const service = globalThis.${SG_COMPOSER_SERVICE_GLOBAL}?.composerDataService
      for (const id of pendingSnapshots) {
        try {
          const data = service?.getComposerDataIfLoaded?.(id)
          // 独立 usage binding：过程块裁剪/过滤不会吞掉计数。
          try {
            const usage = (${nativeUsagePayload.toString()})(data, id)
            if (usage && globalThis.${CURSOR_USAGE_BINDING_NAME}) globalThis.${CURSOR_USAGE_BINDING_NAME}(JSON.stringify(usage))
          } catch (usageError) { /* 计数链路异常不阻断过程流 */ }
          const snapshot = processSnapshot(data, id)
          if (!snapshot) continue
          const now = Date.now()
          // 终结/等待帧永远全量：回合边界语义与逐帧全量逐位一致。
          const terminal = snapshot.isGenerating !== true
          let state = processThrottle.get(id)
          if (!state) {
            state = { readyAt: 0, timer: undefined, dirty: false }
            processThrottle.set(id, state)
          }
          if (terminal) {
            if (state.timer) { clearTimeout(state.timer); state.timer = undefined }
            state.dirty = false
            state.readyAt = now + PROCESS_PAYLOAD_INTERVAL_MS
            sendProcessFrame(id, snapshot, true)
          } else if (now >= state.readyAt) {
            state.readyAt = now + PROCESS_PAYLOAD_INTERVAL_MS
            sendProcessFrame(id, snapshot, true)
          } else {
            sendProcessFrame(id, snapshot, false)
            state.dirty = true
            if (!state.timer) {
              state.timer = setTimeout(() => flushProcessTrailing(id), Math.max(16, state.readyAt - now))
            }
          }
        } catch (e) {}
      }
      pendingSnapshots.clear()
    })
  }
  globalThis.__sgTeamProcessSchedule = scheduleProcessSnapshot
  // 补发当前已加载 Composer 的过程快照：拾光（重）连上来时立即拿到正在进行的回合，
  // 不等待下一次模型写入。首次安装与「hook 已在位」两条路径都要走——拾光被强退或
  // 还原脚本没来得及刷出时，旧 hook 仍挂在页面上，重启后的拾光只是重新绑了 binding。
  function broadcastLoaded(svc, manager) {
    try {
      const ids = new Set()
      const loaded = svc.composerDataService.getLoadedComposers?.() || []
      for (const item of loaded) ids.add(String(item?.composerId ?? item?.id ?? item ?? ''))
      for (const id of manager.loadedComposers?.ids || []) ids.add(String(id || ''))
      const handles = manager.composerDataHandles || manager.handles
      if (handles && typeof handles.keys === 'function') for (const id of handles.keys()) ids.add(String(id || ''))
      for (const id of ids) if (id) scheduleProcessSnapshot(id)
    } catch (e) {}
  }
  function install() {
    try {
      const svc = globalThis.${SG_COMPOSER_SERVICE_GLOBAL}
      const manager = svc && svc.composerDataService && svc.composerDataService.composerDataHandleManager
      if (!manager) {
        if (++attempts <= 60) setTimeout(install, 2000)
        return 'no-manager'
      }
      const proto = Object.getPrototypeOf(manager)
      if (globalThis.__sgTeamStreamHook && globalThis.__sgTeamStreamHookManager === manager) {
        if (globalThis.__sgTeamStreamHookVersion === HOOK_VERSION) {
          // 同版 hook 已在位：wrapper 会走新绑定的 binding（同名重绑），只需补发当前回合。
          globalThis.__sgTeamProcessSchedule = scheduleProcessSnapshot
          broadcastLoaded(svc, manager)
          return 'already'
        }
        // 拾光被强退时 dispose 无机会还原；新版必须主动替换旧 wrapper，不能因
        // boolean 幂等标记永远沿用旧语义（例如旧版“写前通知”）。
        const stale = globalThis.__sgTeamStreamOriginals || {}
        for (const name of Object.keys(stale)) {
          try { proto[name] = stale[name] } catch (e) {}
        }
      }
      const originals = {}
      let installed = 0
      for (const name of ['markDirty', 'markMessageDirty', 'updateWithoutMarkingDirty', 'pushComposer']) {
        const original = proto[name]
        if (typeof original !== 'function') continue
        if (original.__sgTeamStreamWrapped) { installed += 1; continue }
        originals[name] = original
        const wrapped = function (...args) {
          const signalAfterWrite = () => {
            try {
              const first = args[0]
              let composerId = ''
              if (typeof first === 'string') composerId = first
              else if (first && typeof first === 'object') composerId = String(first.composerId ?? first.id ?? '')
              if (composerId) globalThis.${CURSOR_STREAM_BINDING_NAME}(composerId)
              if (composerId) scheduleProcessSnapshot(composerId)
            } catch (e) {}
          }
          const result = original.apply(this, args)
          // 关键顺序：先让 Cursor 完成数据模型写入，再通知拾光读取；旧实现写前通知，
          // inspector 可能读到上一帧，最终状态甚至要等下一次写或轮询才能出现。
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).then(signalAfterWrite, signalAfterWrite)
          } else {
            signalAfterWrite()
          }
          return result
        }
        wrapped.__sgTeamStreamWrapped = true
        proto[name] = wrapped
        installed += 1
      }
      globalThis.__sgTeamStreamOriginals = originals
      globalThis.__sgTeamStreamHookManager = manager
      globalThis.__sgTeamStreamHook = installed > 0
      globalThis.__sgTeamStreamHookVersion = HOOK_VERSION
      broadcastLoaded(svc, manager)
      return installed
    } catch (e) {
      if (++attempts <= 60) setTimeout(install, 2000)
      return 'error'
    }
  }
  return install()
})()`

/** 还原页面内 hook：恢复原型原始方法并清除全局标志（dispose 时尽力执行）。 */
const STREAM_HOOK_RESTORE_EXPRESSION = `(() => {
  const originals = globalThis.__sgTeamStreamOriginals
  if (originals) {
    try {
      const svc = globalThis.${SG_COMPOSER_SERVICE_GLOBAL}
      const manager = svc && svc.composerDataService && svc.composerDataService.composerDataHandleManager
      const proto = manager && Object.getPrototypeOf(manager)
      if (proto) {
        for (const name of Object.keys(originals)) {
          try { proto[name] = originals[name] } catch (e) {}
        }
      }
    } catch (e) {}
  }
  delete globalThis.__sgTeamStreamOriginals
  delete globalThis.__sgTeamStreamHookManager
  delete globalThis.__sgTeamStreamHook
  delete globalThis.__sgTeamStreamHookVersion
  delete globalThis.__sgTeamProcessSchedule
  return 'restored'
})()`

/**
 * hook 存活探针（只读，不安装）：hook 是否在当前文档里以当前版本就位；
 * scheduler 存在而 hook 缺席 = 页面内 install 自轮询仍在等 manager。
 */
export const CURSOR_STREAM_HOOK_PROBE_EXPRESSION = `/* sg-team-hook-probe */ ({
  hook: globalThis.__sgTeamStreamHook === true,
  version: globalThis.__sgTeamStreamHookVersion,
  scheduler: typeof globalThis.__sgTeamProcessSchedule
})`

interface HookProbe {
  /** hook 已在当前文档验证就位（版本匹配）。 */
  alive: boolean
  /** 页面内 install 链是否仍在自轮询等待 manager。 */
  pendingInstall: boolean
}

/** 测试可注入的最小 socket 面（对齐 ws 事件子集）。 */
export interface StreamObserverSocket {
  send(text: string): void
  close(): void
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export interface CursorStreamObserverOptions {
  port?: number
  fetchPageSocketUrl?: (port: number, timeoutMs: number) => Promise<string | undefined>
  openSocket?: (webSocketDebuggerUrl: string) => StreamObserverSocket
  /**
   * 服务定位（拾光自带网关）：hook 安装前在页面挂载 __sgComposerService。
   * 默认走 locateComposerServiceViaCall（幂等：已挂载时单次 evaluate 短路）；
   * 测试注入桩即可跳过真实 queryObjects 流程。
   */
  locateComposerService?: (call: CdpCall) => Promise<boolean>
  /**
   * 晴天补丁运行时缴械：自带网关定位成功后立即执行（页面内幂等，零文件修改）。
   * 默认走 disarmLegacyPatchViaCall；测试注入桩以断言时序。
   */
  disarmLegacyPatch?: (call: CdpCall) => Promise<LegacyPatchDisarmResult | undefined>
  /** 写信号回调：Cursor 每次模型写入（含持久化批次）即触发。 */
  onWriteSignal?: (composerId: string, at: number) => void
  /** 用量事件回调：bundle 补丁在每个回合 turnEnded 推送真实计费 token。 */
  onUsageEvent?: (event: CursorUsageEvent) => void
  onUsageSample?: (sample: CursorUsageSample) => void
  /** Cursor 内存模型写后直接推送的原生顺序过程快照。 */
  onProcessEvent?: (event: CursorNativeProcessEvent) => void
  onStatus?: (status: { state: 'connected' | 'reconnecting' | 'unavailable'; detail: string; updatedAt: number }) => void
}

/** 写后快照携带的当前回合流式正文（最后一个其后无业务工作的正文气泡）。 */
export interface CursorNativeResponse {
  /** Cursor 原生 bubbleId；与 runtime inspect 的 responseId 同源，可跨来源合并。 */
  id: string
  text: string
  /**
   * 该正文气泡此刻是否仍在吐 token（气泡级 generatingBubbleIds）。帧级 isGenerating 自 v31 起
   * 表示「回合存活」——持续会话里模型写完正文去调 record_reply 时回合仍在进行，
   * 正文的 streaming → complete 必须由本字段而非帧级信号决定。旧 hook 帧缺省为 undefined。
   */
  generating?: boolean
}

export interface CursorNativeProcessEvent {
  composerId: string
  observedAt: number
  isGenerating: boolean
  /** Composer 阻塞在用户决策（ask_question 等）：非生成态但 Agent 仍在等待。 */
  awaitingUser?: boolean
  /** Cursor 回合状态原文（generating / aborted / completed / none）；非生成态区分 Stopped 与 Completed。 */
  composerStatus?: string
  /** Cursor 会话列表副标题（v32）：只在回合存活时携带；旧 hook 帧缺省。 */
  statusLine?: CursorStatusLine
  /** 整个 composer 的气泡数（v34）；旧 hook 帧缺省。 */
  bubbleCount?: number
  process?: CursorProcessStream
  response?: CursorNativeResponse
}

/** 气泡数：非负整数才算事实；其余（旧帧缺省、坏值）为 undefined。 */
export function parseBubbleCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/** 宽容解析写后快照里的正文载荷；缺失/非法时返回 undefined（不影响过程帧）。 */
export function parseNativeResponse(value: unknown): CursorNativeResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 200) : ''
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 100_000) : ''
  if (!id || !text) return undefined
  return typeof raw.generating === 'boolean' ? { id, text, generating: raw.generating } : { id, text }
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class CursorStreamObserver {
  private readonly port: number
  private readonly fetchPageSocketUrl: NonNullable<CursorStreamObserverOptions['fetchPageSocketUrl']>
  private readonly openSocket: NonNullable<CursorStreamObserverOptions['openSocket']>
  private readonly locateComposerService: NonNullable<CursorStreamObserverOptions['locateComposerService']>
  private readonly disarmLegacyPatch: NonNullable<CursorStreamObserverOptions['disarmLegacyPatch']>
  private readonly onWriteSignal: NonNullable<CursorStreamObserverOptions['onWriteSignal']>
  private readonly onUsageEvent: NonNullable<CursorStreamObserverOptions['onUsageEvent']>
  private readonly onUsageSample: NonNullable<CursorStreamObserverOptions['onUsageSample']>
  private readonly onProcessEvent: NonNullable<CursorStreamObserverOptions['onProcessEvent']>
  private readonly onStatus: NonNullable<CursorStreamObserverOptions['onStatus']>
  private socket?: StreamObserverSocket
  private seq = 0
  private readonly pending = new Map<number, PendingCall>()
  private stopped = false
  private retryAttempts = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private attaching = false
  /** 已注册的 new-document 脚本标识：重连前移除旧的，防止 target 上脚本累积。 */
  private newDocumentScriptId?: string
  /** hook 已在当前文档验证就位；文档重载（executionContextsCleared）即清零。 */
  private hookVerified = false
  private ensuringHook = false
  private hookHealthTimer?: ReturnType<typeof setInterval>
  private hookSettleTimer?: ReturnType<typeof setTimeout>
  /** 服务定位重试链（文档重载后 workbench 服务尚未注册时的低频补救）。 */
  private locateRetryTimer?: ReturnType<typeof setTimeout>
  private locateRetryAttempts = 0
  private locating = false
  private lastStatus?: { state: 'connected' | 'reconnecting' | 'unavailable'; detail: string }

  constructor(options: CursorStreamObserverOptions = {}) {
    const envPort = Number(process.env[CURSOR_CDP_PORT_ENV])
    this.port = options.port
      ?? (Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : CURSOR_CDP_DEFAULT_PORT)
    this.fetchPageSocketUrl = options.fetchPageSocketUrl ?? defaultFetchPageSocketUrl
    this.openSocket = options.openSocket ?? defaultOpenSocket
    this.locateComposerService = options.locateComposerService ?? locateComposerServiceViaCall
    this.disarmLegacyPatch = options.disarmLegacyPatch ?? disarmLegacyPatchViaCall
    this.onWriteSignal = options.onWriteSignal ?? (() => {})
    this.onUsageEvent = options.onUsageEvent ?? (() => {})
    this.onUsageSample = options.onUsageSample ?? (() => {})
    this.onProcessEvent = options.onProcessEvent ?? (() => {})
    this.onStatus = options.onStatus ?? (() => {})
  }

  get connected(): boolean {
    return this.socket !== undefined
  }

  /** 幂等附加：解析 workbench 窗口 → 持久连接 → binding + hook 注入。失败退避重试。 */
  async attach(): Promise<boolean> {
    if (this.stopped || this.socket || this.attaching) return this.socket !== undefined
    this.attaching = true
    try {
      const webSocketDebuggerUrl = await this.fetchPageSocketUrl(this.port, ATTACH_TIMEOUT_MS)
      if (this.stopped) return false
      if (!webSocketDebuggerUrl) throw new Error('未找到 Cursor workbench 窗口')
      const socket = this.openSocket(webSocketDebuggerUrl)
      this.socket = socket
      this.retryAttempts = 0
      socket.on('message', (data) => {
        if (this.socket === socket) this.handleMessage(data)
      })
      socket.on('close', () => this.handleDisconnect(socket))
      socket.on('error', () => undefined)
      // 等待连接建立：ws 在 open 前 send 会抛错；握手失败（error）立即失败而非等满超时
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('observer socket 未在时限内建立')), ATTACH_TIMEOUT_MS)
        socket.on('open', () => { clearTimeout(timer); resolve(undefined) })
        socket.on('error', () => { clearTimeout(timer); reject(new Error('observer socket 连接失败')) })
      })
      if (this.stopped) throw new Error('observer disposed during attach')
      await this.call('Runtime.enable', {})
      await this.call('Runtime.addBinding', { name: CURSOR_STREAM_BINDING_NAME })
      await this.call('Runtime.addBinding', { name: CURSOR_USAGE_BINDING_NAME })
      await this.call('Runtime.addBinding', { name: CURSOR_PROCESS_BINDING_NAME })
      // Page 域不启用时 addScriptToEvaluateOnNewDocument 只登记不执行（Chromium 语义，
      // Electron 43 实测）：窗口原地重载后 hook 就此消失而 socket 仍然连着。
      // 启用失败不阻断 attach——下方的 executionContext 事件重装仍能兜底。
      try {
        await this.call('Page.enable', {})
      } catch (error) {
        process.stderr.write(`[cursor-stream-observer] Page.enable 失败，仅依赖上下文事件重装 hook：${error instanceof Error ? error.message : String(error)}\n`)
      }
      // 上一次连接注册的 new-document 脚本在 target 上持久存在——先移除再注册，
      // 防止重连累积（脚本幂等但重复注册浪费且语义模糊）。
      if (this.newDocumentScriptId) {
        try {
          await this.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.newDocumentScriptId })
        } catch { /* 尽力而为 */ }
        this.newDocumentScriptId = undefined
      }
      const added = await this.call('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR_STREAM_HOOK_EXPRESSION })
      const identifier = (added as { identifier?: unknown } | undefined)?.identifier
      this.newDocumentScriptId = typeof identifier === 'string' && identifier ? identifier : undefined
      // 已加载文档立即安装并验证；脚本异常（exceptionDetails）视为 attach 失败重试，
      // 不再把「socket 开着」误报成「过程流已连接」。
      await this.ensureHook('install')
      this.startHookHealthLoop()
      return true
    } catch (error) {
      // 半途失败必须关闭已建立的 socket，否则泄漏连接且 retry 另建新连接。
      const socket = this.socket
      this.socket = undefined
      this.hookVerified = false
      this.stopHookHealthLoop()
      this.stopLocateRetryLoop()
      try { socket?.close() } catch { /* 尽力而为 */ }
      this.setStatus('reconnecting', error instanceof Error ? error.message.slice(0, 240) : 'Cursor 原生过程流连接失败')
      this.scheduleRetry()
      return false
    } finally {
      this.attaching = false
    }
  }

  /**
   * 确保 hook 在当前文档就位并据此上报状态。
   * - install：直接注入（幂等：已装返回 'already'）再探针验证——attach / 文档重载后使用；
   * - probe：先只读探针，缺席才注入——健康自检使用（注入本身幂等，页面内自轮询链
   *   等到 manager 后各自收敛为 'already'）。
   * evaluate 的脚本异常与协议错误向上抛：attach 里转为重连，其余路径由调用方兜住。
   */
  private async ensureHook(mode: 'install' | 'probe'): Promise<boolean> {
    if (!this.socket || this.ensuringHook) return this.hookVerified
    this.ensuringHook = true
    try {
      let probe = mode === 'install' ? await this.installHook() : await this.probeHook()
      if (!probe.alive && mode === 'probe') probe = await this.installHook()
      this.hookVerified = probe.alive
      if (probe.alive) {
        this.setStatus('connected', 'Cursor 原生过程流已连接')
      } else {
        this.setStatus('reconnecting', probe.pendingInstall
          ? '等待 Cursor 工作台就绪后安装过程 hook'
          : '过程 hook 未就位，正在重装')
      }
      return probe.alive
    } finally {
      this.ensuringHook = false
    }
  }

  private async installHook(): Promise<HookProbe> {
    // 先定位服务再装 hook：hook 的页面自轮询等待 __sgComposerService，定位
    // 失败不阻断安装（自轮询 + 定位重试链会师后自动收敛为 'already'）。
    await this.ensureServiceLocated()
    await this.evaluateChecked(CURSOR_STREAM_HOOK_EXPRESSION)
    return this.probeHook()
  }

  /**
   * 幂等定位：成功即停重试链，并顺手让晴天补丁停摆（自带网关就位后它只剩后台开销）；
   * 失败（服务未注册/瞬时异常）排一次低频补试。
   */
  private async ensureServiceLocated(): Promise<void> {
    if (this.locating || !this.socket || this.stopped) return
    this.locating = true
    let located = false
    try {
      located = await this.locateComposerService((method, params, timeoutMs) => this.call(method, params, timeoutMs))
    } catch {
      located = false
    } finally {
      this.locating = false
    }
    if (located) {
      this.stopLocateRetryLoop()
      // 缴械只在自有服务确认在位后进行：此时拾光的任何链路都不再依赖补丁。页面内幂等，
      // 文档重载后补丁随新文档重新启动，这条链路也会随 hook 重装再走一遍。失败静默。
      if (this.socket && !this.stopped) {
        try {
          await this.disarmLegacyPatch((method, params, timeoutMs) => this.call(method, params, timeoutMs))
        } catch {
          // 缴械失败不影响 hook 安装与过程流
        }
      }
      return
    }
    this.scheduleLocateRetry()
  }

  private scheduleLocateRetry(): void {
    if (this.stopped || !this.socket || this.locateRetryTimer) return
    if (this.locateRetryAttempts >= LOCATE_RETRY_MAX_ATTEMPTS) return
    this.locateRetryAttempts += 1
    this.locateRetryTimer = setTimeout(() => {
      this.locateRetryTimer = undefined
      void this.ensureServiceLocated()
    }, LOCATE_RETRY_INTERVAL_MS)
    this.locateRetryTimer.unref?.()
  }

  private stopLocateRetryLoop(): void {
    if (this.locateRetryTimer) clearTimeout(this.locateRetryTimer)
    this.locateRetryTimer = undefined
    this.locateRetryAttempts = 0
  }

  private async probeHook(): Promise<HookProbe> {
    const value = await this.evaluateChecked(CURSOR_STREAM_HOOK_PROBE_EXPRESSION)
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const alive = raw.hook === true && raw.version === CURSOR_STREAM_HOOK_VERSION
    return { alive, pendingInstall: !alive && raw.scheduler === 'function' }
  }

  /** Runtime.evaluate 并把页面脚本异常（exceptionDetails）转成错误，而不是静默当成功。 */
  private async evaluateChecked(expression: string): Promise<unknown> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true }) as {
      result?: { value?: unknown }
      exceptionDetails?: { text?: unknown; exception?: { description?: unknown } }
    } | undefined
    const exception = result?.exceptionDetails
    if (exception) {
      const detail = exception.exception?.description ?? exception.text ?? 'unknown'
      throw new Error(`页面脚本异常：${String(detail).replace(/\s+/g, ' ').slice(0, 200)}`)
    }
    return result?.result?.value
  }

  private startHookHealthLoop(): void {
    this.stopHookHealthLoop()
    this.hookHealthTimer = setInterval(() => {
      if (!this.socket || this.stopped) return
      void this.ensureHook('probe').catch((error) => {
        this.setStatus('reconnecting', `过程 hook 自检失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`)
      })
    }, HOOK_HEALTH_INTERVAL_MS)
    this.hookHealthTimer.unref?.()
  }

  private stopHookHealthLoop(): void {
    if (this.hookHealthTimer) clearInterval(this.hookHealthTimer)
    this.hookHealthTimer = undefined
    if (this.hookSettleTimer) clearTimeout(this.hookSettleTimer)
    this.hookSettleTimer = undefined
  }

  /** 新文档的执行上下文就位后重装 hook（主帧与 iframe 的事件成批到达，合并一次）。 */
  private scheduleHookReinstall(): void {
    if (this.hookSettleTimer || this.stopped) return
    this.hookSettleTimer = setTimeout(() => {
      this.hookSettleTimer = undefined
      if (!this.socket || this.hookVerified) return
      void this.ensureHook('install').catch((error) => {
        // 导航中途上下文可能再次销毁：交给下一次 executionContextCreated / 健康自检重试。
        this.setStatus('reconnecting', `重装过程 hook 失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`)
      })
    }, HOOK_CONTEXT_SETTLE_MS)
    this.hookSettleTimer.unref?.()
  }

  /** 状态去重：同一 (state, detail) 不重复上报，健康自检每拍不制造快照噪音。 */
  private setStatus(state: 'connected' | 'reconnecting' | 'unavailable', detail: string): void {
    if (this.lastStatus?.state === state && this.lastStatus.detail === detail) return
    this.lastStatus = { state, detail }
    this.onStatus({ state, detail, updatedAt: Date.now() })
  }

  dispose(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.stopHookHealthLoop()
    this.stopLocateRetryLoop()
    this.hookVerified = false
    const socket = this.socket
    this.socket = undefined
    for (const pending of this.pending.values()) pending.reject(new Error('observer disposed'))
    this.pending.clear()
    // 离场不留痕（尽力而为，fire-and-forget）：还原页面内原型包装 + 移除注入脚本。
    // 不还原的话，退出后 Cursor 每次模型写入都会调用死 binding，直到窗口重载。
    if (socket) {
      try {
        socket.send(JSON.stringify({
          id: ++this.seq,
          method: 'Runtime.evaluate',
          params: { expression: STREAM_HOOK_RESTORE_EXPRESSION, returnByValue: true }
        }))
      } catch { /* 尽力而为 */ }
      if (this.newDocumentScriptId) {
        try {
          socket.send(JSON.stringify({
            id: ++this.seq,
            method: 'Page.removeScriptToEvaluateOnNewDocument',
            params: { identifier: this.newDocumentScriptId }
          }))
        } catch { /* 尽力而为 */ }
      }
    }
    this.newDocumentScriptId = undefined
    try { socket?.close() } catch { /* 尽力而为 */ }
    this.setStatus('unavailable', 'Cursor 原生过程观察器已停止')
  }

  private handleMessage(data: unknown): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      // 页面原地重载/导航：旧文档连同 hook、__sgComposerService 一起消失，socket 与
      // target 却不变。立即撤销 connected 并停掉旧文档的定位重试——新文档的
      // executionContextCreated 会经重装链路重新定位。
      this.hookVerified = false
      this.stopLocateRetryLoop()
      this.setStatus('reconnecting', 'Cursor 工作台已重载，正在重新安装过程 hook')
      return
    }
    if (message.method === 'Runtime.executionContextCreated') {
      const context = (message.params as { context?: { auxData?: { isDefault?: unknown } } } | undefined)?.context
      // 只认主世界（isDefault）：扩展/隔离世界里没有 Cursor 的 composer 服务。
      if (context?.auxData?.isDefault === true && !this.hookVerified) this.scheduleHookReinstall()
      return
    }
    if (message.method === 'Runtime.bindingCalled') {
      const params = message.params as { name?: unknown; payload?: unknown } | undefined
      if (params?.name === CURSOR_STREAM_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
        this.onWriteSignal(params.payload.slice(0, 120), Date.now())
      }
      if (params?.name === CURSOR_PROCESS_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
        try {
          const raw = JSON.parse(params.payload) as Record<string, unknown>
          const composerId = typeof raw.composerId === 'string' ? raw.composerId.trim().slice(0, 120) : ''
          if (composerId) {
            const statusLine = parseCursorStatusLine(raw.statusLine)
            const composerStatus = typeof raw.composerStatus === 'string' && raw.composerStatus
              ? raw.composerStatus.slice(0, 40)
              : undefined
            const bubbleCount = parseBubbleCount(raw.bubbleCount)
            this.onProcessEvent({
              composerId,
              observedAt: typeof raw.observedAt === 'number' ? raw.observedAt : Date.now(),
              isGenerating: raw.isGenerating === true,
              ...(raw.awaitingUser === true ? { awaitingUser: true } : {}),
              ...(composerStatus ? { composerStatus } : {}),
              ...(statusLine ? { statusLine } : {}),
              ...(bubbleCount === undefined ? {} : { bubbleCount }),
              process: parseProcessStream(raw.process),
              response: parseNativeResponse(raw.response)
            })
          }
        } catch {
          // 单个坏帧不影响后续原生过程事件。
        }
      }
      if (params?.name === CURSOR_USAGE_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
        this.dispatchUsagePayload(params.payload)
      }
    }
  }

  /** 写后样本/结算共用 binding；旧补丁无 generation 的事件仅兼容解析。 */
  private dispatchUsagePayload(payload: string): void {
    try {
      const raw = JSON.parse(payload) as Record<string, unknown>
      const composerId = typeof raw.c === 'string' ? raw.c.trim() : ''
      if (!composerId) return
      const generationId = typeof raw.g === 'string' && raw.g.length <= 200 ? raw.g : undefined
      const modelId = typeof raw.m === 'string' ? raw.m.slice(0, 160) : undefined
      if (raw.kind === 'sample') {
        if (generationId && typeof raw.used === 'number' && Number.isSafeInteger(raw.used) && raw.used > 0) {
          this.onUsageSample({ composerId, generationId, modelId, used: raw.used,
            ...(raw.stopped === true ? { stopped: true } : {}),
            occurredAt: typeof raw.t === 'number' ? raw.t : Date.now() })
        }
        return
      }
      if ([raw.i, raw.o, raw.r, raw.w].some((value) => value !== undefined
        && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))) return
      const toCount = (value: unknown): number => {
        const num = Number(value ?? 0)
        return Number.isFinite(num) && num > 0 ? num : 0
      }
      this.onUsageEvent({
        composerId,
        ...(generationId ? { generationId } : {}),
        ...(modelId ? { modelId } : {}),
        inputTokens: toCount(raw.i),
        outputTokens: toCount(raw.o),
        cacheReadTokens: toCount(raw.r),
        cacheWriteTokens: toCount(raw.w),
        occurredAt: toCount(raw.t) || Date.now()
      })
    } catch {
      // 非法 JSON / 结构漂移：丢弃，不影响写信号通道
    }
  }

  private handleDisconnect(source: StreamObserverSocket): void {
    // 旧 socket 的迟到 close 不得清掉重连后已就位的新 socket。
    if (this.socket !== source) return
    this.socket = undefined
    this.hookVerified = false
    this.stopHookHealthLoop()
    this.stopLocateRetryLoop()
    for (const pending of this.pending.values()) pending.reject(new Error('observer disconnected'))
    this.pending.clear()
    this.setStatus('reconnecting', 'Cursor 原生过程流已断开，正在重连')
    if (!this.stopped) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempts, RETRY_MAX_MS)
    this.retryAttempts += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.attach()
    }, delay)
    this.retryTimer.unref?.()
  }

  private call(method: string, params: Record<string, unknown>, timeoutMs = ATTACH_TIMEOUT_MS): Promise<unknown> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('observer not attached'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`observer call timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

async function defaultFetchPageSocketUrl(port: number, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal })
    if (!response.ok) return undefined
    const targets = await response.json() as Array<Record<string, unknown>>
    const page = targets.find((target) => (
      target.type === 'page'
      && typeof target.webSocketDebuggerUrl === 'string'
      && target.webSocketDebuggerUrl.startsWith('ws')
      && typeof target.url === 'string'
      && /workbench/i.test(target.url)
    ))
    return page ? page.webSocketDebuggerUrl as string : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function defaultOpenSocket(webSocketDebuggerUrl: string): StreamObserverSocket {
  const socket = new WebSocket(webSocketDebuggerUrl, {
    handshakeTimeout: 5_000,
    maxPayload: 4 * 1024 * 1024
  })
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
    // ws 的 on 签名兼容（多事件重载按需绑定）
    on: (event, listener) => {
      if (event === 'open') socket.on('open', listener as () => void)
      else if (event === 'message') socket.on('message', listener as (data: unknown) => void)
      else if (event === 'close') socket.on('close', listener as () => void)
      else socket.on('error', listener as (error: Error) => void)
    }
  }
}
