import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CursorStorageScanner } from '../src/infrastructure/cursor/cursor-storage-scanner'
import { registerCursorStorageIpc } from '../src/main/register-cursor-storage-ipc'
import { IPC } from '../src/shared/desktop-api'

const { handlers, shell } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  shell: { showItemInFolder: vi.fn() }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name)
  },
  shell
}))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: vi.fn() }))

function harness(workbenchBundlePath?: string) {
  handlers.clear()
  shell.showItemInFolder.mockClear()
  const scanner = {
    scan: vi.fn(async (input?: { chatHistoryOlderThanDays?: number }) => ({ input })),
    cleanup: vi.fn(async (request: unknown) => ({ request }))
  }
  const dispose = registerCursorStorageIpc(
    scanner as unknown as CursorStorageScanner,
    { userDataRoot: '/Users/demo/Library/Application Support/Cursor', workbenchBundlePath },
    () => undefined
  )
  const invoke = (channel: string, payload?: unknown): unknown => handlers.get(channel)!({ senderFrame: null }, payload)
  return { scanner, dispose, invoke }
}

describe('存储清理 IPC', () => {
  it('盘点：阈值只接受目录里的档位，其他一律按默认；清理：过滤未知项、校验档位、布尔化压实开关', async () => {
    const { scanner, invoke } = harness()
    await invoke(IPC.cursorStorageScan, { chatHistoryOlderThanDays: 30 })
    await invoke(IPC.cursorStorageScan, { chatHistoryOlderThanDays: 45 })
    await invoke(IPC.cursorStorageScan, 'garbage')
    expect(scanner.scan.mock.calls.map(([input]) => input)).toEqual([{ chatHistoryOlderThanDays: 30 }, {}, {}])

    await invoke(IPC.cursorStorageCleanup, { ids: ['snapshots', 'bogus', 42, 'chat-history'], chatHistoryOlderThanDays: 180, compactDatabase: 'yes' })
    expect(scanner.cleanup).toHaveBeenCalledWith({ ids: ['snapshots', 'chat-history'], chatHistoryOlderThanDays: 180, compactDatabase: false })
    await invoke(IPC.cursorStorageCleanup, { ids: ['logs'], chatHistoryOlderThanDays: 7, compactDatabase: true })
    expect(scanner.cleanup).toHaveBeenLastCalledWith({ ids: ['logs'], compactDatabase: true })
  })

  it('一个合法项都没有时拒绝执行，而不是把空请求交给扫描器', async () => {
    const { scanner, invoke } = harness()
    await expect(Promise.resolve().then(() => invoke(IPC.cursorStorageCleanup, { ids: ['bogus'] }))).rejects.toThrow('没有选择任何清理项')
    await expect(Promise.resolve().then(() => invoke(IPC.cursorStorageCleanup, null))).rejects.toThrow('没有选择任何清理项')
    expect(scanner.cleanup).not.toHaveBeenCalled()
  })

  it('定位：各项映射到用户数据目录下的真实路径；遗留补丁指向 bundle；未知项拒绝', async () => {
    const bundle = '/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js'
    const { invoke, dispose } = harness(bundle)
    const root = '/Users/demo/Library/Application Support/Cursor'
    // 定位路径由注册器用宿主 path.join 拼出：Windows runner 上是反斜杠，期望值也用 join 生成。
    for (const [id, expected] of [
      ['chat-history', join(root, 'User', 'globalStorage', 'state.vscdb')],
      ['stale-backups', join(root, 'User', 'globalStorage', 'state.vscdb')],
      ['snapshots', join(root, 'snapshots')],
      ['local-history', join(root, 'User', 'History')],
      ['orphan-workspaces', join(root, 'User', 'workspaceStorage')],
      ['caches', join(root, 'Cache')],
      ['logs', join(root, 'logs')],
      ['legacy-patch', bundle]
    ] as const) {
      shell.showItemInFolder.mockClear()
      await invoke(IPC.cursorStorageReveal, id)
      expect(shell.showItemInFolder).toHaveBeenCalledWith(expected)
    }
    expect(() => invoke(IPC.cursorStorageReveal, 'bogus')).toThrow('未知的清理项')
    expect(() => invoke(IPC.cursorStorageReveal, 7)).toThrow('未知的清理项')

    dispose()
    expect(handlers.size).toBe(0)
  })

  it('没有 bundle 路径时，遗留补丁的定位退回用户数据目录', async () => {
    const { invoke } = harness(undefined)
    await invoke(IPC.cursorStorageReveal, 'legacy-patch')
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/Users/demo/Library/Application Support/Cursor')
  })
})
