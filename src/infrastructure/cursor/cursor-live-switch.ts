import { join } from 'node:path'
import type { CursorDesktopTokenExchangePort } from './cursor-desktop-token-exchanger'
import type { CursorRuntimeQueuePort } from './cursor-runtime-account-bridge'
import type { CursorSwitchPumpInstaller } from './cursor-switch-pump-installer'
import type { CursorSwitchMutex } from './cursor-switch-mutex'
import { cursorUserDataRoot } from './cursor-install-paths'

export interface CursorLiveSwitchInput {
  accountId: string
}

export interface CursorLiveSwitchResult {
  switched: boolean
  /** 未切换的原因（人话）；switched=true 时缺省。 */
  reason?: string
  /** Cursor 已切换，但本地附属状态同步存在异常。 */
  warning?: string
  /** 仅瞬时回执超时时允许复用同一份已兑换票据补投。 */
  retryable?: boolean
}

export interface PreparedCursorLiveSwitch {
  accountId: string
  label: string
  /** 提交只执行运行态写票；已兑换票据封装在闭包内，不向应用层暴露。 */
  commit(): Promise<CursorLiveSwitchResult>
}

interface CursorLiveSwitchPayload {
  accountId: string
  label: string
  sourceToken: string
  payload: { accessToken: string; refreshToken: string; userId: string; signUpType: string; email?: string }
}

interface LiveSwitchVault {
  credential(accountId: string): string
  activateAfterLiveSwitch(accountId: string): unknown
  list(): Array<{ id: string; label: string }>
}

/** 账号备注常带「（网页登录）」等来源后缀；邮箱只取纯邮箱部分（与应用层同规则）。 */
function emailFromLabel(label: string | undefined): string | undefined {
  const candidate = label?.replace(/（.*?）\s*$/, '').trim()
  return candidate && /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : undefined
}

/**
 * 无感换号（热切）核心：不杀进程、不写库、不动机器码——把兑换好的桌面票据
 * 挂上回环服务器，运行中的切号补丁按自己内嵌配置轮询取走，在 Cursor 内部
 * 完成写票/广播/flush/回执。
 *
 * 时序契约（与冷切换一致）：回执确认成功后才原子提交 Vault 活跃账号与
 * 机器码待对齐标记——失败时 Cursor 仍是原账号，active 不能先动。
 *
 * 降级而非抛出：补丁未装/端口被占/兑换失败/回执超时都返回 {switched:false}，
 * 自动化主链不受牵连；手动入口由调用方把 reason 亮给用户。
 */
export class CursorLiveSwitcher {
  constructor(private readonly deps: {
    vault: LiveSwitchVault
    exchanger: Pick<CursorDesktopTokenExchangePort, 'resolve'>
    bridge: CursorRuntimeQueuePort
    installer: Pick<CursorSwitchPumpInstaller, 'readInstalledConfig'>
    mutex: CursorSwitchMutex
    stateDatabasePath?: string
    /** 回执等待时限（默认 12s：补丁 1.5s 轮询 + 写票回读余量）。 */
    ackTimeoutMs?: number
    /** 热切写票前短暂压住 CDP auto-heal，避免身份刷新瞬间误报。 */
    suppressRuntimeWatch?: () => void
    trace?: (message: string) => void
  }) {}

