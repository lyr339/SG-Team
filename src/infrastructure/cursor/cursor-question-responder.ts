import type { CursorQuestionActionResult, CursorQuestionFailureCode } from '../../shared/desktop-api'
import { evaluateCdpExpression } from './cursor-cdp-session-creator'
import { SG_COMPOSER_BRIDGE_PRELUDE, SG_COMPOSER_SERVICE_GLOBAL } from './cursor-composer-service-locator'

/**
 * 在 Cursor 渲染进程内回答 / 跳过原生 ask_question（CDP Runtime.evaluate）。
 *
 * Cursor 自己的问卷提交函数依赖一个模块私有的答案暂存表，外部拿不到；但它的
 * ToolFormer 在「问卷未答时用户直接发消息」这条原生路径（onBeforeSubmitChat）里，
 * 会读取气泡 additionalData.currentSelections 组装答案、接受工具调用，再把消息文本
 * 作为跟进消息送入当前回合。拾光复用这条路径：
 *   1. setBubbleData 写入 currentSelections / freeformTexts（与 Cursor 问卷 UI 点选时的写法一致）；
 *   2. 经 sgBridge.submitByComposerId（自带网关薄桥）触发 submitChatMaybeAbortCurrent；
 *   3. 轮询气泡 additionalData.status 变为 submitted 作为硬回执。
 * 跳过则与 Cursor 面板的 Skip 完全一致：additionalData.status=cancelled + rejectToolCall。
 *
 * 服务句柄 __sgComposerService 由观察器在会话运行期挂载（问卷必然出现在运行期），
 * 此处不再自行定位。全部操作按 composerId + toolCallId 定位，并先核对 ToolFormer
 * 的待决策表里确有该工具调用；运行时缺少任一依赖方法时明确返回 unsupported_runtime，
 * 不做半截操作。
 */

export interface CursorQuestionAnswerCommand {
  composerId: string
  toolCallId: string
  selections: Record<string, string[]>
  freeformTexts: Record<string, string>
  /** 跟进消息正文（非空）；Cursor 回退路径要求有文本才会走问卷接受分支。 */
  note: string
}

export interface CursorQuestionSkipCommand {
  composerId: string
  toolCallId: string
}

export interface CursorQuestionResponderDeps {
  /** 团队工作区所在 Cursor 窗口的调试 socket（与会话创建/过程观察共用解析）。 */
  resolveWorkbenchSocket(workspacePath?: string): Promise<string | undefined>
  evaluate?: typeof evaluateCdpExpression
  /** 页面内等待 Cursor 回执的上限。 */
  confirmTimeoutMs?: number
}

const EVALUATE_TIMEOUT_MS = 15_000
const DEFAULT_CONFIRM_TIMEOUT_MS = 3_000

/** 页面内共用的定位逻辑：composer → ToolFormer → 气泡 → 待决策；任一缺失返回结构化失败。 */
const LOCATE_QUESTION_SOURCE = `
  const svc = window.${SG_COMPOSER_SERVICE_GLOBAL};
  const cds = svc && svc.composerDataService;
  if (!cds || typeof cds.getHandleIfLoaded !== 'function' || typeof cds.getToolFormer !== 'function') {
    return { ok: false, code: 'unsupported_runtime', error: 'composerDataService 不可用' };
  }
  const handle = cds.getHandleIfLoaded(COMPOSER_ID);
  if (!handle) return { ok: false, code: 'composer_not_loaded', error: 'Cursor 未加载该会话' };
  const toolFormer = cds.getToolFormer(handle);
  if (!toolFormer
    || typeof toolFormer.getBubbleIdByToolCallId !== 'function'
    || typeof toolFormer.getBubbleData !== 'function'
    || typeof toolFormer.setBubbleData !== 'function'
    || typeof toolFormer.pendingDecisions !== 'function'
    || typeof toolFormer.rejectToolCall !== 'function') {
    return { ok: false, code: 'unsupported_runtime', error: 'ToolFormer 接口与预期不符' };
  }
  const bubbleId = toolFormer.getBubbleIdByToolCallId(TOOL_CALL_ID);
  if (!bubbleId) return { ok: false, code: 'question_not_pending', error: '找不到该提问的气泡' };
  const bubble = toolFormer.getBubbleData(bubbleId) || {};
  const additional = bubble.additionalData && typeof bubble.additionalData === 'object' ? bubble.additionalData : {};
  const pending = (toolFormer.pendingDecisions() || {}).pendingDecisions || {};
  const decision = pending[bubbleId] || Object.values(pending).find((item) => item && item.toolCallId === TOOL_CALL_ID);
  if (!decision || decision.toolCallId !== TOOL_CALL_ID || decision.blocking !== true || additional.status !== 'pending') {
    return { ok: false, code: 'question_not_pending', error: '该提问已不在等待回答（' + String(additional.status || 'unknown') + '）' };
  }
  const readStatus = () => {
    const data = toolFormer.getBubbleData(bubbleId);
    const extra = data && data.additionalData && typeof data.additionalData === 'object' ? data.additionalData : {};
    return String(extra.status || '');
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
`

