import { createServer, type RequestListener } from 'node:http'
import { connect, type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  CursorRuntimeAccountBridge,
  type CursorRuntimeSwitchPayload
} from '../src/infrastructure/cursor/cursor-runtime-account-bridge'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** 一条已建立、还没送出任何字节的连接（刚 accept 的补丁轮询在服务端就是这个样子）。 */
async function connectSilently(port: number): Promise<Socket> {
  const socket = connect({ port, host: '127.0.0.1' })
  socket.on('error', () => {})
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  // 客户端 connect 与服务端 accept 是两个事件；等服务端把连接登记进去再往下走。
  await new Promise((resolve) => setTimeout(resolve, 20))
  return socket
}

/**
 * 模拟切号补丁的轮询：同一条 keep-alive 连接上每 100ms 一个 GET /v1/switch，永不停歇——
 * 只有服务端把连接掐断才会停。返回 closed 供断言「是服务端主动关的」。
 */
function pollForever(socket: Socket, key: string): { closed: Promise<void>; stop: () => void } {
  const request = `GET /v1/switch HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Zhimo-Switch-Key: ${key}\r\nConnection: keep-alive\r\n\r\n`
  const send = (): void => { if (!socket.destroyed) socket.write(request) }
  const timer = setInterval(send, 100)
  socket.resume()
  send()
  const closed = new Promise<void>((resolve) => socket.once('close', () => { clearInterval(timer); resolve() }))
  return { closed, stop: () => { clearInterval(timer); socket.destroy() } }
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms))
  ])
}

const payload: CursorRuntimeSwitchPayload = {
  accessToken: 'access.jwt.value',
  refreshToken: 'refresh.jwt.value',
  email: 'next@example.com',
  signUpType: 'Auth_0',
  userId: 'auth0|user_next'
}

