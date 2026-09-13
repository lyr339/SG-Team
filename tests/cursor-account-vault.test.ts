import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CursorAccountVault, type CursorAccountVaultCrypto } from '../src/application/cursor-account-vault'
import { generateCursorMachineIdentity } from '../src/infrastructure/cursor/cursor-machine-identity'

const crypto: CursorAccountVaultCrypto = {
  available: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`).reverse(),
  decrypt: (value) => Buffer.from(value).reverse().toString().replace(/^encrypted:/, '')
}

describe('CursorAccountVault', () => {
  it('persists only ciphertext and returns masked account metadata', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, crypto, () => 123)
    const accounts = vault.save({ label: '工作账号', token: 'cursor-secret-token-1234' })

    expect(accounts).toEqual([
      expect.objectContaining({ label: '工作账号', maskedToken: '••••1234', active: true })
    ])
    expect(readFileSync(path, 'utf8')).not.toContain('cursor-secret-token-1234')
    // POSIX 权限位断言只在类 Unix 平台生效：Windows 的 statSync 恒报 0666
    // （Node 仅映射只读位，无 0600 语义）；macOS 行为不变。
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(vault.credential()).toBe('cursor-secret-token-1234')
  })

  it('supports multiple accounts, active selection and recoverable metadata deletion', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, crypto)
    let accounts = vault.save({ label: '账号 A', token: 'cursor-token-aaaa' })
    accounts = vault.save({ label: '账号 B', token: 'cursor-token-bbbb' })
    const first = accounts.find((account) => account.label === '账号 A')!
    const second = accounts.find((account) => account.label === '账号 B')!
    expect(second.active).toBe(true)
    expect(vault.select(first.id).find((account) => account.id === first.id)?.active).toBe(true)
    expect(vault.remove(first.id)).toEqual([
      expect.objectContaining({ id: second.id, active: true })
    ])
  })

  it('refuses to persist plaintext when system encryption is unavailable', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, { ...crypto, available: () => false })
    expect(() => vault.save({ label: '账号', token: 'cursor-token-abcd' })).toThrowError(/系统凭据加密/)
  })

  it('maps a changed system key to a recoverable import instruction', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, crypto)
    vault.save({ label: '账号', token: 'cursor-token-abcd' })
    const unreadable = new CursorAccountVault(path, {
      ...crypto,
      decrypt: () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.') }
    })
    expect(() => unreadable.credential()).toThrowError(/重新导入 Token/)
    expect(() => unreadable.credential()).not.toThrowError(/safeStorage/)
  })

  it('binds a machine identity per account and replays it on later switches', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, crypto)
    const [saved] = vault.save({ label: 'a@example.com（网页登录）', token: 'cursor-token-abcd' })
    const accountId = saved!.id

    expect(vault.machineIdentity(accountId)).toBeUndefined()
    const identity = generateCursorMachineIdentity()
    vault.attachMachineIdentity(accountId, identity)
    expect(vault.machineIdentity(accountId)).toEqual(identity)

    // 绑定后不可覆盖（幂等保持第一套）；持久化后重新加载仍可回放
    vault.attachMachineIdentity(accountId, generateCursorMachineIdentity())
    expect(vault.machineIdentity(accountId)).toEqual(identity)
    const reloaded = new CursorAccountVault(path, crypto)
    expect(reloaded.machineIdentity(accountId)).toEqual(identity)

    // 格式漂移的身份在加载时视为未绑定（下次切换重新生成）
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { accounts: Array<{ machineIdentity?: unknown }> }
    raw.accounts[0]!.machineIdentity = { machineId: 'drifted', macMachineId: 'x' }
    writeFileSync(path, JSON.stringify(raw), 'utf8')
    expect(new CursorAccountVault(path, crypto).machineIdentity(accountId)).toBeUndefined()
  })

  it('rejects machine identity binding for unknown accounts or invalid shapes', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, crypto)
    vault.save({ label: '账号', token: 'cursor-token-abcd' })

    expect(() => vault.attachMachineIdentity('cursor-account:missing', generateCursorMachineIdentity()))
      .toThrowError(/不存在/)
    const [account] = vault.list()
    expect(() => vault.attachMachineIdentity(account!.id, { machineId: 'bad' } as ReturnType<typeof generateCursorMachineIdentity>))
      .toThrowError(/机器码身份格式无效/)
  })

  it('commits live/cold activation and machine-alignment state in one vault write', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
    const vault = new CursorAccountVault(path, crypto)
    const first = vault.save({ label: 'A', token: 'cursor-token-aaaa' })[0]!
    const second = vault.save({ label: 'B', token: 'cursor-token-bbbb', makeActive: false })
      .find((account) => account.id !== first.id)!

    let accounts = vault.activateAfterLiveSwitch(second.id)
    expect(accounts.find((account) => account.id === second.id)).toMatchObject({ active: true, pendingMachineAlign: true })
    expect(accounts.find((account) => account.id === first.id)?.pendingMachineAlign).toBe(false)

    accounts = vault.activateAfterLiveSwitch(first.id)
    expect(accounts.find((account) => account.id === first.id)).toMatchObject({ active: true, pendingMachineAlign: true })
    expect(accounts.find((account) => account.id === second.id)?.pendingMachineAlign).toBe(false)

    accounts = vault.activateAfterColdSwitch(second.id)
    expect(accounts.find((account) => account.id === second.id)).toMatchObject({ active: true, pendingMachineAlign: false })
    expect(accounts.every((account) => account.pendingMachineAlign === false)).toBe(true)
    expect(() => vault.activateAfterLiveSwitch('missing')).toThrow(/不存在/)
    expect(() => vault.activateAfterColdSwitch('missing')).toThrow(/不存在/)
  })

  describe('指纹窗口绑定（账号 ↔ Roxy profile）', () => {
    it('导入即绑定：save 携带 fingerprintProfileId 并随 list 暴露', () => {
      const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
      const vault = new CursorAccountVault(path, crypto)
      const accounts = vault.save({ label: 'A', token: 'cursor-token-aaaa', fingerprintProfileId: 'win-1' })
      expect(accounts[0]).toMatchObject({ fingerprintProfileId: 'win-1' })
      // 重新加载后绑定仍在（持久化），且明文 token 不落盘
      expect(new CursorAccountVault(path, crypto).list()[0]).toMatchObject({ fingerprintProfileId: 'win-1' })
    })

    it('save 缺省/空白绑定 → 字段缺省（回退默认窗口语义）', () => {
      const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
      const vault = new CursorAccountVault(path, crypto)
      expect(vault.save({ label: 'A', token: 'cursor-token-aaaa' })[0]).not.toHaveProperty('fingerprintProfileId')
      expect(vault.save({ label: 'B', token: 'cursor-token-bbbb', fingerprintProfileId: '  ' })[1])
        .not.toHaveProperty('fingerprintProfileId')
    })

    it('setFingerprintProfile：绑定 → 改绑 → 解绑；不触碰 updatedAt（不搅动接手账号排序）', () => {
      const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
      let clock = 1000
      const vault = new CursorAccountVault(path, crypto, () => clock)
      const [account] = vault.save({ label: 'A', token: 'cursor-token-aaaa' })
      const originalUpdatedAt = account!.updatedAt

      clock = 2000
      expect(vault.setFingerprintProfile(account!.id, 'win-1')[0]).toMatchObject({ fingerprintProfileId: 'win-1' })
      expect(vault.setFingerprintProfile(account!.id, 'win-2')[0]).toMatchObject({ fingerprintProfileId: 'win-2' })
      // 解绑：undefined / 空白都回到未绑定
      expect(vault.setFingerprintProfile(account!.id, undefined)[0]).not.toHaveProperty('fingerprintProfileId')
      expect(vault.setFingerprintProfile(account!.id, 'win-2')[0]).toMatchObject({ fingerprintProfileId: 'win-2' })
      expect(vault.setFingerprintProfile(account!.id, '  ')[0]).not.toHaveProperty('fingerprintProfileId')
      // 全链路 updatedAt 保持导入时刻
      expect(vault.list()[0]!.updatedAt).toBe(originalUpdatedAt)
      expect(() => vault.setFingerprintProfile('cursor-account:missing', 'win-1')).toThrow(/不存在/)
    })

    it('旧数据/脏数据回退：字段缺失或非字符串时按未绑定处理', () => {
      const path = join(mkdtempSync(join(tmpdir(), 'sg-cursor-accounts-')), 'accounts.json')
      const vault = new CursorAccountVault(path, crypto)
      vault.save({ label: 'A', token: 'cursor-token-aaaa', fingerprintProfileId: 'win-1' })
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { accounts: Array<Record<string, unknown>> }
      raw.accounts[0]!.fingerprintProfileId = 42
      writeFileSync(path, JSON.stringify(raw), 'utf8')
      expect(new CursorAccountVault(path, crypto).list()[0]).not.toHaveProperty('fingerprintProfileId')
    })
  })
})
