import type {
  CursorCdpCreateInput,
  CursorCdpCreateResult,
  CursorComposerRuntimeEvidence
} from '../infrastructure/cursor/cursor-cdp-session-creator'
import type { CursorModelOption } from '../domain/cursor-model'
import {
  SESSION_WARMUP_PROMPT,
  SESSION_WARMUP_SESSION_NAME,
  SESSION_WARMUP_SLOW_MS,
  SESSION_WARMUP_TIMEOUT_MS,
  isWarmupModelRejection,
  rankWarmupModelCandidates,
  warmupDoneMessage,
  type SessionWarmupCandidate,
  type SessionWarmupRun
} from '../domain/session-warmup'
import { SG_COMPOSER_SERVICE_GLOBAL } from '../infrastructure/cursor/cursor-composer-service-locator'

export interface SessionWarmupCreatorPort {
  /** 创建并提交一个会话（硬回执真实 composerId）。 */
  createAgentSession(input: CursorCdpCreateInput): Promise<CursorCdpCreateResult>
  /** 读取指定 composer 的实时执行证据（isGenerating / responseText / state）。 */
  inspectComposerRuntime(
    workspacePath: string | undefined,
    composerIds: string[]
  ): Promise<Record<string, CursorComposerRuntimeEvidence>>
  /** 团队工作区所在窗口的 CDP socket（用于预热会话的用完即删）。 */
  resolveWorkbenchSocket(workspacePath?: string): Promise<string | undefined>
}

export interface SessionWarmupServiceDeps {
  creator: SessionWarmupCreatorPort
  /** CDP 页面表达式求值（awaitPromise）；仅用于删除预热 Composer。 */
  evaluate: (webSocketDebuggerUrl: string, expression: string, timeoutMs: number) => Promise<unknown>
  /** 当前团队工作区路径（多窗口定位用）。 */
  activeWorkspacePath: () => string | undefined
  /** 当前模型目录（遥测快照）；目录为空时预热报告无候选，不猜模型。 */
  listModels: () => CursorModelOption[]
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
}

type SessionWarmupListener = (run: SessionWarmupRun) => void

const DEFAULT_POLL_INTERVAL_MS = 500
const DELETE_TIMEOUT_MS = 5_000

/** 用完即删：预热 Composer 不应留在用户的会话列表里（服务句柄来自拾光自带网关）。 */
function buildWarmupDeleteExpression(composerId: string): string {
  return `(async () => {
  try {
    const s = window.${SG_COMPOSER_SERVICE_GLOBAL};
    if (!s || !s.deleteComposer) return { ok: false, error: 'composer_service_not_ready' };
    await s.deleteComposer(${JSON.stringify(composerId)});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 180) };
  }
})()`
}

/**
 * 会话预热编排器：创建（指定低成本模型）→ 观测响应完成 → 删除预热会话。
 *
 * 与 AgentSessionLauncher 完全解耦：不取开场提示词、不写通道绑定、
 * 不触发 onAllTriggered——一次探针永远不会成为账号自动化的扳机。
 * 同一时刻只允许一轮预热；新一轮调用在运行中直接拒绝。
 */
export class SessionWarmupService {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number
  private readonly listeners = new Set<SessionWarmupListener>()
  private current: SessionWarmupRun | undefined
  /** 在途轮次的终态 Promise：并发调用等待同一轮结果，而不是读到中间态误判失败。 */
  private inFlight: Promise<SessionWarmupRun> | undefined

