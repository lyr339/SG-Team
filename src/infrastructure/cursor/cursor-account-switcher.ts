import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { writeStoreFileSync } from '../fs/store-file'
import type { CursorMachineIdentity } from './cursor-machine-identity'
import type { CursorRuntimeAccountBridgePort } from './cursor-runtime-account-bridge'
import {
  CursorDesktopTokenExchanger,
  type CursorDesktopTokenExchangePort
} from './cursor-desktop-token-exchanger'
import { cursorUserDataRoot, cursorWorkbenchBundleCandidates } from './cursor-install-paths'
import {
  CursorRuntimeCompanionConfig,
  cursorExecutableFromRuntimeBundle,
  locateCursorRuntimeCompanionBundle
} from './cursor-runtime-companion-config'
import { isCursorMainProcessRunning } from './cursor-process-probe'
import { readCursorCompatibility } from './cursor-compatibility'
import { appRootOfBundle } from './cursor-install-paths'
import { macBundlePathFromAppRoot } from './cursor-switch-pump-installer'
import { CursorAccountSwitchBackup } from './cursor-account-switch-backup'
import {
  cursorWindowsStartCommand,
  defaultProcessExecFile,
  resolveCursorWindowsExecutable,
  runningCursorWindowsExecutable
} from './cursor-windows-launch'

const execFileAsync = promisify(execFile)

/** 主进程死亡后、写库前的静置时长（孤儿 Helper/utility 进程 flush 收尾窗口）。 */
const POST_EXIT_SETTLE_MS = 1_200

export interface CursorAccountSwitchInput {
  /** 目标账号 Token：允许 cursor.com type=web JWT，切换前会兑换为 IDE type=session JWT。 */
  token: string
  /** 缓存邮箱（可选，提升 Cursor 侧显示一致性）。 */
  email?: string
  /** 账号绑定的机器码身份（调用方负责生成/回放）。 */
  identity: CursorMachineIdentity
  /** 是否清理上一账号痕迹（默认 true，FlyCursor 一键换号推荐路径）。 */
  resetTraces?: boolean
}

export interface CursorAccountSwitchResult {
  switched: boolean
  /** 切换前 Cursor 是否在运行（true = 本轮执行了终止链）。 */
  killedCursor: boolean
  /** 拉起结果；failed 保留用于旧回执，当前实现会恢复状态并抛错，不返回半成功。 */
  relaunchMode: 'cdp' | 'plain' | 'failed'
  /** CDP 端口是否在时限内就绪（仅 relaunchMode=cdp 时存在；false = 会话创建需再等或手动重启）。 */
  cdpPortReady?: boolean
  machineIdentityApplied: boolean
  /** 逻辑备份目录（旧回执可缺省；当前实现要求完整备份先于第一次写入）。 */
  backupDir?: string
  tokenExpiresAt?: number
  tokenExpired?: boolean
  /** Cursor authenticationService 已在运行时读回目标账号，并完成 storage flush。 */
  runtimeVerified: boolean
}

/**
 * 一键切换 Cursor 账号（逆向 FlyCursor「一键换号」，2026-08-29 本机实证）。
 *
 * 与旧「先写库后重启」路径的本质区别——时序倒转：
 *   ① 确定性杀掉 Cursor（pkill 广播 → pgrep 轮询确认 → pkill -9 兜底）
 *   ② Cursor 死透后独占写 state.vscdb（无锁竞争，同步 API 毫秒级完成，
 *      不再出现「Cursor 运行中抢写锁 → node:sqlite 同步阻塞 → 拾光主进程假死」）
 *   ③ 重置机器码身份（machineid 文件 + storage.serviceMachineId + storage.json 遥测 4 键）
 *   ④ 拉起 Cursor（auto-heal 开启时附带 --remote-debugging-port，保住拾光 CDP 能力）
 *
 * 实证依据：machineid 文件 mtime 与账号 onboardingDate 仅差 4 秒（同一轮换号写入痕迹）；
 * FlyCursor bytecode 含完整 pkill/pgrep/SQL 常量链。
 */
