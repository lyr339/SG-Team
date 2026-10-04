import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorAccountVault } from '../src/application/cursor-account-vault'
import { registerCursorAccountIpc } from '../src/main/register-cursor-account-ipc'
import { IPC } from '../src/shared/desktop-api'

const { handlers, switchWithVault } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(), switchWithVault: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (event: unknown, payload: unknown) => Promise<unknown>) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) } }))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: vi.fn() }))
vi.mock('../src/application/cursor-account-switch', () => ({ switchCursorAccountWithVault: switchWithVault }))

describe('restart observation does not own execution', () => {
  let folder: string | undefined; let dispose: (() => void) | undefined
  afterEach(() => { dispose?.(); if (folder) rmSync(folder, { recursive: true, force: true }); handlers.clear(); switchWithVault.mockReset() })
  const setup = (begin: () => string | undefined, finish: (id: string | undefined, success: boolean) => void) => {
    folder = mkdtempSync(join(tmpdir(), 'sg-restart-observer-'))
    const vault = new CursorAccountVault(join(folder, 'test-only-accounts.json'), { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
    const suppress = vi.fn()
    dispose = registerCursorAccountIpc(vault, () => undefined, { suppressCdpAutoHeal: suppress, restartObservation: { begin, finish } })
    return suppress
  }
  it('keeps watchdog-before-stop ordering and returns the original verified result even when notification callbacks fail', async () => {
    const order: string[] = []; const begin = vi.fn(() => { order.push('notification'); throw Error('notification unavailable') })
    const finish = vi.fn(() => { throw Error('notification unavailable') }); const suppress = setup(begin, finish)
    suppress.mockImplementation(() => { order.push('watchdog') })
    const result = { switched: true, runtimeVerified: true, relaunchMode: 'normal' }
    switchWithVault.mockImplementation(async deps => { deps.suppressCdpAutoHeal(); return result })
    expect(await handlers.get(IPC.cursorAccountsRestartWith)!({}, 'account-1')).toBe(result)
    expect(order).toEqual(['watchdog', 'notification']); expect(finish).toHaveBeenCalledWith(undefined, true)
  })
  it('failed original execution is not swallowed or replaced by notification bookkeeping', async () => {
    const begin = vi.fn(() => 'op-1'); const finish = vi.fn(); setup(begin, finish)
    switchWithVault.mockImplementation(async deps => { deps.suppressCdpAutoHeal(); throw Error('original switch failed') })
    await expect(handlers.get(IPC.cursorAccountsRestartWith)!({}, 'account-1')).rejects.toThrow('original switch failed')
    expect(finish).toHaveBeenCalledWith('op-1', false)
  })
  it('validation failure before the existing suppression boundary does not invent a restart operation', async () => {
    const begin = vi.fn(); const finish = vi.fn(); setup(begin, finish)
    await expect(handlers.get(IPC.cursorAccountsRestartWith)!({}, '')).rejects.toThrow()
    expect(switchWithVault).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled()
  })
})
