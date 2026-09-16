import { parseUpdateManifest, UPDATE_MANIFEST_FILE_NAME, type UpdateManifest } from '../../domain/app-update-manifest'
import { APP_UPDATE_REPOSITORY, appUpdateReleaseUrl } from '../../domain/app-update'

/** `fetch` 的结构子集：生产传 Electron `net.fetch`（走系统代理），测试传本地服务器。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const DEFAULT_MANIFEST_URL = `${appUpdateReleaseUrl()}/download/${UPDATE_MANIFEST_FILE_NAME}`
const DEFAULT_TIMEOUT_MS = 15_000

export type ManifestFetchResult =
  | { kind: 'manifest'; manifest: UpdateManifest }
  /** 最新 Release 没有清单资产（清单机制之前发的版本，或上传尚未完成）。 */
  | { kind: 'not_found' }
  | { kind: 'error'; message: string }

/**
 * 取更新清单。只跟随重定向、只接受 2xx JSON；404 单独报出让调用方退化到「只看 tag」。
 * 不做条件请求——清单几百字节，省掉 ETag 记账。
 */
export async function fetchUpdateManifest(input: {
  url?: string
  fetch: FetchLike
  timeoutMs?: number
}): Promise<ManifestFetchResult> {
  const url = input.url ?? DEFAULT_MANIFEST_URL
  let response: Response
  try {
    response = await input.fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.8', 'cache-control': 'no-cache' }
    })
  } catch (error) {
    return { kind: 'error', message: `请求更新清单失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (response.status === 404) return { kind: 'not_found' }
  if (!response.ok) return { kind: 'error', message: `更新清单返回 HTTP ${response.status}` }
  let raw: unknown
  try {
    raw = JSON.parse(await response.text())
  } catch {
    return { kind: 'error', message: '更新清单不是合法 JSON' }
  }
  const parsed = parseUpdateManifest(raw)
  if ('error' in parsed) return { kind: 'error', message: `更新清单不合法：${parsed.error}` }
  return { kind: 'manifest', manifest: parsed.manifest }
}

/**
 * 退化路径：`releases/latest` 的 302 Location 末段就是最新 tag（不计 API 限额）。
 * 拿不到（非重定向 / 形状不对 / 网络错误）返回 undefined。
 */
export async function resolveLatestReleaseTag(input: {
  fetch: FetchLike
  url?: string
  timeoutMs?: number
}): Promise<string | undefined> {
  const url = input.url ?? `https://github.com/${APP_UPDATE_REPOSITORY.owner}/${APP_UPDATE_REPOSITORY.repo}/releases/latest`
  try {
    const response = await input.fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })
    const location = response.headers.get('location')
    if (!location) return undefined
    const match = /\/releases\/tag\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/?$/.exec(location)
    return match?.[1]
  } catch {
    return undefined
  }
}
