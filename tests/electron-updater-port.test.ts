import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import {
  APP_UPDATER_CACHE_DIR_NAME,
  createElectronUpdaterPort,
  releaseFromUpdateInfo,
  type ElectronUpdaterLike
} from '../src/infrastructure/app-update/electron-updater-port'

const info: UpdateInfo = {
  version: '0.3.3',
  files: [{ url: 'ShiGuang-Setup-0.3.3.exe', sha512: 'abc', size: 116_467_543 }],
  path: 'ShiGuang-Setup-0.3.3.exe',
  sha512: 'abc',
  releaseDate: '2026-09-17T02:00:00.000Z',
  releaseName: '拾光 v0.3.3',
  releaseNotes: '<h2>v0.3.3</h2>'
}

class FakeUpdater extends EventEmitter implements ElectronUpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  autoRunAppAfterInstall = true
  allowPrerelease = true
  allowDowngrade = true
  logger: ElectronUpdaterLike['logger'] = null
  feeds: unknown[] = []
  checkResult: Awaited<ReturnType<ElectronUpdaterLike['checkForUpdates']>> = null
  installCalls: Array<[boolean | undefined, boolean | undefined]> = []
  downloadImpl: (token: { cancelled: boolean; once: (event: 'cancel', listener: () => void) => unknown }) => Promise<string[]> = async () => ['C:\\cache\\ShiGuang-Setup-0.3.3.exe']

  setFeedURL(options: unknown): void { this.feeds.push(options) }
  checkForUpdates() { return Promise.resolve(this.checkResult) }
  downloadUpdate(token?: { cancelled: boolean; once: (event: 'cancel', listener: () => void) => unknown }) {
    return this.downloadImpl(token!)
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void { this.installCalls.push([isSilent, isForceRunAfter]) }
}

function portFor(updater: FakeUpdater, overrides: { platform?: NodeJS.Platform; isPackaged?: boolean } = {}) {
  const logs: string[] = []
  const port = createElectronUpdaterPort({
    updater,
    platform: overrides.platform ?? 'win32',
    isPackaged: overrides.isPackaged ?? true,
    log: (message) => logs.push(message)
  })
  return { port, logs }
}

describe('electron-updater 端口', () => {
  it('支持判定：只有打包后的 Windows；mac / 开发态给出人话原因', () => {
    expect(portFor(new FakeUpdater()).port.support()).toEqual({ ok: true })
    expect(portFor(new FakeUpdater(), { platform: 'darwin' }).port.support()).toMatchObject({ ok: false, reason: expect.stringContaining('发布页') })
    expect(portFor(new FakeUpdater(), { isPackaged: false }).port.support()).toMatchObject({ ok: false, reason: expect.stringContaining('开发模式') })
  })

  it('首次使用即关掉自动下载 / 退出安装 / 预发布 / 降级，并接管日志', async () => {
    const updater = new FakeUpdater()
    const { port, logs } = portFor(updater)
    updater.checkResult = { isUpdateAvailable: false, updateInfo: info, versionInfo: info }
    await port.checkForUpdates()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    expect(updater.autoRunAppAfterInstall).toBe(true)
    updater.logger?.warn('slow network')
    expect(logs).toContain('warn: slow network')
  })

  it('检查：null（更新器未激活）与 isUpdateAvailable=false 都是无更新；有更新时映射发布信息', async () => {
    const updater = new FakeUpdater()
    const { port } = portFor(updater)
    expect(await port.checkForUpdates()).toEqual({ available: false })
    updater.checkResult = { isUpdateAvailable: false, updateInfo: info, versionInfo: info }
    expect(await port.checkForUpdates()).toEqual({ available: false })
    updater.checkResult = { isUpdateAvailable: true, updateInfo: info, versionInfo: info }
    expect(await port.checkForUpdates()).toEqual({
      available: true,
      release: {
        version: '0.3.3',
        releaseDate: '2026-09-17T02:00:00.000Z',
        releaseName: '拾光 v0.3.3',
        releaseNotes: '<h2>v0.3.3</h2>',
        sizeBytes: 116_467_543,
        releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.3'
      }
    })
  })

  it('releaseFromUpdateInfo：多条发布说明合并为文本；无大小 / 无说明时字段缺省', () => {
    const merged = releaseFromUpdateInfo({
      ...info,
      files: [{ url: 'x', sha512: 'y' }],
      releaseName: null,
      releaseNotes: [{ version: '0.3.3', note: '第三' }, { version: '0.3.2', note: null }]
    })
    expect(merged).toEqual({
      version: '0.3.3',
      releaseDate: info.releaseDate,
      releaseNotes: '0.3.3\n第三\n\n0.3.2',
      releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.3'
    })
  })

  it('下载：进度事件转成字节口径并在结束后解绑；返回首个文件路径', async () => {
    const updater = new FakeUpdater()
    const { port } = portFor(updater)
    updater.downloadImpl = async () => {
      const progress: ProgressInfo = { total: 100, delta: 40, transferred: 40, percent: 40, bytesPerSecond: 12 }
      updater.emit('download-progress', progress)
      return ['C:\\cache\\ShiGuang-Setup-0.3.3.exe']
    }
    const seen: unknown[] = []
    const result = await port.downloadUpdate({ onProgress: (progress) => seen.push(progress), signal: new AbortController().signal })
    expect(result).toEqual({ filePath: 'C:\\cache\\ShiGuang-Setup-0.3.3.exe' })
    expect(seen).toEqual([{ receivedBytes: 40, totalBytes: 100, bytesPerSecond: 12 }])
    expect(updater.listenerCount('download-progress')).toBe(0)
  })

  it('取消：signal 中止传给 CancellationToken；下载 reject 原样上抛', async () => {
    const updater = new FakeUpdater()
    const { port } = portFor(updater)
    updater.downloadImpl = (token) => new Promise((_resolve, reject) => {
      token.once('cancel', () => reject(new Error('cancelled by token')))
    })
    const abort = new AbortController()
    const pending = port.downloadUpdate({ onProgress: () => {}, signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toThrow('cancelled by token')
    expect(updater.listenerCount('download-progress')).toBe(0)
  })

  it('安装：静默 + 装完拉起', () => {
    const updater = new FakeUpdater()
    portFor(updater).port.quitAndInstall()
    expect(updater.installCalls).toEqual([[true, true]])
  })

  it('更新源：自定义走 generic 并保住缓存目录名；清空只在曾切换过时才回写 GitHub；不支持的平台不动', () => {
    const updater = new FakeUpdater()
    const { port } = portFor(updater)
    port.setFeedUrl(undefined)
    expect(updater.feeds).toEqual([])
    port.setFeedUrl('https://mirror.example.com/sg/')
    expect(updater.feeds).toEqual([{ provider: 'generic', url: 'https://mirror.example.com/sg/', updaterCacheDirName: APP_UPDATER_CACHE_DIR_NAME }])
    port.setFeedUrl(undefined)
    expect(updater.feeds.at(-1)).toEqual({ provider: 'github', owner: 'lyr339', repo: 'SG-Team', updaterCacheDirName: APP_UPDATER_CACHE_DIR_NAME })

    const mac = new FakeUpdater()
    portFor(mac, { platform: 'darwin' }).port.setFeedUrl('https://mirror.example.com/sg/')
    expect(mac.feeds).toEqual([])
  })
})