export function buildAnswerQuestionExpression(command: CursorQuestionAnswerCommand, confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS): string {
  return `(async () => {
  const COMPOSER_ID = ${JSON.stringify(command.composerId)};
  const TOOL_CALL_ID = ${JSON.stringify(command.toolCallId)};
  const SELECTIONS = ${JSON.stringify(command.selections)};
  const FREEFORM = ${JSON.stringify(command.freeformTexts)};
  const NOTE = ${JSON.stringify(command.note)};
  const CONFIRM_MS = ${Math.max(500, Math.floor(confirmTimeoutMs))};
  ${LOCATE_QUESTION_SOURCE}
  ${SG_COMPOSER_BRIDGE_PRELUDE}
  const bridge = sgBridge;
  if (!bridge || typeof bridge.submitByComposerId !== 'function') {
    return { ok: false, code: 'unsupported_runtime', error: '拾光网关未就绪（服务定位未完成）' };
  }
  // 与 Cursor 问卷 UI 点选时的写法一致：草稿进 additionalData，状态仍为 pending。
  toolFormer.setBubbleData(bubbleId, {
    additionalData: { ...additional, status: 'pending', currentSelections: SELECTIONS, freeformTexts: FREEFORM }
  });
  // submitChatMaybeAbortCurrent 的 promise 随 Agent 回合存续，不等待它；只以气泡状态为回执。
  let submitError = '';
  Promise.resolve().then(() => bridge.submitByComposerId(COMPOSER_ID, NOTE, { ignoreQueuing: true }))
    .then((result) => { if (result && result.ok === false) submitError = String(result.error || 'submit rejected'); })
    .catch((error) => { submitError = String(error && error.message || error); });
  const deadline = Date.now() + CONFIRM_MS;
  while (Date.now() < deadline) {
    const status = readStatus();
    if (status === 'submitted') return { ok: true, status: 'submitted' };
    if (status === 'cancelled') return { ok: false, code: 'submit_failed', error: '提交过程中问卷被取消' };
    if (submitError) return { ok: false, code: 'submit_failed', error: submitError };
    await sleep(100);
  }
  return { ok: false, code: 'unconfirmed', error: '已提交但 ' + CONFIRM_MS + 'ms 内未收到 Cursor 回执（状态 ' + readStatus() + '）' };
})()`
}

export function buildSkipQuestionExpression(command: CursorQuestionSkipCommand, confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS): string {
  return `(async () => {
  const COMPOSER_ID = ${JSON.stringify(command.composerId)};
  const TOOL_CALL_ID = ${JSON.stringify(command.toolCallId)};
  const CONFIRM_MS = ${Math.max(500, Math.floor(confirmTimeoutMs))};
  ${LOCATE_QUESTION_SOURCE}
  toolFormer.setBubbleData(bubbleId, { additionalData: { ...additional, status: 'cancelled', skipReason: 'user' } });
  toolFormer.rejectToolCall(TOOL_CALL_ID, { skipReason: 'user' });
  const deadline = Date.now() + CONFIRM_MS;
  while (Date.now() < deadline) {
    const remaining = (toolFormer.pendingDecisions() || {}).pendingDecisions || {};
    const still = remaining[bubbleId] || Object.values(remaining).some((item) => item && item.toolCallId === TOOL_CALL_ID);
    if (!still) return { ok: true, status: 'cancelled' };
    await sleep(100);
  }
  return { ok: false, code: 'unconfirmed', error: '已请求跳过但 ' + CONFIRM_MS + 'ms 内待决策仍未清除' };
})()`
}

const FAILURE_CODES: ReadonlySet<CursorQuestionFailureCode> = new Set<CursorQuestionFailureCode>([
  'invalid_input', 'composer_unbound', 'cdp_unavailable', 'composer_not_loaded',
  'unsupported_runtime', 'question_not_pending', 'submit_failed', 'unconfirmed'
])

/** 页面返回值 → 结构化结果；形状不符按 unconfirmed 处理（绝不伪装成功）。 */
export function parseQuestionActionResult(value: unknown): CursorQuestionActionResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, code: 'unconfirmed', message: 'Cursor 未返回有效结果' }
  }
  const raw = value as Record<string, unknown>
  if (raw.ok === true) {
    if (raw.status === 'submitted' || raw.status === 'cancelled') return { ok: true, status: raw.status }
    return { ok: false, code: 'unconfirmed', message: 'Cursor 未返回明确的问卷处理状态' }
  }
  const code = typeof raw.code === 'string' && FAILURE_CODES.has(raw.code as CursorQuestionFailureCode)
    ? raw.code as CursorQuestionFailureCode
    : 'unconfirmed'
  const message = typeof raw.error === 'string' && raw.error ? raw.error.slice(0, 300) : '未知错误'
  return { ok: false, code, message }
}

export class CursorQuestionResponder {
  private readonly evaluate: typeof evaluateCdpExpression
  private readonly confirmTimeoutMs: number

  constructor(private readonly deps: CursorQuestionResponderDeps) {
    this.evaluate = deps.evaluate ?? evaluateCdpExpression
    this.confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS
  }

  answer(workspacePath: string | undefined, command: CursorQuestionAnswerCommand): Promise<CursorQuestionActionResult> {
    return this.run(workspacePath, buildAnswerQuestionExpression(command, this.confirmTimeoutMs))
  }

  skip(workspacePath: string | undefined, command: CursorQuestionSkipCommand): Promise<CursorQuestionActionResult> {
    return this.run(workspacePath, buildSkipQuestionExpression(command, this.confirmTimeoutMs))
  }

  private async run(workspacePath: string | undefined, expression: string): Promise<CursorQuestionActionResult> {
    let socket: string | undefined
    try {
      socket = await this.deps.resolveWorkbenchSocket(workspacePath)
    } catch (error) {
      return { ok: false, code: 'cdp_unavailable', message: describe(error) }
    }
    if (!socket) return { ok: false, code: 'cdp_unavailable', message: '未找到团队工作区所在的 Cursor 窗口（请确认调试端口可用）' }
    try {
      return parseQuestionActionResult(await this.evaluate(socket, expression, EVALUATE_TIMEOUT_MS + this.confirmTimeoutMs))
    } catch (error) {
      return { ok: false, code: 'submit_failed', message: describe(error) }
    }
  }
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || '未知错误'
}
