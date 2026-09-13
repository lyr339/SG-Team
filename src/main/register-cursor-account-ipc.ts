import { ipcMain, type BrowserWindow } from 'electron'
import type { CursorAccountVault } from '../application/cursor-account-vault'
import { switchCursorAccountWithVault } from '../application/cursor-account-switch'
import { verifyCursorRuntimeAccountMatch } from '../application/cursor-runtime-account-verify'
import { resolveCursorMembership } from '../application/cursor-membership-resolver'
import { fetchCursorAccountMemberships } from '../application/cursor-account-memberships'
import { CursorTokenImporter } from '../infrastructure/cursor/cursor-token-importer'
import { CursorMembershipFetcher } from '../infrastructure/cursor/cursor-membership-profile'
import { CursorAccountSwitcher } from '../infrastructure/cursor/cursor-account-switcher'
import { CursorRuntimeAccountBridge, CURSOR_RUNTIME_SWITCH_KEY, CURSOR_RUNTIME_SWITCH_PORT } from '../infrastructure/cursor/cursor-runtime-account-bridge'
import { CursorDesktopTokenExchanger } from '../infrastructure/cursor/cursor-desktop-token-exchanger'
import { CursorBrowserTokenReader } from '../infrastructure/cursor/cursor-browser-token-reader'
import type { CursorAccountProfile } from '../infrastructure/cursor/cursor-account-profile'
import { CursorAccountProfileFetcher, profileLabel } from '../infrastructure/cursor/cursor-account-profile'
import type { CursorLiveSwitcher } from '../infrastructure/cursor/cursor-live-switch'
import type { CursorSwitchPumpInstaller } from '../infrastructure/cursor/cursor-switch-pump-installer'
import type { CursorSwitchMutex } from '../infrastructure/cursor/cursor-switch-mutex'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function accountIdOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Cursor 账号 ID 无效')
  return value.trim()
}

function accountIdsOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) throw new Error('Cursor 账号 ID 列表无效')
  return [...new Set(value.map(accountIdOf))]
}

export interface CursorAccountIpcOptions {
  /** 拉起 Cursor 时附带的 CDP 端口（未启用 CDP 时返回 undefined）。 */
  cdpPort?: () => number | undefined
  /** 拉起时打开的团队工作区路径。 */
  workspacePath?: () => string | undefined
  /** 切换开始前抑制 CDP auto-heal 看门（启动窗口内端口未就绪是预期状态）。 */
  suppressCdpAutoHeal?: () => void
  /**
   * 从指纹浏览器 profile 读取当前登录态 Token（第一步「获取 Token」的指纹导入来源）。
   * 返回 token（user_xxx::jwt）与可选 userId + 官网资料（email 等，识别失败缺省）；
   * 读毕关窗（cookie 留 profile）。profileId 为实际读取的窗口——保存时写入账号绑定
   * （导入即绑定：之后该账号的自动化链固定在此窗口执行，与全局默认窗口解耦）。
   */
  importFromFingerprint?: () => Promise<{
    token: string
    userId?: string
    browserName?: string
    profile?: CursorAccountProfile
    profileId?: string
  }>
  /**
   * 官网资料识别器（系统浏览器导入用：token → email/name）。
   * 缺省时内部自建；main 装配层统一实例传入（与指纹导入共用同一配置）。
   */
  profileFetcher?: Pick<CursorAccountProfileFetcher, 'fetch'>
  /**
   * 打开选定的指纹浏览器窗口并导航到 cursor.com（用户提前登录入口）。
   * 窗口不自动关；未选窗口/指纹浏览器不可达时抛带引导信息的错误。
   */
  openFingerprintLogin?: () => Promise<void>
  cleanupFingerprintEnvironment?: () => Promise<void>
  /** 当前指纹 profile 的模型数据政策确认；返回导航后的最新 token。 */
  acknowledgeModelDataPolicies?: () => Promise<{
    token: string
    changed: boolean
    policies: Array<{ kind: 'already_acknowledged' | 'acknowledged'; modelId: string; consentVersion: string }>
  }>
  /** 无感换号核心（热切手动入口）；缺省时热切 IPC 报未装配。 */
  liveSwitcher?: Pick<CursorLiveSwitcher, 'switchLive'>
  /** 切号补丁安装器（维护页状态卡/一键安装）。 */
  switchPumpInstaller?: Pick<CursorSwitchPumpInstaller, 'status' | 'ensure' | 'remove'>
  /** 冷热切换互斥锁：注入冷切换器，热切持锁期间冷切换拒绝。 */
  switchMutex?: CursorSwitchMutex
}

