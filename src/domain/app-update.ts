/**
 * 拾光自更新（app-update）的纯领域：版本比较、设置归一化、状态机、提醒判定与安装门禁。
 *
 * 与 `cursor-update.ts`（关闭 Cursor 自身自动更新的开关）无关。这里描述的是拾光自己
 * 从 GitHub Releases 发现新版、由用户手动下载并安装的流程：更新是**手动组件**——
 * 服务端只静默检查，发现新版只允许一个不打扰的小提醒；下载与安装都由用户显式触发。
 */

export const APP_UPDATE_REPOSITORY = { owner: 'lyr339', repo: 'SG-Team' } as const

/** 启动后首次静默检查的延迟：让会话、遥测与 CDP 先就位，不与启动期的磁盘 / 网络争抢。 */
export const APP_UPDATE_FIRST_CHECK_DELAY_MS = 45_000
/** 「稍后」压制提醒的时长。 */
export const APP_UPDATE_SNOOZE_MS = 24 * 60 * 60_000
/** 自动检查间隔的可选档位（小时）。 */
export const APP_UPDATE_CHECK_INTERVAL_HOURS = [6, 12, 24] as const
export type AppUpdateCheckIntervalHours = (typeof APP_UPDATE_CHECK_INTERVAL_HOURS)[number]

export interface AppVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识（`0.3.0-beta.1` 的 `beta.1`）；同号下有预发布标识的低于正式版。 */
  prerelease?: string
}

/** 接受 `v0.2.1` / `0.2.1` / `0.3.0-beta.1`；其余形态返回 undefined。 */
export function parseAppVersion(text: string): AppVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim())
  if (!match) return undefined
  const [, major, minor, patch, prerelease] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(prerelease ? { prerelease } : {})
  }
}

function comparePrerelease(left: string | undefined, right: string | undefined): -1 | 0 | 1 {
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  const leftParts = left.split('.')
  const rightParts = right.split('.')
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index]
    const b = rightParts[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

export function compareAppVersions(left: AppVersion, right: AppVersion): -1 | 0 | 1 {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** 候选版本是否严格高于当前版本；任一无法解析视为不更新（宁可漏报，不误报）。 */
export function isNewerAppVersion(candidate: string, current: string): boolean {
  const next = parseAppVersion(candidate)
  const now = parseAppVersion(current)
  if (!next || !now) return false
  return compareAppVersions(next, now) > 0
}

export interface AppUpdateSettings {
  /** 静默自动检查开关（默认开）。只检查，不下载。 */
  autoCheck: boolean
  checkIntervalHours: AppUpdateCheckIntervalHours
  /** 用户「跳过此版本」：该版本不再提醒，直到出现更高版本。 */
  skippedVersion?: string
  /** 用户「稍后」：此刻之前不弹提醒（手动检查不受限）。 */
  snoozedUntil?: number
  /**
   * 自定义更新源（高级）：electron-updater `generic` 提供方的目录 URL，目录下须有
   * `latest.yml` 与安装包。缺省走 GitHub Releases。国内镜像与本机验收用。
   */
  feedUrl?: string
}

export const DEFAULT_APP_UPDATE_SETTINGS: AppUpdateSettings = {
  autoCheck: true,
  checkIntervalHours: 6
}

function normalizeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return trimmed
  } catch {
    return undefined
  }
}

export function normalizeAppUpdateSettings(value: unknown): AppUpdateSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const interval = APP_UPDATE_CHECK_INTERVAL_HOURS.find((hours) => hours === raw.checkIntervalHours)
    ?? DEFAULT_APP_UPDATE_SETTINGS.checkIntervalHours
  const skippedVersion = typeof raw.skippedVersion === 'string' && parseAppVersion(raw.skippedVersion)
    ? raw.skippedVersion.trim()
    : undefined
  const snoozedUntil = typeof raw.snoozedUntil === 'number' && Number.isFinite(raw.snoozedUntil) && raw.snoozedUntil > 0
    ? raw.snoozedUntil
    : undefined
  const feedUrl = normalizeHttpUrl(raw.feedUrl)
  return {
    autoCheck: raw.autoCheck !== false,
    checkIntervalHours: interval,
    ...(skippedVersion ? { skippedVersion } : {}),
    ...(snoozedUntil ? { snoozedUntil } : {}),
    ...(feedUrl ? { feedUrl } : {})
  }
}

