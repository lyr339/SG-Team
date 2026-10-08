import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { CursorProtocolStore } from '../src/infrastructure/cursor/cursor-protocol-store'
import type { CursorProtocolQuotaReader } from '../src/infrastructure/cursor/cursor-protocol-quota'
import { registerCursorProtocolIpc } from '../src/main/register-cursor-protocol-ipc'
import { IPC } from '../src/shared/desktop-api'

const { handlers, showOpenDialog } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), showOpenDialog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, run: (...args: unknown[]) => unknown) => handlers.set(key, run), removeHandler: (key: string) => handlers.delete(key) }, dialog: { showOpenDialog } }))
afterEach(() => { handlers.clear(); vi.clearAllMocks() })
describe('read-only protocol IPC ownership', () => {
  it('rejects another renderer and a child frame even when webContents is shared', async () => {
    const mainFrame = {}, sender = { mainFrame }, window = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow
    const load = vi.fn(), read = vi.fn()
    const dispose = registerCursorProtocolIpc({ load } as unknown as CursorProtocolStore, () => window, { read } as unknown as CursorProtocolQuotaReader)
    for (const key of [IPC.cursorProtocolGet, IPC.cursorProtocolImport, IPC.cursorProtocolQuota]) {
      for (const event of [{ sender: {}, senderFrame: mainFrame }, { sender, senderFrame: {} }]) await expect(Promise.resolve().then(() => handlers.get(key)!(event))).rejects.toThrow('只能从拾光')
    }
    expect(load).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(showOpenDialog).not.toHaveBeenCalled()
    dispose(); expect(handlers.size).toBe(0)
  })
})
