import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CursorAccountVault, type CursorAccountVaultCrypto } from '../src/application/cursor-account-vault'
import { registerCursorAccountIpc } from '../src/main/register-cursor-account-ipc'
import { PageOperationNotifications, type PageOperationObserver } from '../src/application/notifications/page-operation-notifications'
import { notificationSourceHarness } from './notification-source-fixtures'
import { IPC } from '../src/shared/desktop-api'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (event: unknown, payload?: unknown) => unknown) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) } }))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: vi.fn() }))
const crypto: CursorAccountVaultCrypto = { available: () => true, encrypt: value => Buffer.from(value).reverse(), decrypt: value => Buffer.from(value).reverse().toString() }
const notificationId = '11d31976-5887-4eaa-9805-45a85b1a1a44'
const card = (expires = 1): string => {
  const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'auth0|user_test', exp: expires })).toString('base64url')}.sig`
  return `private@example.com----mail-secret----cursor-secret--------backup-secret----user_test::${jwt}`
}
describe('actual account and maintenance IPC effects into private notifications', () => {
  let folder: string
  beforeEach(() => { handlers.clear(); folder = mkdtempSync(join(tmpdir(), 'sg-page-op-account-test-')) })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))
  const invoke = (channel: string, value?: unknown) => handlers.get(channel)!({}, value)
  it('expired-card login failure preserves the saved account and original error facts while recording only safe partial outcome', async () => {
    const h = notificationSourceHarness(), notifications = new PageOperationNotifications(h.owner), vault = new CursorAccountVault(join(folder, 'vault.json'), crypto)
    const login = vi.fn(async () => { throw Error('credential cursor-secret user_test::opaque private@example.com') })
    const dispose = registerCursorAccountIpc(vault, () => undefined, { operations: notifications, loginWithCredentials: login })
    try {
      await notifications.flush()
      const result = await invoke(IPC.cursorAccountsSaveCard, { card: card(), notificationId }) as { accountId: string; loginError: string; notification: { key: string } }
      await notifications.flush(); expect(vault.list()).toHaveLength(1); expect(login).toHaveBeenCalledOnce(); expect(result.loginError).toContain('cursor-secret')
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'partial', scope: { accountId: result.accountId }, title: '账号卡已保存，登录仍未完成' })
      const stored = JSON.stringify(h.ledger.page()); expect(stored).not.toContain('cursor-secret'); expect(stored).not.toContain('private@example.com'); expect(stored).not.toContain('opaque')
    } finally { dispose(); notifications.dispose(); await h.owner.close() }
  })
  it('fingerprint import calls the original provider once and retains real account/window binding and original array response', async () => {
    const h = notificationSourceHarness(), notifications = new PageOperationNotifications(h.owner), vault = new CursorAccountVault(join(folder, 'vault.json'), crypto)
    const read = vi.fn(async () => ({ token: 'user_test::opaque-test-token', userId: 'user_test', profileId: 'actual-window', browserName: 'Roxy' }))
    const dispose = registerCursorAccountIpc(vault, () => undefined, { operations: notifications, importFromFingerprint: read })
    try {
      await notifications.flush(); const result = await invoke(IPC.cursorAccountsImportFromFingerprint, { notificationId }); await notifications.flush()
      expect(Array.isArray(result)).toBe(true); expect(read).toHaveBeenCalledOnce(); expect(vault.list()[0]?.fingerprintProfileId).toBe('actual-window')
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'success', scope: { accountId: vault.list()[0]!.id }, origin: { section: 'import' } })
      expect(JSON.stringify(h.ledger.page())).not.toContain('opaque-test-token')
    } finally { dispose(); notifications.dispose(); await h.owner.close() }
  })
  it('awaiting checkout is not a confirmed payment, and a broken observer never repeats login or changes its return', async () => {
    const h = notificationSourceHarness(), notifications = new PageOperationNotifications(h.owner), vault = new CursorAccountVault(join(folder, 'vault.json'), crypto)
    const upgrade = vi.fn(async () => ({ outcome: 'awaiting_payment' as const, detail: 'original detail: await QR payment' }))
    const dispose = registerCursorAccountIpc(vault, () => undefined, { operations: notifications, startProUpgrade: upgrade })
    try {
      await notifications.flush(); const result = await invoke(IPC.cursorAccountsStartProUpgrade, { accountId: 'requested-account', notificationId }) as { outcome: string; detail: string }
      await notifications.flush(); expect(result.outcome).toBe('awaiting_payment'); expect(result.detail).toContain('original detail'); expect(upgrade).toHaveBeenCalledExactlyOnceWith('requested-account')
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'waiting', attention: 'notice', scope: { accountId: 'requested-account' }, state: 'active' })
      expect(h.ledger.page().summary.pending).toBe(0)
    } finally { dispose(); notifications.dispose(); await h.owner.close() }
  })
  it('verified checkout is the pre-submit test gate, never a paid membership confirmation', async () => {
    const h = notificationSourceHarness(), notifications = new PageOperationNotifications(h.owner), vault = new CursorAccountVault(join(folder, 'vault.json'), crypto)
    const upgrade = vi.fn(async () => ({ outcome: 'verified' as const, detail: 'form verified before submission' }))
    const dispose = registerCursorAccountIpc(vault, () => undefined, { operations: notifications, startProUpgrade: upgrade })
    try {
      await notifications.flush(); const result = await invoke(IPC.cursorAccountsStartProUpgrade, { accountId: 'frozen-account', notificationId }); await notifications.flush()
      expect(result).toMatchObject({ outcome: 'verified', detail: 'form verified before submission' })
      expect(h.ledger.page().records[0]).toMatchObject({ title: '结账资料已复核，尚未提交付款', tone: 'info', state: 'resolved' })
      expect(h.ledger.page().records[0]?.detail).toContain('没有据此确认支付成功或账号档位')
      expect(upgrade).toHaveBeenCalledOnce()
    } finally { dispose(); notifications.dispose(); await h.owner.close() }
  })
  it('patch warnings stay distinct from actual ok/changed and the original install mutex/call is not bypassed', async () => {
    const h = notificationSourceHarness(), notifications = new PageOperationNotifications(h.owner), vault = new CursorAccountVault(join(folder, 'vault.json'), crypto)
    const ensure = vi.fn(async () => ({ ok: true, changed: true, message: 'files modified', warning: 'signature unconfirmed' }))
    const lock = vi.fn(async (_label: string, fn: () => unknown) => fn())
    const dispose = registerCursorAccountIpc(vault, () => undefined, { operations: notifications, switchPumpInstaller: { ensure, status: vi.fn(), remove: vi.fn() }, switchMutex: { withLock: lock } as never })
    try {
      await notifications.flush(); const result = await invoke(IPC.cursorSwitchPumpEnsure, { notificationId }) as { ok: boolean; changed: boolean; warning: string }
      await notifications.flush(); expect(result).toMatchObject({ ok: true, changed: true, warning: 'signature unconfirmed' }); expect(ensure).toHaveBeenCalledOnce(); expect(lock).toHaveBeenCalledOnce()
      expect(h.ledger.page().records[0]).toMatchObject({ subjectState: 'partial', tone: 'warning', origin: { section: 'maintenance' } })
    } finally { dispose(); notifications.dispose(); await h.owner.close() }
  })
  it('observer failure before or after effects cannot turn a successful original response into an error/retry', async () => {
    const h = notificationSourceHarness(), vault = new CursorAccountVault(join(folder, 'vault.json'), crypto), read = vi.fn(async () => ({ token: 'user_test::opaque', profileId: 'actual-window' }))
    const observer: PageOperationObserver = { begin: () => { throw Error('display unavailable') } }
    const dispose = registerCursorAccountIpc(vault, () => undefined, { operations: observer, importFromFingerprint: read })
    try { const result = await invoke(IPC.cursorAccountsImportFromFingerprint); expect(Array.isArray(result)).toBe(true); expect(read).toHaveBeenCalledOnce(); expect(vault.list()).toHaveLength(1) }
    finally { dispose(); await h.owner.close() }
  })
})