describe('CursorRuntimeAccountBridge', () => {
  it('serves a hot-switch payload once on the exact installed endpoint and validates nonce', async () => {
    const port = await freePort()
    const key = 'hot-key'
    const bridge = new CursorRuntimeAccountBridge()
    const pending = bridge.serveOnce(payload, { port, key }, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const response = await fetch(`http://127.0.0.1:${port}/v1/switch`, { headers: { 'X-Zhimo-Switch-Key': key } })
    expect(response.status).toBe(200)
    const received = await response.json() as CursorRuntimeSwitchPayload & { nonce: string }
    expect(received).toMatchObject(payload)
    expect((await fetch(`http://127.0.0.1:${port}/v1/switch`, { headers: { 'X-Zhimo-Switch-Key': key } })).status).toBe(204)
    expect((await fetch(`http://127.0.0.1:${port}/v1/switch-done`, {
      method: 'POST', headers: { 'X-Zhimo-Switch-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: 'wrong', success: true })
    })).status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${port}/v1/switch-done`, {
      method: 'POST', headers: { 'X-Zhimo-Switch-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: received.nonce, success: true, reason: '' })
    })).status).toBe(204)
    await expect(pending).resolves.toEqual({ success: true, reason: '' })
  })

  /**
   * 切号补丁的轮询永不停歇（setInterval 1.5s，keep-alive 复用同一连接）。Node 的 server.close()
   * 只顺手关掉「此刻空闲」的连接：回执瞬间一条刚 accept、请求字节还没到的连接会活下来，
   * 之后每 1.5s 一次的轮询让它永不空闲——close 回调永远不来，serveOnce 永不返回，
   * 上层的互斥锁与自动化收尾随之永久吊住。用「先连上、回执之后才开始轮询」把这个时序钉死。
   */
  it('settles after the ack even when a poller connected right before it and keeps polling on keep-alive', async () => {
    const port = await freePort()
    const key = 'hot-key'
    const bridge = new CursorRuntimeAccountBridge()
    const pending = bridge.serveOnce(payload, { port, key }, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const received = await fetch(`http://127.0.0.1:${port}/v1/switch`, { headers: { 'X-Zhimo-Switch-Key': key } })
      .then((response) => response.json()) as { nonce: string }

    const straggler = await connectSilently(port)
    try {
      expect((await fetch(`http://127.0.0.1:${port}/v1/switch-done`, {
        method: 'POST', headers: { 'X-Zhimo-Switch-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: received.nonce, success: true, reason: '' })
      })).status).toBe(204)
      const poller = pollForever(straggler, key)
      await expect(settlesWithin(pending, 2_000)).resolves.toEqual({ success: true, reason: '' })
      // 残留连接是服务端主动掐断的，不是等客户端自觉。
      await expect(settlesWithin(poller.closed, 1_000)).resolves.toBeUndefined()
    } finally {
      straggler.destroy()
    }
  })

  it('times out promptly even with a silent connection lingering on the server', async () => {
    const port = await freePort()
    const bridge = new CursorRuntimeAccountBridge()
    const pending = bridge.serveOnce(payload, { port, key: 'key' }, 50)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const straggler = await connectSilently(port)
    try {
      await expect(settlesWithin(pending, 2_000)).rejects.toThrow(/没有确认运行时登录态/)
    } finally {
      straggler.destroy()
    }
  })

  it('times out cleanly and rejects an occupied exact hot-switch port', async () => {
    const timeoutPort = await freePort()
    const bridge = new CursorRuntimeAccountBridge()
    await expect(bridge.serveOnce(payload, { port: timeoutPort, key: 'key' }, 20)).rejects.toThrow(/没有确认运行时登录态/)

    const occupiedPort = await freePort()
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(occupiedPort, '127.0.0.1', resolve))
    try {
      await expect(bridge.serveOnce(payload, { port: occupiedPort, key: 'key' }, 100)).rejects.toThrow(/端口.*占用/)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('serves one authenticated payload and waits for Cursor runtime hard acknowledgement', async () => {
    const port = await freePort()
    const key = 'test-switch-key'
    const bridge = new CursorRuntimeAccountBridge({ port, key, timeoutMs: 2_000 })

    const result = await bridge.applyAfterLaunch(payload, async () => {
      const preflight = await fetch(`http://127.0.0.1:${port}/v1/switch`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'vscode-file://vscode-app',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-zhimo-switch-key'
        }
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
      const response = await fetch(`http://127.0.0.1:${port}/v1/switch`, {
        headers: { 'X-Zhimo-Switch-Key': key }
      })
      expect(response.status).toBe(200)
      const received = await response.json() as CursorRuntimeSwitchPayload & { nonce: string }
      expect(received).toMatchObject(payload)
      expect(received.nonce).toBeTruthy()
      const done = await fetch(`http://127.0.0.1:${port}/v1/switch-done`, {
        method: 'POST',
        headers: { 'X-Zhimo-Switch-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: received.nonce, success: true, reason: '' })
      })
      expect(done.status).toBe(204)
      return 'cdp' as const
    })

    expect(result).toEqual({ launchResult: 'cdp', ack: { success: true, reason: '' } })
  })

  it('rejects unauthenticated polling and surfaces a runtime rejection', async () => {
    const port = await freePort()
    const key = 'test-switch-key'
    const bridge = new CursorRuntimeAccountBridge({ port, key, timeoutMs: 2_000 })
    const result = await bridge.applyAfterLaunch(payload, async () => {
      expect((await fetch(`http://127.0.0.1:${port}/v1/switch`)).status).toBe(403)
      const received = await fetch(`http://127.0.0.1:${port}/v1/switch`, {
        headers: { 'X-Zhimo-Switch-Key': key }
      }).then((response) => response.json()) as { nonce: string }
      await fetch(`http://127.0.0.1:${port}/v1/switch-done`, {
        method: 'POST',
        headers: { 'X-Zhimo-Switch-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: received.nonce, success: false, reason: 'readback-mismatch' })
      })
      return 'plain' as const
    })
    expect(result.ack).toEqual({ success: false, reason: 'readback-mismatch' })
  })

  it('fails when Cursor starts but never confirms the target runtime account', async () => {
    const port = await freePort()
    const bridge = new CursorRuntimeAccountBridge({ port, key: 'key', timeoutMs: 15 })
    await expect(bridge.applyAfterLaunch(payload, async () => 'plain' as const))
      .rejects.toThrowError(/没有确认运行时登录态/)
  })

  it('skips an occupied legacy port, prepares the companion for the selected port and completes', async () => {
    const occupiedPort = await freePort()
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(occupiedPort, '127.0.0.1', resolve))
    const prepared: Array<{ port: number; key: string }> = []
    const key = 'range-key'
    const bridge = new CursorRuntimeAccountBridge({
      port: occupiedPort,
      portMax: occupiedPort + 1,
      prepareCompanion: (port, selectedKey) => { prepared.push({ port, key: selectedKey }) },
      key,
      timeoutMs: 2_000
    })
    const result = await bridge.applyAfterLaunch(payload, async () => {
      const selectedPort = occupiedPort + 1
      const received = await fetch(`http://127.0.0.1:${selectedPort}/v1/switch`, {
        headers: { 'X-Zhimo-Switch-Key': key }
      }).then((response) => response.json()) as { nonce: string }
      await fetch(`http://127.0.0.1:${selectedPort}/v1/switch-done`, {
        method: 'POST',
        headers: { 'X-Zhimo-Switch-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: received.nonce, success: true, reason: '' })
      })
      return 'cdp' as const
    })
    expect(result.ack.success).toBe(true)
    expect(prepared).toEqual([{ port: occupiedPort + 1, key }])
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  })

  /**
   * Windows 保留端口（Hyper-V / WSL2 / Docker 的 excludedportrange）让 bind 报 EACCES 而不是
   * EADDRINUSE。本机无法真实复现，注入一个在指定端口上抛 EACCES 的 server 工厂。
   */
  const eaccesOn = (reservedPorts: Set<number>): typeof createServer => ((handler?: RequestListener) => {
    const server = createServer(handler)
    const realListen = server.listen.bind(server)
    server.listen = ((port: number, host: string, callback: () => void) => {
      if (reservedPorts.has(port)) {
        const error = new Error(`listen EACCES: permission denied 127.0.0.1:${port}`) as NodeJS.ErrnoException
        error.code = 'EACCES'
        queueMicrotask(() => server.emit('error', error))
        return server
      }
      return realListen(port, host, callback)
    }) as typeof server.listen
    return server
  }) as typeof createServer

  it('windows: explains a reserved (EACCES) hot-switch port instead of surfacing a raw bind error', async () => {
    const reservedPort = await freePort()
    const bridge = new CursorRuntimeAccountBridge({ createServer: eaccesOn(new Set([reservedPort])) })
    await expect(bridge.serveOnce(payload, { port: reservedPort, key: 'key' }, 100))
      .rejects.toThrow(/被系统保留.*excludedportrange.*重装切号补丁/)
  })

  it('windows: the cold-switch range scan skips reserved (EACCES) ports like occupied ones and keeps the companion on the selected port', async () => {
    const reservedPort = await freePort()
    const prepared: Array<{ port: number; key: string }> = []
    const key = 'range-key'
    const bridge = new CursorRuntimeAccountBridge({
      port: reservedPort,
      portMax: reservedPort + 1,
      prepareCompanion: (port, selectedKey) => { prepared.push({ port, key: selectedKey }) },
      key,
      timeoutMs: 2_000,
      createServer: eaccesOn(new Set([reservedPort]))
    })
    const result = await bridge.applyAfterLaunch(payload, async () => {
      const selectedPort = reservedPort + 1
      const received = await fetch(`http://127.0.0.1:${selectedPort}/v1/switch`, {
        headers: { 'X-Zhimo-Switch-Key': key }
      }).then((response) => response.json()) as { nonce: string }
      await fetch(`http://127.0.0.1:${selectedPort}/v1/switch-done`, {
        method: 'POST',
        headers: { 'X-Zhimo-Switch-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: received.nonce, success: true, reason: '' })
      })
      return 'cdp' as const
    })
    expect(result.ack.success).toBe(true)
    expect(prepared).toEqual([{ port: reservedPort + 1, key }])

    // 整段都被保留：报保留语义（不是「被占用」），并保留错误码给上层。
    const allReserved = new CursorRuntimeAccountBridge({
      port: reservedPort,
      portMax: reservedPort + 1,
      prepareCompanion: () => {},
      key,
      createServer: eaccesOn(new Set([reservedPort, reservedPort + 1]))
    })
    await expect(allReserved.applyAfterLaunch(payload, async () => 'cdp' as const))
      .rejects.toMatchObject({ code: 'EACCES', message: expect.stringMatching(/全部被系统保留/) })
  })
})
