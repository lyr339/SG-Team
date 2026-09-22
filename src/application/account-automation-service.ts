import type { ProcessingProviderRegistry } from './processing-provider-registry'
import type { CursorAccountVault } from './cursor-account-vault'
import type { AccountAutomationSettingsStore } from './account-automation-store'
import type { CursorAccountDeleter, CursorAccountDeleteResult } from '../infrastructure/cursor/cursor-account-deleter'
import type { InBrowserDeleteResult } from '../infrastructure/cursor/cursor-in-browser-account-deleter'
import {
  IDLE_ACCOUNT_AUTOMATION_RUN,
  type AccountAutomationRun,
  type AccountAutomationSettings
} from '../domain/account-automation'

export interface AccountAutomationServiceDeps {
  settings: AccountAutomationSettingsStore
  processingProviders: Pick<ProcessingProviderRegistry, 'require' | 'hasCredential'>
  accounts: Pick<CursorAccountVault, 'list' | 'credential' | 'replaceToken' | 'remove'>
  /** 读取浏览器当前 WorkosCursorSessionToken；存在时用于执行前校验「浏览器会话与拾光凭据一致」。 */
  readBrowserToken?: () => Promise<string>
  /** 刷新浏览器会话并返回新 WorkosCursorSessionToken（处理服务完成后旧 token 失效，须经浏览器换发）。 */
  refreshBrowserToken: (previousToken: string) => Promise<string>
  /**
   * Cursor 运行时登录态与活跃账号一致性核对（JWT sub 比对）。不一致/未登录时
   * preflight 中止——会话创建消耗的是 Cursor 运行态额度，删除锚定的是 vault
   * 活跃账号，劈叉会导致删错官网账号或会话僵尸。缺省不校验（测试/降级装配）。
   */
  verifyCursorRuntime?: () => { ok: boolean; reason?: string }
  deleter: Pick<CursorAccountDeleter, 'deleteAccount'>
  /**
   * 无感换号（热切）：处理成功后把运行中的 Cursor 热切到接手账号。
   * 结果永不 throw（内部全降级）；缺省 = 未装配热切能力，自动化主链不受影响。
   */
  liveSwitch?: (accountId: string) => Promise<LiveSwitchResult>
  /** 自动化预热入口：只兑换票据，commit 才触碰 Cursor 运行态。 */
  prepareLiveSwitch?: (accountId: string) => Promise<{ commit(): Promise<LiveSwitchResult> }>
  /** 选接手账号（排除当前处理号；updatedAt 最新优先）；无可接手号返回 undefined。 */
  pickNextAccount?: (excludeId: string) => string | undefined
  /**
   * 页内秒级通道（首选）：页面刷新 + token 轮换完成后直接在浏览器会话内删除官网账号——
   * 删除不需要 token 值，绕开 cookie 落盘等待（~20s → ~3s）。
   * 不可用时返回 retry_legacy，服务回退 cookie 轮换通道。
   */
  inBrowserDeleter?: {
    prepareRefresh: () => Promise<void>
    /** expectedAccountId＝被处理账号的 userId 前缀：删除发起前的归属守门（指纹宿主执行）。 */
    deleteWhenReady: (expectedAccountId?: string) => Promise<InBrowserDeleteResult>
    /**
     * 账号隔离：官网账号删除成功后、关窗前清空宿主内 cursor.com 站点数据
     * （cookie/匿名 id/localStorage——防下一账号被风控关联）。可选（旧宿主无）。
     */
    clearSiteData?: () => Promise<void>
    /** 删除确认后的完整收尾（指纹宿主：页面卸载 + 关窗 + Roxy 缓存/指纹轮换事务）。 */
    finalizeDeletedAccount?: () => Promise<void>
    /** 每轮自动化结束后清理通道资源（关窗断连；cookie 保留在 profile）。可选。 */
    dispose?: () => Promise<void>
  }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** token 的账号归属（userId 前缀）；仅 user_xxx::jwt 形态可判定，其余形态不猜（守卫退化为不拦）。 */
function tokenAccountId(token: string): string | undefined {
  if (!token.includes('::')) return undefined
  return token.split('::', 1)[0]?.trim() || undefined
}

type AccountAutomationListener = (run: AccountAutomationRun) => void

interface LiveSwitchResult {
  switched: boolean
  reason?: string
  warning?: string
  retryable?: boolean
  /** 自动化内部标记：本轮结果来自一次精准补投。 */
  retried?: boolean
  /** 自动化内部标记：切换前等待随主链取消而放弃（commit 未发出），不写回 failed。 */
  cancelled?: boolean
}

interface LiveSwitchPreparation {
  runSeq: number
  targetAccountId: string
  targetLabel: string
  prepared: Promise<
    | { ok: true; commit: () => Promise<LiveSwitchResult> }
    | { ok: false; result: LiveSwitchResult }
  >
}

const TICK_MS = 500
/**
 * 收尾两条支线的编排级时限（看门狗）。每一步 I/O 各自有超时，但叠起来没有上限，而收尾
 * 相位既不可取消也没有别的兜底——任何一条支线「再也不返回」，运行卡就永远停在「收尾 ·
 * 进行中」，只能重启应用（2026-09-17 实机事故：热切回环服务器关不掉）。取值只兜「不返回」，
 * 不截正常的慢，都留在各自可算出的最坏路径之上：
 *   清场：页面卸载与站点数据清理（CDP 20s + 20s）+ 关 target（20s）+ Roxy 事务两轮
 *        （取 workspace / 关窗 / 本地缓存 / 服务端缓存 / 指纹轮换各 20s）≈ 260s；
 *   热切：切换前等待 ≤60s + 两次回执 12s + 两次补丁配置读取 ≈ 90s。
 */
const CLEANUP_DEADLINE_MS = 300_000
const LIVE_SWITCH_DEADLINE_MS = 120_000
/** 限流退避：起始 5s、逐次翻倍、单次上限 120s、总窗口 5min（自首次限流起算）。 */
const RATE_LIMIT_INITIAL_BACKOFF_MS = 5_000
const RATE_LIMIT_MAX_BACKOFF_MS = 120_000
const RATE_LIMIT_WINDOW_MS = 300_000

/**
 * 账号自动化编排器（玩法 A）：一键创建会话全部提交成功后触发。
 *
 * 链条（每步失败即中止并保留本地账号记录）：
 *   处理前倒计时（可取消；末段预热处理服务）→ 所选服务自助处理（按服务端规则扣点）
 *   → 加固前倒计时（可取消）→ 秒级删除（首选：浏览器会话内直接删，~3s）
 *   → cookie 轮换（换发新 token 入库后用新会话删除，~15-30s；含退团/限流自愈重试；
 *     轮换超时且旧会话仍有效时兜底直删——处理服务副作用延迟场景）
 *   → 移除拾光本地记录
 *
 * 与 AgentSessionLauncher 解耦：launcher 只发「全部提交成功」事件，
 * 本服务自行判断开关状态决定是否执行；同一 plan 只执行一次。
 */
export class AccountAutomationService {
  private readonly listeners = new Set<AccountAutomationListener>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private run: AccountAutomationRun = { ...IDLE_ACCOUNT_AUTOMATION_RUN }
  private lastHandledPlanId: string | undefined
  private cancelRequested = false
  private running = false
  /** 运行序号：新一轮触发取代倒计时中的旧轮，旧链检测到序号变化即静默退出。 */
  private runSeq = 0
  /** 本轮处理成功后放出的热切；绑定 run 序号与目标，避免跨轮污染或补切旧账号。 */
  private pendingLiveSwitch: {
    runSeq: number
    promise: Promise<LiveSwitchResult>
  } | undefined

