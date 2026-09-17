import { existsSync, rmSync } from 'node:fs'
import { quarantineStoreFileSync, readStoreJsonSync, writeStoreFileSync } from '../infrastructure/fs/store-file'
import type { CursorAccountVaultCrypto } from './cursor-account-vault'

interface AozaiCardFile {
  version: 1
  encryptedCode: string
  codeSuffix: string
  updatedAt: number
}

export const AOZAI_CREDENTIAL_UNREADABLE_MESSAGE = '已保存的奥仔卡密读取失败；应用升级期间系统加密钥匙发生变化，请重新粘贴卡密后验证'

export class AozaiCardVault {
  constructor(
    readonly path: string,
    private readonly crypto: CursorAccountVaultCrypto,
    private readonly now: () => number = Date.now
  ) {}

  maskedCode(): string | undefined {
    const card = this.load()
    return card ? `••••${card.codeSuffix}` : undefined
  }

  save(cardCode: string): string {
    this.assertEncryption()
    const code = cardCode.trim()
    if (code.length < 6 || code.length > 200) throw new Error('卡密长度无效')
    this.store({
      version: 1,
      encryptedCode: this.crypto.encrypt(code).toString('base64'),
      codeSuffix: code.slice(-4),
      updatedAt: this.now()
    })
    return `••••${code.slice(-4)}`
  }

  credential(): string {
    this.assertEncryption()
    const card = this.load()
    if (!card) throw new Error('尚未保存奥仔卡密')
    try {
      return this.crypto.decrypt(Buffer.from(card.encryptedCode, 'base64'))
    } catch {
      throw new Error(AOZAI_CREDENTIAL_UNREADABLE_MESSAGE)
    }
  }

  clear(): void {
    try {
      if (existsSync(this.path)) rmSync(this.path)
    } catch {
      // 文件不存在或权限不足时视为已清除
    }
  }

  private assertEncryption(): void {
    if (!this.crypto.available()) throw new Error('macOS 系统凭据加密当前不可用')
  }

  /** 坏文件先留档再回「未保存」，避免下一次 store 覆写仅存的密文现场。 */
  private load(): AozaiCardFile | undefined {
    const file = readStoreJsonSync(this.path)
    if (file.kind !== 'json') return undefined
    const parsed = file.value as Partial<AozaiCardFile> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1
      || typeof parsed.encryptedCode !== 'string' || typeof parsed.codeSuffix !== 'string'
      || typeof parsed.updatedAt !== 'number') {
      quarantineStoreFileSync(this.path, '奥仔卡密文件版本或结构不符')
      return undefined
    }
    return { version: 1, encryptedCode: parsed.encryptedCode, codeSuffix: parsed.codeSuffix, updatedAt: parsed.updatedAt }
  }

  private store(card: AozaiCardFile): void {
    writeStoreFileSync(this.path, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600 })
  }
}
