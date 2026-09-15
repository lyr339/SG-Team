import { describe, expect, it, vi } from 'vitest'
import { CursorLiveSwitcher } from '../src/infrastructure/cursor/cursor-live-switch'
import { CursorSwitchMutex } from '../src/infrastructure/cursor/cursor-switch-mutex'
import type { CursorDesktopTokenPair } from '../src/infrastructure/cursor/cursor-desktop-token-exchanger'

function jwt(sub: string): string {
  return `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.y`
}

function harness(options: {
  config?: { port: number; key: string; revision: number }
  ack?: { success: boolean; reason: string }
  activateError?: string
} = {}) {
  const order: string[] = []
  const activate = vi.fn((id: string) => {
    order.push(`activate:${id}`)
    if (options.activateError) throw new Error(options.activateError)
  })
  const exchange = vi.fn(async () => {
    order.push('exchange')
    return {
      accessToken: jwt('auth0|next'), refreshToken: 'refresh',
      sourceType: 'web', runtimeType: 'session', exchanged: true
    }
  })
  const serve = vi.fn(async () => {
    order.push('serve')
    return options.ack ?? { success: true, reason: '' }
  })
  const suppress = vi.fn(() => order.push('suppress'))
  const service = new CursorLiveSwitcher({
    vault: {
      credential: () => 'web-token',
      list: () => [{ id: 'next', label: 'next@example.com（网页登录）' }],
      activateAfterLiveSwitch: activate
    },
    exchanger: { resolve: exchange },
    bridge: { serveOnce: serve },
    installer: { readInstalledConfig: async () => options.config ?? { port: 51_824, key: 'key', revision: 2 } },
    mutex: new CursorSwitchMutex(),
    suppressRuntimeWatch: suppress,
    stateDatabasePath: '/state.vscdb'
  })
  return { service, order, activate, exchange, serve, suppress }
}