export class CursorAccountSwitcher {
  private inFlight?: Promise<CursorAccountSwitchResult>
  /** Windows：终止前记下正在运行的 Cursor 路径，重新拉起时优先用它（Program Files 安装无 App Paths）。 */
  private windowsRunningExecutable?: string
  private macApplicationPath?: string

  constructor(private readonly options: {
    stateDatabasePath?: string
    storageJsonPath?: string
    machineIdPath?: string
    /** 拉起 Cursor 时附带的 CDP 端口（undefined = 普通拉起）。 */
    cdpPort?: () => number | undefined
    /** 拉起时打开的团队工作区路径（无效路径自动忽略）。 */
    workspacePath?: () => string | undefined
    /** 进程命令注入点（测试替身）；生产执行真实 pkill/pgrep/open。第三个参数只有 Windows 拉起用（原样命令串）。 */
    execFn?: (file: string, args: string[], options?: { windowsVerbatimArguments?: boolean }) => Promise<{ stdout: string }>
    /** 端口探测注入点（测试替身）。 */
    fetchFn?: (url: string) => Promise<{ status: number }>
    /** 拉起后等待 CDP 端口就绪的时限（默认 30s）。 */
    portReadyTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    /** 平台注入点（测试替身）；生产取 node:os。 */
    platform?: () => NodeJS.Platform
    /** Cursor Companion 运行时换号桥；生产必传，测试可省略。 */
    runtimeBridge?: CursorRuntimeAccountBridgePort
    /** 测试注入：生产按正在运行的进程 → 安装登记 → 默认目录发现真实 bundle。 */
    locateRuntimeBundle?: () => Promise<string | undefined>
    /** 网页 Token → IDE session Token 兑换器（测试注入点）。 */
    tokenExchanger?: CursorDesktopTokenExchangePort
    /** 冷热切换互斥锁（热切持锁期间冷切换必须拒绝，防写库竞争/进程误杀）。 */
    switchMutex?: { withLock<T>(name: string, fn: () => Promise<T>): Promise<T> }
    /** Refresh the existing watchdog suppression before stopping a partially launched editor. */
    beforeRecovery?: () => void
  } = {}) {}

  private get platform(): () => NodeJS.Platform {
    return this.options.platform ?? platform
  }

  private get exec(): (file: string, args: string[], options?: { windowsVerbatimArguments?: boolean }) => Promise<{ stdout: string }> {
    return this.options.execFn ?? ((file, args, options) => execFileAsync(file, args, {
      encoding: 'utf8',
      timeout: 5_000,
      // Electron 主进程没有控制台：不加这个，tasklist（退出轮询每 300ms 一次）/ taskkill / cmd 各闪一个黑窗。
      // cmd start 拉起的 Cursor 不受影响——start 给子进程的 STARTUPINFO 不带 SW_HIDE（见 defaultProcessExecFile）。
      windowsHide: true,
      ...options
    }))
  }

  /**
   * Windows 运行路径探测走真实 PowerShell，慢机器上远超 exec 的 5s；超时会被探测吞成 undefined，
   * 随后拉起就退回候选目录、漏掉自定义安装。只给这一条探测更长预算，taskkill / tasklist / start 仍是 5s。
   */
  private get probeExec(): (file: string, args: string[]) => Promise<{ stdout: string }> {
    return this.options.execFn ?? defaultProcessExecFile
  }

