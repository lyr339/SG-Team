import { describe, expect, it } from 'vitest'
import { CursorSwitchMutex } from '../src/infrastructure/cursor/cursor-switch-mutex'

describe('CursorSwitchMutex', () => {
  it('rejects a competing hot/cold operation immediately and releases after success', async () => {
    const mutex = new CursorSwitchMutex()
    let release!: () => void
    const held = mutex.withLock('无感换号', () => new Promise<void>((resolve) => { release = resolve }))
    await Promise.resolve()
    expect(mutex.locked).toBe(true)
    await expect(mutex.withLock('切换并重启', async () => {})).rejects.toThrow(/无感换号正在进行/)
    release()
    await held
    await expect(mutex.withLock('切换并重启', async () => 'ok')).resolves.toBe('ok')
    expect(mutex.locked).toBe(false)
  })

  it('releases after an exception', async () => {
    const mutex = new CursorSwitchMutex()
    await expect(mutex.withLock('安装切号补丁', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(mutex.locked).toBe(false)
  })
})