describe('CursorLiveSwitcher', () => {
  it('checks the pump first, then exchanges and serves under one lock, committing vault only after ack', async () => {
    const h = harness()
    await expect(h.service.switchLive({ accountId: 'next' })).resolves.toEqual({ switched: true })
    expect(h.order).toEqual(['exchange', 'suppress', 'serve', 'activate:next'])
    expect(h.exchange).toHaveBeenCalledWith('web-token', '/state.vscdb')
    expect(h.serve).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: jwt('auth0|next'), refreshToken: 'refresh', userId: 'auth0|next',
      signUpType: 'Auth_0', email: 'next@example.com'
    }), { port: 51_824, key: 'key' }, 12_000)
  })

  it('does not exchange tokens when the pump is absent', async () => {
    const h = harness({ config: undefined })
    // Explicitly replace the defaulted fixture config with an absent installer response.
    const service = new CursorLiveSwitcher({
      vault: { credential: () => 'web', list: () => [], activateAfterLiveSwitch: h.activate },
      exchanger: { resolve: h.exchange }, bridge: { serveOnce: h.serve },
      installer: { readInstalledConfig: async () => undefined }, mutex: new CursorSwitchMutex()
    })
    expect(await service.switchLive({ accountId: 'next' })).toMatchObject({ switched: false, reason: expect.stringContaining('未安装') })
    expect(h.exchange).not.toHaveBeenCalled()
    expect(h.serve).not.toHaveBeenCalled()
  })

  it('keeps vault unchanged when Cursor rejects or the bridge throws', async () => {
    const rejected = harness({ ack: { success: false, reason: 'readback-mismatch' } })
    expect(await rejected.service.switchLive({ accountId: 'next' })).toMatchObject({ switched: false, reason: expect.stringContaining('readback-mismatch') })
    expect(rejected.activate).not.toHaveBeenCalled()

    const throwing = harness()
    throwing.serve.mockRejectedValueOnce(new Error('端口占用'))
    expect(await throwing.service.switchLive({ accountId: 'next' })).toEqual({ switched: false, reason: '端口占用' })
    expect(throwing.activate).not.toHaveBeenCalled()
  })

  it('reports an honest partial success when Cursor switched but the atomic vault commit failed', async () => {
    const h = harness({ activateError: 'disk full' })
    expect(await h.service.switchLive({ accountId: 'next' })).toEqual({
      switched: true,
      warning: 'Cursor 已完成换号，但拾光本地账号状态同步失败：disk full'
    })
  })

  it('keeps prewarming read-only, then holds the mutex only while committing to Cursor', async () => {
    const mutex = new CursorSwitchMutex()
    let finishExchange!: (value: CursorDesktopTokenPair) => void
    let finishAck!: (value: { success: boolean; reason: string }) => void
    const service = new CursorLiveSwitcher({
      vault: { credential: () => 'web', list: () => [], activateAfterLiveSwitch: () => {} },
      exchanger: { resolve: () => new Promise((resolve) => { finishExchange = resolve }) },
      bridge: { serveOnce: () => new Promise((resolve) => { finishAck = resolve }) },
      installer: { readInstalledConfig: async () => ({ port: 51_824, key: 'key', revision: 2 }) },
      mutex
    })
    const preparing = service.prepare({ accountId: 'next' })
    await Promise.resolve()
    await expect(mutex.withLock('切换并重启', async () => {})).resolves.toBeUndefined()
    finishExchange({
      accessToken: jwt('next'), refreshToken: 'refresh',
      sourceType: 'web', runtimeType: 'session', exchanged: true
    })
    const prepared = await preparing
    const committing = prepared.commit()
    await Promise.resolve()
    await expect(mutex.withLock('切换并重启', async () => {})).rejects.toThrow(/无感换号正在进行/)
    finishAck({ success: true, reason: '' })
    await committing
  })

  it('keeps the manual switch entry mutually exclusive from exchange through commit', async () => {
    const mutex = new CursorSwitchMutex()
    let finishExchange!: (value: CursorDesktopTokenPair) => void
    const service = new CursorLiveSwitcher({
      vault: { credential: () => 'web', list: () => [], activateAfterLiveSwitch: () => {} },
      exchanger: { resolve: () => new Promise((resolve) => { finishExchange = resolve }) },
      bridge: { serveOnce: async () => ({ success: true, reason: '' }) },
      installer: { readInstalledConfig: async () => ({ port: 51_824, key: 'key', revision: 2 }) },
      mutex
    })
    const switching = service.switchLive({ accountId: 'next' })
    await Promise.resolve()
    await expect(mutex.withLock('切换并重启', async () => {})).rejects.toThrow(/无感换号正在进行/)
    finishExchange({
      accessToken: jwt('next'), refreshToken: 'refresh',
      sourceType: 'web', runtimeType: 'session', exchanged: true
    })
    await switching
  })

  it('marks only a missing hard receipt as retryable', async () => {
    const timeout = harness()
    timeout.serve.mockRejectedValueOnce(new Error('Cursor 切号补丁在 12 秒内没有确认运行时登录态'))
    await expect(timeout.service.switchLive({ accountId: 'next' })).resolves.toMatchObject({
      switched: false,
      retryable: true
    })
    const occupied = harness()
    occupied.serve.mockRejectedValueOnce(new Error('切号泵端口 51824 被占用'))
    await expect(occupied.service.switchLive({ accountId: 'next' })).resolves.toEqual({
      switched: false,
      reason: '切号泵端口 51824 被占用'
    })
  })

  it('drops a prepared switch when the source credential changed before commit', async () => {
    let sourceToken = 'web-token-v1'
    const serve = vi.fn(async () => ({ success: true, reason: '' }))
    const service = new CursorLiveSwitcher({
      vault: {
        credential: () => sourceToken,
        list: () => [{ id: 'next', label: 'next@example.com' }],
        activateAfterLiveSwitch: () => {}
      },
      exchanger: {
        resolve: async () => ({
          accessToken: jwt('next'), refreshToken: 'refresh',
          sourceType: 'web', runtimeType: 'session', exchanged: true
        })
      },
      bridge: { serveOnce: serve },
      installer: { readInstalledConfig: async () => ({ port: 51_824, key: 'key', revision: 2 }) },
      mutex: new CursorSwitchMutex()
    })
    const prepared = await service.prepare({ accountId: 'next' })
    sourceToken = 'web-token-v2'
    await expect(prepared.commit()).resolves.toMatchObject({
      switched: false,
      reason: expect.stringContaining('凭据已更新')
    })
    expect(serve).not.toHaveBeenCalled()
  })
})
