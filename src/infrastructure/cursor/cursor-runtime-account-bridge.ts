import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { CursorRuntimeCompanionConfig, locateCursorRuntimeCompanionBundle } from './cursor-runtime-companion-config'

/** 51823 是旧织梦桌面的固定端口；拾光使用独立范围并同步改写 Cursor Companion。 */
export const CURSOR_RUNTIME_SWITCH_PORT = 51_824
export const CURSOR_RUNTIME_SWITCH_PORT_MAX = 51_839
export const CURSOR_RUNTIME_SWITCH_KEY = '5f17ca98b1da1798b10261c4da6dd5e1642a064433a4ca90'

export interface CursorRuntimeSwitchPayload {
  accessToken: string
  refreshToken: string
  email?: string
  signUpType: string
  userId: string
}

export interface CursorRuntimeSwitchAck {
  success: boolean
  reason: string
}

export interface CursorRuntimeAccountBridgePort {
  applyAfterLaunch<Result>(
    payload: CursorRuntimeSwitchPayload,
    launch: () => Promise<Result>,
    bundlePath?: string
  ): Promise<{ launchResult: Result; ack: CursorRuntimeSwitchAck }>
}

/**
 * 热切（无感换号）专用：在指定端口/密钥上把票据挂出去，等运行中的 Cursor
 * 切号补丁按自己内嵌配置轮询取走并回执。
 *
 * 关键约束：运行中的补丁轮询的是它启动时读到的 port/key——热切绝不能改写
 * bundle（写了运行中那份也不会重读），必须原样绑定补丁当前配置；端口被占用
 * （如小辰桌面的常驻服务）直接向调用方抛错，由上层降级。
 */
export interface CursorRuntimeQueuePort {
  serveOnce(
    payload: CursorRuntimeSwitchPayload,
    endpoint: { port: number; key: string },
    timeoutMs?: number
  ): Promise<CursorRuntimeSwitchAck>
}

interface PendingAck extends CursorRuntimeSwitchAck {
  nonce?: string
}

/**
 * 端口不可用的两种错误码：EADDRINUSE = 被别的进程占着；EACCES = 系统不允许绑定——
 * Windows 上 Hyper-V / WSL2 / Docker Desktop 会整段保留动态端口（49152–65535 内常见），
 * 撞上保留段 bind 报的就是它（WSAEACCES 10013，`netsh int ipv4 show excludedportrange
 * protocol=tcp` 可查）。两者对调用方语义一致：这个端口用不了，能换就换。
 */
type PortUnavailableCode = 'EADDRINUSE' | 'EACCES'

function portUnavailableCode(error: unknown): PortUnavailableCode | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EADDRINUSE' || code === 'EACCES' ? code : undefined
}

const RESERVED_PORT_HINT = 'Windows 上常见于 Hyper-V / WSL2 / Docker 保留的动态端口段，可用 netsh int ipv4 show excludedportrange protocol=tcp 查看'

/** 保留原始错误码：serveOnce 据此给出精确到单端口的人话提示。 */
function portUnavailableError(code: PortUnavailableCode, firstPort: number, lastPort: number): NodeJS.ErrnoException {
  const range = firstPort === lastPort ? `端口 ${firstPort}` : `端口 ${firstPort}-${lastPort} 全部`
  const error: NodeJS.ErrnoException = new Error(code === 'EADDRINUSE'
    ? `Cursor 运行时换号${range}被占用`
    : `Cursor 运行时换号${range}被系统保留，无法绑定（${RESERVED_PORT_HINT}）`)
  error.code = code
  return error
}

/**
 * Cursor Companion 运行时换号桥。
 *
 * 当前 Cursor workbench 内置的 Companion 每 1.5s 轮询 GET /v1/switch，收到
 * payload 后通过 Cursor 自己的 authenticationService 写入 Token、通知登录监听器、
 * 刷新会员状态并 flush，最后 POST /v1/switch-done。拾光必须等这个硬回执，不能把
 * “离线改过 state.vscdb”误报成切换成功。
 */