  private get sleep(): (ms: number) => Promise<void> {
    return this.options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  private get now(): () => number {
    return this.options.now ?? Date.now
  }

  async switchAccount(
    input: CursorAccountSwitchInput,
    commitSelection?: (result: Readonly<CursorAccountSwitchResult>) => void | Promise<void>
  ): Promise<CursorAccountSwitchResult> {
    const body = () => {
      if (this.inFlight) throw new Error('账号切换正在进行，请等待当前操作完成')
      const operation = this.switchAccountOnce(input, commitSelection)
      this.inFlight = operation
      return operation.finally(() => {
        if (this.inFlight === operation) this.inFlight = undefined
      })
    }
    // 热切持锁期间（等补丁回执）冷切换必须拒：此时杀进程/写库会让热切拿不到回执，
    // 且写库结果会被运行中的 Cursor flush 覆盖。
    return this.options.switchMutex ? this.options.switchMutex.withLock('切换并重启', body) : body()
  }

  private async switchAccountOnce(
    input: CursorAccountSwitchInput,
    commitSelection?: (result: Readonly<CursorAccountSwitchResult>) => void | Promise<void>
  ): Promise<CursorAccountSwitchResult> {
    this.windowsRunningExecutable = undefined
    this.macApplicationPath = undefined
    const rawToken = input.token.trim()
    if (rawToken.length < 8 || rawToken.length > 8_192) throw new Error('Cursor Token 长度无效')
    // 网页登录/浏览器导入链路保存的是 WorkosCursorSessionToken（user_xxx::eyJ...）；
    // state.vscdb 的 cursorAuth/accessToken 实值为裸 JWT，写入前必须归一化。
    const sourceJwt = rawToken.replace(/^user_[A-Za-z0-9]+::/, '')
    if (sourceJwt.split('.').length !== 3) throw new Error('Cursor Token 格式无效：必须是 JWT 三段式')

    const stateDbPath = this.resolveStateDatabasePath()
    if (!existsSync(stateDbPath)) {
      throw new Error(`Cursor 配置文件不存在：${stateDbPath}。请先启动一次 Cursor 客户端。`)
    }

    // Cheap local compatibility checks first, on both platforms: never exchange tickets or exit
    // the editor only to discover that an upgrade removed the required Companion.
    const runtimeBundlePath = await this.preflightRuntimeBundle()

    // 浏览器导入拿到的是 type=web，会让 Cursor 设置页显示已登录/Pro，但 AI 后端拒绝。
    // 在杀进程和改库之前，先按 Cursor 自身 PKCE 流程兑换 type=session；
    // 兑换失败保持 Cursor 与本地数据库原样（零副作用失败）。
    const tokens = await (this.options.tokenExchanger ?? new CursorDesktopTokenExchanger())
      .resolve(rawToken, stateDbPath)
    const token = tokens.accessToken

    // ① 确定性退出：不确认死透不动数据库（旧路径卡死根因）。
    const killedCursor = await this.killCursor()
    let backup: CursorAccountSwitchBackup | undefined
    let writeStarted = false
    try {
      // 主进程死亡 ≠ 孤儿 Helper/utility 进程停止 flush；写库前静置。
      if (killedCursor) await this.sleep(POST_EXIT_SETTLE_MS)

      // 严格备份：任何旧值不可读/备份不完整，都在第一次写入之前中止。
      backup = CursorAccountSwitchBackup.capture({
        database: stateDbPath,
        storage: this.resolveStorageJsonPath(),
        machineId: this.resolveMachineIdPath()
      }, [...AUTH_UPSERT_KEYS, ...TRACE_DELETE_KEYS, ...STALE_DELETE_KEYS, APPLICATION_USER_KEY], this.now(),
      { key: APPLICATION_USER_KEY, fields: APPLICATION_USER_ACCOUNT_TRACE_FIELDS })
      const writeAccountState = (): void => {
        // Mark before the first write: a later file failure must undo the committed SQLite transaction.
        writeStarted = true
        this.applyDatabaseState(stateDbPath, tokens, input)
        this.applyStorageJson(input.identity)
        this.applyMachineIdFile(input.identity.machineGuid)
      }

      // Companion 改写先于账号落库；权限失败时旧账号尚未改动。
      // 成功必须同时具备原生回执和 flush 后读回，不能把离线写库当作运行态证明。
      const userId = decodeJwtSubject(token)
      let relaunchMode: CursorAccountSwitchResult['relaunchMode']
      let runtimeVerified = false
      if (this.options.runtimeBridge) {
        const applied = await this.options.runtimeBridge.applyAfterLaunch({
          accessToken: token,
          refreshToken: tokens.refreshToken,
          email: input.email?.trim() || undefined,
          signUpType: isAuth0Token(token) ? 'Auth_0' : '',
          userId
        }, async () => {
          writeAccountState()
          const mode = await this.launchCursor()
          if (mode === 'failed') throw new Error('Cursor 拉起失败，运行时账号尚未切换')
          return mode
        }, runtimeBundlePath)
        relaunchMode = applied.launchResult
        if (!applied.ack.success) {
          throw new Error(`Cursor 运行时拒绝账号切换：${applied.ack.reason || 'unknown'}`)
        }
        this.verifyDatabaseAccount(stateDbPath, userId, tokens.runtimeType)
        runtimeVerified = true
      } else {
        writeAccountState()
        relaunchMode = await this.launchCursor()
        if (relaunchMode === 'failed') throw new Error('Cursor 拉起失败，运行时账号尚未切换')
      }
      const cdpPortReady = relaunchMode === 'cdp'
        ? await this.waitForCdpPort(this.options.cdpPort?.())
        : undefined

      const expiresAt = decodeJwtExpiry(token)
      const result: CursorAccountSwitchResult = {
        switched: true,
        killedCursor,
        relaunchMode,
        cdpPortReady,
        machineIdentityApplied: true,
        backupDir: backup.directory,
        tokenExpiresAt: expiresAt,
        tokenExpired: expiresAt !== undefined ? expiresAt * 1000 <= this.now() : undefined,
        runtimeVerified
      }
      // Keep the Vault commit inside the same mutex and recovery window as the Cursor state writes.
      await commitSelection?.(result)
      return result
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const recovery = await this.recoverFailedSwitch(backup, writeStarted, killedCursor)
      throw new Error(`${detail}；${recovery}`, { cause: error })
    }
  }

  /** Never infer runtime success from the target token we wrote ourselves; absent/rejected ACK rolls back. */
  private async recoverFailedSwitch(
    backup: CursorAccountSwitchBackup | undefined,
    writeStarted: boolean,
    originallyRunning: boolean
  ): Promise<string> {
    let stopped = false
    try {
      if (writeStarted) {
        if (!backup) throw new Error('没有完整的切换备份，拒绝猜测旧登录态')
        this.options.beforeRecovery?.()
        await this.killCursor()
        await this.sleep(POST_EXIT_SETTLE_MS)
        if (await this.cursorRunning()) throw new Error('Cursor 在恢复窗口内再次启动，已停止写回以避免竞争')
        stopped = true
        backup.restore()
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return `账号状态恢复未完成（${reason}）；${stopped ? '未重新拉起 Cursor' : '未继续写回或拉起 Cursor'}${backup ? `；备份：${backup.directory}` : ''}`
    }
    const state = writeStarted ? '已恢复切换前的登录态与机器码' : '登录态与机器码未改动'
    if (!originallyRunning) return `${state}，Cursor 保持关闭`
    const mode = await this.launchCursor()
    return `${state}；${mode === 'failed' ? 'Cursor 重新打开失败，可从原安装再次打开' : '已按原安装重新打开 Cursor'}`
  }

  // ── 进程生命周期 ────────────────────────────────────────────────

  private cursorProcessName(): string {
    return this.platform() === 'win32' ? 'Cursor.exe' : 'Cursor'
  }

  /**
   * 主进程是否存活（探针见 cursor-process-probe.ts）。探测失败意味着无法证明 Cursor 已死——
   * 必须中止切换，绝不带着不确定的进程状态写 state.vscdb（「Cursor 运行中抢写锁冻结主进程」
   * 卡死根因的回归防线）。
   */
  private async cursorRunning(): Promise<boolean> {
    try {
      return await isCursorMainProcessRunning(this.exec, this.platform())
    } catch (error) {
      throw new Error(`无法确认 Cursor 进程状态，已中止切换：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * FlyCursor 同款终止链：SIGTERM 广播（pkill 命中全部主进程）→ 轮询确认 →
   * SIGKILL 兜底 → 仍存活即失败。返回「此前是否在运行」。
   */
  private async killCursor(): Promise<boolean> {
    const running = await this.cursorRunning()
    if (!running) return false
    const name = this.cursorProcessName()
    if (this.platform() === 'win32') {
      // 有 Companion 的生产链已在退出前从同一份 bundle 推出 exe；不再重复启动 PowerShell。
      this.windowsRunningExecutable ??= await runningCursorWindowsExecutable(this.probeExec)
      await this.exec('taskkill', ['/F', '/IM', name])
    } else {
      await this.exec('pkill', ['-x', name])
    }
    if (!(await this.waitForExit(10_000))) {
      if (this.platform() !== 'win32') await this.exec('pkill', ['-9', '-x', name])
      if (!(await this.waitForExit(3_000))) {
        throw new Error('Cursor 未能在限定时间内退出；请手动关闭 Cursor 后重试')
      }
    }
    return true
  }

  private async preflightRuntimeBundle(): Promise<string | undefined> {
    if (!this.options.runtimeBridge) return undefined
    const bundlePath = await (this.options.locateRuntimeBundle?.()
      ?? locateCursorRuntimeCompanionBundle(this.platform(), this.probeExec))
    if (!bundlePath) {
      throw new Error(`切换前未定位到 Cursor 主程序 bundle（已查找：${cursorWorkbenchBundleCandidates(this.platform()).join('；')}）。Cursor 与本地账号状态均未改动`)
    }
    try {
      const compatibility = readCursorCompatibility(bundlePath)
      if (compatibility.state !== 'supported') throw new Error(compatibility.detail)
      new CursorRuntimeCompanionConfig(bundlePath).validate()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`切换前检查 Cursor 主程序 bundle 失败（${bundlePath}）：${detail}。Cursor 与本地账号状态均未改动`)
    }
    // bundle 与重新拉起的 exe 必须来自同一安装；自定义盘符/目录同样一键完成。
    if (this.platform() === 'win32') this.windowsRunningExecutable = cursorExecutableFromRuntimeBundle(bundlePath)
    if (this.platform() === 'darwin') {
      this.macApplicationPath = macBundlePathFromAppRoot(appRootOfBundle(bundlePath))
      if (!this.macApplicationPath) throw new Error('检查通过的 Cursor bundle 不属于有效的 macOS 应用；未退出或改写账号')
    }
    return bundlePath
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      if (!(await this.cursorRunning())) return true
      await this.sleep(300)
    }
    return !(await this.cursorRunning())
  }

  /** 拉起 Cursor；CDP 端口可用时附带调试参数，保住拾光会话创建能力。 */
  private async launchCursor(): Promise<'cdp' | 'plain' | 'failed'> {
    try {
      if (this.platform() === 'darwin') {
        const port = this.options.cdpPort?.()
        const workspace = this.validWorkspacePath(this.options.workspacePath?.())
        const args = ['-a', this.macApplicationPath ?? 'Cursor']
        if (workspace) args.push(workspace)
        if (port) {
          args.push(
            '--args',
            `--remote-debugging-port=${port}`,
            '--disable-features=LocalNetworkAccessChecks'
          )
        }
        // macOS LaunchServices 在应用刚退出时可能短暂返回 -609；按固定上限重试，
        // 避免“数据库已切换但 Cursor 没重新打开”的半成功状态。
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await this.exec('open', args)
            return port ? 'cdp' : 'plain'
          } catch {
            if (attempt === 4) return 'failed'
            await this.sleep(800)
          }
        }
        return 'failed'
      }
      if (this.platform() === 'win32') {
        const port = this.options.cdpPort?.()
        const workspace = this.validWorkspacePath(this.options.workspacePath?.())
        // cmd start 立即返回（不等待 GUI 进程），经 this.exec 走注入链可测试；
        // 与 mac 侧对齐：CDP 端口可用时附带调试参数，保住切换后的会话创建能力。
        // 命令串必须原样（windowsVerbatimArguments）交给 cmd，否则引号被 Node 转义、start 找不到程序。
        const command = cursorWindowsStartCommand({
          executable: resolveCursorWindowsExecutable({ runningPath: this.windowsRunningExecutable }),
          workspacePath: workspace,
          cdpPort: port
        })
        await this.exec(command.file, command.args, command.options)
        return port ? 'cdp' : 'plain'
      }
      return 'failed'
    } catch {
      // 拉起失败不影响已写入的登录态，用户可手动启动。
      return 'failed'
    }
  }

  /**
   * 拉起后轮询 CDP 端口就绪（/json/version 2xx）。超时不视为切换失败——登录态已
   * 写入；调用方（含 auto-heal 看门，配合抑制窗口）决定是否需要进一步动作。
   */
  private async waitForCdpPort(port: number | undefined): Promise<boolean> {
    if (!port) return false
    const fetchFn = this.options.fetchFn ?? defaultFetchWithTimeout
    const timeoutMs = this.options.portReadyTimeoutMs ?? 30_000
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      try {
        const response = await fetchFn(`http://127.0.0.1:${port}/json/version`)
        if (response.status >= 200 && response.status < 300) return true
      } catch {
        // 端口尚未就绪，继续等待
      }
      await this.sleep(500)
    }
    try {
      const response = await fetchFn(`http://127.0.0.1:${port}/json/version`)
      return response.status >= 200 && response.status < 300
    } catch {
      return false
    }
  }

  private validWorkspacePath(input: string | undefined): string | undefined {
    const path = input?.trim()
    if (!path) return undefined
    try {
      return existsSync(path) && statSync(path).isDirectory() ? path : undefined
    } catch {
      return undefined
    }
  }

  // ── 路径解析 ────────────────────────────────────────────────────

  private resolveCursorBaseDir(): string {
    return cursorUserDataRoot(this.platform())
  }

  private resolveStateDatabasePath(): string {
    return this.options.stateDatabasePath
      ?? join(this.resolveCursorBaseDir(), 'User', 'globalStorage', 'state.vscdb')
  }

  private resolveStorageJsonPath(): string {
    return this.options.storageJsonPath
      ?? join(dirname(this.resolveStateDatabasePath()), 'storage.json')
  }

  private resolveMachineIdPath(): string {
    return this.options.machineIdPath ?? join(this.resolveCursorBaseDir(), 'machineid')
  }

  // ── 备份与写入 ──────────────────────────────────────────────────

  /** 认证 + 机器码 + 痕迹清理，单事务原子落库（Cursor 已死，独占无竞争）。 */
  private applyDatabaseState(
    stateDbPath: string,
    tokens: { accessToken: string; refreshToken: string },
    input: CursorAccountSwitchInput
  ): void {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(stateDbPath, { timeout: 5_000 })
      db.exec('BEGIN IMMEDIATE')
      try {
        const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
        const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?')

        upsert.run('cursorAuth/accessToken', tokens.accessToken)
        upsert.run('cursorAuth/refreshToken', tokens.refreshToken)
        // 与当前 Cursor authenticationService 一致：未知值写空串，不保留上一账号。
        const email = input.email?.trim()
        if (email) upsert.run('cursorAuth/cachedEmail', email)
        else upsert.run('cursorAuth/cachedEmail', '')
        if (isAuth0Token(tokens.accessToken)) upsert.run('cursorAuth/cachedSignUpType', 'Auth_0')
        else upsert.run('cursorAuth/cachedSignUpType', '')
        const userId = decodeJwtSubject(tokens.accessToken)
        upsert.run('cursorAuth/userId', userId)
        upsert.run('cursorAuth/cachedUserId', userId)
        upsert.run('cursorAuth/authId', userId)
        upsert.run('storage.serviceMachineId', input.identity.machineGuid)

        // 陈旧运行时缓存/服务端下发值：删除后由 Cursor 按新登录态重建
        // （实证：cursor.accessToken 与当前 JWT sub 不一致时登录仍正常）。
        for (const key of STALE_DELETE_KEYS) remove.run(key)
        if (input.resetTraces !== false) {
          for (const key of TRACE_DELETE_KEYS) remove.run(key)
          this.stripApplicationUserAccountTraces(db)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } finally {
      try {
        db?.close()
      } catch {
        // ignore
      }
    }
  }

  /**
   * applicationUser 外科手术式清痕（同一事务内）：只删账号身份字段、保留设备级
   * 偏好（工具放行/对话框决策/编辑器偏好）。键缺失＝上一轮已清或全新安装，跳过；
   * 值损坏/非对象＝无法安全摘除，回退为整键删除（旧行为，宁失偏好不留脏数据）。
   */
  private stripApplicationUserAccountTraces(db: DatabaseSync): void {
    const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?')
    let row: { value?: unknown } | undefined
    try {
      row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(APPLICATION_USER_KEY) as { value?: unknown } | undefined
    } catch {
      return
    }
    if (row?.value === undefined || row?.value === null) return
    const text = typeof row.value === 'string'
      ? row.value
      : row.value instanceof Uint8Array
        ? Buffer.from(row.value).toString('utf8')
        : ''
    // 空串/非文本值与损坏 JSON 同处置：无法安全摘除即整键删除（旧行为），
    // 不给未知形态的账号痕迹留静默存活的缝。
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      remove.run(APPLICATION_USER_KEY)
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      remove.run(APPLICATION_USER_KEY)
      return
    }
    const root = parsed as Record<string, unknown>
    let changed = false
    for (const field of APPLICATION_USER_ACCOUNT_TRACE_FIELDS) {
      if (field in root) {
        delete root[field]
        changed = true
      }
    }
    if (!changed) return
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
      .run(APPLICATION_USER_KEY, JSON.stringify(root))
  }

  /** storage.json 遥测 4 键重写（原子替换；文件缺失则创建最小骨架）。 */
  private applyStorageJson(identity: CursorMachineIdentity): void {
    const path = this.resolveStorageJsonPath()
    let current: Record<string, unknown> = {}
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        // 仅接受普通对象：数组/标量等异常内容交回 Cursor 自行重建，不覆盖。
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
        current = parsed as Record<string, unknown>
      } catch {
        // 主文件损坏时不覆盖，交给 Cursor 自行重建。
        return
      }
    }
    current['telemetry.machineId'] = identity.machineId
    current['telemetry.macMachineId'] = identity.macMachineId
    current['telemetry.devDeviceId'] = identity.devDeviceId
    current['telemetry.sqmId'] = identity.sqmId
    writeStoreFileSync(path, JSON.stringify(current, null, 2))
  }

