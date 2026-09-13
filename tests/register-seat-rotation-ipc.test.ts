import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SeatRotationSettingsStore } from '../src/application/seat-rotation-settings-store'
import { registerSeatRotationIpc } from '../src/main/register-seat-rotation-ipc'
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

describe('席位自动轮换 IPC', () => {
  it('读取即 store.load；保存归一化后回传，并通知服务按新设置立刻评估；dispose 撤销处理器', () => {
    handlers.clear()
    const store = new SeatRotationSettingsStore(join(mkdtempSync(join(tmpdir(), 'sg-seat-rotation-ipc-')), 'seat-rotation.json'))
    const onSettingsSaved = vi.fn()
    const dispose = registerSeatRotationIpc(store, () => undefined, { onSettingsSaved })
    const invoke = (channel: string, payload?: unknown): unknown => handlers.get(channel)!({ senderFrame: null }, payload)

    expect(invoke(IPC.seatRotationGetSettings)).toEqual({ enabled: true, bubbleThreshold: 400 })
    expect(invoke(IPC.seatRotationSaveSettings, { enabled: false, bubbleThreshold: 620 })).toEqual({ enabled: false, bubbleThreshold: 600 })
    expect(onSettingsSaved).toHaveBeenCalledTimes(1)
    expect(invoke(IPC.seatRotationGetSettings)).toEqual({ enabled: false, bubbleThreshold: 600 })
    // 垃圾输入按默认值落盘，不抛错
    expect(invoke(IPC.seatRotationSaveSettings, 'garbage')).toEqual({ enabled: true, bubbleThreshold: 400 })

    dispose()
    expect(handlers.has(IPC.seatRotationGetSettings)).toBe(false)
    expect(handlers.has(IPC.seatRotationSaveSettings)).toBe(false)
  })
})
