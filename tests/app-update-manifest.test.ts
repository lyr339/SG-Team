import { describe, expect, it } from 'vitest'
import {
  classifyInstallLocation,
  estimateUpdateRequiredBytes,
  installLocationBlockReason,
  isPlainAssetFileName,
  macBundlePathOf,
  parseUpdateManifest,
  updatePlatformKey
} from '../src/domain/app-update-manifest'

const sha = 'a'.repeat(128)
const manifest = {
  schemaVersion: 1,
  version: '0.3.4',
  tag: 'v0.3.4',
  publishedAt: '2026-09-17T02:00:00.000Z',
  notesMarkdown: '## v0.3.4\n- 一条',
  assets: {
    'mac-arm64': { name: 'ShiGuang-0.3.4-mac-arm64.zip', url: 'https://github.com/lyr339/SG-Team/releases/download/v0.3.4/ShiGuang-0.3.4-mac-arm64.zip', size: 133_896_447, sha512: sha },
    'win-x64': { name: 'ShiGuang-Setup-0.3.4.exe', url: 'https://github.com/lyr339/SG-Team/releases/download/v0.3.4/ShiGuang-Setup-0.3.4.exe', size: 117_596_850, sha512: sha }
  }
}

describe('app-update-manifest · 清单解析', () => {
  it('合法清单原样通过；v 前缀版本被归一，缺 tag 时按 v<version> 推导', () => {
    const parsed = parseUpdateManifest(manifest)
    expect('manifest' in parsed && parsed.manifest).toEqual(manifest)
    const derived = parseUpdateManifest({ ...manifest, version: 'v0.3.4', tag: undefined })
    expect('manifest' in derived && derived.manifest.version).toBe('0.3.4')
    expect('manifest' in derived && derived.manifest.tag).toBe('v0.3.4')
  })

  it('拒绝：非对象、schemaVersion ≠ 1、版本不合法、时间不合法、assets 缺失、资产字段不合法（sha512 非 128 hex、size 非正整数、url 非 http）', () => {
    const errorOf = (raw: unknown): string => {
      const parsed = parseUpdateManifest(raw)
      return 'error' in parsed ? parsed.error : ''
    }
    expect(errorOf('x')).toContain('不是 JSON 对象')
    expect(errorOf({ ...manifest, schemaVersion: 2 })).toContain('schemaVersion')
    expect(errorOf({ ...manifest, version: '1.2' })).toContain('version')
    expect(errorOf({ ...manifest, publishedAt: 'yesterday' })).toContain('publishedAt')
    expect(errorOf({ ...manifest, minimumVersion: 'abc' })).toContain('minimumVersion')
    expect(errorOf({ ...manifest, assets: undefined })).toContain('assets')
    expect(errorOf({ ...manifest, assets: { 'mac-arm64': { ...manifest.assets['mac-arm64'], sha512: 'abc' } } })).toContain('sha512')
    expect(errorOf({ ...manifest, assets: { 'mac-arm64': { ...manifest.assets['mac-arm64'], size: 0 } } })).toContain('size')
    expect(errorOf({ ...manifest, assets: { 'mac-arm64': { ...manifest.assets['mac-arm64'], url: 'ftp://x' } } })).toContain('url')
    // 未知平台键被忽略，不算错
    const extra = parseUpdateManifest({ ...manifest, assets: { ...manifest.assets, 'linux-x64': { bogus: true } } })
    expect('manifest' in extra && Object.keys(extra.manifest.assets).sort()).toEqual(['mac-arm64', 'win-x64'])
  })

  it('资产名必须是纯文件名：带 / 、\\ 、.. 或 NUL 的名字一律拒绝（它会拼进本地下载路径，清单来自第三方源）', () => {
    const errorOf = (name: string): string => {
      const parsed = parseUpdateManifest({ ...manifest, assets: { 'mac-arm64': { ...manifest.assets['mac-arm64'], name } } })
      return 'error' in parsed ? parsed.error : ''
    }
    for (const name of ['../../.cursor/mcp.json', 'sub/ShiGuang.zip', '..\\ShiGuang.zip', '/etc/passwd', '..', '.', 'a\u0000b']) {
      expect(errorOf(name), name).toContain('不是纯文件名')
    }
    expect(isPlainAssetFileName('ShiGuang-0.3.4-mac-arm64.zip')).toBe(true)
    expect(isPlainAssetFileName('拾光 0.3.4.zip')).toBe(true)
    expect(isPlainAssetFileName('.hidden.zip')).toBe(true) // 以点开头的普通文件名不是路径穿越
  })

  it('平台键：darwin/arm64 → mac-arm64，darwin/x64 → mac-x64，win32/x64 → win-x64，其余 undefined', () => {
    expect(updatePlatformKey('darwin', 'arm64')).toBe('mac-arm64')
    expect(updatePlatformKey('darwin', 'x64')).toBe('mac-x64')
    expect(updatePlatformKey('win32', 'x64')).toBe('win-x64')
    expect(updatePlatformKey('win32', 'arm64')).toBeUndefined()
    expect(updatePlatformKey('linux', 'x64')).toBeUndefined()
  })
})

