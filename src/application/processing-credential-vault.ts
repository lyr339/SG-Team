import { existsSync, rmSync } from 'node:fs'
import { quarantineStoreFileSync, readStoreJsonSync, writeStoreFileSync } from '../infrastructure/fs/store-file'
import type { CursorAccountVaultCrypto } from './cursor-account-vault'

interface ProcessingCredentialFile {
  version: 1
  encryptedCode: string
  codeSuffix: string
  updatedAt: number
}

/** 一个服务商一份文件；卡密密文结构共用，路径和错误标签分别注入。 */
export class ProcessingCredentialVault {
  constructor(
    readonly path: string,
    private readonly crypto: CursorAccountVaultCrypto,
    private readonly serviceLabel: string,
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
    if (!card) throw new Error(`尚未保存${this.serviceLabel}卡密`)
    try {
      return this.crypto.decrypt(Buffer.from(card.encryptedCode, 'base64'))
    } catch {
      throw new Error(`已保存的${this.serviceLabel}卡密读取失败；系统加密钥匙发生变化，请重新粘贴卡密后验证`)
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
    if (!this.crypto.available()) throw new Error('系统凭据加密当前不可用')
  }

  private load(): ProcessingCredentialFile | undefined {
    const file = readStoreJsonSync(this.path)
    if (file.kind !== 'json') return undefined
    const parsed = file.value as Partial<ProcessingCredentialFile> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1
      || typeof parsed.encryptedCode !== 'string' || typeof parsed.codeSuffix !== 'string'
      || typeof parsed.updatedAt !== 'number') {
      quarantineStoreFileSync(this.path, `${this.serviceLabel}卡密文件版本或结构不符`)
      return undefined
    }
    return { version: 1, encryptedCode: parsed.encryptedCode, codeSuffix: parsed.codeSuffix, updatedAt: parsed.updatedAt }
  }

  private store(card: ProcessingCredentialFile): void {
    writeStoreFileSync(this.path, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600 })
  }
}
