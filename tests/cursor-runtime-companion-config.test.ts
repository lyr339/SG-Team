import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CursorRuntimeCompanionConfig,
  cursorExecutableFromRuntimeBundle,
  locateCursorRuntimeCompanionBundle,
  rewriteCursorRuntimeCompanion
} from '../src/infrastructure/cursor/cursor-runtime-companion-config'

function fixture(port = 51_823, key = 'old-key'): string {
  const config = Buffer.from(JSON.stringify({ port, key, revision: 1 }), 'utf8').toString('base64')
  return `prefix/*ZMO_SWITCH_CONFIG:${config}*/(()=>{const zP=${port},zK="${key}",zH={};return zP+zK})()suffix`
}

describe('CursorRuntimeCompanionConfig', () => {
  it('rewrites metadata and executable port atomically while preserving surrounding bundle bytes', () => {
    const result = rewriteCursorRuntimeCompanion(fixture(), { port: 51_824, key: 'new-key' })
    expect(result.changed).toBe(true)
    expect(result.previousPort).toBe(51_823)
    expect(result.source).toContain('prefix')
    expect(result.source).toContain('suffix')
    expect(result.source).toContain('const zP=51824,zK="new-key"')
    const encoded = result.source.match(/ZMO_SWITCH_CONFIG:([A-Za-z0-9+/=]+)/)?.[1]
    expect(JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'))).toEqual({
      port: 51_824, key: 'new-key', revision: 2
    })
  })

  it('persists a backup once and is idempotent on the selected port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shiguang-companion-'))
    const path = join(dir, 'workbench.js')
    writeFileSync(path, fixture())
    const config = new CursorRuntimeCompanionConfig(path)
    expect(config.ensure({ port: 51_825, key: 'key-2' })).toMatchObject({ changed: true, previousPort: 51_823 })
    expect(config.ensure({ port: 51_825, key: 'key-2' })).toMatchObject({ changed: false, previousPort: 51_825 })
    expect(readFileSync(`${path}.sg-runtime-switch-backup`, 'utf8')).toBe(fixture())
  })

  it('只读预检在文件存在但 Companion 损坏时提前失败；成功时不改写原文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shiguang-companion-preflight-'))
    const path = join(dir, 'workbench.js')
    writeFileSync(path, fixture())
    const config = new CursorRuntimeCompanionConfig(path)
    expect(() => config.validate()).not.toThrow()
    expect(readFileSync(path, 'utf8')).toBe(fixture())
    writeFileSync(path, 'plain Cursor bundle')
    expect(() => config.validate()).toThrow(/锚点缺失/)
  })

  it('改写后同步 Cursor product.json 的 workbench 校验和', () => {
    const root = mkdtempSync(join(tmpdir(), 'shiguang-companion-checksum-'))
    const appRoot = join(root, 'resources', 'app')
    const bundle = join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
    mkdirSync(dirname(bundle), { recursive: true })
    writeFileSync(bundle, fixture())
    const productPath = join(appRoot, 'product.json')
    writeFileSync(productPath, JSON.stringify({ checksums: { 'vs/workbench/workbench.desktop.main.js': 'old' } }))
    new CursorRuntimeCompanionConfig(bundle).ensure({ port: 51_825, key: 'key-2' })
    const product = JSON.parse(readFileSync(productPath, 'utf8')) as { checksums: Record<string, string> }
    expect(product.checksums['vs/workbench/workbench.desktop.main.js']).not.toBe('old')
  })

  it('fails closed when the installed companion anchor drifted', () => {
    expect(() => rewriteCursorRuntimeCompanion('plain Cursor bundle', { port: 51_824, key: 'key' }))
      .toThrowError(/Companion 锚点缺失/)
  })

  it('windows: 一键切换自动锁定运行中自定义盘符的 bundle 与同一份 Cursor.exe', async () => {
    const bundle = 'D:\\Tools\\Cursor\\resources\\app\\out\\vs\\workbench\\workbench.desktop.main.js'
    const resolved = await locateCursorRuntimeCompanionBundle('win32', async () => ({
      stdout: 'D:\\Tools\\Cursor\\Cursor.exe\r\n'
    }))
    expect(resolved).toBe(bundle)
    expect(cursorExecutableFromRuntimeBundle(bundle)).toBe('D:\\Tools\\Cursor\\Cursor.exe')
  })
})
