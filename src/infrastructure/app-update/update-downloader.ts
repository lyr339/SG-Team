import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FetchLike } from './github-manifest-feed'

export interface DownloadFileInput {
  url: string
  /** 最终文件路径；传输期间写 `<destination>.part`，校验通过后才 rename 过去。 */
  destination: string
  expectedSha512: string
  expectedSize: number
  fetch: FetchLike
  signal: AbortSignal
  onProgress?: (progress: { receivedBytes: number; totalBytes: number; bytesPerSecond?: number }) => void
  /** 网络中断的重试次数（每次从清单 URL 重新解析、从零下载；GitHub 的签名下载地址约 1 小时过期，不能缓存最终地址）。 */
  attempts?: number
  now?: () => number
}

export class DownloadCancelledError extends Error {
  constructor() {
    super('下载已取消')
    this.name = 'DownloadCancelledError'
  }
}

export class DownloadVerifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadVerifyError'
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DownloadCancelledError
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'DownloadCancelledError'))
}

/**
 * 流式下载 + 边写边算 sha512。完成后大小与哈希都对才落到 destination；不对 → 删 `.part`，抛 DownloadVerifyError。
 * 取消 → 删 `.part`，抛 DownloadCancelledError。网络错误按 attempts 重试；HTTP 4xx/5xx 与校验失败不重试。
 */
export async function downloadFile(input: DownloadFileInput): Promise<void> {
  const attempts = Math.max(1, input.attempts ?? 3)
  const partPath = `${input.destination}.part`
  mkdirSync(dirname(input.destination), { recursive: true })
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (input.signal.aborted) throw new DownloadCancelledError()
    try {
      await downloadOnce(input, partPath)
      renameSync(partPath, input.destination)
      return
    } catch (error) {
      rmSync(partPath, { force: true })
      if (isAbortError(error) || input.signal.aborted) throw new DownloadCancelledError()
      if (error instanceof DownloadVerifyError || error instanceof HttpStatusError) throw error
      lastError = error
      if (attempt < attempts) continue
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

class HttpStatusError extends Error {
  constructor(status: number) {
    super(`下载返回 HTTP ${status}`)
    this.name = 'HttpStatusError'
  }
}

async function downloadOnce(input: DownloadFileInput, partPath: string): Promise<void> {
  const now = input.now ?? (() => Date.now())
  const response = await input.fetch(input.url, { redirect: 'follow', signal: input.signal })
  if (!response.ok) throw new HttpStatusError(response.status)
  if (!response.body) throw new Error('下载响应没有正文')
  const declared = Number(response.headers.get('content-length') ?? '')
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : input.expectedSize
  const hash = createHash('sha512')
  let receivedBytes = 0
  const startedAt = now()
  let lastReportAt = 0
  const report = (final: boolean): void => {
    const at = now()
    if (!final && at - lastReportAt < 250) return
    lastReportAt = at
    const elapsed = (at - startedAt) / 1000
    input.onProgress?.({
      receivedBytes,
      totalBytes,
      ...(elapsed >= 1 ? { bytesPerSecond: Math.round(receivedBytes / elapsed) } : {})
    })
  }
  rmSync(partPath, { force: true })
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    receivedBytes += chunk.length
    report(false)
  })
  await pipeline(body, createWriteStream(partPath), { signal: input.signal })
  report(true)
  if (!existsSync(partPath)) throw new Error('下载文件未落盘')
  if (receivedBytes !== input.expectedSize) {
    throw new DownloadVerifyError(`下载大小不符：期望 ${input.expectedSize} 字节，实收 ${receivedBytes} 字节`)
  }
  const digest = hash.digest('hex')
  if (digest !== input.expectedSha512.toLowerCase()) {
    throw new DownloadVerifyError('下载文件校验失败（sha512 不匹配）')
  }
}