  /** machineid 文件与 state.vscdb 的 storage.serviceMachineId 恒同值（实证）。 */
  private applyMachineIdFile(machineGuid: string): void {
    writeStoreFileSync(this.resolveMachineIdPath(), machineGuid)
  }

  /** Companion flush 后再次从 Cursor 主库验证目标账号，杜绝“按钮报成功但仍是旧号”。 */
  private verifyDatabaseAccount(stateDbPath: string, expectedUserId: string, expectedTokenType: string): void {
    const db = new DatabaseSync(stateDbPath, { readOnly: true, timeout: 2_000 })
    try {
      const rows = db.prepare(
        "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken', 'cursorAuth/refreshToken')"
      ).all() as { key: string; value: unknown }[]
      const actual = new Map(rows.map((row) => [row.key, typeof row.value === 'string' ? row.value : '']))
      const access = actual.get('cursorAuth/accessToken') ?? ''
      const refresh = actual.get('cursorAuth/refreshToken') ?? ''
      if (decodeJwtSubject(access) !== expectedUserId
        || decodeJwtSubject(refresh) !== expectedUserId
        || (expectedTokenType === 'session' && (decodeJwtType(access) !== 'session' || decodeJwtType(refresh) !== 'session'))) {
        throw new Error('Cursor 运行时回执后账号落库校验不一致')
      }
    } finally {
      db.close()
    }
  }
}

