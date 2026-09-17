// electron-updater 是 CJS，主进程是 ESM：只用默认导入取 module.exports（命名导入 `autoUpdater` 在
// Node 的 CJS 词法分析里找不到——它是 exports 上的惰性 getter；CancellationToken 虽能命名导入，
// 但同一模块保持一种导入方式，别让两处依赖两套解析规则）。类型导入在编译期擦除，不受影响。
import electronUpdater, {
  type AppUpdater,
  type CancellationToken as CancellationTokenType,
  type ProgressInfo,
  type UpdateCheckResult,
  type UpdateInfo
} from 'electron-updater'
import type { AppUpdateCheckOutcome, AppUpdaterPort } from '../../application/app-update-service'
import { APP_UPDATE_REPOSITORY, appUpdateReleaseUrl, type AppUpdateRelease } from '../../domain/app-update'

const { CancellationToken } = electronUpdater

type FeedOptions = Parameters<AppUpdater['setFeedURL']>[0]

/** electron-updater `autoUpdater` 的结构子集；测试注入假实现。 */
export interface ElectronUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  logger: { info(message?: unknown): void; warn(message?: unknown): void; error(message?: unknown): void } | null
  setFeedURL(options: FeedOptions): void
  checkForUpdates(): Promise<UpdateCheckResult | null>
  downloadUpdate(cancellationToken?: CancellationTokenType): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown
  removeListener(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown
}

export interface ElectronUpdaterPortInput {
  /** 缺省 = 本平台不接更新器（调用方在 mac 上连 getter 都不碰，避免白白实例化 MacUpdater）。 */
  updater?: ElectronUpdaterLike
  platform: NodeJS.Platform
  isPackaged: boolean
  /** 与安装器一致的缓存目录名（app-update.yml 的 updaterCacheDirName）；切换更新源时保住差分下载用的旧安装包。 */
  updaterCacheDirName?: string
  log?: (message: string) => void
}

export const APP_UPDATER_CACHE_DIR_NAME = 'shiguang-team-updater'

function releaseNotesText(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  const merged = notes
    .map((entry) => (entry.note ? `${entry.version}\n${entry.note}` : entry.version))
    .join('\n\n')
    .trim()
  return merged || undefined
}

export function releaseFromUpdateInfo(info: UpdateInfo): AppUpdateRelease {
  const size = info.files.find((file) => typeof file.size === 'number' && file.size > 0)?.size
  const notes = releaseNotesText(info.releaseNotes)
  return {
    version: info.version,
    ...(info.releaseDate ? { releaseDate: info.releaseDate } : {}),
    ...(info.releaseName ? { releaseName: info.releaseName } : {}),
    ...(notes ? { releaseNotes: notes } : {}),
    ...(size !== undefined ? { sizeBytes: size } : {}),
    releaseUrl: appUpdateReleaseUrl(info.version)
  }
}

/**
 * 把 electron-updater 收成 AppUpdaterPort。只在打包后的 Windows 上支持：mac 包是 adhoc 签名，
 * Squirrel.Mac 永远过不了同一 designated requirement 的校验（任务书 §0.3-1），先不接。
 *
 * 手动组件的三条硬规则在这里落地：不自动下载、不在退出时静默安装、安装只由 quitAndInstall 触发。
 * 默认更新源来自打包时写入 resources/app-update.yml（GitHub Releases：atom 订阅取最新 tag →
 * `releases/download/<tag>/latest.yml`，不碰 REST API 限额）；自定义源走 generic 提供方。
 */
export function createElectronUpdaterPort(input: ElectronUpdaterPortInput): AppUpdaterPort {
  const log = input.log ?? ((message: string) => process.stderr.write(`[app-update] ${message}\n`))
  const cacheDirName = input.updaterCacheDirName ?? APP_UPDATER_CACHE_DIR_NAME
  const support = ((): { ok: true } | { ok: false; reason: string } => {
    if (input.platform !== 'win32' || !input.updater) {
      return { ok: false, reason: '此平台的应用内更新尚未提供：请到发布页下载新版后手动替换。' }
    }
    if (!input.isPackaged) return { ok: false, reason: '开发模式下不检查更新。' }
    return { ok: true }
  })()
  const updaterOrThrow = (): ElectronUpdaterLike => {
    if (!input.updater) throw new Error('此平台没有更新器')
    return input.updater
  }

  let configured = false
  let customFeedApplied = false
  const configure = (): ElectronUpdaterLike => {
    const updater = updaterOrThrow()
    if (configured) return updater
    configured = true
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.autoRunAppAfterInstall = true
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.logger = {
      info: (message) => log(String(message)),
      warn: (message) => log(`warn: ${String(message)}`),
      error: (message) => log(`error: ${String(message)}`)
    }
    return updater
  }

  return {
    support: () => support,
    setFeedUrl: (url) => {
      if (!support.ok) return
      const updater = configure()
      if (url) {
        updater.setFeedURL({ provider: 'generic', url, updaterCacheDirName: cacheDirName } as FeedOptions)
        customFeedApplied = true
        log(`更新源切换为自定义：${url}`)
        return
      }
      // 从未离开默认源就什么都不做：app-update.yml 的配置只在打包时写入，这里没有更准确的副本。
      if (!customFeedApplied) return
      updater.setFeedURL({
        provider: 'github',
        owner: APP_UPDATE_REPOSITORY.owner,
        repo: APP_UPDATE_REPOSITORY.repo,
        updaterCacheDirName: cacheDirName
      } as FeedOptions)
      customFeedApplied = false
      log('更新源恢复为 GitHub Releases')
    },
    checkForUpdates: async (): Promise<AppUpdateCheckOutcome> => {
      const result = await configure().checkForUpdates()
      if (!result || !result.isUpdateAvailable) return { available: false }
      return { available: true, release: releaseFromUpdateInfo(result.updateInfo) }
    },
    downloadUpdate: async ({ onProgress, signal }) => {
      const updater = configure()
      const token = new CancellationToken()
      const onAbort = (): void => token.cancel()
      if (signal.aborted) token.cancel()
      signal.addEventListener('abort', onAbort, { once: true })
      const onDownloadProgress = (info: ProgressInfo): void => {
        onProgress({ receivedBytes: info.transferred, totalBytes: info.total, bytesPerSecond: info.bytesPerSecond })
      }
      updater.on('download-progress', onDownloadProgress)
      try {
        const paths = await updater.downloadUpdate(token)
        const filePath = paths[0]
        return filePath ? { filePath } : {}
      } finally {
        updater.removeListener('download-progress', onDownloadProgress)
        signal.removeEventListener('abort', onAbort)
        token.dispose()
      }
    },
    quitAndInstall: () => {
      // 静默安装 + 装完拉起：安装器按注册表沿用原目录与安装模式（按机安装会经 UAC 提权一次）。
      configure().quitAndInstall(true, true)
    }
  }
}
