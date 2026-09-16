import {
  appUpdateReleaseUrl,
  appUpdateReminderVersion,
  evaluateUpdateGate,
  isNewerAppVersion,
  nextAppUpdateCheckDelayMs,
  reduceAppUpdate,
  APP_UPDATE_SNOOZE_MS,
  type AppUpdateEvent,
  type AppUpdateRelease,
  type AppUpdateSettings,
  type AppUpdateState,
  type AppUpdateStatus,
  type UpdateGate,
  type UpdateGateInput
} from '../domain/app-update'
import type { AppUpdateSettingsStore } from './app-update-settings-store'

export type AppUpdateCheckOutcome =
  | { available: false }
  | { available: true; release: AppUpdateRelease }

export interface AppUpdateDownloadProgress {
  receivedBytes: number
  totalBytes: number
  bytesPerSecond?: number
}

/**
 * 更新器端口：把 electron-updater（或任何提供方）收成四个动作。实现里不得弹窗、不得
 * 自动下载或在退出时静默安装——手动组件的所有触发都在服务层由用户意图驱动。
 */
export interface AppUpdaterPort {
  /** 平台 / 打包状态是否支持应用内更新；不支持时给出人话原因。 */
  support(): { ok: true } | { ok: false; reason: string }
  /** 切换更新源（undefined = 回到默认 GitHub Releases）。 */
  setFeedUrl(url: string | undefined): void
  checkForUpdates(): Promise<AppUpdateCheckOutcome>
  /** 下载本平台安装包；signal 中止时以 reject 结束（服务层按 signal.aborted 识别取消）。 */
  downloadUpdate(input: { onProgress: (progress: AppUpdateDownloadProgress) => void; signal: AbortSignal }): Promise<{ filePath?: string }>
  /** 退出拾光并运行安装器（安装完成后拉起新版）。同步抛错表示没能启动安装器。 */
  quitAndInstall(): void
}

export interface AppUpdateServiceDeps {
  currentVersion: string
  port: AppUpdaterPort
  settings: AppUpdateSettingsStore
  gateInput: () => UpdateGateInput
  /** 本次进程是否由安装器更新后拉起（`process.argv.includes('--updated')`）。 */
  launchedAfterUpdate?: boolean
  now?: () => number
  timers?: { setTimeout: (handler: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }
  log?: (message: string) => void
}

const PROGRESS_EMIT_INTERVAL_MS = 500

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

/**
 * 拾光自更新服务：静默周期检查 → 发现新版只置状态（提醒由渲染层按 reminderVersion 展示）→
 * 下载与安装均由用户显式触发；单飞（检查 / 下载 / 安装期间拒绝重入，返回当前状态）。
 * 网络失败只落到 `idle.lastError`，从不上抛为弹窗。
 */
export class AppUpdateService {
  private state: AppUpdateState
  private settings: AppUpdateSettings
  private lastCheckedAt: number | undefined
  private readonly listeners = new Set<(status: AppUpdateStatus) => void>()
  private timer: unknown
  private started = false
  private downloadAbort: AbortController | undefined
  private lastProgressEmitAt = 0
  private lastProgressPercent = -1
  private readonly now: () => number
  private readonly timers: NonNullable<AppUpdateServiceDeps['timers']>
  private readonly log: (message: string) => void

