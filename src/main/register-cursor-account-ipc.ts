import { ipcMain, type BrowserWindow } from 'electron'
import type { CursorAccountVault } from '../application/cursor-account-vault'
import { switchCursorAccountWithVault } from '../application/cursor-account-switch'
import { verifyCursorRuntimeAccountMatch } from '../application/cursor-runtime-account-verify'
import { resolveCursorMembership } from '../application/cursor-membership-resolver'
import { fetchCursorAccountMemberships } from '../application/cursor-account-memberships'
import { CursorTokenImporter } from '../infrastructure/cursor/cursor-token-importer'
import { parseCursorAccountCard } from '../domain/cursor-account-card'
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
import type { CursorProUpgradeResult } from '../domain/cursor-checkout-profile'
import { assertTrustedSender } from './ipc-security'
import { randomUUID } from 'node:crypto'
import type { NotificationService } from '../application/notification-service'
import type { NotificationReference } from '../domain/notification-reference'
import { accountSwitchNotification } from '../domain/account-switch-notification'
import { beginPageOperation, failPageOperation, finishPageOperation, notificationOperationId, type PageOperationObserver } from '../application/notifications/page-operation-notifications'

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
  /** Optional presentation-only observer; it does not control restart, recovery or the switch lock. */
  restartObservation?: { begin: () => string | undefined; finish: (id: string | undefined, success: boolean) => void }
  notifications?: Pick<NotificationService, 'offerCurrent'>
  operations?: PageOperationObserver
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
  /**
   * 凭据自动登录（卡号导入账号）：在指纹窗口内走官网邮箱+密码登录链。
   * profileId 缺省时按「活跃账号绑定 ?? 默认窗口」解析；失败抛带引导的错误。
   */
  loginWithCredentials?: (input: { email: string; password: string }, profileId?: string) => Promise<{
    token: string
    outcome: 'already_logged_in' | 'logged_in'
  }>
  /**
   * 升级 Pro 扫码付款：直达 Stripe 月付结账（USD · 支付宝），填写复核后提交，
   * 窗口保留供用户扫码。编排（vault 归属核对/凭据自愈 + 设置里的账单资料）
   * 在装配层闭包完成；缺省时 IPC 报未装配。
   */
  startProUpgrade?: (accountId: string) => Promise<CursorProUpgradeResult>
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
    beforeRecovery: options.suppressCdpAutoHeal,
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
    const operation = beginPageOperation(options.operations, { kind: 'import-token', id: notificationOperationId(input) })
    try {
      const result = vault.save({ label: input.label, token: input.token, makeActive: typeof input.makeActive === 'boolean' ? input.makeActive : undefined })
      finishPageOperation(operation, { state: 'success', facts: ['账号已保存，当前 Cursor 运行登录态未据此改变。'] }); return result
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsSaveCard, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!value || typeof value !== 'object') throw new Error('卡号参数无效')
    const input = value as Record<string, unknown>
    if (typeof input.card !== 'string' || !input.card.trim() || input.card.length > 16_384) throw new Error('卡号参数无效')
    // 主进程权威解析（渲染层的粘贴预览只是预览）；字段错误原样上抛给表单亮出。
    const card = parseCursorAccountCard(input.card)
    const operation = beginPageOperation(options.operations, { kind: 'import-card', id: notificationOperationId(input) })
    try {
      let result = vault.saveCard({
        card,
        sub: card.sub,
        makeActive: typeof input.makeActive === 'boolean' ? input.makeActive : undefined
      })
      // Token 已过期且装配了自动登录：用卡内凭据当场刷新（失败不阻断保存——
      // 凭据已入库，结果带 loginError，账号卡片可稍后重试）。
      if (card.expiresAt !== undefined && card.expiresAt <= Date.now() && options.loginWithCredentials) {
        try {
          const login = await options.loginWithCredentials({ email: card.email, password: card.cursorPassword }, undefined)
          result = { ...result, accounts: vault.replaceToken(result.accountId, login.token), tokenRefreshed: true }
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : String(reason)
          result = { ...result, loginError: detail.replace(/\s+/g, ' ').trim().slice(0, 200) }
        }
      }
      const notification = finishPageOperation(operation, { state: result.loginError ? 'partial' : 'success', scope: { accountId: result.accountId }, facts: result.loginError
        ? ['账号和凭据已保存，但原入口未确认自动登录完成。可在账号卡片核对，通知不会再次登录。']
        : [result.tokenRefreshed ? '账号已保存，原自动登录已返回并更新保存的 Token。' : '账号已保存。导入不等于当前 Cursor 已切换或会员档位已确认。'] })
      return notification ? { ...result, notification } : result
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsLogin, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!options.loginWithCredentials) throw new Error('指纹浏览器自动登录未装配')
    const payload = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
    const id = accountIdOf(payload ? payload.accountId : value)
    const credentials = vault.credentials(id)
    if (!credentials) throw new Error('该账号没有保存的登录凭据（仅卡号导入的账号支持自动登录）')
    // 窗口锚定账号绑定（导入时记录）；未绑定回退默认窗口（通道内解析）。
    const account = vault.list().find((candidate) => candidate.id === id)
    const operation = beginPageOperation(options.operations, { kind: 'account-login', id: notificationOperationId(payload), scope: { accountId: id } })
    try {
      const login = await options.loginWithCredentials(
        { email: credentials.email, password: credentials.cursorPassword },
        account?.fingerprintProfileId
      )
      const result = { accounts: vault.replaceToken(id, login.token), outcome: login.outcome }
      const notification = finishPageOperation(operation, { state: 'success', facts: [login.outcome === 'already_logged_in' ? '原绑定窗口已登录，保存的账号 Token 已更新。' : '原网页登录已完成，保存的账号 Token 已更新。', '未据此改变 Cursor 当前运行登录态。'] })
      return notification ? { ...result, notification } : result
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsStartProUpgrade, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!options.startProUpgrade) throw new Error('升级 Pro 结账通道未装配')
    // 编排（归属守门/凭据/账单资料/窗口解析）在装配闭包内；这里只做入参校验。
    const payload = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
    const id = accountIdOf(payload ? payload.accountId : value)
    const operation = beginPageOperation(options.operations, { kind: 'checkout', id: notificationOperationId(payload), scope: { accountId: id } })
    try {
      const result = await options.startProUpgrade(id)
      const notification = finishPageOperation(operation, { state: result.outcome === 'verified' ? 'success' : 'waiting', verifiedOnly: result.outcome === 'verified', facts: result.outcome === 'verified'
        ? ['账单资料由原入口复核，按原测试闸门停在提交前。没有生成付款二维码，也没有据此确认支付成功或账号档位。'] : ['原结账入口已准备，仍需由你在原窗口完成付款。未确认支付成功，通知不会代付款或再次提交。'] })
      return notification ? { ...result, notification } : result
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsSelect, (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    return vault.select(accountIdOf(accountId))
  })
  ipcMain.handle(IPC.cursorAccountsRemove, (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    return vault.remove(accountIdOf(accountId))
  })
  ipcMain.handle(IPC.cursorAccountsImportFromLocal, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const operation = beginPageOperation(options.operations, { kind: 'import-local', id: notificationOperationId(input) })
    try {
      const imported = importer.import()
      const label = imported.email
        ? `${imported.email}（本机 Cursor）`
        : imported.sub
          ? `${imported.sub}（本机 Cursor）`
          : '本机 Cursor'
      const result = vault.save({ label, token: imported.token, makeActive: true })
      finishPageOperation(operation, { state: 'success', scope: { accountId: result.find(account => account.active)?.id }, facts: ['本机 Cursor 的可读取登录态已保存；未据此确认远端档位。'] }); return result
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsImportFromBrowser, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const operation = beginPageOperation(options.operations, { kind: 'import-browser', id: notificationOperationId(input) })
    try {
      const result = browserReader.read()
      // 同一识别链路：官网 /api/auth/me 把 user_xxx 换成可读邮箱（失败回落 userId）
      const profile = await profileFetcher.fetch(result.token)
      const saved = vault.save({
        label: profileLabel(profile, result.userId, result.browser),
        token: result.token,
        makeActive: true
      })
      finishPageOperation(operation, { state: 'success', scope: { accountId: saved.find(account => account.active)?.id }, facts: ['原浏览器读取和资料识别流程已返回，账号已保存。未据此切换 Cursor 的运行账号。'] }); return saved
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsImportFromFingerprint, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!options.importFromFingerprint) throw new Error('指纹浏览器通道未装配')
    const operation = beginPageOperation(options.operations, { kind: 'import-fingerprint', id: notificationOperationId(input) })
    try {
      const result = await options.importFromFingerprint()
      const userId = result.userId || result.token.split('::')[0] || 'cursor'
      // 资料识别成功时 label 显示邮箱（官网 /api/auth/me）；失败回落 user_xxx。
      // 导入即绑定：从哪个窗口读出 Token，就把该账号绑定到哪个窗口。
      const saved = vault.save({
        label: profileLabel(result.profile, userId, result.browserName ?? '指纹浏览器'),
        token: result.token,
        makeActive: true,
        fingerprintProfileId: result.profileId
      })
      const account = saved.find(account => account.active)
      finishPageOperation(operation, { state: 'success', scope: { accountId: account?.id }, facts: [account?.fingerprintProfileId ? '所选窗口的登录态已保存并绑定到该账号。' : '登录态已保存；导入结果未提供具体窗口绑定。', '当前 Cursor 运行账号未被本次导入切换。'] }); return saved
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsSetFingerprintProfile, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const profileId = typeof input.profileId === 'string' && input.profileId.trim() ? input.profileId.trim() : undefined
    return vault.setFingerprintProfile(accountIdOf(input.accountId), profileId)
  })
  ipcMain.handle(IPC.cursorAccountsOpenFingerprintLogin, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!options.openFingerprintLogin) throw new Error('指纹浏览器通道未装配')
    const operation = beginPageOperation(options.operations, { kind: 'login-window', id: notificationOperationId(input) })
    try { await options.openFingerprintLogin(); finishPageOperation(operation, { state: 'waiting', facts: ['所选登录窗口已按原入口打开；仍需在原窗口完成登录。未把打开窗口当成已登录。'] }) }
    catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsCleanupFingerprintEnvironment, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!options.cleanupFingerprintEnvironment) throw new Error('指纹浏览器通道未装配')
    const operation = beginPageOperation(options.operations, { kind: 'fingerprint-cleanup', id: notificationOperationId(input) })
    try { await options.cleanupFingerprintEnvironment(); finishPageOperation(operation, { state: 'success', facts: ['原浏览器环境清理方法已返回。实际清理范围以原确认入口为准，不会自动再清理一次。'] }) }
    catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsAcknowledgeModelDataPolicies, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!options.acknowledgeModelDataPolicies) throw new Error('指纹浏览器政策确认通道未装配')
    const operation = beginPageOperation(options.operations, { kind: 'model-policy', id: notificationOperationId(input) })
    try {
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
      const response = {
        changed: result.changed,
        tokenUpdated,
        modelIds,
        message: result.changed
          ? `已确认 ${modelIds.join('、')} 的数据政策`
          : `${modelIds.join('、')} 的数据政策已确认，无需重复提交`
      }
      const notification = finishPageOperation(operation, { state: modelIds.length ? 'success' : 'unconfirmed', facts: modelIds.length
        ? [result.changed ? `原入口已返回 ${modelIds.length} 个模型的数据政策确认结果。` : `原入口返回的 ${modelIds.length} 个模型政策已确认，本次未重复提交。`, tokenUpdated ? '仅在同账号匹配时更新了保存的 Token。' : '保存账号的 Token 未被本次结果覆盖。']
        : ['原入口未返回具体模型政策清单，不推测所有模型已完成授权。'] })
      return notification ? { ...response, notification } : response
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsRestartWith, async (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    // 一键切换：杀 Cursor → 写登录态 + 重置机器码 → 带端口拉起（FlyCursor 时序）；
    // 成功后才同步 vault 活跃账号（失败时 Cursor 仍运行原账号，active 不能变）。
    // 重启断开全部拾光通道，UI 已在调用前完成用户确认。
    let observationId: string | undefined
    const payload = accountId && typeof accountId === 'object' ? accountId as { accountId?: unknown; notificationId?: unknown } : undefined
    const requestedId = accountIdOf(payload ? payload.accountId : accountId)
    const notificationId = typeof payload?.notificationId === 'string' && /^[a-f0-9-]{36}$/.test(payload.notificationId) ? payload.notificationId : randomUUID()
    const notify = (result: Parameters<typeof accountSwitchNotification>[0]['cold'], error?: unknown): NotificationReference | undefined => {
      if (!options.notifications) return undefined
      try {
        const draft = accountSwitchNotification({ id: notificationId, accountId: requestedId, mode: 'cold', cold: result,
          ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}), now: Date.now() })
        options.notifications.offerCurrent(draft); return { key: draft.key, eventId: draft.eventId }
      } catch { return undefined }
    }
    let observed = false
    const suppress = (): void => {
      options.suppressCdpAutoHeal?.()
      if (!observed) { observed = true; try { observationId = options.restartObservation?.begin() } catch { /* Presentation only. */ } }
    }
    const finish = (success: boolean): void => { try { options.restartObservation?.finish(observationId, success) } catch { /* Original result must remain authoritative. */ } }
    try {
      const result = await switchCursorAccountWithVault({ vault, switcher, suppressCdpAutoHeal: suppress }, requestedId)
      finish(result.switched)
      const reference = notify(result)
      return reference ? { ...result, notification: reference } : result
    } catch (error) { finish(false); notify(undefined, error); throw error }
  })
  ipcMain.handle(IPC.cursorAccountsSwitchLive, async (event, accountId: unknown) => {
    assertTrustedSender(event, getWindow)
    // 无感换号（热切）：不杀进程、不写库、不动机器码；结果不 throw——
    // {switched:false, reason} 由 UI 原样亮出（热切降级语义，与自动化链同款）。
    if (!options.liveSwitcher) throw new Error('无感换号未装配')
    const payload = accountId && typeof accountId === 'object' ? accountId as { accountId?: unknown; notificationId?: unknown } : undefined
    const requestedId = accountIdOf(payload ? payload.accountId : accountId)
    const notificationId = typeof payload?.notificationId === 'string' && /^[a-f0-9-]{36}$/.test(payload.notificationId) ? payload.notificationId : randomUUID()
    const notify = (result: Parameters<typeof accountSwitchNotification>[0]['hot'], error?: unknown): NotificationReference | undefined => {
      if (!options.notifications) return undefined
      try {
        const draft = accountSwitchNotification({ id: notificationId, accountId: requestedId, mode: 'hot', hot: result,
          ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}), now: Date.now() })
        options.notifications.offerCurrent(draft); return { key: draft.key, eventId: draft.eventId }
      } catch { return undefined }
    }
    try {
      const result = await options.liveSwitcher.switchLive({ accountId: requestedId })
      const reference = notify(result); return reference ? { ...result, notification: reference } : result
    } catch (error) { notify(undefined, error); throw error }
  })
  ipcMain.handle(IPC.cursorSwitchPumpStatus, (event) => {
    assertTrustedSender(event, getWindow)
    if (!options.switchPumpInstaller) throw new Error('切号补丁管理未装配')
    return options.switchPumpInstaller.status()
  })
  ipcMain.handle(IPC.cursorSwitchPumpEnsure, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!options.switchPumpInstaller) throw new Error('切号补丁管理未装配')
    // 端口/密钥无所谓固定：热切按盘上配置绑定，冷切换每次重写；用既有常量即可。
    const install = () => options.switchPumpInstaller!.ensure({
      port: CURSOR_RUNTIME_SWITCH_PORT,
      key: CURSOR_RUNTIME_SWITCH_KEY
    })
    const operation = beginPageOperation(options.operations, { kind: 'patch-install', id: notificationOperationId(input) })
    try {
      const result = await (options.switchMutex ? options.switchMutex.withLock('安装切号补丁', install) : install())
      const notification = finishPageOperation(operation, { state: !result.ok ? 'failed' : result.warning ? 'partial' : 'success', unchanged: !result.changed, facts: [result.message,
        ...(result.warning ? [result.warning] : []), result.changed ? '原管理器确认文件已变化；运行时是否生效请按原维护页面核对，通知不额外重启。' : '原管理器未确认文件变化；不会为了通知再次执行安装。'] })
      return notification ? { ...result, notification } : result
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.cursorSwitchPumpRemove, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!options.switchPumpInstaller) throw new Error('切号补丁管理未装配')
    const remove = () => options.switchPumpInstaller!.remove()
    const operation = beginPageOperation(options.operations, { kind: 'patch-remove', id: notificationOperationId(input) })
    try {
      const result = await (options.switchMutex ? options.switchMutex.withLock('卸载切号补丁', remove) : remove())
      const notification = finishPageOperation(operation, { state: !result.ok ? 'failed' : result.warning ? 'partial' : 'success', unchanged: !result.changed, facts: [result.message, ...(result.warning ? [result.warning] : []),
        result.changed ? '原管理器确认文件已变化；没有由通知触发额外重启。' : '原管理器未确认文件变化；不推测外部工具补丁已被移除。'] })
      return notification ? { ...result, notification } : result
    } catch (error) { failPageOperation(operation, error); throw error }
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
    ipcMain.removeHandler(IPC.cursorAccountsSaveCard)
    ipcMain.removeHandler(IPC.cursorAccountsLogin)
    ipcMain.removeHandler(IPC.cursorAccountsStartProUpgrade)
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