/** 认证写入键（FlyCursor 实证集；不含 cursor.accessToken——Cursor 自行维护该运行时缓存）。 */
const AUTH_UPSERT_KEYS = [
  'cursorAuth/accessToken',
  'cursorAuth/refreshToken',
  'cursorAuth/cachedEmail',
  'cursorAuth/cachedSignUpType',
  'cursorAuth/userId',
  'cursorAuth/cachedUserId',
  'cursorAuth/authId',
  'storage.serviceMachineId'
] as const

/** 上一账号痕迹（FlyCursor isResetCursor 清理集，Cursor 登录后按服务端真相重建）。 */
const TRACE_DELETE_KEYS = [
  'aiCodeTrackingLines',
  'aiCodeTrackingStartTime',
  'aiSettings',
  'cursorai/serverConfig',
  'cursorupdate.lastUpdatedAndShown.version',
  'isUsagePricingEnabled',
  // 3.21.12 keeps account-dependent model catalogs outside applicationUser when the gate is on.
  'cursor.modelCatalog.v1',
  'cursor.modelCatalog.privateInference.v1',
  'lastUpgradeToProNotificationTime',
  'releaseNotes/lastVersion'
] as const

/**
 * applicationUser（reactiveStorage 持久层）里的账号身份字段：服务端在登录后重推，
 * 删除即可切断账号关联。其余字段是设备级本机偏好（服务端不会重建）——尤其
 * composerState 装着全部工具放行偏好（yoloEnableRunEverything / mcpAllowedTools /
 * modes4[].autoRun），整键删除会让每次切换回到工厂默认，自动化管道的每个 MCP
 * 调用都弹人工审批，无人值守即死锁（2026-09-01 P0 实证）。
 */
