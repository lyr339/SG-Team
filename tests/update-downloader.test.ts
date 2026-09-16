import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadCancelledError, DownloadVerifyError, downloadFile } from '../src/infrastructure/app-update/update-downloader'

const body = randomBytes(100 * 1024)
const sha512 = createHash('sha512').update(body).digest('hex')

interface ServerPlan {
  /** 第 n 次请求（1 起）中途掐断连接。 */
  dropOnAttempt?: number
  /** 服务端完整送达一个比清单预期短的正文（大小不符；content-length 与实发一致）。 */
  truncate?: boolean
  status?: number
  /** 分片发送的延迟（毫秒），用于取消测试。 */
  slowChunkMs?: number
}

async function serve(plan: ServerPlan): Promise<{ url: string; server: Server; requests: number }> {
  const state = { requests: 0 }
  const server = createServer((request, response) => {
    state.requests += 1
    if (plan.status && plan.status !== 200) {
      response.writeHead(plan.status)
      response.end('nope')
      return
    }
    const payload = plan.truncate ? body.subarray(0, body.length - 10) : body
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(payload.length) })
    if (plan.dropOnAttempt === state.requests) {
      response.write(payload.subarray(0, 1024))
      setTimeout(() => request.socket.destroy(), 5)
      return
    }
    if (plan.slowChunkMs) {
      let offset = 0
      const tick = (): void => {
        if (offset >= payload.length) { response.end(); return }
        response.write(payload.subarray(offset, offset + 4096))
        offset += 4096
        setTimeout(tick, plan.slowChunkMs)
      }
      tick()
      return
    }
    response.end(payload)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/ShiGuang-0.3.4-mac-arm64.zip`,
    server,
    get requests() { return state.requests }
  }
}

describe('update-downloader', () => {
  const servers: Server[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  const dir = (): string => mkdtempSync(join(tmpdir(), 'sg-dl-'))

  it('完整下载：进度单调、末次为总量；落到 destination，无 .part 残留，内容一致', async () => {
    const served = await serve({})
    servers.push(served.server)
    const destination = join(dir(), 'a.zip')
    const progress: number[] = []
    let now = 1_000
    await downloadFile({
      url: served.url, destination, expectedSha512: sha512, expectedSize: body.length, fetch,
      signal: new AbortController().signal,
      onProgress: (p) => { progress.push(p.receivedBytes); expect(p.totalBytes).toBe(body.length) },
      now: () => (now += 300)
    })
    expect(readFileSync(destination).equals(body)).toBe(true)
    expect(existsSync(`${destination}.part`)).toBe(false)
    expect(progress.at(-1)).toBe(body.length)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
  })

  it('sha512 不匹配 → DownloadVerifyError，.part 与目标都不存在，不重试', async () => {
    const served = await serve({})
    servers.push(served.server)
    const destination = join(dir(), 'a.zip')
    await expect(downloadFile({
      url: served.url, destination, expectedSha512: 'c'.repeat(128), expectedSize: body.length, fetch, signal: new AbortController().signal
    })).rejects.toBeInstanceOf(DownloadVerifyError)
    expect(existsSync(destination)).toBe(false)
    expect(existsSync(`${destination}.part`)).toBe(false)
    expect(served.requests).toBe(1)
  })

  it('大小不符（正文被截断）→ DownloadVerifyError 并说明期望 / 实收', async () => {
    const served = await serve({ truncate: true })
    servers.push(served.server)
    const destination = join(dir(), 'a.zip')
    await expect(downloadFile({
      url: served.url, destination, expectedSha512: sha512, expectedSize: body.length, fetch, signal: new AbortController().signal
    })).rejects.toThrow(/大小不符/)
    expect(existsSync(`${destination}.part`)).toBe(false)
  })

  it('连接中途断开一次 → 自动重试成功；HTTP 404 不重试', async () => {
    const served = await serve({ dropOnAttempt: 1 })
    servers.push(served.server)
    const destination = join(dir(), 'a.zip')
    await downloadFile({ url: served.url, destination, expectedSha512: sha512, expectedSize: body.length, fetch, signal: new AbortController().signal })
    expect(served.requests).toBe(2)
    expect(readFileSync(destination).equals(body)).toBe(true)

    const missing = await serve({ status: 404 })
    servers.push(missing.server)
    await expect(downloadFile({
      url: missing.url, destination: join(dir(), 'b.zip'), expectedSha512: sha512, expectedSize: body.length, fetch, signal: new AbortController().signal, attempts: 3
    })).rejects.toThrow(/HTTP 404/)
    expect(missing.requests).toBe(1)
  })

  it('取消：signal 中止 → DownloadCancelledError，.part 已删；已中止的 signal 直接拒绝且不请求', async () => {
    const served = await serve({ slowChunkMs: 20 })
    servers.push(served.server)
    const destination = join(dir(), 'a.zip')
    const abort = new AbortController()
    const pending = downloadFile({
      url: served.url, destination, expectedSha512: sha512, expectedSize: body.length, fetch, signal: abort.signal,
      onProgress: (p) => { if (p.receivedBytes > 0) abort.abort() }
    })
    await expect(pending).rejects.toBeInstanceOf(DownloadCancelledError)
    expect(existsSync(`${destination}.part`)).toBe(false)
    expect(existsSync(destination)).toBe(false)

    const already = new AbortController()
    already.abort()
    const before = served.requests
    await expect(downloadFile({
      url: served.url, destination, expectedSha512: sha512, expectedSize: body.length, fetch, signal: already.signal
    })).rejects.toBeInstanceOf(DownloadCancelledError)
    expect(served.requests).toBe(before)
  })
})