/** 一次发布（来自 latest.yml / GitHub Release）；渲染层只消费这些字段。 */
export interface AppUpdateRelease {
  version: string
  /** ISO 8601；提供方没给时缺省。 */
  releaseDate?: string
  releaseName?: string
  /** GitHub Release 正文（HTML 或 Markdown 原文）；渲染层按纯文本段落展示。 */
  releaseNotes?: string
  /** 本平台安装包字节数。 */
  sizeBytes?: number
  releaseUrl: string
  /** false = 这一版没有本平台的应用内下载（清单缺资产 / 只拿到 tag）：只能去发布页。缺省视为可下载。 */
  downloadable?: boolean
}

export type AppUpdateFailureStep = 'check' | 'download' | 'install' | 'rollback'

/** 检查失败的分级：网络类（瞬断、断网、被墙——该重试、别吓人）与其他（服务端答复、清单损坏——如实报）。 */
export type AppUpdateErrorKind = 'network' | 'other'

const NETWORK_ERROR_PATTERNS: readonly RegExp[] = [
  /net::ERR_[A-Z_]+/, // Chromium 网络栈（Electron net / electron-updater 的 ElectronHttpExecutor）
  /\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|NOTFOUND|AI_AGAIN|NETDOWN|NETUNREACH|HOSTUNREACH|PIPE)\b/,
  /\b(?:ETIMEOUT|ENETRESET)\b/,
  /socket hang up/i,
  /fetch failed/i,
  /\bterminated\b/i, // undici：连接在响应中途被掐
  /timeout/i,
  /aborted/i,
  /请求更新清单失败/, // mac 清单源对 fetch 异常的包装
  /无法获取最新版本信息/ // 清单 404 且发布页拿不到 tag：多为网络不通，按可重试处理
]

/**
 * 按错误文案分级。HTTP 状态类（「返回 HTTP 500」）是服务端的明确答复，不算网络失败；
 * 拿不准的一律归 other——宁可如实报红，也不把真错误藏成「稍后重试」。
 */
export function classifyAppUpdateError(message: string): AppUpdateErrorKind {
  if (/返回 HTTP \d{3}/.test(message)) return 'other'
  return NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message)) ? 'network' : 'other'
}

/** 网络类检查失败的短退避：2 → 10 → 30 分钟，此后每 30 分钟一次，直到成功或出现明确错误。 */
export const APP_UPDATE_RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000] as const

export function appUpdateRetryDelayMs(consecutiveFailures: number): number {
  const index = Math.min(Math.max(1, consecutiveFailures), APP_UPDATE_RETRY_DELAYS_MS.length) - 1
  return APP_UPDATE_RETRY_DELAYS_MS[index]!
}

/** 下载相位里的子活动：传输中，或传输完成后正在校验 / 解压（mac 的 ditto + codesign 要跑几秒）。 */
export type AppUpdateDownloadActivity = 'transfer' | 'verify'