  constructor(private readonly deps: AppUpdateServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.timers = deps.timers ?? {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
    this.log = deps.log ?? ((message) => process.stderr.write(`[app-update] ${message}\n`))
    const loaded = deps.settings.load()
    this.settings = loaded.settings
    this.lastCheckedAt = loaded.runtime.lastCheckedAt
    const support = deps.port.support()
    this.state = support.ok
      ? { phase: 'idle', ...(this.lastCheckedAt !== undefined ? { lastCheckedAt: this.lastCheckedAt } : {}) }
      : { phase: 'unsupported', reason: support.reason }
    if (support.ok && this.settings.feedUrl) deps.port.setFeedUrl(this.settings.feedUrl)
  }

  getStatus(): AppUpdateStatus {
    const now = this.now()
    const reminderVersion = appUpdateReminderVersion(this.state, this.settings, now)
    const release = 'release' in this.state ? this.state.release : undefined
    return {
      currentVersion: this.deps.currentVersion,
      state: this.state,
      settings: this.settings,
      ...(reminderVersion ? { reminderVersion } : {}),
      launchedAfterUpdate: this.deps.launchedAfterUpdate === true,
      releaseUrl: release?.releaseUrl ?? appUpdateReleaseUrl(this.deps.currentVersion)
    }
  }

  getSettings(): AppUpdateSettings {
    return this.settings
  }

  onChange(listener: (status: AppUpdateStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 启动周期检查（autoCheck 关闭或平台不支持时不排定时器）。幂等。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleAutoCheck()
  }

  stop(): void {
    this.started = false
    this.clearTimer()
    this.downloadAbort?.abort()
  }

  saveSettings(raw: unknown): AppUpdateStatus {
    const previous = this.settings
    this.settings = this.deps.settings.save(raw, this.runtimeRecord())
    if (previous.feedUrl !== this.settings.feedUrl && this.state.phase !== 'unsupported') {
      this.deps.port.setFeedUrl(this.settings.feedUrl)
    }
    this.scheduleAutoCheck()
    return this.emit()
  }

  async check(input: { manual: boolean }): Promise<AppUpdateStatus> {
    // 已下载待安装时不再检查：用户还没装，再报一个更新版本只会制造困惑；装完新版自会再检查。
    if (this.state.phase === 'unsupported' || this.state.phase === 'checking' || this.state.phase === 'downloaded'
      || this.state.phase === 'downloading' || this.state.phase === 'installing') {
      return this.getStatus()
    }
    this.dispatch({ type: 'check_started' })
    try {
      const outcome = await this.deps.port.checkForUpdates()
      this.noteChecked()
      if (outcome.available && isNewerAppVersion(outcome.release.version, this.deps.currentVersion)) {
        this.dispatch({ type: 'check_available', release: outcome.release })
      } else {
        this.dispatch({ type: 'check_up_to_date' })
      }
    } catch (error) {
      this.noteChecked()
      const message = errorMessage(error)
      this.log(`检查更新失败：${message}`)
      this.dispatch({ type: 'check_failed', message })
    }
    this.scheduleAutoCheck()
    return this.getStatus()
  }

  async download(): Promise<AppUpdateStatus> {
    if (this.state.phase !== 'available') return this.getStatus()
    const abort = new AbortController()
    this.downloadAbort = abort
    this.lastProgressEmitAt = 0
    this.lastProgressPercent = -1
    this.dispatch({ type: 'download_started' })
    try {
      const result = await this.deps.port.downloadUpdate({
        signal: abort.signal,
        onProgress: (progress) => this.onProgress(progress)
      })
      if (abort.signal.aborted) {
        this.dispatch({ type: 'download_cancelled' })
      } else {
        this.dispatch({ type: 'download_completed', ...(result.filePath ? { filePath: result.filePath } : {}) })
      }
    } catch (error) {
      if (abort.signal.aborted) {
        this.dispatch({ type: 'download_cancelled' })
      } else {
        const message = errorMessage(error)
        this.log(`下载更新失败：${message}`)
        this.dispatch({ type: 'download_failed', message })
      }
    } finally {
      if (this.downloadAbort === abort) this.downloadAbort = undefined
    }
    return this.getStatus()
  }

  cancelDownload(): AppUpdateStatus {
    if (this.state.phase !== 'downloading') return this.getStatus()
    this.downloadAbort?.abort()
    return this.getStatus()
  }

  /**
   * 安装：先过门禁。`block` 与未确认的 `confirm` 只返回门禁结论，不动状态；
   * 放行后置 installing 并交给安装器——正常情况下进程随即退出。
   */
  install(input: { confirmed: boolean }): { gate: UpdateGate; status: AppUpdateStatus } {
    if (this.state.phase !== 'downloaded') return { gate: { verdict: 'allow' }, status: this.getStatus() }
    const gate = evaluateUpdateGate(this.deps.gateInput())
    if (gate.verdict === 'block' || (gate.verdict === 'confirm' && !input.confirmed)) {
      return { gate, status: this.getStatus() }
    }
    this.dispatch({ type: 'install_started' })
    try {
      this.deps.port.quitAndInstall()
    } catch (error) {
      const message = errorMessage(error)
      this.log(`启动安装器失败：${message}`)
      this.dispatch({ type: 'install_failed', message })
    }
    return { gate, status: this.getStatus() }
  }

  /** 跳过当前发现的版本：不再提醒，直到出现更高版本。只改设置，不改状态。 */
  skipCurrent(): AppUpdateStatus {
    const release = 'release' in this.state ? this.state.release : undefined
    if (!release) return this.getStatus()
    return this.saveSettings({ ...this.settings, skippedVersion: release.version })
  }

  unskip(): AppUpdateStatus {
    const { skippedVersion: _skipped, ...rest } = this.settings
    return this.saveSettings(rest)
  }

  /** 稍后：24 小时内不再提醒（手动检查与面板不受影响）。 */
  snooze(): AppUpdateStatus {
    return this.saveSettings({ ...this.settings, snoozedUntil: this.now() + APP_UPDATE_SNOOZE_MS })
  }

  dismissFailure(): AppUpdateStatus {
    this.dispatch({ type: 'dismissed' })
    return this.getStatus()
  }

  private onProgress(progress: AppUpdateDownloadProgress): void {
    if (this.state.phase !== 'downloading') return
    const now = this.now()
    const percent = progress.totalBytes > 0 ? Math.floor((progress.receivedBytes / progress.totalBytes) * 100) : -1
    const dueByTime = now - this.lastProgressEmitAt >= PROGRESS_EMIT_INTERVAL_MS
    const dueByPercent = percent !== this.lastProgressPercent
    this.state = reduceAppUpdate(this.state, { type: 'download_progress', ...progress }, now)
    if (!dueByTime && !dueByPercent) return
    this.lastProgressEmitAt = now
    this.lastProgressPercent = percent
    this.emit()
  }

  private dispatch(event: AppUpdateEvent): void {
    const next = reduceAppUpdate(this.state, event, this.now())
    if (next === this.state) return
    this.state = next
    this.emit()
  }

  private emit(): AppUpdateStatus {
    const status = this.getStatus()
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch (error) {
        this.log(`状态监听器抛错：${errorMessage(error)}`)
      }
    }
    return status
  }

  private noteChecked(): void {
    this.lastCheckedAt = this.now()
    try {
      this.deps.settings.save(this.settings, this.runtimeRecord())
    } catch (error) {
      this.log(`记录检查时间失败：${errorMessage(error)}`)
    }
  }

  private runtimeRecord(): { lastCheckedAt?: number } {
    return this.lastCheckedAt !== undefined ? { lastCheckedAt: this.lastCheckedAt } : {}
  }

  private scheduleAutoCheck(): void {
    this.clearTimer()
    if (!this.started || !this.settings.autoCheck || this.state.phase === 'unsupported') return
    const delay = nextAppUpdateCheckDelayMs(this.settings, this.lastCheckedAt, this.now())
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      void this.check({ manual: false })
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}