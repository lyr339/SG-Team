/**
 * mac 自更新的更新源与安装位置（纯函数）。
 *
 * Windows 走 electron-updater 的 `latest.yml`；mac 包是 adhoc 签名，Squirrel.Mac 永远过不了校验，
 * 所以 mac 用拾光自己的静态清单 `update-manifest.json`（发布链在 publish job 里由
 * `scripts/update-manifest.mjs` 生成为 Release 资产），客户端经 `releases/latest/download/…`
 * 重定向端点取它——不碰有限额的 REST API。
 */

import { parseAppVersion } from './app-update'

export const UPDATE_MANIFEST_FILE_NAME = 'update-manifest.json'
export const MAC_BUNDLE_IDENTIFIER = 'app.shiguang.team'

export type UpdatePlatformKey = 'mac-arm64' | 'mac-x64' | 'win-x64'

export interface UpdateManifestAsset {
  name: string
  url: string
  size: number
  /** 128 位小写 hex。 */
  sha512: string
}

export interface UpdateManifest {
  schemaVersion: 1
  version: string
  tag: string
  publishedAt: string
  minimumVersion?: string
  notesMarkdown?: string
  assets: Partial<Record<UpdatePlatformKey, UpdateManifestAsset>>
}

const PLATFORM_KEYS: readonly UpdatePlatformKey[] = ['mac-arm64', 'mac-x64', 'win-x64']

export function updatePlatformKey(platform: NodeJS.Platform, arch: string): UpdatePlatformKey | undefined {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : undefined
  if (platform === 'win32') return arch === 'x64' ? 'win-x64' : undefined
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAsset(raw: unknown, key: string): UpdateManifestAsset | { error: string } {
  if (!isRecord(raw)) return { error: `assets.${key} 不是对象` }
  const { name, url, size, sha512 } = raw
  if (typeof name !== 'string' || !name.trim()) return { error: `assets.${key}.name 缺失` }
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { error: `assets.${key}.url 不是 http(s) 地址` }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return { error: `assets.${key}.size 不是正整数` }
  if (typeof sha512 !== 'string' || !/^[0-9a-f]{128}$/.test(sha512)) return { error: `assets.${key}.sha512 不是 128 位 hex` }
  return { name: name.trim(), url, size, sha512 }
}

/** 校验清单形状；任何不合法都给出原因，调用方只当「检查失败」记录，不弹窗。 */
export function parseUpdateManifest(raw: unknown): { manifest: UpdateManifest } | { error: string } {
  if (!isRecord(raw)) return { error: '清单不是 JSON 对象' }
  if (raw.schemaVersion !== 1) return { error: `不支持的清单 schemaVersion：${String(raw.schemaVersion)}` }
  if (typeof raw.version !== 'string' || !parseAppVersion(raw.version)) return { error: `version 不合法：${String(raw.version)}` }
  const version = raw.version.trim().replace(/^v/, '')
  const tag = typeof raw.tag === 'string' && raw.tag.trim() ? raw.tag.trim() : `v${version}`
  if (typeof raw.publishedAt !== 'string' || Number.isNaN(new Date(raw.publishedAt).getTime())) {
    return { error: 'publishedAt 不是合法时间' }
  }
  if (raw.minimumVersion !== undefined && (typeof raw.minimumVersion !== 'string' || !parseAppVersion(raw.minimumVersion))) {
    return { error: `minimumVersion 不合法：${String(raw.minimumVersion)}` }
  }
  if (raw.notesMarkdown !== undefined && typeof raw.notesMarkdown !== 'string') return { error: 'notesMarkdown 不是字符串' }
  if (!isRecord(raw.assets)) return { error: 'assets 缺失' }
  const assets: UpdateManifest['assets'] = {}
  for (const key of PLATFORM_KEYS) {
    if (raw.assets[key] === undefined) continue
    const parsed = parseAsset(raw.assets[key], key)
    if ('error' in parsed) return { error: parsed.error }
    assets[key] = parsed
  }
  return {
    manifest: {
      schemaVersion: 1,
      version,
      tag,
      publishedAt: raw.publishedAt,
      ...(raw.minimumVersion ? { minimumVersion: raw.minimumVersion } : {}),
      ...(raw.notesMarkdown ? { notesMarkdown: raw.notesMarkdown } : {}),
      assets
    }
  }
}

export type InstallLocationKind = 'applications' | 'user-folder' | 'build-output' | 'translocated' | 'unknown'

export interface InstallLocation {
  kind: InstallLocationKind
  /** `…/拾光.app`；`unknown` 时为 execPath 本身。 */
  bundlePath: string
  /** bundle 的父目录对当前用户可写。 */
  writable: boolean
}

/** execPath 形如 `<bundle>.app/Contents/MacOS/<name>` 才算 bundle。 */
export function macBundlePathOf(execPath: string): string | undefined {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match?.[1]
}

/**
 * 安装位置判定（任务书 §5.2）。只有「应用程序」与「用户目录里直接运行」两种允许自替换：
 * 系统 translocation 挂载点是临时的，构建目录下次 pack 会重写。
 */
export function classifyInstallLocation(input: {
  execPath: string
  platform: NodeJS.Platform
  homeDir: string
  writable: boolean
}): InstallLocation {
  if (input.platform !== 'darwin') return { kind: 'unknown', bundlePath: input.execPath, writable: false }
  const bundlePath = macBundlePathOf(input.execPath)
  if (!bundlePath) return { kind: 'unknown', bundlePath: input.execPath, writable: false }
  if (input.execPath.includes('/AppTranslocation/')) return { kind: 'translocated', bundlePath, writable: false }
  if (/\/release\/mac(-[a-z0-9]+)?\//.test(bundlePath) || /\/out\//.test(bundlePath)) {
    return { kind: 'build-output', bundlePath, writable: input.writable }
  }
  const home = input.homeDir.replace(/\/+$/, '')
  if (bundlePath.startsWith('/Applications/') || bundlePath.startsWith(`${home}/Applications/`)) {
    return { kind: 'applications', bundlePath, writable: input.writable }
  }
  return { kind: 'user-folder', bundlePath, writable: input.writable }
}

/** 位置不允许自替换时给用户的一句话；允许时返回 undefined。 */
export function installLocationBlockReason(location: InstallLocation): string | undefined {
  switch (location.kind) {
    case 'translocated':
      return '拾光正从系统的隔离挂载点运行：请先把它拖进「应用程序」再更新。'
    case 'build-output':
      return '拾光正从构建目录运行，应用内更新只对安装好的副本开放。'
    case 'unknown':
      return '无法识别拾光的安装位置。'
    case 'applications':
    case 'user-folder':
      return location.writable ? undefined : `没有权限改写 ${location.bundlePath} 所在目录。`
  }
}

/** 磁盘余量下限：zip + 解压（约 2.3 × zip）+ 库备份 + 200 MB 余量。 */
export function estimateUpdateRequiredBytes(zipBytes: number, databaseBytes: number): number {
  return Math.ceil(zipBytes * 3.3) + databaseBytes + 200 * 1024 * 1024
}
