import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { AppUpdateDownloadProgress } from '../src/application/app-update-service'
import { DEFAULT_MANIFEST_URL, type FetchLike } from '../src/infrastructure/app-update/github-manifest-feed'
import type { RunCommand } from '../src/infrastructure/app-update/mac-app-replacer'
import { APP_UPDATES_DIR_NAME, createMacUpdaterPort, PENDING_RESULT_FILE, type MacUpdaterPortInput } from '../src/infrastructure/app-update/mac-updater-port'

const zipBytes = randomBytes(2048)
const zipSha512 = createHash('sha512').update(zipBytes).digest('hex')
const ASSET_URL = 'https://github.com/lyr339/SG-Team/releases/download/v0.3.4/ShiGuang-0.3.4-mac-arm64.zip'
const LATEST_URL = 'https://github.com/lyr339/SG-Team/releases/latest'

const manifest = {
  schemaVersion: 1,
  version: '0.3.4',
  tag: 'v0.3.4',
  publishedAt: '2026-09-17T02:00:00.000Z',
  notesMarkdown: '- mac 应用内更新',
  assets: {
    'mac-arm64': { name: 'ShiGuang-0.3.4-mac-arm64.zip', url: ASSET_URL, size: zipBytes.length, sha512: zipSha512 },
    'win-x64': { name: 'ShiGuang-Setup-0.3.4.exe', url: 'https://example.com/setup.exe', size: 1, sha512: 'b'.repeat(128) }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeBundle(dir: string): void {
  const contents = join(dir, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  writeFileSync(join(contents, 'MacOS', '拾光'), 'binary', { mode: 0o755 })
  mkdirSync(join(contents, 'Resources', 'mcp'), { recursive: true })
  writeFileSync(join(contents, 'Resources', 'mcp', 'index.mjs'), '// mcp')
}

function harness(overrides: Partial<MacUpdaterPortInput> & { routes?: Record<string, () => Response> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sg-mac-port-'))
  const userDataDir = join(dir, 'user-data')
  const updatesDir = join(userDataDir, APP_UPDATES_DIR_NAME)
  const mcpJson = join(dir, 'mcp.json')
  writeFileSync(mcpJson, '{}')
  const routes: Record<string, () => Response> = {
    [DEFAULT_MANIFEST_URL]: () => jsonResponse(manifest),
    [ASSET_URL]: () => new Response(new Uint8Array(zipBytes), { status: 200, headers: { 'content-length': String(zipBytes.length) } }),
    ...overrides.routes
  }
  const fetch: FetchLike = async (url) => {
    const handler = routes[url]
    if (!handler) throw new Error(`ENOROUTE ${url}`)
    return handler()
  }
  const relaunches: Array<{ execPath: string; args: string[] }> = []
  let quits = 0
  const logs: string[] = []
  const run: RunCommand = async (command, args) => {
    if (command === 'ditto') {
      expect(existsSync(args[2]!)).toBe(true) // zip 已落盘
      makeBundle(join(args[3]!, '拾光.app'))
      return { status: 0, stdout: '', stderr: '' }
    }
    if (command === 'plutil') {
      const value = args[1] === 'CFBundleShortVersionString' ? manifest.version : 'app.shiguang.team'
      return { status: 0, stdout: `${value}\n`, stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' } // codesign / xattr
  }
  const { routes: _routes, ...portOverrides } = overrides
  const port = createMacUpdaterPort({
    platform: 'darwin',
    arch: 'arm64',
    isPackaged: true,
    execPath: '/Applications/拾光.app/Contents/MacOS/拾光',
    homeDir: '/Users/u',
    currentVersion: '0.3.3',
    userDataDir,
    databasePath: join(dir, 'task-pool.sqlite3'),
    backupFiles: () => [mcpJson],
    fetch,
    relaunch: (execPath, args) => relaunches.push({ execPath, args }),
    quit: () => { quits += 1 },
    pid: 4242,
    run,
    now: () => 1_758_000_000_000,
    log: (message) => logs.push(message),
    isWritable: () => true,
    freeBytes: () => 10 * 1024 ** 3,
    ...portOverrides
  })
  return {
    dir,
    port,
    updatesDir,
    relaunches,
    logs,
    quits: () => quits,
    databasePath: join(dir, 'task-pool.sqlite3'),
    async ready() {
      await port.checkForUpdates()
      const progress: AppUpdateDownloadProgress[] = []
      const result = await port.downloadUpdate({ onProgress: (p) => progress.push(p), signal: new AbortController().signal })
      return { progress, result }
    }
  }
}

describe('mac 更新器端口 · support', () => {
  it('平台矩阵：win32 / 未知架构不支持；开发模式不检查；darwin + 已打包 + 应用程序目录可写 → 支持', () => {
    expect(harness({ platform: 'win32', execPath: 'C:\\app\\拾光.exe' }).port.support())
      .toEqual({ ok: false, reason: '此平台的应用内更新尚未提供：请到发布页下载新版后手动替换。' })
    expect(harness({ arch: 'ia32' }).port.support()).toMatchObject({ ok: false })
    expect(harness({ isPackaged: false }).port.support()).toEqual({ ok: false, reason: '开发模式下不检查更新。' })
    expect(harness().port.support()).toEqual({ ok: true })
  })

  it('位置矩阵：translocation / 构建目录 / 不可写目录都拦下', () => {
    const translocated = harness({ execPath: '/private/var/folders/x/AppTranslocation/ABC/d/拾光.app/Contents/MacOS/拾光' })
    expect(translocated.port.support()).toEqual({ ok: false, reason: '拾光正从系统的隔离挂载点运行：请先把它拖进「应用程序」再更新。' })
    const buildOutput = harness({ execPath: '/Users/u/code/SG/release/mac-arm64/拾光.app/Contents/MacOS/拾光' })
    expect(buildOutput.port.support()).toEqual({ ok: false, reason: '拾光正从构建目录运行，应用内更新只对安装好的副本开放。' })
    const readOnly = harness({ isWritable: () => false })
    expect(readOnly.port.support()).toEqual({ ok: false, reason: '没有权限改写 /Applications/拾光.app 所在目录。' })
  })
})

describe('mac 更新器端口 · 检查', () => {
  it('清单带本平台资产：版本、说明、体积与发布页齐全，可应用内下载', async () => {
    const outcome = await harness().port.checkForUpdates()
    expect(outcome).toEqual({
      available: true,
      release: {
        version: '0.3.4',
        releaseDate: '2026-09-17T02:00:00.000Z',
        releaseNotes: '- mac 应用内更新',
        sizeBytes: zipBytes.length,
        releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.4'
      }
    })
  })

  it('清单没有本平台资产：downloadable=false，下载入口报人话', async () => {
    const h = harness({ routes: { [DEFAULT_MANIFEST_URL]: () => jsonResponse({ ...manifest, assets: { 'win-x64': manifest.assets['win-x64'] } }) } })
    const outcome = await h.port.checkForUpdates()
    expect(outcome).toMatchObject({ available: true, release: { version: '0.3.4', downloadable: false } })
    await expect(h.port.downloadUpdate({ onProgress: () => {}, signal: new AbortController().signal }))
      .rejects.toThrow('这一版没有提供 mac 安装包，请到发布页手动下载。')
  })

  it('清单 404：退化到 releases/latest 的重定向 tag，只能去发布页；连 tag 也拿不到则报错', async () => {
    const fallback = harness({ routes: {
      [DEFAULT_MANIFEST_URL]: () => new Response('', { status: 404 }),
      [LATEST_URL]: () => new Response(null, { status: 302, headers: { location: 'https://github.com/lyr339/SG-Team/releases/tag/v0.5.0' } })
    } })
    expect(await fallback.port.checkForUpdates()).toEqual({
      available: true,
      release: { version: '0.5.0', releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.5.0', downloadable: false }
    })

    const dead = harness({ routes: {
      [DEFAULT_MANIFEST_URL]: () => new Response('', { status: 404 }),
      [LATEST_URL]: () => new Response('', { status: 200 })
    } })
    await expect(dead.port.checkForUpdates()).rejects.toThrow('无法获取最新版本信息（清单不存在，发布页也没有给出版本）')
  })

  it('自定义更新源：目录地址补 update-manifest.json、安装包从同一目录取（与 Windows 的目录语义一致），清单文件 URL 也认；404 直接报错不退化', async () => {
    const custom = 'https://mirror.example.com/sg/update-manifest.json'
    const mirroredAsset = 'https://mirror.example.com/sg/ShiGuang-0.3.4-mac-arm64.zip'
    const fetched: string[] = []
    const h = harness({ routes: {
      [custom]: () => jsonResponse(manifest),
      [mirroredAsset]: () => { fetched.push(mirroredAsset); return new Response(new Uint8Array(zipBytes), { status: 200, headers: { 'content-length': String(zipBytes.length) } }) },
      [ASSET_URL]: () => { throw new Error('自定义源在场时不该回 GitHub 取安装包') }
    } })
    h.port.setFeedUrl(custom)
    expect(await h.port.checkForUpdates()).toMatchObject({ available: true, release: { version: '0.3.4' } })
    await h.port.downloadUpdate({ onProgress: () => {}, signal: new AbortController().signal })
    expect(fetched).toEqual([mirroredAsset])
    h.port.setFeedUrl('https://mirror.example.com/sg/') // 目录形式，同一路由生效
    expect(await h.port.checkForUpdates()).toMatchObject({ available: true, release: { version: '0.3.4' } })
    await h.port.downloadUpdate({ onProgress: () => {}, signal: new AbortController().signal })
    expect(fetched).toEqual([mirroredAsset, mirroredAsset])

    const missing = harness({ routes: { [custom]: () => new Response('', { status: 404 }) } })
    missing.port.setFeedUrl(custom)
    await expect(missing.port.checkForUpdates()).rejects.toThrow('自定义更新源上没有 update-manifest.json')
    missing.port.setFeedUrl(undefined)
    expect(await missing.port.checkForUpdates()).toMatchObject({ available: true })
  })

  it('网络失败与坏 JSON 都以一句话错误上抛', async () => {
    const offline = harness({ routes: { [DEFAULT_MANIFEST_URL]: () => { throw new Error('ENETDOWN') } } })
    await expect(offline.port.checkForUpdates()).rejects.toThrow(/请求更新清单失败：.*ENETDOWN/)
    const garbage = harness({ routes: { [DEFAULT_MANIFEST_URL]: () => new Response('<html>', { status: 200 }) } })
    await expect(garbage.port.checkForUpdates()).rejects.toThrow('更新清单不是合法 JSON')
  })
})

describe('mac 更新器端口 · 下载与安装', () => {
  it('下载：磁盘余量先行检查', async () => {
    const h = harness({ freeBytes: () => 1024 })
    await h.port.checkForUpdates()
    await expect(h.port.downloadUpdate({ onProgress: () => {}, signal: new AbortController().signal }))
      .rejects.toThrow(/磁盘可用空间不足/)
  })

  it('下载 → 校验 → 暂存：进度先 transfer 后一发 verify；zip 用完即删，暂存 bundle 留下', async () => {
    const h = harness()
    const { progress, result } = await h.ready()
    const stagedBundle = join(h.updatesDir, 'staging', '拾光.app')
    expect(result).toEqual({ filePath: stagedBundle })
    expect(existsSync(stagedBundle)).toBe(true)
    expect(existsSync(join(h.updatesDir, 'downloads', 'ShiGuang-0.3.4-mac-arm64.zip'))).toBe(false)
    expect(progress.at(-1)).toEqual({ receivedBytes: zipBytes.length, totalBytes: zipBytes.length, activity: 'verify' })
    expect(progress.slice(0, -1).every((entry) => entry.activity === 'transfer')).toBe(true)
  })

  it('quitAndInstall：备份（含 mcp.json 与 backup.json）→ 写替换脚本 → relaunch(/bin/sh) → quit', async () => {
    const h = harness()
    expect(() => h.port.quitAndInstall()).toThrow('没有已就绪的新版本')
    await h.ready()
    h.port.quitAndInstall()

    const backupDir = join(h.updatesDir, 'backup', '0.3.3-1758000000000')
    expect(JSON.parse(readFileSync(join(backupDir, 'backup.json'), 'utf8'))).toMatchObject({ appVersion: '0.3.3', bundleName: '拾光.app' })
    expect(readFileSync(join(backupDir, 'mcp.json'), 'utf8')).toBe('{}')

    expect(h.relaunches).toHaveLength(1)
    expect(h.relaunches[0]!.execPath).toBe('/bin/sh')
    const script = readFileSync(h.relaunches[0]!.args[0]!, 'utf8')
    expect(script).toContain('apply 0.3.3 -> 0.3.4 pid=4242')
    expect(script).toContain(`APP='/Applications/拾光.app'`)
    expect(h.quits()).toBe(1)
  })
})

describe('mac 更新器端口 · 结果回执与回滚', () => {
  function seedBackup(h: ReturnType<typeof harness>, options: { database?: boolean } = {}): string {
    const dir = join(h.updatesDir, 'backup', '0.3.2-1000')
    mkdirSync(join(dir, '拾光.app'), { recursive: true })
    writeFileSync(join(dir, 'backup.json'), JSON.stringify({
      version: 1, appVersion: '0.3.2', createdAt: 1_000, bundleName: '拾光.app', databasePath: h.databasePath, files: []
    }))
    if (options.database !== false) writeFileSync(join(dir, 'task-pool.sqlite3'), 'snapshot')
    return dir
  }

  it('takePendingApplyResult：读取并删除结果文件，顺手清空下载与暂存；坏文件只记日志', () => {
    const h = harness()
    const resultPath = join(h.updatesDir, PENDING_RESULT_FILE)
    mkdirSync(join(h.updatesDir, 'downloads'), { recursive: true })
    mkdirSync(join(h.updatesDir, 'staging'), { recursive: true })
    writeFileSync(resultPath, JSON.stringify({ status: 'applied', from: '0.3.3', to: '0.3.4', backupDir: '/x' }))
    expect(h.port.takePendingApplyResult?.()).toEqual({ status: 'applied', from: '0.3.3', to: '0.3.4', backupDir: '/x' })
    expect(existsSync(resultPath)).toBe(false)
    expect(existsSync(join(h.updatesDir, 'downloads'))).toBe(false)
    expect(existsSync(join(h.updatesDir, 'staging'))).toBe(false)

    expect(h.port.takePendingApplyResult?.()).toBeUndefined()

    writeFileSync(resultPath, '{broken')
    expect(h.port.takePendingApplyResult?.()).toBeUndefined()
    expect(existsSync(resultPath)).toBe(false)
    expect(h.logs.some((line) => line.includes('结果文件不可读'))).toBe(true)

    const win = harness({ platform: 'win32' })
    expect(win.port.takePendingApplyResult?.()).toBeUndefined()
  })

  it('backupInfo：有完整备份才给；rollback 没备份直接抛', () => {
    const h = harness()
    expect(h.port.backupInfo?.()).toBeUndefined()
    expect(() => h.port.rollback?.()).toThrow('没有可回滚的备份')
    const dir = seedBackup(h)
    expect(h.port.backupInfo?.()).toEqual({ version: '0.3.2', createdAt: 1_000, dir })
  })

  it('rollback：当前库另存一份 → 写回滚脚本（带库快照恢复）→ relaunch → quit', () => {
    const h = harness()
    seedBackup(h)
    const database = new DatabaseSync(h.databasePath)
    database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    database.close()

    h.port.rollback?.()
    const keepCopy = join(h.updatesDir, 'rollback-1758000000000', 'task-pool.sqlite3')
    expect(existsSync(keepCopy)).toBe(true)
    expect(h.relaunches).toHaveLength(1)
    expect(h.relaunches[0]!.execPath).toBe('/bin/sh')
    const script = readFileSync(h.relaunches[0]!.args[0]!, 'utf8')
    expect(script).toContain('rollback 0.3.3 -> 0.3.2 pid=4242')
    expect(script).toContain('task-pool.sqlite3')
    expect(script).toContain('mv -f "$DB.rollback-tmp" "$DB"')
    expect(h.quits()).toBe(1)
  })

  it('rollback：备份里没有库快照 → 脚本不动库', () => {
    const h = harness()
    seedBackup(h, { database: false })
    h.port.rollback?.()
    const script = readFileSync(h.relaunches[0]!.args[0]!, 'utf8')
    expect(script).toContain('no database snapshot in backup; database left as is')
  })
})
