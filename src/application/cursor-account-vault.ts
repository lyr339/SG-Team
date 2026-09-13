import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CursorAccountMetadata } from '../domain/cursor-account'
import { isCursorMachineIdentity, type CursorMachineIdentity } from '../infrastructure/cursor/cursor-machine-identity'

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
      ...(account.fingerprintProfileId ? { fingerprintProfileId: account.fingerprintProfileId } : {})
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

  private load(): CursorAccountVaultFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CursorAccountVaultFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) return structuredClone(EMPTY_VAULT)
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
        ))
      }
    } catch {
      return structuredClone(EMPTY_VAULT)
    }
  }

  private store(vault: CursorAccountVaultFile): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(vault, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}