  constructor(private readonly deps: SessionWarmupServiceDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.timeoutMs = deps.timeoutMs ?? SESSION_WARMUP_TIMEOUT_MS
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  getRun(): SessionWarmupRun | undefined {
    return this.current ? { ...this.current } : undefined
  }

  onProgress(listener: SessionWarmupListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(run: SessionWarmupRun): void {
    this.current = run
    for (const listener of this.listeners) listener({ ...run })
  }

  /** 批量发起前的预热探针；返回终态 run（phase done / failed），永不 throw。并发调用共享同一在途轮次。 */
  async warmup(): Promise<SessionWarmupRun> {
    if (this.inFlight) return this.inFlight
    const promise = this.runOnce()
    this.inFlight = promise
    try {
      return await promise
    } finally {
      this.inFlight = undefined
    }
  }

  private async runOnce(): Promise<SessionWarmupRun> {
    const candidates = rankWarmupModelCandidates(this.deps.listModels())
    if (!candidates.length) {
      return this.fail(this.now(), '未在 Cursor 模型目录中找到可用的低成本模型（GPT-5.6 Luna 等）；已中止预热，绝不静默切换贵模型')
    }
    let lastModelRejection = ''
    for (const candidate of candidates) {
      const run = await this.tryCandidate(candidate)
      if (run.phase === 'done') return run
      if (run.phase === 'failed' && run.modelLabel && isWarmupModelRejection(run.message)) {
        // 该候选模型配置被 Cursor 拒绝：换下一个候选（拒绝路径的会话由创建方回滚删除）。
        lastModelRejection = `${run.modelLabel}：${run.message}`
        continue
      }
      return run
    }
    return this.fail(this.now(), `低成本模型均不可用（${lastModelRejection}）；已中止预热，绝不静默切换贵模型`)
  }

  private async tryCandidate(candidate: SessionWarmupCandidate): Promise<SessionWarmupRun> {
    const startedAt = this.now()
    const workspacePath = this.deps.activeWorkspacePath()
    this.emit({ phase: 'creating', message: `正在创建 ${candidate.label} 预热会话…`, modelLabel: candidate.label, startedAt })

    const receipt = await this.deps.creator.createAgentSession({
      channelId: '0',
      name: SESSION_WARMUP_SESSION_NAME,
      prompt: SESSION_WARMUP_PROMPT,
      workspacePath,
      modelSelection: candidate.selection
    })
    if (!receipt.ok || !receipt.composerId) {
      return this.fail(startedAt, receipt.message || 'Cursor 拒绝了预热创建请求', candidate.label)
    }
    const composerId = receipt.composerId

    const submittedAt = this.now()
    this.emit({ phase: 'waiting', message: `预热会话已提交，等待 ${candidate.label} 响应…`, modelLabel: candidate.label, startedAt })
    const deadline = submittedAt + this.timeoutMs
    let evidence: CursorComposerRuntimeEvidence | undefined
    while (this.now() < deadline) {
      const rows = await this.deps.creator.inspectComposerRuntime(workspacePath, [composerId])
      evidence = rows[composerId]
      // 完成 = 出现响应文本且已不在生成中（覆盖「错过生成窗口」的瞬时响应）。
      if (evidence && evidence.isGenerating !== true && evidence.responseText?.trim()) break
      evidence = undefined
      await this.sleep(this.pollIntervalMs)
    }

    if (!evidence) {
      await this.discard(workspacePath, composerId)
      return this.fail(startedAt, `预热响应超时（${Math.round(this.timeoutMs / 1_000)}s 内 ${candidate.label} 未产出回复）——账号可能已不可用，已中止批量发起`, candidate.label)
    }

    const durationMs = Math.max(0, this.now() - submittedAt)
    await this.discard(workspacePath, composerId)
    const slow = durationMs > SESSION_WARMUP_SLOW_MS
    const run: SessionWarmupRun = {
      phase: 'done',
      message: warmupDoneMessage(candidate.label, durationMs, slow),
      modelLabel: candidate.label,
      startedAt,
      finishedAt: this.now(),
      durationMs,
      ...(slow ? { slow: true } : {})
    }
    this.emit(run)
    return run
  }

  /** 删除预热 Composer（尽力而为；失败不翻转预热结果，会话名「拾光预热」可被用户识别）。 */
  private async discard(workspacePath: string | undefined, composerId: string): Promise<void> {
    try {
      const socket = await this.deps.creator.resolveWorkbenchSocket(workspacePath)
      if (!socket) return
      await this.deps.evaluate(socket, buildWarmupDeleteExpression(composerId), DELETE_TIMEOUT_MS)
    } catch {
      // 删除失败仅留痕一个可识别的空会话，不影响预热结论。
    }
  }

  private fail(startedAt: number, message: string, modelLabel?: string, emit = true): SessionWarmupRun {
    const run: SessionWarmupRun = {
      phase: 'failed',
      message,
      ...(modelLabel ? { modelLabel } : {}),
      startedAt,
      finishedAt: this.now()
    }
    if (emit) this.emit(run)
    return run
  }
}