export class CursorRuntimeAccountBridge implements CursorRuntimeAccountBridgePort, CursorRuntimeQueuePort {
  constructor(private readonly options: {
    port?: number
    portMax?: number
    key?: string
    timeoutMs?: number
    prepareCompanion?: (port: number, key: string) => void | Promise<void>
    /** 测试注入：模拟 bind 失败（如 Windows 保留端口的 EACCES，本机无法真实复现）。 */
    createServer?: typeof createServer
  } = {}) {}

  async applyAfterLaunch<Result>(
    payload: CursorRuntimeSwitchPayload,
    launch: () => Promise<Result>,
    bundlePath?: string
  ): Promise<{ launchResult: Result; ack: CursorRuntimeSwitchAck }> {
    const key = this.options.key ?? CURSOR_RUNTIME_SWITCH_KEY
    const timeoutMs = this.options.timeoutMs ?? 30_000
    const opened = await this.openSwitchServer(payload, {
      firstPort: this.options.port ?? CURSOR_RUNTIME_SWITCH_PORT,
      lastPort: this.options.portMax ?? (this.options.port === undefined ? CURSOR_RUNTIME_SWITCH_PORT_MAX : this.options.port),
      key
    })
    const prepareCompanion = this.options.prepareCompanion
      ?? (this.options.port === undefined
        ? async (selectedPort: number, selectedKey: string) => {
            const path = bundlePath ?? await locateCursorRuntimeCompanionBundle()
            if (!path) throw new Error('未找到 Cursor 主程序 bundle')
            new CursorRuntimeCompanionConfig(path).ensure({ port: selectedPort, key: selectedKey })
          }
        : undefined)

    try {
      await prepareCompanion?.(opened.port, key)
      const launchResult = await launch()
      const ack = await opened.waitAck(timeoutMs)
      return { launchResult, ack }
    } finally {
      await opened.close()
    }
  }

  /**
   * 热切路径：绑定补丁当前配置的端口/密钥（精确端口，不扫范围），不触碰 bundle。
   * 端口被占用时抛出带原因的 Error（调用方降级为跳过/冷切换提示）。
   */
  async serveOnce(
    payload: CursorRuntimeSwitchPayload,
    endpoint: { port: number; key: string },
    timeoutMs = 12_000
  ): Promise<CursorRuntimeSwitchAck> {
    const opened = await this.openSwitchServer(payload, {
      firstPort: endpoint.port,
      lastPort: endpoint.port,
      key: endpoint.key
    }).catch((error: unknown) => {
      const code = portUnavailableCode(error)
      if (code === 'EADDRINUSE') {
        throw new Error(`切号泵端口 ${endpoint.port} 被占用（是否有其他换号服务正在运行？）`)
      }
      if (code === 'EACCES') {
        // 端口烧在补丁里，拾光这边换不了：只能提示用户换端口重装补丁（并重启 Cursor）。
        throw new Error(`切号泵端口 ${endpoint.port} 被系统保留，无法绑定（${RESERVED_PORT_HINT}；需换端口重装切号补丁并重启 Cursor）`)
      }
      throw error
    })
    try {
      return await opened.waitAck(timeoutMs)
    } finally {
      await opened.close()
    }
  }

