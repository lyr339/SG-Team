import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CursorAccountVault, type CursorAccountVaultCrypto } from '../src/application/cursor-account-vault'
import { registerCursorAccountIpc } from '../src/main/register-cursor-account-ipc'
import { IPC } from '../src/shared/desktop-api'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name)
  }
}))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: vi.fn() }))

const crypto: CursorAccountVaultCrypto = {
  available: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`).reverse(),
  decrypt: (value) => Buffer.from(value).reverse().toString().replace(/^encrypted:/, '')
}

function fakeCardText(): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const jwt = `${segment({ alg: 'HS256' })}.${segment({ sub: 'auth0|user_01M25', exp: 1_794_218_127 })}.sig`
  return ['a@b.co', 'mail-pass', 'cursor-pass', '', '', `user_01M25::${jwt}`].join('----')
}

describe('卡号导入 IPC', () => {
  it('主进程权威解析并入库；非法输入与解析错误原样上抛；dispose 撤销处理器', async () => {
    handlers.clear()
    const vault = new CursorAccountVault(join(mkdtempSync(join(tmpdir(), 'sg-account-ipc-')), 'accounts.json'), crypto)
    const dispose = registerCursorAccountIpc(vault, () => undefined)
    const invoke = async (channel: string, payload?: unknown): Promise<unknown> => handlers.get(channel)!({ senderFrame: null }, payload)

    const result = await invoke(IPC.cursorAccountsSaveCard, { card: fakeCardText() }) as {
      outcome: string
      label: string
      accountId: string
      accounts: Array<{ label: string; hasCredentials?: boolean }>
    }
    expect(result.outcome).toBe('created')
    expect(result.label).toBe('a@b.co')
    expect(result.accounts[0]).toMatchObject({ label: 'a@b.co', hasCredentials: true })
    expect(vault.credentials(result.accountId)?.cursorPassword).toBe('cursor-pass')

    // 同一 sub 再粘贴 → 原地更新
    expect((await invoke(IPC.cursorAccountsSaveCard, { card: fakeCardText() }) as { outcome: string }).outcome).toBe('updated')

    await expect(invoke(IPC.cursorAccountsSaveCard, { card: 'garbage' })).rejects.toThrow(/卡号参数无效|6 段/)
    await expect(invoke(IPC.cursorAccountsSaveCard, { card: 42 })).rejects.toThrow(/卡号参数无效/)
    await expect(invoke(IPC.cursorAccountsSaveCard, null)).rejects.toThrow(/卡号参数无效/)

    dispose()
    expect(handlers.has(IPC.cursorAccountsSaveCard)).toBe(false)
  })

  it('卡内 Token 已过期：装配自动登录时当场刷新；未装配时按原样保存', async () => {
    handlers.clear()
    const vault = new CursorAccountVault(join(mkdtempSync(join(tmpdir(), 'sg-account-ipc-')), 'accounts.json'), crypto)
    const segment = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    // 已过期（exp 在过去）的卡号
    const expiredJwt = `${segment({ alg: 'HS256' })}.${segment({ sub: 'auth0|user_01M25', exp: 1_700_000_000 })}.sig`
    const expiredCard = ['a@b.co', 'mail-pass', 'cursor-pass', '', '', `user_01M25::${expiredJwt}`].join('----')

    const login = vi.fn(async () => ({ token: 'user_01M25::fresh-jwt', outcome: 'logged_in' as const }))
    let dispose = registerCursorAccountIpc(vault, () => undefined, { loginWithCredentials: login })
    const invoke = async (channel: string, payload?: unknown): Promise<unknown> => handlers.get(channel)!({ senderFrame: null }, payload)

    const refreshed = await invoke(IPC.cursorAccountsSaveCard, { card: expiredCard }) as {
      tokenRefreshed?: boolean
      accounts: Array<{ maskedToken: string }>
    }
    expect(refreshed.tokenRefreshed).toBe(true)
    expect(login).toHaveBeenCalledWith({ email: 'a@b.co', password: 'cursor-pass' }, undefined)
    expect(refreshed.accounts[0]!.maskedToken).toBe('••••-jwt')
    expect(vault.credential()).toBe('user_01M25::fresh-jwt')
    dispose()

    // 自动登录失败：账号与凭据照常保存，结果带 loginError
    const failing = vi.fn(async () => { throw new Error('  自动登录超时：若窗口弹出人机验证\n请手动完成  ') })
    dispose = registerCursorAccountIpc(vault, () => undefined, { loginWithCredentials: failing })
    const failed = await invoke(IPC.cursorAccountsSaveCard, { card: expiredCard }) as { loginError?: string; outcome: string }
    expect(failed.outcome).toBe('updated')
    expect(failed.loginError).toBe('自动登录超时：若窗口弹出人机验证 请手动完成')
    dispose()

    // 未装配自动登录：过期 Token 按原样保存，无附加字段
    dispose = registerCursorAccountIpc(vault, () => undefined)
    const plain = await invoke(IPC.cursorAccountsSaveCard, { card: expiredCard }) as { tokenRefreshed?: boolean; loginError?: string }
    expect(plain).not.toHaveProperty('tokenRefreshed')
    expect(plain).not.toHaveProperty('loginError')
    dispose()
  })

  it('凭据自动登录：无凭据账号拒绝；成功时原地刷新 Token', async () => {
    handlers.clear()
    const vault = new CursorAccountVault(join(mkdtempSync(join(tmpdir(), 'sg-account-ipc-')), 'accounts.json'), crypto)
    const login = vi.fn(async () => ({ token: 'user_01M25::fresh-jwt', outcome: 'logged_in' as const }))
    const dispose = registerCursorAccountIpc(vault, () => undefined, { loginWithCredentials: login })
    const invoke = async (channel: string, payload?: unknown): Promise<unknown> => handlers.get(channel)!({ senderFrame: null }, payload)

    const [plain] = vault.save({ label: 'plain', token: 'cursor-token-plain' })
    await expect(invoke(IPC.cursorAccountsLogin, plain!.id)).rejects.toThrow(/没有保存的登录凭据/)

    const created = vault.saveCard({
      card: {
        email: 'a@b.co', cursorPassword: 'cursor-pass', token: 'user_01M25::old-jwt'
      },
      sub: 'auth0|user_01M25',
      fingerprintProfileId: 'win-7'
    })
    const result = await invoke(IPC.cursorAccountsLogin, created.accountId) as {
      outcome: string
      accounts: Array<{ maskedToken: string }>
    }
    expect(result.outcome).toBe('logged_in')
    // 窗口锚定账号绑定（win-7）
    expect(login).toHaveBeenCalledWith({ email: 'a@b.co', password: 'cursor-pass' }, 'win-7')
    expect(vault.credential(created.accountId)).toBe('user_01M25::fresh-jwt')
    dispose()
  })
})

describe('升级 Pro 结账 IPC', () => {
  it('未装配 → 报未装配；装配后校验入参并委托编排闭包，结果原样返回；dispose 撤销', async () => {
    handlers.clear()
    const vault = new CursorAccountVault(join(mkdtempSync(join(tmpdir(), 'sg-account-ipc-')), 'accounts.json'), crypto)
    let dispose = registerCursorAccountIpc(vault, () => undefined)
    const invoke = async (channel: string, payload?: unknown): Promise<unknown> => handlers.get(channel)!({ senderFrame: null }, payload)

    await expect(invoke(IPC.cursorAccountsStartProUpgrade, 'acc-1')).rejects.toThrow(/升级 Pro 结账通道未装配/)
    dispose()

    const startProUpgrade = vi.fn(async (accountId: string) => ({
      outcome: 'awaiting_payment' as const,
      detail: `已提交 ${accountId}，请扫码`
    }))
    dispose = registerCursorAccountIpc(vault, () => undefined, { startProUpgrade })
    const result = await invoke(IPC.cursorAccountsStartProUpgrade, '  acc-9  ') as { outcome: string; detail: string }
    expect(startProUpgrade).toHaveBeenCalledWith('acc-9')
    expect(result).toEqual({ outcome: 'awaiting_payment', detail: '已提交 acc-9，请扫码' })
    await expect(invoke(IPC.cursorAccountsStartProUpgrade, '')).rejects.toThrow(/账号 ID 无效/)
    await expect(invoke(IPC.cursorAccountsStartProUpgrade, 42)).rejects.toThrow(/账号 ID 无效/)
    dispose()
    expect(handlers.has(IPC.cursorAccountsStartProUpgrade)).toBe(false)
  })
})
