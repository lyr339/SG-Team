import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNativeNotificationPort } from '../src/main/native-notification-port'

const { captured, supported } = vi.hoisted(() => ({ captured: [] as Array<{ options: unknown; show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; emit(event: string, value?: unknown): void }>, supported: vi.fn(() => true) }))
vi.mock('electron', () => ({ Notification: class extends EventEmitter {
  static isSupported = supported
  show = vi.fn(); close = vi.fn()
  constructor(public options: unknown) { super(); captured.push(this) }
} }))
describe('Electron macOS/Windows notice adapter contract (no OS permissions touched)', () => {
  beforeEach(() => { captured.length = 0; supported.mockClear() })
  it.each(['darwin', 'win32'] as const)('performs only a readonly capability query on %s before explicit show', platform => {
    const port = createNativeNotificationPort(platform); expect(port.supported()).toBe(true); expect(supported).toHaveBeenCalledOnce(); expect(captured).toHaveLength(0)
    const clicked = vi.fn(), failed = vi.fn(), closed = vi.fn(), shown = vi.fn()
    const handle = port.show({ title: '拾光', body: '隐私提示', silent: true }, { clicked, failed, closed, shown })
    const native = captured[0]!
    expect(native.options).toEqual({ title: '拾光', body: '隐私提示', silent: true, timeoutType: 'default' }); expect(native.show).toHaveBeenCalledOnce()
    native.emit('click'); native.emit('click'); expect(clicked).toHaveBeenCalledOnce()
    expect(shown).not.toHaveBeenCalled(); native.emit('show'); native.emit('show'); expect(shown).toHaveBeenCalledOnce()
    native.emit('failed'); expect(failed).toHaveBeenCalledOnce(); handle.close(); expect(native.close).toHaveBeenCalledOnce()
    native.emit('close'); expect(closed).not.toHaveBeenCalled()
  })
  it.each([['timedOut', 'timed-out'], ['userCanceled', 'dismissed'], ['applicationHidden', 'programmatic'], ['unrecognized', 'unknown']] as const)('passes only typed Windows close reason %s, never arbitrary OS details', (reason, expected) => {
    const closed = vi.fn()
    createNativeNotificationPort('win32').show({ title: 'fixture', body: 'fixture', silent: true }, { clicked: vi.fn(), failed: vi.fn(), shown: vi.fn(), closed })
    captured[0]!.emit('close', { reason, private: 'do not copy' }); expect(closed).toHaveBeenCalledWith(expected)
  })
  it('preserves a later definite Windows close after banner timeout, without mapping arbitrary data to a dismissal', () => {
    const closed = vi.fn()
    createNativeNotificationPort('win32').show({ title: 'fixture', body: 'fixture', silent: true }, { clicked: vi.fn(), failed: vi.fn(), shown: vi.fn(), closed })
    captured[0]!.emit('close', { reason: 'timedOut' }); captured[0]!.emit('close', { reason: 'userCanceled' })
    expect(closed.mock.calls.map(args => args[0])).toEqual(['timed-out', 'dismissed'])
  })
  it('never probes unsupported platforms or creates a permission test notice', () => {
    expect(createNativeNotificationPort('linux').supported()).toBe(false); expect(supported).not.toHaveBeenCalled(); expect(captured).toHaveLength(0)
  })
})
