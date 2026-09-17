import { randomUUID } from 'node:crypto'
import type { CursorAccountMetadata } from '../domain/cursor-account'
import { isCursorAccountCredentials, type CursorAccountCredentials } from '../domain/cursor-account'
import type { CursorAccountCard } from '../domain/cursor-account-card'
import { isCursorMachineIdentity, type CursorMachineIdentity } from '../infrastructure/cursor/cursor-machine-identity'
import { quarantineStoreFileSync, readStoreJsonSync, writeStoreFileSync } from '../infrastructure/fs/store-file'

export interface CursorAccountVaultCrypto {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface StoredCursorAccount {
  id: string
  label: string
  encryptedToken: string
  tokenSuffix: string
  createdAt: number
  updatedAt: number
  /** 账号绑定的 Cursor 机器码身份（首次切换账号时生成，之后回放同一套）。 */
  machineIdentity?: CursorMachineIdentity
  /** 热切（无感换号）置位：运行中 Cursor 的机器码仍是上一账号的，待冷切换归一。 */
  pendingMachineAlign?: boolean
  /** 账号绑定的指纹浏览器窗口 id（导入时自动记录；自动化链锚定此窗口执行）。 */
  fingerprintProfileId?: string
  /** JWT sub（auth0|user_xxx）：卡号导入的去重锚点，同一账号再粘贴即更新而非重复新建。 */
  sub?: string
  /** 卡号账号的邮箱（明文元数据；与 label 解耦，用户改备注后仍可查）。 */
  email?: string
  /** 加密的登录凭据 blob（CursorAccountCredentials JSON 整体加密）。 */
  encryptedCredentials?: string
}

/** saveCard 的返回：账号列表 + 新建/更新结果（UI 反馈文案的依据）。 */
export interface SaveCardResult {
  accounts: CursorAccountMetadata[]
  outcome: 'created' | 'updated'
  accountId: string
  label: string
  /** （IPC 组合层回填）卡内 Token 已过期且经凭据自动登录刷新成功。 */
  tokenRefreshed?: boolean
  /** （IPC 组合层回填）卡内 Token 已过期且自动登录未成功的引导文案。 */
  loginError?: string
}

interface CursorAccountVaultFile {
  version: 1
  activeId?: string
  accounts: StoredCursorAccount[]
}

const EMPTY_VAULT: CursorAccountVaultFile = { version: 1, accounts: [] }
export const CURSOR_CREDENTIAL_UNREADABLE_MESSAGE = '已保存的 Cursor Token 读取失败；应用升级期间系统加密钥匙发生变化，请重新导入 Token'

export class CursorAccountVault {
  constructor(
    readonly path: string,
    private readonly crypto: CursorAccountVaultCrypto,
    private readonly now: () => number = Date.now
  ) {}