export type AppUpdateState =
  | { phase: 'unsupported'; reason: string }
  | { phase: 'idle'; lastCheckedAt?: number; lastError?: string; lastErrorKind?: AppUpdateErrorKind }
  | { phase: 'checking'; startedAt: number; release?: AppUpdateRelease }
  | { phase: 'up_to_date'; checkedAt: number }
  | { phase: 'available'; release: AppUpdateRelease; checkedAt: number }
  | {
      phase: 'downloading'
      release: AppUpdateRelease
      receivedBytes: number
      totalBytes: number
      bytesPerSecond?: number
      activity?: AppUpdateDownloadActivity
      startedAt: number
    }
  | { phase: 'downloaded'; release: AppUpdateRelease; filePath?: string; downloadedAt: number }
  | { phase: 'installing'; release: AppUpdateRelease; startedAt: number }
  /** mac：正在退出并把备份里的旧版换回来（Windows 没有这一相位）。 */
  | { phase: 'rolling_back'; targetVersion: string; startedAt: number }
  | { phase: 'failed'; step: AppUpdateFailureStep; message: string; at: number; release?: AppUpdateRelease }

export type AppUpdateEvent =
  | { type: 'check_started' }
  | { type: 'check_up_to_date' }
  | { type: 'check_available'; release: AppUpdateRelease }
  | { type: 'check_failed'; message: string; kind?: AppUpdateErrorKind }
  | { type: 'download_started' }
  | { type: 'download_progress'; receivedBytes: number; totalBytes: number; bytesPerSecond?: number; activity?: AppUpdateDownloadActivity }
  | { type: 'download_completed'; filePath?: string }
  | { type: 'download_cancelled' }
  | { type: 'download_failed'; message: string }
  | { type: 'install_started' }
  | { type: 'install_failed'; message: string }
  | { type: 'rollback_started'; targetVersion: string }
  | { type: 'rollback_failed'; message: string }
  | { type: 'dismissed' }

function releaseOf(state: AppUpdateState): AppUpdateRelease | undefined {
  return 'release' in state ? state.release : undefined
}

/**
 * 状态机（纯 reducer）。不合法的边返回原状态：调用方只在允许的相位上派发，
 * 但网络回调可能迟到（取消后仍收到进度），这里静默吸收而不是抛错。
 */
export function reduceAppUpdate(state: AppUpdateState, event: AppUpdateEvent, now: number): AppUpdateState {
  if (state.phase === 'unsupported') return state
  switch (event.type) {
    case 'check_started': {
      // 已下载待安装也不再检查：再报一个更新版本只会让「装哪个」变得含糊。
      if (state.phase === 'downloading' || state.phase === 'downloaded' || state.phase === 'installing'
        || state.phase === 'rolling_back' || state.phase === 'checking') {
        return state
      }
      const release = releaseOf(state)
      return { phase: 'checking', startedAt: now, ...(release ? { release } : {}) }
    }
    case 'check_up_to_date':
      return state.phase === 'checking' ? { phase: 'up_to_date', checkedAt: now } : state
    case 'check_available':
      return state.phase === 'checking' ? { phase: 'available', release: event.release, checkedAt: now } : state
    case 'check_failed':
      return state.phase === 'checking'
        ? { phase: 'idle', lastCheckedAt: now, lastError: event.message, lastErrorKind: event.kind ?? 'other' }
        : state
    case 'download_started':
      // 没有本平台资产的版本只能去发布页：下载边不成立。
      return state.phase === 'available' && state.release.downloadable !== false
        ? { phase: 'downloading', release: state.release, receivedBytes: 0, totalBytes: state.release.sizeBytes ?? 0, startedAt: now }
        : state
    case 'download_progress': {
      if (state.phase !== 'downloading') return state
      // 进入校验阶段后传输速率没有意义，摘掉；传输中的事件没带速率则沿用上一次的。
      const { bytesPerSecond: previousRate, ...rest } = state
      const rate = event.bytesPerSecond ?? (event.activity === 'verify' ? undefined : previousRate)
      return {
        ...rest,
        receivedBytes: Math.max(0, event.receivedBytes),
        totalBytes: Math.max(0, event.totalBytes),
        ...(rate !== undefined ? { bytesPerSecond: rate } : {}),
        ...(event.activity !== undefined ? { activity: event.activity } : {})
      }
    }
    case 'download_completed':
      return state.phase === 'downloading'
        ? { phase: 'downloaded', release: state.release, downloadedAt: now, ...(event.filePath ? { filePath: event.filePath } : {}) }
        : state
    case 'download_cancelled':
      return state.phase === 'downloading' ? { phase: 'available', release: state.release, checkedAt: now } : state
    case 'download_failed':
      return state.phase === 'downloading'
        ? { phase: 'failed', step: 'download', message: event.message, at: now, release: state.release }
        : state
    case 'install_started':
      return state.phase === 'downloaded' ? { phase: 'installing', release: state.release, startedAt: now } : state
    case 'install_failed':
      return state.phase === 'installing'
        ? { phase: 'failed', step: 'install', message: event.message, at: now, release: state.release }
        : state
    case 'rollback_started':
      // 回滚只从「没在忙」的相位出发；下载 / 安装 / 检查进行中不许插队。
      return state.phase === 'idle' || state.phase === 'up_to_date' || state.phase === 'available'
        || state.phase === 'downloaded' || state.phase === 'failed'
        ? { phase: 'rolling_back', targetVersion: event.targetVersion, startedAt: now }
        : state
    case 'rollback_failed':
      return state.phase === 'rolling_back'
        ? { phase: 'failed', step: 'rollback', message: event.message, at: now }
        : state
    case 'dismissed': {
      if (state.phase !== 'failed') return state
      // 下载 / 安装失败后回到「有新版」，让用户能重试；检查失败已在 idle 里带 lastError。
      return state.release ? { phase: 'available', release: state.release, checkedAt: now } : { phase: 'idle', lastCheckedAt: now }
    }
  }
}