  constructor(private readonly deps: AccountAutomationServiceDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  getSettings(): AccountAutomationSettings {
    return this.deps.settings.load()
  }

  saveSettings(input: unknown): AccountAutomationSettings {
    return this.deps.settings.save(input)
  }

  getRun(): AccountAutomationRun {
    return structuredClone(this.run)
  }

  subscribe(listener: AccountAutomationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** launcher 钩子：本轮所有通道的会话都已创建提交成功（CDP 硬回执齐全）。 */
  onAllSessionsTriggered(planId: string): void {
    if (!planId || planId === this.lastHandledPlanId) return
    if (!this.getSettings().enabled) return
    if (this.running && this.run.phase !== 'countdown') return
    this.lastHandledPlanId = planId
    void this.execute(planId)
  }

  /** 两段倒计时均可取消；处理/删除请求已发出后不可中止（服务商扣费/删号无回滚）。 */
  cancel(): AccountAutomationRun {
    if (this.run.phase !== 'countdown' && this.run.phase !== 'hardening-countdown') return this.getRun()
    this.cancelRequested = true
    return this.getRun()
  }

  private setRun(patch: Partial<AccountAutomationRun>): void {
    this.run = { ...this.run, ...patch }
    for (const listener of this.listeners) listener(structuredClone(this.run))
  }

  /**
   * 删除调用统一入口，带两类自愈重试：
   *
   * 1. 退团等待：官网报「先退出团队」时每 2s 自动重试、最长 60s。
   *    服务商 completed ≠ 副作用已落地——退团/会话失效有服务端延迟（实机实测：
   *    completed 后 1s 删除撞 leave team，约一小时后 team_id 已清空）。
   * 2. 限流退避：限流型拒绝（HTTP 429 / Retry-After / "Try again later"）做指数
   *    退避重试——起始 5s、逐次翻倍、单次上限 120s，总窗口 ≤5min；服务端给了
   *    Retry-After 就按它等（钳在 [1s, 120s]）。限流期间会话本身仍有效，
   *    轮换 token 无意义，退避重试是唯一正解。
   *
   * 其余结果（含重试中途会话失效 authExpired）原样返回，由调用方分支处理。
   */
  private async deleteWithTeamWait(token: string): Promise<CursorAccountDeleteResult> {
    const teamDeadline = this.now() + 60_000
    let attempts = 0
    let rateLimitAttempts = 0
    let rateLimitDeadline: number | undefined
    let backoffMs = RATE_LIMIT_INITIAL_BACKOFF_MS
    for (;;) {
      attempts += 1
      const result = await this.deps.deleter.deleteAccount(token)
      if (result.needLeaveTeam) {
        if (this.now() >= teamDeadline) {
          return { ok: false, message: `官网持续要求先退出团队（已等待 60s 重试 ${attempts} 次）：${result.message}` }
        }
        this.setRun({ message: `官网要求先退出团队，等待团队状态生效后自动重试…（已试 ${attempts} 次）` })
        await this.sleep(2_000)
        continue
      }
      if (result.rateLimited) {
        rateLimitAttempts += 1
        // 总窗口从首次限流起算 ≤5min；超限即识败，不无限拖住自动化链
        rateLimitDeadline = rateLimitDeadline ?? this.now() + RATE_LIMIT_WINDOW_MS
        const hintMs = result.retryAfterSec !== undefined ? result.retryAfterSec * 1_000 : undefined
        const waitMs = Math.min(Math.max(hintMs ?? backoffMs, 1_000), RATE_LIMIT_MAX_BACKOFF_MS)
        if (this.now() + waitMs > rateLimitDeadline) {
          return { ok: false, message: `官网持续限流（已重试 ${rateLimitAttempts} 次）：${result.message}` }
        }
        this.setRun({ message: `官网限流，${Math.round(waitMs / 1000)}s 后重试（第 ${rateLimitAttempts} 次）` })
        await this.sleep(waitMs)
        backoffMs = Math.min(backoffMs * 2, RATE_LIMIT_MAX_BACKOFF_MS)
        continue
      }
      return result
    }
  }

  /** 共用倒计时循环：0.5s 步进，可取消、可被新一轮取代。 */
  private async waitCountdown(input: {
    mySeq: number
    phase: 'countdown' | 'hardening-countdown'
    durationSec: number
    tickMessage: (left: number) => string
    cancelledMessage: string
    onTick?: (left: number) => void
  }): Promise<'completed' | 'cancelled' | 'superseded'> {
    for (let left = input.durationSec; left > 0; left -= 0.5) {
      if (this.runSeq !== input.mySeq) return 'superseded'
      this.setRun({ phase: input.phase, remainingSec: left, message: input.tickMessage(left) })
      input.onTick?.(left)
      await this.sleep(TICK_MS)
      if (this.runSeq !== input.mySeq) return 'superseded'
      if (this.cancelRequested) {
        this.setRun({
          phase: 'cancelled',
          message: input.cancelledMessage,
          remainingSec: undefined,
          finishedAt: this.now()
        })
        return 'cancelled'
      }
    }
    this.setRun({ remainingSec: undefined })
    return 'completed'
  }

  /**
   * 服务商处理开始时预热接手票据（不触碰 Cursor 运行态）：开关关闭、能力未装配
   * 或没有接手号时跳过；目标账号在这里冻结，后续不随列表变化漂移。
   */
  private prepareLiveSwitch(processedAccountId: string, runSeq: number): LiveSwitchPreparation | undefined {
    if (this.getSettings().seamlessHandoverEnabled === false) return undefined
    if ((!this.deps.prepareLiveSwitch && !this.deps.liveSwitch) || !this.deps.pickNextAccount) return undefined
    const nextId = this.deps.pickNextAccount(processedAccountId)
    if (!nextId) return undefined
    const targetLabel = this.deps.accounts.list().find((account) => account.id === nextId)?.label ?? nextId
    this.setRun({
      handover: {
        accountId: nextId,
        label: targetLabel,
        status: 'preparing',
        message: '正在准备 Cursor 会话票据',
        startedAt: this.now()
      }
    })
    const prepared = (this.deps.prepareLiveSwitch
      ? this.deps.prepareLiveSwitch(nextId)
          .then((value) => ({ ok: true as const, commit: () => value.commit() }))
          .catch((error: unknown) => ({
            ok: false as const,
            result: { switched: false, reason: error instanceof Error ? error.message : String(error) }
          }))
      : Promise.resolve({
          ok: true as const,
          commit: () => this.deps.liveSwitch!(nextId)
        }))
      .then((result) => {
        if (this.runSeq === runSeq && this.run.handover?.accountId === nextId) {
          this.setRun({
            handover: {
              ...this.run.handover,
              status: result.ok ? 'preparing' : 'failed',
              message: result.ok ? '票据已就绪，等待处理完成' : (result.result.reason ?? '票据准备失败'),
              ...(result.ok ? {} : { finishedAt: this.now() })
            }
          })
        }
        return result
      })
    return {
      runSeq,
      targetAccountId: nextId,
      targetLabel,
      prepared
    }
  }

  /** 处理成功确认后提交已预热票据，并把结果即时写入独立子状态。delaySec > 0 时先等待再 commit。 */
  private startLiveSwitch(preparation: LiveSwitchPreparation, delaySec = 0): typeof this.pendingLiveSwitch {
    const handoverBase = {
      accountId: preparation.targetAccountId,
      label: preparation.targetLabel,
      startedAt: this.run.handover?.startedAt ?? this.now()
    }
    const announceSwitching = (): void => {
      this.setRun({ handover: { ...handoverBase, status: 'switching', message: '等待 Cursor 接收并确认' } })
    }
    if (delaySec <= 0) announceSwitching()
    const run = async (): Promise<LiveSwitchResult> => {
      // 切换前等待：handover 保持 preparing 并倒计时；commit 尚未发出，
      // 主链取消/被取代即放弃热切（与「请求已发出后不可中止」互补：未发出的不发出）。
      if (delaySec > 0) {
        for (let left = delaySec; left > 0; left -= 0.5) {
          if (this.runSeq !== preparation.runSeq || this.cancelRequested) {
            return { switched: false, reason: '切换前等待已随自动化取消', cancelled: true }
          }
          this.setRun({ handover: { ...handoverBase, status: 'preparing', message: `票据已就绪，${left}s 后切换` } })
          await this.sleep(TICK_MS)
        }
        announceSwitching()
      }
      const prepared = await preparation.prepared
      return prepared.ok ? prepared.commit() : prepared.result
    }
    const promise = run().then(async (first) => {
      if (!first.retryable || this.runSeq !== preparation.runSeq) return first
      this.setRun({
        handover: {
          accountId: preparation.targetAccountId,
          label: preparation.targetLabel,
          status: 'switching',
          message: '首次回执超时，正在补投一次',
          startedAt: this.run.handover?.startedAt ?? this.now()
        }
      })
      const retried = await run()
      return { ...retried, retried: true }
    }).then((result) => {
      // 取消放弃的切换不写回 failed——主链已按用户意图定型为 cancelled。
      if (this.runSeq === preparation.runSeq && !result.cancelled) {
        this.setRun({
          handover: {
            accountId: preparation.targetAccountId,
            label: preparation.targetLabel,
            status: result.switched ? 'done' : 'failed',
            message: result.switched
              ? result.retried ? 'Cursor 已在补投后完成接手' : 'Cursor 已完成接手'
              : (result.reason ?? 'Cursor 未完成接手'),
            startedAt: this.run.handover?.startedAt ?? this.now(),
            finishedAt: this.now()
          }
        })
      }
      return result
    })
    return {
      runSeq: preparation.runSeq,
      promise
    }
  }

  /** 等待已在处理成功后执行（含切换前等待与精准补投）的热切，并生成最终摘要。 */
  private async settleLiveSwitch(runSeq: number): Promise<string | undefined> {
    const pending = this.pendingLiveSwitch
    if (!pending || pending.runSeq !== runSeq) return undefined
    this.pendingLiveSwitch = undefined
    const first = await pending.promise
    if (first.cancelled) return '无感换号已随自动化取消（未切换）'
    if (first.switched) return first.warning
      ? `无感换号已完成，但需处理：${first.warning}`
      : first.retried
        ? '无感换号已完成（补切，Cursor 未重启）'
        : '无感换号已完成（Cursor 未重启）'
    return `无感换号未完成（${first.reason ?? '未知原因'}），可在账号列表手动切换`
  }

  /**
   * 看门狗：等 work 完成，最多等 ms。超时返回 `{ done: false }`——只是「不再等」，work 仍在
   * 后台跑完；未超时的异常原样抛给调用方分支。用服务自己的 now/sleep 时钟按 TICK_MS 巡检
   * （与倒计时同一时间模型），完成即刻返回，不留长定时器。
   */
  private async awaitWithin<T>(work: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
    let settled: { ok: true; value: T } | { ok: false; error: unknown } | undefined
    const tracked = work.then(
      (value) => { settled = { ok: true, value } },
      (error: unknown) => { settled = { ok: false, error } }
    )
    const deadline = this.now() + ms
    while (!settled) {
      if (this.now() >= deadline) return { done: false }
      await Promise.race([tracked, this.sleep(TICK_MS)])
    }
    if (!settled.ok) throw settled.error
    return { done: true, value: settled.value }
  }

  /** 等热切定型并生成摘要，压上看门狗：超时只降级提示，最终结果以 handover 子状态为准。 */
  private async liveSwitchNoteWithin(settling: Promise<string | undefined>): Promise<string | undefined> {
    const settled = await this.awaitWithin(settling, LIVE_SWITCH_DEADLINE_MS)
    if (settled.done) return settled.value
    return `无感换号 ${LIVE_SWITCH_DEADLINE_MS / 1_000}s 内未回执，以接手状态为准（可在账号列表手动切换）`
  }

  /**
   * 所有删除成功分支的唯一收口（Profile 事务）：
   * ① 本地凭据移除；② 浏览器清场事务。分别执行、分别记错，任一失败不阻断
   * 另一项——账号加固已成功是事实，收尾异常按降级口径呈现（不置 failed，
   * 不再让用户以为加固失败；旧版曾把清场失败误报成整个流程失败）。
   *
   * 「不阻断」必须同时管住「不返回」：`cleaning` 相位不可取消（`cancel()` 只在两个倒计时
   * 相位生效），运行态只在内存里——清场与热切任一支线吊住，运行卡就永远停在「收尾 · 进行中」。
   * 所以两条支线都压上看门狗，超时按「收尾异常」降级并写明是哪一条（下次不必再猜）。
   */
  private async finishDeletedAccount(accountId: string, successMessage: string, runSeq: number): Promise<void> {
    let localRemoveError: string | undefined
    try {
      this.deps.accounts.remove(accountId)
    } catch (error) {
      localRemoveError = error instanceof Error ? error.message : String(error)
    }
    // 热切 settle 与浏览器清场并行：两条通道本就独立（回环泵 ↔ Roxy profile）。
    let liveSwitchSettled = this.pendingLiveSwitch?.runSeq !== runSeq
    const liveSwitchNotePromise = this.settleLiveSwitch(runSeq)
    void liveSwitchNotePromise.then(() => { liveSwitchSettled = true }, () => { liveSwitchSettled = true })
    const cleanup = this.deps.inBrowserDeleter?.finalizeDeletedAccount ?? this.deps.inBrowserDeleter?.clearSiteData
    let cleanupError: string | undefined
    if (cleanup) {
      this.setRun({ phase: 'cleaning', message: '账号已加固，正在清理浏览器环境并轮换指纹…' })
      try {
        const cleaned = await this.awaitWithin(cleanup(), CLEANUP_DEADLINE_MS)
        if (!cleaned.done) cleanupError = `超过 ${CLEANUP_DEADLINE_MS / 1_000}s 未返回（后台继续）`
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error)
      }
    }
    // 清场已收、只剩热切未定型时如实告知——不让「正在清理」挂在等 Cursor 回执的时间上；
    // 具体在等什么（切换前倒计时 / 等待 Cursor 确认）由 handover 子状态呈现，这里不重复。
    if (!liveSwitchSettled) {
      this.setRun({
        phase: 'cleaning',
        message: cleanup && !cleanupError ? '账号已加固、浏览器环境已清场，等待无感换号完成…' : '账号已加固，等待无感换号完成…'
      })
    }
    const liveSwitchNote = await this.liveSwitchNoteWithin(liveSwitchNotePromise)
    const message = liveSwitchNote ? `${successMessage}；${liveSwitchNote}` : successMessage
    if (localRemoveError || cleanupError) {
      const details = [
        localRemoveError ? `本地记录移除失败：${localRemoveError}` : undefined,
        cleanupError ? `浏览器清场未完成：${cleanupError}` : undefined
      ].filter((entry): entry is string => Boolean(entry)).join('；')
      this.setRun({
        phase: 'done',
        message: `${message}；收尾异常（不影响加固结果）：${details.replace(/\s+/g, ' ').slice(0, 200)}`,
        finishedAt: this.now()
      })
      return
    }
    this.setRun({ phase: 'done', message, finishedAt: this.now() })
  }

  private async execute(planId: string): Promise<void> {
    const mySeq = ++this.runSeq
    this.pendingLiveSwitch = undefined
    this.running = true
    this.cancelRequested = false
    const startedAt = this.now()
    try {
      const settings = this.getSettings()
      const processing = this.deps.processingProviders.require(settings.processingProvider)
      const provider = processing.service
      this.setRun({
        phase: 'countdown',
        planId,
        processingProvider: provider.id,
        startedAt,
        finishedAt: undefined,
        handover: undefined,
        remainingSec: settings.delaySec,
        message: `将在 ${settings.delaySec}s 后自动处理当前账号（可取消）`
      })

      // 前置校验放在倒计时之前亮相、倒计时之后复检（期间用户可能改动）。
      // stage='recheck' 时闸 4（浏览器会话一致性，要连/读浏览器窗口）可按
      // preflightRecheckEnabled 关闭；闸 1-3 是内存/SQLite 毫秒级读，始终复检。
      const preflight = async (stage: 'early' | 'recheck'): Promise<string | undefined> => {
        if (!this.deps.processingProviders.hasCredential(provider.id)) return `未配置${provider.label}卡密，自动化中止`
        const active = this.deps.accounts.list().find((account) => account.active)
        if (!active) return '尚未选择 Cursor 账号，自动化中止'
        // 运行态一致性硬闸：Cursor 登录的必须是活跃账号本身（本地 SQLite 读毫秒级）。
        // 卡密/活跃账号检查之后、浏览器会话校验之前——后者要开窗，本闸先挡最廉价也最致命的劈叉。
        if (this.deps.verifyCursorRuntime) {
          const runtime = this.deps.verifyCursorRuntime()
          if (!runtime.ok) return runtime.reason ?? 'Cursor 登录态与活跃账号不一致，自动化中止'
        }
        // 消耗卡密前的最后一道闸：浏览器会话必须可读且与拾光凭据一致——
        // 否则会把已失效/错误账号的 token 提交给所选服务，失败还浪费一次排查时间
        if (this.deps.readBrowserToken && !(stage === 'recheck' && this.getSettings().preflightRecheckEnabled === false)) {
          // 会话来源描述：指纹宿主精确到「账号绑定窗口 / 默认窗口」，外部宿主为系统浏览器。
          // 绑定语义让报错能指到具体窗口与修法，而不是泛泛的「重新导入」。
          const host = this.getSettings().browserHost ?? 'fingerprint'
          const bound = Boolean(active.fingerprintProfileId)
          const sessionSource = host === 'external'
            ? '系统浏览器会话'
            : bound ? `账号「${active.label}」绑定的指纹窗口` : '默认指纹窗口'
          let browserToken = ''
          try {
            browserToken = (await this.deps.readBrowserToken()).trim()
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            return `${sessionSource}读取失败（${detail.replace(/\s+/g, ' ').slice(0, 80)}），自动化中止`
          }
          if (!browserToken) return `${sessionSource}未登录 cursor.com——请登录后重新导入 Token，自动化中止`
          let vaultToken = ''
          try {
            vaultToken = this.deps.accounts.credential(active.id).trim()
          } catch {
            vaultToken = ''
          }
          if (vaultToken && browserToken !== vaultToken) {
            const guidance = host !== 'external' && bound
              ? '该窗口可能已改登其他账号——请打开绑定窗口重新登录后导入，或在账号列表改绑窗口'
              : '请重新从浏览器导入 Token'
            return `${sessionSource}登录态与拾光凭据不一致（${guidance}），自动化中止`
          }
        }
        return undefined
      }
      const earlyIssue = await preflight('early')
      if (earlyIssue) {
        this.setRun({ phase: 'failed', message: earlyIssue, remainingSec: undefined, finishedAt: this.now() })
        return
      }

      const beforeProcess = await this.waitCountdown({
        mySeq,
        phase: 'countdown',
        durationSec: settings.delaySec,
        tickMessage: (left) => `将在 ${left}s 后自动处理当前账号（可取消）`,
        cancelledMessage: '已取消本次自动化',
        // 倒计时末段预热处理服务：执行时直接进入提交，省一次往返
        onTick: (left) => {
          if (left === Math.min(3, settings.delaySec)) void provider.warmup().catch(() => {})
        }
      })
      if (beforeProcess !== 'completed') return
      const issue = await preflight('recheck')
      if (issue) {
        this.setRun({ phase: 'failed', message: issue, finishedAt: this.now() })
        return
      }

      const account = this.deps.accounts.list().find((candidate) => candidate.active)
      if (!account) {
        this.setRun({ phase: 'failed', message: '尚未选择 Cursor 账号，自动化中止', finishedAt: this.now() })
        return
      }

      this.setRun({ phase: 'processing', message: `${provider.label}自助处理中…` })
      const previousToken = this.deps.accounts.credential(account.id)
      // 目标在本轮固定；票据兑换与服务商请求并行。预热不触碰 Cursor，只有退款
      // 成功后的 startLiveSwitch 才提交运行态写票。
      const liveSwitchPreparation = this.prepareLiveSwitch(account.id, mySeq)
      const processed = await provider.processToken(
        previousToken,
        (_state, message) => {
          if (this.run.phase === 'processing') this.setRun({ message: `${provider.label}：${message}` })
        },
        { refreshBalance: false }
      )
      if (!processed.ok) {
        this.setRun({
          phase: 'failed',
          message: `${provider.label}处理失败：${processed.message}（本地账号已保留）`,
          handover: undefined,
          finishedAt: this.now()
        })
        return
      }

      // 处理成功即热切（对齐小辰 accountRefunded 点）：旧号额度已废，运行中的
      // Cursor 必须尽快落到接手号上；加固倒计时/删除与热切并行，互不阻塞。
      // fire-and-forget：结果在 finishDeletedAccount 收口时 settle 呈现。
      // handoverDelaySec > 0 时先经「切换前等待」再 commit（commit 未发出前取消即放弃）。
      this.pendingLiveSwitch = liveSwitchPreparation
        ? this.startLiveSwitch(liveSwitchPreparation, settings.handoverDelaySec ?? 0)
        : undefined

      // 加固前第二段倒计时：处理服务已完成（卡密已扣），此段取消只跳过加固、保留本地账号。
      const beforeHardening = await this.waitCountdown({
        mySeq,
        phase: 'hardening-countdown',
        durationSec: settings.postProcessDelaySec,
        tickMessage: (left) => `${provider.label}已完成，将在 ${left}s 后加固当前账号（可取消）`,
        cancelledMessage: `${provider.label}处理已完成；已取消后续账号加固，本地账号保留`
      })
      if (beforeHardening !== 'completed') return

      const inBrowser = this.deps.inBrowserDeleter

      // 主路径：处理服务完成后旧 token 通常已失效，新会话首先出现在浏览器内存中。
      // 优先使用 AppleScript 秒级通道（外部浏览器会话内直接删），失败后回退 cookie 轮换。
      if (inBrowser) {
        this.setRun({ phase: 'deleting', message: `${provider.label}已完成，正在刷新浏览器会话并秒级加固账号…` })
        let fast: InBrowserDeleteResult
        try {
          await inBrowser.prepareRefresh()
          // 归属守门透传：删除前核对页面会话仍属被处理账号（仅可判定形态生效）
          fast = await inBrowser.deleteWhenReady(tokenAccountId(previousToken))
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          fast = { kind: 'retry_legacy', message: detail.replace(/\s+/g, ' ').slice(0, 160) }
        }
        if (fast.kind === 'deleted') {
          await this.finishDeletedAccount(
            account.id,
            '自动化完成：已处理、账号已加固（浏览器会话内秒级执行）、浏览器环境已清场',
            mySeq
          )
          return
        }
        if (fast.kind === 'not_logged_in') {
          this.setRun({ phase: 'failed', message: `${fast.message}（本地账号已保留）`, finishedAt: this.now() })
          return
        }
        this.setRun({ phase: 'importing', message: `秒级通道不可用（${fast.message}），回退 cookie 轮换通道…` })
      } else {
        // 无浏览器秒级通道时保留旧行为：先尝试当前 token，若已失效再轮换。
        this.setRun({ phase: 'deleting', message: '正在加固 Cursor 账号（不可撤销）…' })
        const direct = await this.deleteWithTeamWait(previousToken)
        if (direct.ok) {
          this.deps.accounts.remove(account.id)
          const liveSwitchNote = await this.liveSwitchNoteWithin(this.settleLiveSwitch(mySeq))
          this.setRun({
            phase: 'done',
            message: `自动化完成：已处理、账号已加固（当前会话直接执行）、本地记录已移除${liveSwitchNote ? `；${liveSwitchNote}` : ''}`,
            finishedAt: this.now()
          })
          return
        }
        if (!direct.authExpired) {
          this.setRun({ phase: 'failed', message: `${direct.message}（本地账号已保留）`, finishedAt: this.now() })
          return
        }
        this.setRun({ phase: 'importing', message: '会话已失效，正在刷新浏览器会话获取新 Token…' })
      }
      let newToken: string
      try {
        newToken = await this.deps.refreshBrowserToken(previousToken)
      } catch (error) {
        // 轮换超时的真实成因之一：处理服务副作用延迟，旧 token 仍有效（completed ≠ 已落地，
        // 与退团延迟同理的实机先例）。秒级通道在场时兜底用旧 token 直删一次——
        // 仍有效则直接完成；无通道路径此前已直删并确认失效，重试无意义，维持原失败语义。
        if (inBrowser) {
          this.setRun({ phase: 'deleting', message: '新 Token 轮换超时，尝试用当前会话直接加固…' })
          const direct = await this.deleteWithTeamWait(previousToken)
          if (direct.ok) {
            await this.finishDeletedAccount(
              account.id,
              '自动化完成：已处理、账号已加固（当前会话直接执行）、浏览器环境已清场',
              mySeq
            )
            return
          }
          const detail = error instanceof Error ? error.message : String(error)
          this.setRun({ phase: 'failed', message: `新 Token 获取失败：${detail}；旧会话加固未成功：${direct.message}（本地账号已保留）`, finishedAt: this.now() })
          return
        }
        const detail = error instanceof Error ? error.message : String(error)
        this.setRun({ phase: 'failed', message: `新 Token 获取失败：${detail}（本地账号已保留）`, finishedAt: this.now() })
        return
      }
      // 归属复核（先于入库）：轮换出的新会话必须仍属被处理账号——热切后活跃账号
      // 已变更，若执行窗口被重登成其他账号，绝不能用错账号的凭据入库并执行删除。
      // 仅在两侧 token 都可判定归属（user_xxx::jwt 形态）时拦截，否则保持原链路。
      const previousAccountId = tokenAccountId(previousToken)
      const newAccountId = tokenAccountId(newToken)
      if (previousAccountId && newAccountId && previousAccountId !== newAccountId) {
        this.setRun({
          phase: 'failed',
          message: '浏览器刷新出的新会话已属于其他账号——已中止以防误删（请检查执行窗口登录态）；本地账号已保留',
          finishedAt: this.now()
        })
        return
      }
      try {
        this.deps.accounts.replaceToken(account.id, newToken)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.setRun({ phase: 'failed', message: `新 Token 入库失败：${detail}`, finishedAt: this.now() })
        return
      }

      this.setRun({ phase: 'deleting', message: '正在用新会话加固 Cursor 账号（不可撤销）…' })
      const deleted = await this.deleteWithTeamWait(newToken)
      if (!deleted.ok) {
        this.setRun({ phase: 'failed', message: `${deleted.message}（新 Token 已入库，本地记录已保留）`, finishedAt: this.now() })
        return
      }

      await this.finishDeletedAccount(
        account.id,
        '自动化完成：已处理、新凭据已用毕、账号已加固、浏览器环境已清场',
        mySeq
      )
    } catch (error) {
      if (this.runSeq !== mySeq) return // 静默让位给新一轮
      const detail = error instanceof Error ? error.message : String(error)
      this.setRun({ phase: 'failed', message: `自动化异常中止：${detail}`, finishedAt: this.now() })
    } finally {
      if (this.runSeq === mySeq) {
        // 成功收口已消费 pending；取消/失败也必须把已启动热切的结果呈现并清空。
        // 同样压看门狗：这里吊住会让 running 永远为 true，之后每一轮自动化都被静默拒绝。
        if (this.pendingLiveSwitch?.runSeq === mySeq) {
          const liveSwitchNote = await this.liveSwitchNoteWithin(this.settleLiveSwitch(mySeq))
          if (liveSwitchNote && this.runSeq === mySeq && this.run.phase !== 'done') {
            this.setRun({ message: `${this.run.message}；${liveSwitchNote}` })
          }
        }
        this.running = false
        // 一轮结束即清理浏览器通道（关窗断连；cookie 保留在 profile）。
        // 被新一轮取代时不清理——新轮的 preflight 可能已复用同一通道。
        await this.deps.inBrowserDeleter?.dispose?.().catch(() => {})
      }
    }
  }
}
