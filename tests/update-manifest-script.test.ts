import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 零依赖的发布脚本没有类型声明；测试直接 import 它导出的纯函数。
import { buildManifest, classifyAsset } from '../scripts/update-manifest.mjs'
import { parseUpdateManifest } from '../src/domain/app-update-manifest'

const SCRIPT = resolve(__dirname, '..', 'scripts', 'update-manifest.mjs')

function assetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sg-manifest-script-'))
  writeFileSync(join(dir, 'ShiGuang-0.3.4-mac-arm64.zip'), 'mac-zip-bytes')
  writeFileSync(join(dir, 'ShiGuang-Setup-0.3.4.exe'), 'win-exe-bytes')
  writeFileSync(join(dir, 'ShiGuang-0.3.3-mac-arm64.zip'), 'stale-old-version')
  writeFileSync(join(dir, 'ShiGuang-Setup-0.3.4.exe.blockmap'), 'blockmap')
  writeFileSync(join(dir, 'latest.yml'), 'version: 0.3.4')
  return dir
}

describe('classifyAsset', () => {
  it('只认属于本版本的 mac zip 与 Setup exe；版本号按字面匹配（点不作通配）', () => {
    expect(classifyAsset('ShiGuang-0.3.4-mac-arm64.zip', '0.3.4')).toBe('mac-arm64')
    expect(classifyAsset('ShiGuang-0.3.4-mac-x64.zip', '0.3.4')).toBe('mac-x64')
    expect(classifyAsset('ShiGuang-0.3.4-mac-universal.zip', '0.3.4')).toBeUndefined()
    expect(classifyAsset('ShiGuang-Setup-0.3.4.exe', '0.3.4')).toBe('win-x64')
    expect(classifyAsset('ShiGuang-0.3.3-mac-arm64.zip', '0.3.4')).toBeUndefined()
    expect(classifyAsset('ShiGuang-0x3x4-mac-arm64.zip', '0.3.4')).toBeUndefined()
    expect(classifyAsset('ShiGuang-Setup-0.3.4.exe.blockmap', '0.3.4')).toBeUndefined()
  })
})

describe('buildManifest', () => {
  it('登记本版产物的 sha512 / 大小 / 下载地址；旧版残留忽略；没有 mac 产物则拒绝', async () => {
    const dir = assetsDir()
    const manifest = await buildManifest({
      version: '0.3.4',
      tag: 'v0.3.4',
      assetsDir: dir,
      repo: 'lyr339/SG-Team',
      notes: '- 说明',
      publishedAt: '2026-09-17T02:00:00.000Z'
    })
    expect(Object.keys(manifest.assets).sort()).toEqual(['mac-arm64', 'win-x64'])
    expect(manifest.assets['mac-arm64']).toEqual({
      name: 'ShiGuang-0.3.4-mac-arm64.zip',
      url: 'https://github.com/lyr339/SG-Team/releases/download/v0.3.4/ShiGuang-0.3.4-mac-arm64.zip',
      size: 13,
      sha512: createHash('sha512').update('mac-zip-bytes').digest('hex')
    })
    // 域层解析器（客户端实际用的）必须认它
    const parsed = parseUpdateManifest(manifest)
    expect(parsed).toHaveProperty('manifest')

    const winOnly = mkdtempSync(join(tmpdir(), 'sg-manifest-win-'))
    writeFileSync(join(winOnly, 'ShiGuang-Setup-0.3.4.exe'), 'x')
    await expect(buildManifest({ version: '0.3.4', tag: 'v0.3.4', assetsDir: winOnly, repo: 'r/r', publishedAt: 'now' }))
      .rejects.toThrow(/没有版本 0\.3\.4 的 mac 产物/)
  })
})

describe('update-manifest.mjs 脚本入口', () => {
  const runScript = (args: string[]): string =>
    execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

  it('完整跑一遍：写出的清单被域层解析器接受，notes 进 notesMarkdown', () => {
    const dir = assetsDir()
    const notes = join(dir, 'notes.md')
    writeFileSync(notes, '## 0.3.4\n- mac 自更新\n')
    const out = join(dir, 'update-manifest.json')
    const stdout = runScript([
      '--version', 'v0.3.4', '--tag', 'v0.3.4', '--assets', dir, '--out', out,
      '--notes', notes, '--repo', 'lyr339/SG-Team', '--published-at', '2026-09-17T02:00:00.000Z'
    ])
    expect(stdout).toContain('mac-arm64')
    const parsed = parseUpdateManifest(JSON.parse(readFileSync(out, 'utf8')))
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.manifest).toMatchObject({
      version: '0.3.4',
      tag: 'v0.3.4',
      publishedAt: '2026-09-17T02:00:00.000Z',
      notesMarkdown: '## 0.3.4\n- mac 自更新\n'
    })
    expect(parsed.manifest.assets['win-x64']?.name).toBe('ShiGuang-Setup-0.3.4.exe')
  })

  it('非法版本 / tag 不一致 / 没有 mac 产物：退出非零并报原因', () => {
    const dir = assetsDir()
    const fail = (args: string[]): string => {
      try {
        runScript(args)
      } catch (error) {
        const failure = error as { status?: number; stderr?: string }
        expect(failure.status).toBe(1)
        return String(failure.stderr)
      }
      throw new Error('本应退出非零')
    }
    expect(fail(['--version', 'abc', '--assets', dir])).toContain('--version 不合法')
    expect(fail(['--version', '0.3.4', '--tag', 'v9.9.9', '--assets', dir])).toContain('不一致')
    const empty = mkdtempSync(join(tmpdir(), 'sg-manifest-empty-'))
    expect(fail(['--version', '0.3.4', '--assets', empty])).toContain('没有版本 0.3.4 的 mac 产物')
  })
})
