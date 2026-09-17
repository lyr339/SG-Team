import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MANIFEST_URL, fetchUpdateManifest, resolveLatestReleaseTag } from '../src/infrastructure/app-update/github-manifest-feed'

const manifest = {
  schemaVersion: 1,
  version: '0.3.4',
  tag: 'v0.3.4',
  publishedAt: '2026-09-17T02:00:00.000Z',
  assets: {
    'mac-arm64': { name: 'ShiGuang-0.3.4-mac-arm64.zip', url: 'https://example.com/ShiGuang-0.3.4-mac-arm64.zip', size: 10, sha512: 'b'.repeat(128) }
  }
}

type Route = (url: string, respond: (status: number, body?: string, headers?: Record<string, string>) => void) => void

async function serve(route: Route): Promise<{ base: string; server: Server; hits: string[] }> {
  const hits: string[] = []
  const server = createServer((request, response) => {
    hits.push(request.url ?? '')
    route(request.url ?? '', (status, body, headers) => {
      response.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) })
      response.end(body ?? '')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, server, hits }
}

describe('github-manifest-feed', () => {
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('默认清单地址走 releases/latest/download 重定向端点，不碰 api.github.com', () => {
    expect(DEFAULT_MANIFEST_URL).toBe('https://github.com/lyr339/SG-Team/releases/latest/download/update-manifest.json')
  })

  it('200 JSON → manifest（跟随 302）；404 → not_found；5xx / 非 JSON / 不合法清单 / 连接失败 → error', async () => {
    const { base, server, hits } = await serve((url, respond) => {
      if (url === '/latest/download/update-manifest.json') return respond(302, '', { location: `${base}/download/v0.3.4/update-manifest.json` })
      if (url === '/download/v0.3.4/update-manifest.json') return respond(200, JSON.stringify(manifest))
      if (url === '/missing') return respond(404, 'Not Found')
      if (url === '/broken') return respond(200, '{not json')
      if (url === '/invalid') return respond(200, JSON.stringify({ ...manifest, schemaVersion: 9 }))
      respond(500, 'boom')
    })
    servers.push(server)
    expect(await fetchUpdateManifest({ url: `${base}/latest/download/update-manifest.json`, fetch })).toEqual({ kind: 'manifest', manifest })
    expect(hits).toEqual(['/latest/download/update-manifest.json', '/download/v0.3.4/update-manifest.json'])
    expect(await fetchUpdateManifest({ url: `${base}/missing`, fetch })).toEqual({ kind: 'not_found' })
    expect(await fetchUpdateManifest({ url: `${base}/broken`, fetch })).toMatchObject({ kind: 'error', message: expect.stringContaining('JSON') })
    expect(await fetchUpdateManifest({ url: `${base}/invalid`, fetch })).toMatchObject({ kind: 'error', message: expect.stringContaining('schemaVersion') })
    expect(await fetchUpdateManifest({ url: `${base}/oops`, fetch })).toEqual({ kind: 'error', message: '更新清单返回 HTTP 500' })
    const closed = await serve(() => {})
    await new Promise<void>((resolve) => closed.server.close(() => resolve()))
    expect(await fetchUpdateManifest({ url: `${closed.base}/x`, fetch })).toMatchObject({ kind: 'error', message: expect.stringContaining('请求更新清单失败') })
  })

  it('超时按错误返回，不抛', async () => {
    const { base, server } = await serve(() => { /* 不响应 */ })
    servers.push(server)
    const result = await fetchUpdateManifest({ url: `${base}/slow`, fetch, timeoutMs: 80 })
    expect(result.kind).toBe('error')
    server.closeAllConnections()
  })

  it('resolveLatestReleaseTag：从 302 Location 末段取 tag；非重定向 / 形状不对 / 网络错误 → undefined', async () => {
    const { base, server } = await serve((url, respond) => {
      if (url === '/releases/latest') return respond(302, '', { location: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.4' })
      if (url === '/weird') return respond(302, '', { location: 'https://github.com/lyr339/SG-Team/releases' })
      respond(200, 'ok')
    })
    servers.push(server)
    expect(await resolveLatestReleaseTag({ fetch, url: `${base}/releases/latest` })).toBe('v0.3.4')
    expect(await resolveLatestReleaseTag({ fetch, url: `${base}/weird` })).toBeUndefined()
    expect(await resolveLatestReleaseTag({ fetch, url: `${base}/plain` })).toBeUndefined()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    servers.splice(servers.indexOf(server), 1)
    expect(await resolveLatestReleaseTag({ fetch, url: `${base}/releases/latest` })).toBeUndefined()
  })
})
