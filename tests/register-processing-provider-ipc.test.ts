import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerProcessingProviderIpc } from '../src/main/register-processing-provider-ipc'
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

describe('处理服务 IPC', () => {
  beforeEach(() => handlers.clear())

  it('按 providerId 路由状态、卡密、账号处理和手动处理', async () => {
    const processToken = vi.fn(async () => ({ providerId: 'henxin' as const, ok: true, message: '处理成功' }))
    const registry = {
      statuses: vi.fn(async () => [
        { providerId: 'aozai', label: '奥仔', unit: 'points', saved: true },
        { providerId: 'henxin', label: '痕心', unit: 'uses', saved: true }
      ]),
      status: vi.fn(async (providerId: string) => ({ providerId, label: '痕心', unit: 'uses', saved: true, remaining: 5 })),
      saveCredential: vi.fn(async (providerId: string) => ({ providerId, label: '痕心', unit: 'uses', saved: true })),
      clearCredential: vi.fn((providerId: string) => ({ providerId, label: '痕心', unit: 'uses', saved: false })),
      require: vi.fn(() => ({ service: { processToken } }))
    }
    const accounts = { credential: vi.fn(() => 'user_abc::jwt') }
    const dispose = registerProcessingProviderIpc(registry as never, accounts as never, () => undefined)
    const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
      Promise.resolve(handlers.get(channel)!({ senderFrame: null }, payload) as T)

    await invoke(IPC.processingGetStatuses)
    await invoke(IPC.processingRefreshBalance, 'henxin')
    await invoke(IPC.processingSaveCredential, { providerId: 'henxin', code: ' CTI-CARD ' })
    await invoke(IPC.processingClearCredential, 'henxin')
    await invoke(IPC.processingProcessAccount, { providerId: 'henxin', accountId: 'acc-1', requestId: 'req-1' })
    await invoke(IPC.processingProcessToken, { providerId: 'henxin', token: ' user_manual::jwt ', requestId: 'req-2' })

    expect(registry.status).toHaveBeenCalledWith('henxin', true)
    expect(registry.saveCredential).toHaveBeenCalledWith('henxin', 'CTI-CARD')
    expect(registry.clearCredential).toHaveBeenCalledWith('henxin')
    expect(accounts.credential).toHaveBeenCalledWith('acc-1')
    expect(processToken).toHaveBeenNthCalledWith(1, 'user_abc::jwt', expect.any(Function))
    expect(processToken).toHaveBeenNthCalledWith(2, 'user_manual::jwt', expect.any(Function))
    dispose()
    expect(handlers.has(IPC.processingGetStatuses)).toBe(false)
  })

  it('拒绝未知服务商和非法参数', async () => {
    const registry = { statuses: vi.fn(), status: vi.fn(), saveCredential: vi.fn(), clearCredential: vi.fn(), require: vi.fn() }
    registerProcessingProviderIpc(registry as never, { credential: vi.fn() } as never, () => undefined)
    const invoke = async (channel: string, payload?: unknown) => handlers.get(channel)!({ senderFrame: null }, payload)
    await expect(invoke(IPC.processingRefreshBalance, 'unknown')).rejects.toThrow(/处理服务无效/)
    await expect(invoke(IPC.processingSaveCredential, { providerId: 'henxin', code: '' })).rejects.toThrow(/卡密无效/)
    await expect(invoke(IPC.processingProcessToken, { providerId: 'henxin', token: '', requestId: 'r' })).rejects.toThrow(/Session Token 无效/)
  })
})
