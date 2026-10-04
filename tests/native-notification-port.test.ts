import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNativeNotificationPort } from '../src/main/native-notification-port'

const { captured, supported } = vi.hoisted(() => ({ captured: [] as Array<{ options: unknown; show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; emit(event: string): void }>, supported: vi.fn(() => true) }))
vi.mock('electron', () => ({ Notification: class extends EventEmitter {
  static isSupported = supported
  show = vi.fn(); close = vi.fn()
  constructor(public options: unknown) { super(); captured.push(this) }
} }))
describe('Electron macOS/Windows notice adapter contract (no OS permissions touched)', () => {
  beforeEach(() => { captured.length = 0; supported.mockClear() })
  it.each(['darwin', 'win32'] as const)('performs only a readonly capability query on %s before explicit show', platform => {
    const port = createNativeNotificationPort(platform); expect(port.supported()).toBe(true); expect(supported).toHaveBeenCalledOnce(); expect(captured).toHaveLength(0)
    const clicked = vi.fn(), failed = vi.fn(), closed = vi.fn()
    const handle = port.show({ title: '拾光', body: '隐私提示', silent: true }, { clicked, failed, closed })
    const native = captured[0]!
    expect(native.options).toEqual({ title: '拾光', body: '隐私提示', silent: true, timeoutType: 'default' }); expect(native.show).toHaveBeenCalledOnce()
    native.emit('click'); native.emit('click'); expect(clicked).toHaveBeenCalledOnce()
    native.emit('failed'); expect(failed).toHaveBeenCalledOnce(); handle.close(); expect(native.close).toHaveBeenCalledOnce()
    native.emit('close'); expect(closed).not.toHaveBeenCalled()
  })
  it('never probes unsupported platforms or creates a permission test notice', () => {
    expect(createNativeNotificationPort('linux').supported()).toBe(false); expect(supported).not.toHaveBeenCalled(); expect(captured).toHaveLength(0)
  })
})