/** 安装器 / 辅助脚本留给下一次启动的结果（mac：`updates/pending-result.json`）。 */
export interface AppUpdateApplyResult {
  status: 'applied' | 'rolled_back' | 'apply_failed' | 'rollback_failed'
  from: string
  to: string
  reason?: string
  backupDir?: string
}

export function parseAppUpdateApplyResult(raw: unknown): AppUpdateApplyResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const status = record.status
  if (status !== 'applied' && status !== 'rolled_back' && status !== 'apply_failed' && status !== 'rollback_failed') return undefined
  if (typeof record.from !== 'string' || typeof record.to !== 'string') return undefined
  return {
    status,
    from: record.from,
    to: record.to,
    ...(typeof record.reason === 'string' && record.reason ? { reason: record.reason } : {}),
    ...(typeof record.backupDir === 'string' && record.backupDir ? { backupDir: record.backupDir } : {})
  }
}

/** 可回滚到的备份（mac）：更新前留下的旧 app + 库副本。 */
export interface AppUpdateBackupInfo {
  version: string
  createdAt: number
  dir: string
}

/** 面板 / 角标 / 提醒共用的「有可用新版」判定：跳过的版本与稍后期内不提醒。 */
export function shouldRemindAppUpdate(state: AppUpdateState, settings: AppUpdateSettings, now: number): boolean {
  const release = releaseOf(state)
  if (!release || state.phase === 'installing' || state.phase === 'checking' || state.phase === 'rolling_back') return false
  if (settings.skippedVersion && !isNewerAppVersion(release.version, settings.skippedVersion)) return false
  if (settings.snoozedUntil !== undefined && now < settings.snoozedUntil) return false
  return true
}

/** 是否该把「有新版」的提醒推给用户（相对 shouldRemind 只多一条：只有 available 相位才主动提醒）。 */
export function appUpdateReminderVersion(state: AppUpdateState, settings: AppUpdateSettings, now: number): string | undefined {
  if (state.phase !== 'available' && state.phase !== 'downloaded') return undefined
  return shouldRemindAppUpdate(state, settings, now) ? state.release.version : undefined
}