  async switchLive(input: CursorLiveSwitchInput): Promise<CursorLiveSwitchResult> {
    try {
      // 手动入口保持整段互斥：用户同时点击冷切换时，不让两个操作意图交错。
      return await this.deps.mutex.withLock('无感换号', async () => {
        const prepared = await this.preparePayload(input)
        return this.commitPreparedUnlocked(prepared)
      })
    } catch (error) {
      return { switched: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 预先完成网页票据 → IDE Session 票据兑换。此阶段只读 Vault/SQLite 并访问
   * Cursor 登录端点，不触碰运行态；自动化可与奥仔处理并行，退款成功后再 commit。
   */
  async prepare(input: CursorLiveSwitchInput): Promise<PreparedCursorLiveSwitch> {
    const prepared = await this.preparePayload(input)
    return {
      accountId: prepared.accountId,
      label: prepared.label,
      commit: () => this.commitPrepared(prepared)
    }
  }

  private async preparePayload(input: CursorLiveSwitchInput): Promise<CursorLiveSwitchPayload> {
    const accountId = input.accountId.trim()
    if (!accountId) throw new Error('Cursor 账号 ID 无效')
    // 先验补丁，缺失时不制造无意义的桌面会话兑换；提交时会再次复检。
    if (!this.deps.installer.readInstalledConfig()) {
      throw new Error('切号补丁未安装或配置不可读（请到维护页安装切号补丁）')
    }
    const sourceToken = this.deps.vault.credential(accountId)
    const account = this.deps.vault.list().find((item) => item.id === accountId)
    const label = account?.label ?? accountId
    const stateDb = this.deps.stateDatabasePath
      ?? join(cursorUserDataRoot(), 'User', 'globalStorage', 'state.vscdb')
    let tokens: Awaited<ReturnType<CursorDesktopTokenExchangePort['resolve']>>
    try {
      tokens = await this.deps.exchanger.resolve(sourceToken, stateDb)
    } catch (error) {
      throw new Error(`换票失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const userId = this.jwtSubject(tokens.accessToken)
    if (!userId) throw new Error('兑换出的桌面票据无法解析账号标识')
    const email = emailFromLabel(account?.label)
    const payload = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      userId,
      signUpType: userId.startsWith('auth0|') ? 'Auth_0' : '',
      ...(email ? { email } : {})
    }
    return {
      accountId,
      label,
      sourceToken,
      payload
    }
  }

  private async commitPrepared(prepared: CursorLiveSwitchPayload): Promise<CursorLiveSwitchResult> {
    try {
      return await this.deps.mutex.withLock('无感换号', () => this.commitPreparedUnlocked(prepared))
    } catch (error) {
      return { switched: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  private async commitPreparedUnlocked(prepared: CursorLiveSwitchPayload): Promise<CursorLiveSwitchResult> {
    const { accountId, sourceToken, payload } = prepared
    try {
        const config = this.deps.installer.readInstalledConfig()
        if (!config) return { switched: false, reason: '切号补丁未安装或配置不可读（请到维护页安装切号补丁）' }
        // 预热后账号可能被重新导入；只提交与准备时完全相同的源凭据。
        try {
          if (this.deps.vault.credential(accountId) !== sourceToken) {
            return { switched: false, reason: '目标账号凭据已更新，请重新发起无感换号' }
          }
        } catch (error) {
          return { switched: false, reason: error instanceof Error ? error.message : String(error) }
        }
        this.deps.suppressRuntimeWatch?.()
        let ack
        try {
          ack = await this.deps.bridge.serveOnce(
            payload,
            { port: config.port, key: config.key },
            this.deps.ackTimeoutMs ?? 12_000
          )
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return {
            switched: false,
            reason,
            ...(reason.includes('没有确认运行时登录态') ? { retryable: true } : {})
          }
        }
        if (!ack.success) {
          return { switched: false, reason: `Cursor 运行时拒绝换号：${ack.reason || 'unknown'}` }
        }
        // 硬回执后以一次 Vault 原子写同步当前账号与机器码待对齐状态。
        try {
          this.deps.vault.activateAfterLiveSwitch(accountId)
        } catch (error) {
          return {
            switched: true,
            warning: `Cursor 已完成换号，但拾光本地账号状态同步失败：${error instanceof Error ? error.message : String(error)}`
          }
        }
        this.deps.trace?.(`[live-switch] 无感换号成功：${accountId}（端口 ${config.port}）`)
        return { switched: true }
    } catch (error) {
      return { switched: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  private jwtSubject(token: string): string | undefined {
    const payload = token.trim().split('.')[1]
    if (!payload) return undefined
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown }
      return typeof parsed.sub === 'string' && parsed.sub.trim() ? parsed.sub.trim() : undefined
    } catch {
      return undefined
    }
  }
}