  /** 起服务器并把票据挂成待取件：补丁取走一次即交付（delivered 幂等，防轮询重复执行）。 */
  private async openSwitchServer(
    payload: CursorRuntimeSwitchPayload,
    range: { firstPort: number; lastPort: number; key: string }
  ): Promise<{
    port: number
    waitAck: (timeoutMs: number) => Promise<CursorRuntimeSwitchAck>
    close: () => Promise<void>
  }> {
    const nonce = randomUUID()
    let completed = false
    let delivered = false
    let resolveAck!: (ack: CursorRuntimeSwitchAck) => void
    const ackPromise = new Promise<CursorRuntimeSwitchAck>((resolve) => { resolveAck = resolve })

    const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
      if (request.method === 'OPTIONS') {
        this.respond(response, 204)
        return
      }
      if (request.headers['x-zhimo-switch-key'] !== range.key) {
        this.respond(response, 403)
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/switch') {
        if (completed || delivered) {
          this.respond(response, 204)
          return
        }
        delivered = true
        this.respond(response, 200, { ...payload, nonce })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/switch-done') {
        void this.readJson(request).then((value) => {
          if (value.nonce !== nonce || typeof value.success !== 'boolean') {
            this.respond(response, 400)
            return
          }
          completed = true
          const ack = {
            success: value.success,
            reason: typeof value.reason === 'string' ? value.reason.slice(0, 240) : ''
          }
          this.respond(response, 204)
          resolveAck(ack)
        }).catch(() => this.respond(response, 400))
        return
      }
      this.respond(response, 404)
    }

    const { server, port } = await this.listen(handleRequest, range.firstPort, range.lastPort)
    let timer: ReturnType<typeof setTimeout> | undefined
    const waitAck = (timeoutMs: number): Promise<CursorRuntimeSwitchAck> => {
      const timeout = new Promise<CursorRuntimeSwitchAck>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Cursor 切号补丁在 ${Math.round(timeoutMs / 1_000)} 秒内没有确认运行时登录态`
        )), timeoutMs)
      })
      return Promise.race([ackPromise, timeout])
    }
    // 一次性协议：票据取走一次、回执收一次，之后没有任何连接值得保留——必须强制掐断全部连接
    // 再关服务器。Node 的 server.close() 是「不再 accept，等所有连接自己断开」，只顺手关掉
    // 此刻空闲的连接；一条刚 accept、请求字节还没到的连接（补丁从别的窗口发起的轮询）会活下来，
    // 而补丁每 1.5s 用同一条 keep-alive 连接轮询、永不停歇，这条连接就永不空闲——close 回调
    // 永远不来，serveOnce 永不返回，持锁的热切与自动化收尾随之永久吊住（2026-09-17 实机事故）。
    const close = (): Promise<void> => {
      if (timer) clearTimeout(timer)
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }
    return { port, waitAck, close }
  }

  private async listen(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
    firstPort: number,
    lastPort: number
  ): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
    const makeServer = this.options.createServer ?? createServer
    for (let port = firstPort; port <= lastPort; port += 1) {
      const server = makeServer(handler)
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException): void => reject(error)
          server.once('error', onError)
          server.listen(port, '127.0.0.1', () => {
            server.off('error', onError)
            resolve()
          })
        })
        return { server, port }
      } catch (error) {
        try { server.close() } catch { /* 未监听时无需处理 */ }
        // 被占用 / 被保留的端口在范围扫描里都跳到下一个（冷切换会把选中端口写回 Companion）；
        // 其他错误（如无权限创建 socket）原样抛出。
        const unavailable = portUnavailableCode(error)
        if (!unavailable) throw error
        if (port === lastPort) throw portUnavailableError(unavailable, firstPort, lastPort)
      }
    }
    throw new Error('Cursor 运行时换号桥没有可用端口')
  }

  private respond(response: ServerResponse, status: number, body?: unknown): void {
    if (response.headersSent) return
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Zhimo-Switch-Key, Content-Type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store'
    }
    if (body === undefined) {
      response.writeHead(status, headers).end()
      return
    }
    response.writeHead(status, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
    }).end(JSON.stringify(body))
  }

  private readJson(request: IncomingMessage): Promise<PendingAck> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 8_192) {
          reject(new Error('ack_too_large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ack_invalid')
          resolve(value as PendingAck)
        } catch (error) {
          reject(error)
        }
      })
      request.on('error', reject)
    })
  }
}