describe('app-update-manifest · 安装位置', () => {
  const home = '/Users/demo'
  const classify = (execPath: string, writable = true) => classifyInstallLocation({ execPath, platform: 'darwin', homeDir: home, writable })

  it('bundle 路径 = execPath 去掉 Contents/MacOS/<name>；形状不对为 undefined', () => {
    expect(macBundlePathOf('/Applications/拾光.app/Contents/MacOS/拾光')).toBe('/Applications/拾光.app')
    expect(macBundlePathOf('/usr/local/bin/node')).toBeUndefined()
  })

  it('五种位置：translocated / build-output / applications（含 ~/Applications）/ user-folder / unknown', () => {
    expect(classify('/private/var/folders/ab/T/AppTranslocation/1234/d/拾光.app/Contents/MacOS/拾光')).toMatchObject({ kind: 'translocated', writable: false })
    expect(classify('/Users/demo/SG-Team/release/mac-arm64/拾光.app/Contents/MacOS/拾光')).toMatchObject({ kind: 'build-output' })
    expect(classify('/Users/demo/SG-Team/out/拾光.app/Contents/MacOS/拾光')).toMatchObject({ kind: 'build-output' })
    expect(classify('/Applications/拾光.app/Contents/MacOS/拾光')).toEqual({ kind: 'applications', bundlePath: '/Applications/拾光.app', writable: true })
    expect(classify('/Users/demo/Applications/拾光.app/Contents/MacOS/拾光')).toMatchObject({ kind: 'applications' })
    expect(classify('/Users/demo/Downloads/拾光.app/Contents/MacOS/拾光')).toMatchObject({ kind: 'user-folder', writable: true })
    expect(classify('/Users/demo/Downloads/拾光')).toMatchObject({ kind: 'unknown', writable: false })
    expect(classifyInstallLocation({ execPath: 'C:\\x\\ShiGuang.exe', platform: 'win32', homeDir: 'C:\\Users\\a', writable: true })).toMatchObject({ kind: 'unknown' })
  })

  it('阻断原因：只有 applications / user-folder 且可写才放行', () => {
    expect(installLocationBlockReason(classify('/Applications/拾光.app/Contents/MacOS/拾光'))).toBeUndefined()
    expect(installLocationBlockReason(classify('/Users/demo/Downloads/拾光.app/Contents/MacOS/拾光'))).toBeUndefined()
    expect(installLocationBlockReason(classify('/Applications/拾光.app/Contents/MacOS/拾光', false))).toContain('没有权限')
    expect(installLocationBlockReason(classify('/private/var/folders/x/AppTranslocation/y/d/拾光.app/Contents/MacOS/拾光'))).toContain('拖进「应用程序」')
    expect(installLocationBlockReason(classify('/Users/demo/SG/release/mac-arm64/拾光.app/Contents/MacOS/拾光'))).toContain('构建目录')
    expect(installLocationBlockReason(classify('/bin/sh'))).toContain('无法识别')
  })

  it('磁盘余量公式：3.3 × zip + 库 + 200 MB', () => {
    expect(estimateUpdateRequiredBytes(100, 50)).toBe(330 + 50 + 200 * 1024 * 1024)
  })
})
