import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AppUpdateCheckOutcome, AppUpdaterPort } from '../../application/app-update-service'
import {
  APP_UPDATE_REPOSITORY,
  parseAppUpdateApplyResult,
  type AppUpdateApplyResult,
  type AppUpdateBackupInfo,
  type AppUpdateRelease
} from '../../domain/app-update'
import {
  classifyInstallLocation,
  estimateUpdateRequiredBytes,
  installLocationBlockReason,
  MAC_BUNDLE_IDENTIFIER,
  UPDATE_MANIFEST_FILE_NAME,
  updatePlatformKey,
  type InstallLocation,
  type UpdateManifest,
  type UpdateManifestAsset
} from '../../domain/app-update-manifest'
import { fetchUpdateManifest, resolveLatestReleaseTag, type FetchLike } from './github-manifest-feed'
import { buildApplyScript, buildRollbackScript, stageMacBundle, writeHelperScript, type RunCommand } from './mac-app-replacer'
import { createUpdateBackup, findRollbackBackup, vacuumDatabaseInto } from './update-backup'
import { downloadFile } from './update-downloader'

export interface MacUpdaterPortInput {
  platform: NodeJS.Platform
  arch: string
  isPackaged: boolean
  /** `process.execPath`：`/Applications/拾光.app/Contents/MacOS/拾光`。 */
  execPath: string
  homeDir: string
  currentVersion: string
  /** userData 目录；`updates/` 子目录放下载、暂存、备份、脚本、日志与结果文件。 */
  userDataDir: string
  databasePath: string
  /** 备份时一并复制的小文件（`~/.cursor/mcp.json`、userData 根下的 *.json）。 */
  backupFiles: () => string[]
  fetch: FetchLike
  /** 让 Electron 在本进程退出后执行辅助脚本：`app.relaunch({ execPath: '/bin/sh', args })`。 */
  relaunch: (execPath: string, args: string[]) => void
  /** 退出本进程（`app.quit()`：走 before-quit 把仓储关干净）。 */
  quit: () => void
  pid?: number
  run?: RunCommand
  now?: () => number
  log?: (message: string) => void
  /** 测试注入：目录可写判定与卷余量。 */
  isWritable?: (dir: string) => boolean
  freeBytes?: (path: string) => number
}

export const APP_UPDATES_DIR_NAME = 'updates'
export const PENDING_RESULT_FILE = 'pending-result.json'

function defaultIsWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function defaultFreeBytes(path: string): number {
  try {
    const stats = statfsSync(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.ceil(bytes / 1024 ** 2)} MB`
}

/**
 * mac 的更新器端口（任务书 §4–§7）：静态清单当更新源；`net.fetch` 流式下载 + sha512；`ditto` 解压、
 * `plutil` / `codesign` 验收；退出前 `VACUUM INTO` 备库并复制配置；由 `/bin/sh` 脚本在退出后整包
 * `mv` 交换、复验签名、写结果并 `open` 新版。失败即换回旧包。回滚把备份里的 app 与库一起换回。
 */
export function createMacUpdaterPort(input: MacUpdaterPortInput): AppUpdaterPort {
  const log = input.log ?? ((message: string) => process.stderr.write(`[app-update] ${message}\n`))
  const now = input.now ?? (() => Date.now())
  const isWritable = input.isWritable ?? defaultIsWritable
  const freeBytes = input.freeBytes ?? defaultFreeBytes
  const platformKey = updatePlatformKey(input.platform, input.arch)
  const updatesDir = join(input.userDataDir, APP_UPDATES_DIR_NAME)
  const downloadsDir = join(updatesDir, 'downloads')
  const stagingDir = join(updatesDir, 'staging')
  const backupRoot = join(updatesDir, 'backup')
  const logPath = join(updatesDir, 'apply.log')
  const resultPath = join(updatesDir, PENDING_RESULT_FILE)

  const location: InstallLocation = ((): InstallLocation => {
    const probe = classifyInstallLocation({ execPath: input.execPath, platform: input.platform, homeDir: input.homeDir, writable: false })
    const writable = probe.kind === 'unknown' ? false : isWritable(dirname(probe.bundlePath))
    return { ...probe, writable }
  })()
  const bundleName = basename(location.bundlePath)

  const support = ((): { ok: true } | { ok: false; reason: string } => {
    if (input.platform !== 'darwin' || !platformKey) {
      return { ok: false, reason: '此平台的应用内更新尚未提供：请到发布页下载新版后手动替换。' }
    }
    if (!input.isPackaged) return { ok: false, reason: '开发模式下不检查更新。' }
    const blocked = installLocationBlockReason(location)
    return blocked ? { ok: false, reason: blocked } : { ok: true }
  })()

  let manifestUrl: string | undefined
  let candidate: { manifest: UpdateManifest; asset: UpdateManifestAsset | undefined; assetUrl: string | undefined } | undefined
  let staged: { version: string; bundlePath: string } | undefined

  /**
   * 设置里的「自定义更新源」两个平台同义：一个静态目录，Windows 下 electron-updater 取目录里的
   * `latest.yml` 并相对它下载安装包；这里取 `update-manifest.json`，安装包同样从该目录取——
   * 镜像前缀（gh-proxy 类）才能把检查与下载一起接走。直接给到清单文件的 URL 也认，目录取其所在处。
   */
  const customFeed = (): { manifestUrl: string; directory: string } | undefined => {
    if (manifestUrl === undefined) return undefined
    if (/\.json($|[?#])/.test(manifestUrl)) {
      return { manifestUrl, directory: manifestUrl.replace(/\/[^/]*$/, '') }
    }
    const directory = manifestUrl.replace(/\/+$/, '')
    return { manifestUrl: `${directory}/${UPDATE_MANIFEST_FILE_NAME}`, directory }
  }

  const releaseUrlOf = (tag: string): string =>
    `https://github.com/${APP_UPDATE_REPOSITORY.owner}/${APP_UPDATE_REPOSITORY.repo}/releases/tag/${tag}`

  const releaseFromManifest = (manifest: UpdateManifest, asset: UpdateManifestAsset | undefined): AppUpdateRelease => ({
    version: manifest.version,
    releaseDate: manifest.publishedAt,
    ...(manifest.notesMarkdown ? { releaseNotes: manifest.notesMarkdown } : {}),
    ...(asset ? { sizeBytes: asset.size } : {}),
    releaseUrl: releaseUrlOf(manifest.tag),
    ...(asset ? {} : { downloadable: false })
  })

  const databaseBytes = (): number => {
    try {
      return statSync(input.databasePath).size
    } catch {
      return 0
    }
  }

  return {
    support: () => support,
    setFeedUrl: (url) => {
      manifestUrl = url
      log(url ? `更新源切换为自定义清单：${url}` : '更新源恢复为 GitHub Releases')
    },
    checkForUpdates: async (): Promise<AppUpdateCheckOutcome> => {
      const feed = customFeed()
      const result = await fetchUpdateManifest({ ...(feed ? { url: feed.manifestUrl } : {}), fetch: input.fetch })
      if (result.kind === 'error') throw new Error(result.message)
      if (result.kind === 'manifest') {
        const asset = platformKey ? result.manifest.assets[platformKey] : undefined
        const assetUrl = asset ? (feed ? `${feed.directory}/${encodeURIComponent(asset.name)}` : asset.url) : undefined
        candidate = { manifest: result.manifest, asset, assetUrl }
        return { available: true, release: releaseFromManifest(result.manifest, asset) }
      }
      // 最新 Release 没有清单（清单机制之前发的版本）：只能知道 tag，不能应用内下载。
      candidate = undefined
      if (manifestUrl) throw new Error('自定义更新源上没有 update-manifest.json')
      const tag = await resolveLatestReleaseTag({ fetch: input.fetch })
      if (!tag) throw new Error('无法获取最新版本信息（清单不存在，发布页也没有给出版本）')
      return {
        available: true,
        release: { version: tag.replace(/^v/, ''), releaseUrl: releaseUrlOf(tag), downloadable: false }
      }
    },
    downloadUpdate: async ({ onProgress, signal }) => {
      if (!candidate?.asset || !candidate.assetUrl) throw new Error('这一版没有提供 mac 安装包，请到发布页手动下载。')
      const { manifest, asset, assetUrl } = candidate
      const required = estimateUpdateRequiredBytes(asset.size, databaseBytes())
      mkdirSync(updatesDir, { recursive: true })
      const available = freeBytes(updatesDir)
      if (available < required) {
        throw new Error(`磁盘可用空间不足：更新需要约 ${formatBytes(required)}，当前可用 ${formatBytes(available)}。`)
      }
      staged = undefined
      rmSync(stagingDir, { recursive: true, force: true })
      const zipPath = join(downloadsDir, asset.name)
      rmSync(zipPath, { force: true })
      try {
        await downloadFile({
          url: assetUrl,
          destination: zipPath,
          expectedSha512: asset.sha512,
          expectedSize: asset.size,
          fetch: input.fetch,
          signal,
          onProgress: (progress) => onProgress({ ...progress, activity: 'transfer' }),
          now
        })
        onProgress({ receivedBytes: asset.size, totalBytes: asset.size, activity: 'verify' })
        const bundlePath = await stageMacBundle({
          zipPath,
          stagingDir,
          expectedVersion: manifest.version,
          bundleIdentifier: MAC_BUNDLE_IDENTIFIER,
          bundleName,
          ...(input.run ? { run: input.run } : {})
        })
        if (signal.aborted) {
          rmSync(stagingDir, { recursive: true, force: true })
          throw new Error('下载已取消')
        }
        staged = { version: manifest.version, bundlePath }
        return { filePath: bundlePath }
      } finally {
        // zip 只为解压服务；成功失败都不留 130 MB 在磁盘上。
        rmSync(zipPath, { force: true })
      }
    },
    quitAndInstall: () => {
      if (!staged) throw new Error('没有已就绪的新版本')
      if (!existsSync(staged.bundlePath)) {
        staged = undefined
        throw new Error('已就绪的新包不在了，请重新下载')
      }
      const blocked = installLocationBlockReason({ ...location, writable: isWritable(dirname(location.bundlePath)) })
      if (blocked) throw new Error(blocked)
      const backup = createUpdateBackup({
        backupRoot,
        appVersion: input.currentVersion,
        bundleName,
        databasePath: input.databasePath,
        extraFiles: input.backupFiles(),
        now
      })
      const script = writeHelperScript(updatesDir, `apply-${now()}.sh`, buildApplyScript({
        pid: input.pid ?? process.pid,
        fromVersion: input.currentVersion,
        toVersion: staged.version,
        bundlePath: location.bundlePath,
        stagedBundlePath: staged.bundlePath,
        backupBundlePath: backup.bundlePath,
        backupDir: backup.dir,
        rejectedBundlePath: join(stagingDir, 'rejected.app'),
        logPath,
        resultPath
      }))
      log(`退出并替换：${input.currentVersion} → ${staged.version}（脚本 ${script}，备份 ${backup.dir}）`)
      input.relaunch('/bin/sh', [script])
      input.quit()
    },
    takePendingApplyResult: (): AppUpdateApplyResult | undefined => {
      if (input.platform !== 'darwin') return undefined
      let result: AppUpdateApplyResult | undefined
      if (existsSync(resultPath)) {
        try {
          result = parseAppUpdateApplyResult(JSON.parse(readFileSync(resultPath, 'utf8')))
        } catch (error) {
          log(`上次更新的结果文件不可读：${String(error)}`)
        }
        rmSync(resultPath, { force: true })
      }
      // 启动即清理下载与暂存（结果无论成败它们都没用了）；备份与日志保留。
      rmSync(downloadsDir, { recursive: true, force: true })
      rmSync(stagingDir, { recursive: true, force: true })
      return result
    },
    backupInfo: (): AppUpdateBackupInfo | undefined => {
      const record = findRollbackBackup(backupRoot)
      return record ? { version: record.version, createdAt: record.createdAt, dir: record.dir } : undefined
    },
    rollback: () => {
      const record = findRollbackBackup(backupRoot)
      if (!record) throw new Error('没有可回滚的备份')
      const blocked = installLocationBlockReason({ ...location, writable: isWritable(dirname(location.bundlePath)) })
      if (blocked) throw new Error(blocked)
      // 当前库另存一份：回滚会用更新前的快照覆盖它，更新后产生的数据在旧版里不可见但不丢。
      const keepDir = join(updatesDir, `rollback-${now()}`)
      mkdirSync(keepDir, { recursive: true })
      if (existsSync(input.databasePath)) vacuumDatabaseInto(input.databasePath, join(keepDir, basename(input.databasePath)))
      const script = writeHelperScript(updatesDir, `rollback-${now()}.sh`, buildRollbackScript({
        pid: input.pid ?? process.pid,
        fromVersion: input.currentVersion,
        toVersion: record.version,
        bundlePath: location.bundlePath,
        backupBundlePath: record.bundlePath,
        rolledBackBundlePath: join(stagingDir, 'rolled-back.app'),
        databasePath: input.databasePath,
        ...(record.databaseCopyPath ? { backupDatabasePath: record.databaseCopyPath } : {}),
        logPath,
        resultPath
      }))
      log(`退出并回滚：${input.currentVersion} → ${record.version}（脚本 ${script}，当前库另存 ${keepDir}）`)
      input.relaunch('/bin/sh', [script])
      input.quit()
    }
  }
}
