import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAozaiIpc } from '../src/main/register-aozai-ipc'
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

describe('奥仔 IPC', () => {
  beforeEach(() => handlers.clear())

  it('点数字段原样穿过 IPC；更换与清除卡密都会作废旧 Bearer', async () => {
    const events: string[] = []
    let masked: string | undefined = '••••old1'
    const cardVault = {
      maskedCode: () => masked,
      save: (code: string) => { events.push(`save:${code}`); masked = '••••new2'; return masked },
      clear: () => { events.push('clear'); masked = undefined }
    }
    const service = {
      resetAuthorization: vi.fn(() => events.push('reset')),
      verifyCard: vi.fn(async () => {
        events.push('verify')
        return { remainingPoints: 87, maxPoints: 100, pointsPerOperation: 3 }
      }),
      refreshBalance: vi.fn(async () => ({ remainingPoints: 84, usedPoints: 16, maxPoints: 100, pointsPerOperation: 3 })),
      processToken: vi.fn()
    }
    const dispose = registerAozaiIpc(cardVault as never, service as never, { credential: vi.fn() } as never, () => undefined)
    const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
      Promise.resolve(handlers.get(channel)!({ senderFrame: null }, payload) as T)

    await expect(invoke(IPC.aozaiGetCardStatus)).resolves.toEqual({ saved: true, maskedCode: '••••old1' })
    await expect(invoke(IPC.aozaiRefreshBalance)).resolves.toEqual({
      saved: true,
      maskedCode: '••••old1',
      remainingPoints: 84,
      usedPoints: 16,
      maxPoints: 100,
      pointsPerOperation: 3
    })
    await expect(invoke(IPC.aozaiSaveCard, ' CARD-new2 ')).resolves.toEqual({
      saved: true,
      maskedCode: '••••new2',
      remainingPoints: 87,
      maxPoints: 100,
      pointsPerOperation: 3
    })
    expect(events.slice(0, 3)).toEqual(['reset', 'verify', 'save:CARD-new2'])

    await expect(invoke(IPC.aozaiClearCard)).resolves.toEqual({ saved: false })
    expect(events.slice(-2)).toEqual(['reset', 'clear'])
    dispose()
    expect(handlers.has(IPC.aozaiSaveCard)).toBe(false)
  })

  it('验证成功但本地保存失败时再次作废 Bearer', async () => {
    const service = {
      resetAuthorization: vi.fn(),
      verifyCard: vi.fn(async () => ({ remainingPoints: 87 })),
      refreshBalance: vi.fn(),
      processToken: vi.fn()
    }
    registerAozaiIpc({
      maskedCode: () => undefined,
      save: () => { throw new Error('safeStorage 写入失败') },
      clear: vi.fn()
    } as never, service as never, { credential: vi.fn() } as never, () => undefined)
    const invoke = () => Promise.resolve(handlers.get(IPC.aozaiSaveCard)!({ senderFrame: null }, 'CARD-new2'))
    await expect(invoke()).rejects.toThrow(/safeStorage 写入失败/)
    expect(service.resetAuthorization).toHaveBeenCalledTimes(2)
  })
})