const APPLICATION_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
const APPLICATION_USER_ACCOUNT_TRACE_FIELDS = [
  'dashboardUserId',
  'membershipType',
  'subscriptionStatus',
  'hasAutoSpillover',
  'hasTieredSelfServeTeamSpillover',
  'hasTokenBasedPricing',
  'isEnterprise',
  'eligibleForSnippetLearning',
  'authenticationSettings',
  'teamAdminSettings',
  'teamBlockRepos',
  'teamBlocklist',
  'newUserData',
  'aiSettings',
  'availableDefaultModels2',
  'featureModelConfigs'
] as const

/** 陈旧缓存键：随账号切换必须删除（写错格式比留旧值更糟）。 */
const STALE_DELETE_KEYS = [
  'cursor.accessToken',
  'cursor.email',
  'cursorAuth/isAuthenticated',
  'cursorAuth/isAuthorized',
  'cursorAuth/isLoggedIn',
  'cursorAuth/stripeSubscriptionStatus',
  'cursorAuth/stripeMembershipType',
  'cursorAuth/onboardingDate'
] as const

/** 端口探测默认实现：带 AbortController 超时，端口无响应时快速失败而非挂起。 */
async function defaultFetchWithTimeout(url: string): Promise<{ status: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { status: response.status }
  } finally {
    clearTimeout(timer)
  }
}

/** JWT sub 以 auth0| 开头时，cachedSignUpType 固定为 Auth_0（本机实证值）。 */
function isAuth0Token(token: string): boolean {
  return decodeJwtSubject(token).startsWith('auth0|')
}

function decodeJwtSubject(token: string): string {
  try {
    const payload = token.split('.')[1]
    if (!payload) throw new Error('missing_payload')
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as { sub?: unknown }
    if (typeof parsed.sub !== 'string' || !parsed.sub.trim()) throw new Error('missing_sub')
    return parsed.sub.trim()
  } catch {
    throw new Error('Cursor Token 缺少有效账号标识')
  }
}

/** 解码 JWT exp（秒级时间戳）；无法解析返回 undefined。 */
function decodeJwtExpiry(token: string): number | undefined {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as { exp?: unknown }
    return typeof parsed.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp : undefined
  } catch {
    return undefined
  }
}

function decodeJwtType(token: string): string | undefined {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { type?: unknown }
    return typeof parsed.type === 'string' ? parsed.type : undefined
  } catch {
    return undefined
  }
}