/** 渲染层看到的自更新全貌（主进程每次状态变化推送一份，拉取亦同）。 */
export interface AppUpdateStatus {
  currentVersion: string
  state: AppUpdateState
  settings: AppUpdateSettings
  /** 该提醒用户的新版本号（角标 / 小提醒框）；跳过、稍后与非 available 相位下缺省。 */
  reminderVersion?: string
  /** 本次进程由安装器在更新完成后拉起（命令行带 `--updated`）：首页可以提示一次「已更新」。 */
  launchedAfterUpdate: boolean
  /** mac：上一次退出时辅助脚本留下的结果（已更新 / 已回滚 / 失败已恢复），用户看过后清掉。 */
  applyResult?: AppUpdateApplyResult
  /** mac：存在可回滚的备份时给出（面板出「回滚到 x」）。 */
  rollback?: AppUpdateBackupInfo
  /** 当前版本或新版本的发布页。 */
  releaseUrl: string
}

export interface UpdateGateInput {
  onlineSeats: number
  sessionLaunchRunning: boolean
}

export type UpdateGate =
  | { verdict: 'allow' }
  /** 席位在线：安装会让 Cursor 里的 SG Team 服务器重启一次；用户确认后继续。 */
  | { verdict: 'confirm'; reasons: string[] }
  /** 一键建会话在途：不可继续。 */
  | { verdict: 'block'; reasons: string[] }

/**
 * 安装门禁。安装器会结束安装目录下的所有进程——包括 Cursor 托管的 SG Team MCP 服务器，
 * 各在线席位的长轮询会瞬断一次并按协议自动续接；一键建会话正在进行时则不允许安装。
 */
export function evaluateUpdateGate(input: UpdateGateInput): UpdateGate {
  if (input.sessionLaunchRunning) {
    return { verdict: 'block', reasons: ['一键会话创建正在进行，等它完成后再安装。'] }
  }
  if (input.onlineSeats > 0) {
    return {
      verdict: 'confirm',
      reasons: [
        // 措辞不落「安装」二字：同一道门禁也拦回滚（两者都是退出并替换）。
        `有 ${input.onlineSeats} 个席位在线。继续会退出拾光并让 Cursor 里的 SG Team 服务器重启一次，各会话经历约 5 秒瞬断后自动续接；进行中的运行与任务不会丢数据。`
      ]
    }
  }
  return { verdict: 'allow' }
}

/** 下次自动检查的等待时长：从未检查过 → 首检延迟；否则按间隔补齐，最少也隔一段首检延迟。 */
export function nextAppUpdateCheckDelayMs(
  settings: AppUpdateSettings,
  lastCheckedAt: number | undefined,
  now: number
): number {
  if (lastCheckedAt === undefined) return APP_UPDATE_FIRST_CHECK_DELAY_MS
  const due = lastCheckedAt + settings.checkIntervalHours * 60 * 60_000
  return Math.max(APP_UPDATE_FIRST_CHECK_DELAY_MS, due - now)
}

export function appUpdateReleaseUrl(version?: string): string {
  const base = `https://github.com/${APP_UPDATE_REPOSITORY.owner}/${APP_UPDATE_REPOSITORY.repo}/releases`
  if (!version) return `${base}/latest`
  return `${base}/tag/v${version.replace(/^v/, '')}`
}

/**
 * 「自定义更新源」的一键预设：直连 GitHub 不稳时，用 gh-proxy 前缀把最新 Release 的资产目录整个接走——
 * 目录下 `latest.yml`（Windows）、`update-manifest.json`（mac）与安装包都经镜像取，检查与下载一起走。
 * 填进去的仍是普通目录 URL：用户能看到、能改、能恢复默认；镜像换站只需改这一处。
 */
export const APP_UPDATE_MIRROR_FEED = {
  label: 'gh-proxy 镜像',
  url: `https://gh-proxy.com/${appUpdateReleaseUrl()}/download/`
} as const

/** 渲染层展示用：把 GitHub Release 正文（HTML / Markdown）压成纯文本段落。 */
export function releaseNotesToPlainText(notes: string | undefined): string[] {
  if (!notes) return []
  const text = notes
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