  list(): CursorAccountMetadata[] {
    const vault = this.load()
    return vault.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      maskedToken: `••••${account.tokenSuffix}`,
      active: account.id === vault.activeId,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      pendingMachineAlign: account.pendingMachineAlign === true,
      ...(account.fingerprintProfileId ? { fingerprintProfileId: account.fingerprintProfileId } : {}),
      ...(account.email ? { email: account.email } : {}),
      ...(account.encryptedCredentials ? { hasCredentials: true } : {})
    }))
  }

  save(input: { label: string; token: string; makeActive?: boolean; fingerprintProfileId?: string }): CursorAccountMetadata[] {
    this.assertEncryption()
    const label = input.label.trim()
    const token = input.token.trim()
    if (!label || label.length > 80) throw new Error('账号备注必须为 1–80 个字符')
    if (token.length < 8 || token.length > 8_192) throw new Error('Cursor Token 长度无效')
    const vault = this.load()
    const at = this.now()
    const fingerprintProfileId = input.fingerprintProfileId?.trim() || undefined
    const account: StoredCursorAccount = {
      id: `cursor-account:${randomUUID()}`,
      label,
      encryptedToken: this.crypto.encrypt(token).toString('base64'),
      tokenSuffix: token.slice(-4),
      createdAt: at,
      updatedAt: at,
      ...(fingerprintProfileId ? { fingerprintProfileId } : {})
    }
    vault.accounts.push(account)
    if (input.makeActive !== false || !vault.activeId) vault.activeId = account.id
    this.store(vault)
    return this.list()
  }

  /**
   * 卡号导入：凭据（邮箱/Cursor 密码等）整体加密随账号保存。
   * 去重锚点 = JWT sub：同一账号再次粘贴更新 Token 与凭据（保留备注/绑定窗口/选中态），
   * 不重复建行；无 sub（非标准 Token）时退化为永远新建。
   */
  saveCard(input: { card: CursorAccountCard; sub?: string; makeActive?: boolean; fingerprintProfileId?: string }): SaveCardResult {
    this.assertEncryption()
    const { card } = input
    const token = card.token.trim()
    if (token.length < 8 || token.length > 8_192) throw new Error('Cursor Token 长度无效')
    // 与 save() 同一备注护栏：邮箱即备注，超长邮箱（罕见但合法）不得产出非法记录
    if (!card.email.trim() || card.email.trim().length > 80) throw new Error('卡号邮箱长度无效（备注上限 80 字符）')
    const encryptedCredentials = this.crypto.encrypt(JSON.stringify({
      email: card.email,
      cursorPassword: card.cursorPassword,
      ...(card.emailPassword ? { emailPassword: card.emailPassword } : {}),
      ...(card.recoveryEmail ? { recoveryEmail: card.recoveryEmail } : {}),
      ...(card.recoveryEmailPassword ? { recoveryEmailPassword: card.recoveryEmailPassword } : {})
    } satisfies CursorAccountCredentials)).toString('base64')
    const sub = input.sub?.trim() || undefined
    const vault = this.load()
    const at = this.now()
    const fingerprintProfileId = input.fingerprintProfileId?.trim() || undefined

    const existing = sub ? vault.accounts.find((account) => account.sub === sub) : undefined
    if (existing) {
      existing.encryptedToken = this.crypto.encrypt(token).toString('base64')
      existing.tokenSuffix = token.slice(-4)
      existing.encryptedCredentials = encryptedCredentials
      existing.email = card.email
      existing.updatedAt = at
      if (fingerprintProfileId) existing.fingerprintProfileId = fingerprintProfileId
      if (input.makeActive !== false) vault.activeId = existing.id
      this.store(vault)
      return { accounts: this.list(), outcome: 'updated', accountId: existing.id, label: existing.label }
    }

    const account: StoredCursorAccount = {
      id: `cursor-account:${randomUUID()}`,
      label: card.email,
      encryptedToken: this.crypto.encrypt(token).toString('base64'),
      tokenSuffix: token.slice(-4),
      createdAt: at,
      updatedAt: at,
      email: card.email,
      encryptedCredentials,
      ...(sub ? { sub } : {}),
      ...(fingerprintProfileId ? { fingerprintProfileId } : {})
    }
    vault.accounts.push(account)
    if (input.makeActive !== false || !vault.activeId) vault.activeId = account.id
    this.store(vault)
    return { accounts: this.list(), outcome: 'created', accountId: account.id, label: account.label }
  }

  /**
   * 读取账号的登录凭据（自动登录用）。未保存/解密失败/格式漂移均返回 undefined——
   * 凭据是可选增强，缺失时调用方回退手动登录路径，不抛错阻断主流程。
   */
  credentials(accountId?: string): CursorAccountCredentials | undefined {
    this.assertEncryption()
    const vault = this.load()
    const id = accountId?.trim() || vault.activeId
    const account = vault.accounts.find((candidate) => candidate.id === id)
    if (!account?.encryptedCredentials) return undefined
    try {
      const parsed: unknown = JSON.parse(this.crypto.decrypt(Buffer.from(account.encryptedCredentials, 'base64')))
      return isCursorAccountCredentials(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  select(accountId: string): CursorAccountMetadata[] {
    const vault = this.load()
    const id = accountId.trim()
    if (!vault.accounts.some((account) => account.id === id)) throw new Error('Cursor 账号不存在')
    vault.activeId = id
    this.store(vault)
    return this.list()
  }

  /**
   * 热切硬回执后的单次提交：选中新账号，并把“运行态机器码仍属旧号”只标在
   * 当前账号上。两件事共用一次原子文件替换，避免 Cursor 已换号而 Vault 只写一半。
   */
  activateAfterLiveSwitch(accountId: string): CursorAccountMetadata[] {
    const id = accountId.trim()
    const vault = this.load()
    if (!vault.accounts.some((account) => account.id === id)) throw new Error('Cursor 账号不存在')
    vault.activeId = id
    for (const account of vault.accounts) {
      if (account.id === id) account.pendingMachineAlign = true
      else delete account.pendingMachineAlign
    }
    this.store(vault)
    return this.list()
  }

  /** 冷切已同时写入目标机器码：选中新账号并一次清掉全部运行态待对齐标记。 */
  activateAfterColdSwitch(accountId: string): CursorAccountMetadata[] {
    const id = accountId.trim()
    const vault = this.load()
    if (!vault.accounts.some((account) => account.id === id)) throw new Error('Cursor 账号不存在')
    vault.activeId = id
    for (const account of vault.accounts) delete account.pendingMachineAlign
    this.store(vault)
    return this.list()
  }

  /** 原地更新账号 token（保留 id/备注/选中态），供自动化流程刷新凭据。 */
  replaceToken(accountId: string, token: string): CursorAccountMetadata[] {
    this.assertEncryption()
    const id = accountId.trim()
    const next = token.trim()
    if (next.length < 8 || next.length > 8_192) throw new Error('Cursor Token 长度无效')
    const vault = this.load()
    const account = vault.accounts.find((candidate) => candidate.id === id)
    if (!account) throw new Error('Cursor 账号不存在')
    account.encryptedToken = this.crypto.encrypt(next).toString('base64')
    account.tokenSuffix = next.slice(-4)
    account.updatedAt = this.now()
    this.store(vault)
    return this.list()
  }

  remove(accountId: string): CursorAccountMetadata[] {
    const vault = this.load()
    const id = accountId.trim()
    const next = vault.accounts.filter((account) => account.id !== id)
    if (next.length === vault.accounts.length) throw new Error('Cursor 账号不存在')
    vault.accounts = next
    if (vault.activeId === id) vault.activeId = next[0]?.id
    this.store(vault)
    return this.list()
  }

  credential(accountId?: string): string {
    this.assertEncryption()
    const vault = this.load()
    const id = accountId?.trim() || vault.activeId
    const account = vault.accounts.find((candidate) => candidate.id === id)
    if (!account) throw new Error('尚未选择 Cursor 账号')
    try {
      return this.crypto.decrypt(Buffer.from(account.encryptedToken, 'base64'))
    } catch {
      throw new Error(CURSOR_CREDENTIAL_UNREADABLE_MESSAGE)
    }
  }

  /** 读取账号绑定的机器码身份；未绑定或格式漂移返回 undefined。 */
  machineIdentity(accountId: string): CursorMachineIdentity | undefined {
    const id = accountId.trim()
    const account = this.load().accounts.find((candidate) => candidate.id === id)
    return account?.machineIdentity && isCursorMachineIdentity(account.machineIdentity)
      ? account.machineIdentity
      : undefined
  }

  /**
   * 绑定/改绑/解绑账号的指纹浏览器窗口（undefined 解绑，回退默认窗口）。
   * 不触碰 updatedAt：窗口绑定是本机执行提示，不是账号活动信号——
   * 接手账号的「最近更新优先」排序（selectAccountHandoverTarget）不应被改绑搅动。
   */
  setFingerprintProfile(accountId: string, profileId?: string): CursorAccountMetadata[] {
    const id = accountId.trim()
    const vault = this.load()
    const account = vault.accounts.find((candidate) => candidate.id === id)
    if (!account) throw new Error('Cursor 账号不存在')
    const next = profileId?.trim() || undefined
    if (account.fingerprintProfileId === next) return this.list()
    account.fingerprintProfileId = next
    this.store(vault)
    return this.list()
  }

  /** 绑定机器码身份（首次切换时生成后调用）；账号不存在时抛错。 */
  attachMachineIdentity(accountId: string, identity: CursorMachineIdentity): void {
    if (!isCursorMachineIdentity(identity)) throw new Error('机器码身份格式无效')
    const id = accountId.trim()
    const vault = this.load()
    const account = vault.accounts.find((candidate) => candidate.id === id)
    if (!account) throw new Error('Cursor 账号不存在')
    if (account.machineIdentity && isCursorMachineIdentity(account.machineIdentity)) return
    account.machineIdentity = identity
    account.updatedAt = this.now()
    this.store(vault)
  }

  private assertEncryption(): void {
    if (!this.crypto.available()) throw new Error('macOS 系统凭据加密当前不可用')
  }

  /**
   * 坏文件 / 版本不符先留档再回空金库：金库的每个写操作都是 load→改→store，
   * 静默回空意味着下一次操作就把所有账号的密文永久覆写掉（断电损坏尤其如此）。
   */
  private load(): CursorAccountVaultFile {
    const file = readStoreJsonSync(this.path)
    if (file.kind !== 'json') return structuredClone(EMPTY_VAULT)
    try {
      const parsed = file.value as Partial<CursorAccountVaultFile>
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
        quarantineStoreFileSync(this.path, '账号金库版本或结构不符')
        return structuredClone(EMPTY_VAULT)
      }
      return {
        version: 1,
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : undefined,
        accounts: parsed.accounts.filter((account): account is StoredCursorAccount => Boolean(
          account && typeof account.id === 'string' && typeof account.label === 'string'
          && typeof account.encryptedToken === 'string' && typeof account.tokenSuffix === 'string'
          && typeof account.createdAt === 'number' && typeof account.updatedAt === 'number'
        )).map((account) => (
          isCursorMachineIdentity(account.machineIdentity)
            ? { ...account, machineIdentity: account.machineIdentity }
            : { ...account, machineIdentity: undefined }
        )).map((account) => (
          account.pendingMachineAlign === true ? account : { ...account, pendingMachineAlign: undefined }
        )).map((account) => (
          typeof account.fingerprintProfileId === 'string' && account.fingerprintProfileId.trim()
            ? { ...account, fingerprintProfileId: account.fingerprintProfileId.trim() }
            : { ...account, fingerprintProfileId: undefined }
        )).map((account) => ({
          ...account,
          sub: typeof account.sub === 'string' && account.sub.trim() ? account.sub : undefined,
          email: typeof account.email === 'string' && account.email.trim() ? account.email : undefined,
          encryptedCredentials: typeof account.encryptedCredentials === 'string' && account.encryptedCredentials
            ? account.encryptedCredentials
            : undefined
        }))
      }
    } catch {
      quarantineStoreFileSync(this.path, '账号金库内容异常')
      return structuredClone(EMPTY_VAULT)
    }
  }

  private store(vault: CursorAccountVaultFile): void {
    writeStoreFileSync(this.path, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 })
  }
}