export function registerCursorAccountIpc(
  vault: CursorAccountVault,
  getWindow: () => BrowserWindow | undefined,
  options: CursorAccountIpcOptions = {}
): () => void {
  const importer = new CursorTokenImporter()
  const membershipFetcher = new CursorMembershipFetcher()
  // 资料识别器：main 统一实例注入（与指纹导入共用）；未注入时自建（测试便利）
  const profileFetcher = options.profileFetcher ?? new CursorAccountProfileFetcher()
  const switcher = new CursorAccountSwitcher({
    cdpPort: options.cdpPort,
    workspacePath: options.workspacePath,
    runtimeBridge: new CursorRuntimeAccountBridge(),
    tokenExchanger: new CursorDesktopTokenExchanger(),
    ...(options.switchMutex ? { switchMutex: options.switchMutex } : {})
  })
  const browserReader = new CursorBrowserTokenReader()

  ipcMain.handle(IPC.cursorAccountsList, (event) => {
    assertTrustedSender(event, getWindow)
    return vault.list()
  })
  ipcMain.handle(IPC.cursorAccountsSave, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!value || typeof value !== 'object') throw new Error('Cursor 账号参数无效')
    const input = value as Record<string, unknown>
    if (typeof input.label !== 'string' || typeof input.token !== 'string') throw new Error('Cursor 账号参数无效')
    return vault.save({
      label: input.label,
      token: input.token,
      makeActive: typeof input.makeActive === 'boolean' ? input.makeActive : undefined
    })
  })
  ipcMain.handle(IPC.cursorAccountsSelect, (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    return vault.select(accountIdOf(accountId))
  })
  ipcMain.handle(IPC.cursorAccountsRemove, (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    return vault.remove(accountIdOf(accountId))
  })
  ipcMain.handle(IPC.cursorAccountsImportFromLocal, (event) => {
    assertTrustedSender(event, getWindow)
    const imported = importer.import()
    const label = imported.email
      ? `${imported.email}（本机 Cursor）`
      : imported.sub
        ? `${imported.sub}（本机 Cursor）`
        : '本机 Cursor'
    return vault.save({ label, token: imported.token, makeActive: true })
  })
  ipcMain.handle(IPC.cursorAccountsImportFromBrowser, async (event) => {
    assertTrustedSender(event, getWindow)
    const result = browserReader.read()
    // 同一识别链路：官网 /api/auth/me 把 user_xxx 换成可读邮箱（失败回落 userId）
    const profile = await profileFetcher.fetch(result.token)
    return vault.save({
      label: profileLabel(profile, result.userId, result.browser),
      token: result.token,
      makeActive: true
    })
  })
  ipcMain.handle(IPC.cursorAccountsImportFromFingerprint, async (event) => {
    assertTrustedSender(event, getWindow)
    if (!options.importFromFingerprint) throw new Error('指纹浏览器通道未装配')
    const result = await options.importFromFingerprint()
    const userId = result.userId || result.token.split('::')[0] || 'cursor'
    // 资料识别成功时 label 显示邮箱（官网 /api/auth/me）；失败回落 user_xxx。
    // 导入即绑定：从哪个窗口读出 Token，就把该账号绑定到哪个窗口。
    return vault.save({
      label: profileLabel(result.profile, userId, result.browserName ?? '指纹浏览器'),
      token: result.token,
      makeActive: true,
      fingerprintProfileId: result.profileId
    })
  })
  ipcMain.handle(IPC.cursorAccountsSetFingerprintProfile, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const profileId = typeof input.profileId === 'string' && input.profileId.trim() ? input.profileId.trim() : undefined
    return vault.setFingerprintProfile(accountIdOf(input.accountId), profileId)
  })
  ipcMain.handle(IPC.cursorAccountsOpenFingerprintLogin, async (event) => {
    assertTrustedSender(event, getWindow)
    if (!options.openFingerprintLogin) throw new Error('指纹浏览器通道未装配')
    await options.openFingerprintLogin()
  })
  ipcMain.handle(IPC.cursorAccountsCleanupFingerprintEnvironment, async (event) => {
    assertTrustedSender(event, getWindow)
    if (!options.cleanupFingerprintEnvironment) throw new Error('指纹浏览器通道未装配')
    await options.cleanupFingerprintEnvironment()
  })
  ipcMain.handle(IPC.cursorAccountsAcknowledgeModelDataPolicies, async (event) => {
    assertTrustedSender(event, getWindow)
    if (!options.acknowledgeModelDataPolicies) throw new Error('指纹浏览器政策确认通道未装配')
    const result = await options.acknowledgeModelDataPolicies()
    const tokenAccountId = result.token.split('::', 1)[0]?.trim()
    let tokenUpdated = false
    const active = vault.list().find((account) => account.active)
    if (active && tokenAccountId) {
      const previous = vault.credential(active.id)
      const previousAccountId = previous.split('::', 1)[0]?.trim()
      // 仅同账号原地更新：profile 选错账号时绝不覆盖拾光活跃凭据。
      if (previousAccountId === tokenAccountId && previous !== result.token) {
        vault.replaceToken(active.id, result.token)
        tokenUpdated = true
      }
    }
    const modelIds = result.policies.map((policy) => policy.modelId)
    return {
      changed: result.changed,
      tokenUpdated,
      modelIds,
      message: result.changed
        ? `已确认 ${modelIds.join('、')} 的数据政策`
        : `${modelIds.join('、')} 的数据政策已确认，无需重复提交`
    }
  })
  ipcMain.handle(IPC.cursorAccountsRestartWith, async (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    // 一键切换：杀 Cursor → 写登录态 + 重置机器码 → 带端口拉起（FlyCursor 时序）；
    // 成功后才同步 vault 活跃账号（失败时 Cursor 仍运行原账号，active 不能变）。
    // 重启断开全部拾光通道，UI 已在调用前完成用户确认。
    return switchCursorAccountWithVault(
      { vault, switcher, suppressCdpAutoHeal: options.suppressCdpAutoHeal },
      accountIdOf(accountId)
    )
  })
  ipcMain.handle(IPC.cursorAccountsSwitchLive, async (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    // 无感换号（热切）：不杀进程、不写库、不动机器码；结果不 throw——
    // {switched:false, reason} 由 UI 原样亮出（热切降级语义，与自动化链同款）。
    if (!options.liveSwitcher) throw new Error('无感换号未装配')
    return options.liveSwitcher.switchLive({ accountId: accountIdOf(accountId) })
  })
  ipcMain.handle(IPC.cursorSwitchPumpStatus, (event) => {
    assertTrustedSender(event, getWindow)
    if (!options.switchPumpInstaller) throw new Error('切号补丁管理未装配')
    return options.switchPumpInstaller.status()
  })
  ipcMain.handle(IPC.cursorSwitchPumpEnsure, async (event) => {
    assertTrustedSender(event, getWindow)
    if (!options.switchPumpInstaller) throw new Error('切号补丁管理未装配')
    // 端口/密钥无所谓固定：热切按盘上配置绑定，冷切换每次重写；用既有常量即可。
    const install = () => options.switchPumpInstaller!.ensure({
      port: CURSOR_RUNTIME_SWITCH_PORT,
      key: CURSOR_RUNTIME_SWITCH_KEY
    })
    return options.switchMutex ? options.switchMutex.withLock('安装切号补丁', install) : install()
  })
  ipcMain.handle(IPC.cursorSwitchPumpRemove, async (event) => {
    assertTrustedSender(event, getWindow)
    if (!options.switchPumpInstaller) throw new Error('切号补丁管理未装配')
    const remove = () => options.switchPumpInstaller!.remove()
    return options.switchMutex ? options.switchMutex.withLock('卸载切号补丁', remove) : remove()
  })
  ipcMain.handle(IPC.cursorAccountsVerifyRuntime, (event) => {
    assertTrustedSender(event, getWindow)
    // 运行态 vs 活跃账号一致性核对（JWT sub 比对）。vault 解密失败按 credential
    // 语义上抛（IPC reject），调用方显示错误——不给假绿灯。
    return verifyCursorRuntimeAccountMatch({
      readRuntime: () => importer.import(),
      readActiveAccount: () => {
        const active = vault.list().find((account) => account.active)
        if (!active) return undefined
        return { token: vault.credential(active.id), label: active.label }
      }
    })
  })
  ipcMain.handle(IPC.cursorAccountsRefreshMembership, async (event) => {
    assertTrustedSender(event, getWindow)
    // 在线档位抓取：运行时 token 只在主进程内流转；无登录态返回 not_logged_in
    // （不 throw——状态语义由调用方闸门消费，IPC 层不引入第二套错误通道）。
    let token: string
    try {
      token = importer.import().token
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason ?? '')
      return { state: 'not_logged_in', detail: detail.replace(/\s+/g, ' ').trim().slice(0, 120) }
    }
    let activeToken: string | undefined
    try {
      const active = vault.list().find((account) => account.active)
      activeToken = active ? vault.credential(active.id) : undefined
    } catch {
      // 活跃凭据不可读时仍以 Cursor 运行态给出权威结果。
    }
    return resolveCursorMembership({
      runtimeToken: token,
      activeToken,
      fetch: (candidate) => membershipFetcher.fetch(candidate)
    })
  })
  ipcMain.handle(IPC.cursorAccountsRefreshMemberships, async (event, rawAccountIds: unknown) => {
    assertTrustedSender(event, getWindow)
    const requested = accountIdsOf(rawAccountIds)
    return fetchCursorAccountMemberships(vault, (token) => membershipFetcher.fetch(token), requested)
  })
  return () => {
    ipcMain.removeHandler(IPC.cursorAccountsList)
    ipcMain.removeHandler(IPC.cursorAccountsSave)
    ipcMain.removeHandler(IPC.cursorAccountsSelect)
    ipcMain.removeHandler(IPC.cursorAccountsRemove)
    ipcMain.removeHandler(IPC.cursorAccountsImportFromLocal)
    ipcMain.removeHandler(IPC.cursorAccountsImportFromBrowser)
    ipcMain.removeHandler(IPC.cursorAccountsImportFromFingerprint)
    ipcMain.removeHandler(IPC.cursorAccountsSetFingerprintProfile)
    ipcMain.removeHandler(IPC.cursorAccountsOpenFingerprintLogin)
    ipcMain.removeHandler(IPC.cursorAccountsCleanupFingerprintEnvironment)
    ipcMain.removeHandler(IPC.cursorAccountsAcknowledgeModelDataPolicies)
    ipcMain.removeHandler(IPC.cursorAccountsRestartWith)
    ipcMain.removeHandler(IPC.cursorAccountsSwitchLive)
    ipcMain.removeHandler(IPC.cursorSwitchPumpStatus)
    ipcMain.removeHandler(IPC.cursorSwitchPumpEnsure)
    ipcMain.removeHandler(IPC.cursorSwitchPumpRemove)
    ipcMain.removeHandler(IPC.cursorAccountsVerifyRuntime)
    ipcMain.removeHandler(IPC.cursorAccountsRefreshMembership)
    ipcMain.removeHandler(IPC.cursorAccountsRefreshMemberships)
  }
}
