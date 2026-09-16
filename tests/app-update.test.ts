import { describe, expect, it } from 'vitest'
import {
  APP_UPDATE_FIRST_CHECK_DELAY_MS,
  appUpdateReleaseUrl,
  appUpdateReminderVersion,
  compareAppVersions,
  evaluateUpdateGate,
  isNewerAppVersion,
  nextAppUpdateCheckDelayMs,
  normalizeAppUpdateSettings,
  parseAppUpdateApplyResult,
  parseAppVersion,
  reduceAppUpdate,
  releaseNotesToPlainText,
  shouldRemindAppUpdate,
  type AppUpdateRelease,
  type AppUpdateState
} from '../src/domain/app-update'

const release: AppUpdateRelease = {
  version: '0.3.3',
  releaseDate: '2026-09-17T02:00:00.000Z',
  sizeBytes: 116_467_543,
  releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.3'
}
const NOW = 1_800_000_000_000

describe('app-update · 版本', () => {
  it('解析 v 前缀、预发布标识；非法串返回 undefined', () => {
    expect(parseAppVersion('v0.2.1')).toEqual({ major: 0, minor: 2, patch: 1 })
    expect(parseAppVersion(' 0.3.0-beta.1 ')).toEqual({ major: 0, minor: 3, patch: 0, prerelease: 'beta.1' })
    for (const bad of ['', '1.2', '1.2.3.4', 'abc', '1.2.x', 'v']) expect(parseAppVersion(bad)).toBeUndefined()
  })

  it('比较：主次补丁逐级；预发布低于同号正式版；预发布按段比较（数字段按数值）', () => {
    const v = (text: string) => parseAppVersion(text)!
    expect(compareAppVersions(v('0.3.2'), v('0.3.3'))).toBe(-1)
    expect(compareAppVersions(v('1.0.0'), v('0.9.9'))).toBe(1)
    expect(compareAppVersions(v('0.3.3'), v('0.3.3'))).toBe(0)
    expect(compareAppVersions(v('0.3.3-beta.1'), v('0.3.3'))).toBe(-1)
    expect(compareAppVersions(v('0.3.3'), v('0.3.3-rc.1'))).toBe(1)
    expect(compareAppVersions(v('0.3.3-beta.2'), v('0.3.3-beta.10'))).toBe(-1)
    expect(compareAppVersions(v('0.3.3-alpha'), v('0.3.3-beta'))).toBe(-1)
    expect(compareAppVersions(v('0.3.3-beta'), v('0.3.3-beta.1'))).toBe(-1)
  })

  it('isNewerAppVersion：严格更高才算；任一无法解析视为不更新', () => {
    expect(isNewerAppVersion('0.3.3', '0.3.2')).toBe(true)
    expect(isNewerAppVersion('v0.3.3', '0.3.3')).toBe(false)
    expect(isNewerAppVersion('0.3.1', '0.3.2')).toBe(false)
    expect(isNewerAppVersion('garbage', '0.3.2')).toBe(false)
    expect(isNewerAppVersion('0.3.3', 'garbage')).toBe(false)
  })
})

describe('app-update · 设置归一化', () => {
  it('缺省：自动检查开、6 小时；非法档位与非法值回落，稀疏字段只在合法时保留', () => {
    expect(normalizeAppUpdateSettings(undefined)).toEqual({ autoCheck: true, checkIntervalHours: 6 })
    expect(normalizeAppUpdateSettings({ autoCheck: false, checkIntervalHours: 24 })).toEqual({ autoCheck: false, checkIntervalHours: 24 })
    expect(normalizeAppUpdateSettings({ checkIntervalHours: 7, skippedVersion: 'nope', snoozedUntil: -1, feedUrl: 'ftp://x' }))
      .toEqual({ autoCheck: true, checkIntervalHours: 6 })
    expect(normalizeAppUpdateSettings({
      skippedVersion: ' 0.3.3 ', snoozedUntil: NOW, feedUrl: ' https://mirror.example.com/sg-team/ '
    })).toEqual({
      autoCheck: true, checkIntervalHours: 6, skippedVersion: '0.3.3', snoozedUntil: NOW, feedUrl: 'https://mirror.example.com/sg-team/'
    })
    expect(normalizeAppUpdateSettings({ feedUrl: 'http://127.0.0.1:8765/updates/' }).feedUrl).toBe('http://127.0.0.1:8765/updates/')
  })
})

describe('app-update · 状态机', () => {
  const idle: AppUpdateState = { phase: 'idle' }

  it('检查：idle → checking → up_to_date / available / idle(lastError)', () => {
    const checking = reduceAppUpdate(idle, { type: 'check_started' }, NOW)
    expect(checking).toEqual({ phase: 'checking', startedAt: NOW })
    expect(reduceAppUpdate(checking, { type: 'check_up_to_date' }, NOW + 1)).toEqual({ phase: 'up_to_date', checkedAt: NOW + 1 })
    expect(reduceAppUpdate(checking, { type: 'check_available', release }, NOW + 1)).toEqual({ phase: 'available', release, checkedAt: NOW + 1 })
    expect(reduceAppUpdate(checking, { type: 'check_failed', message: 'ENOTFOUND' }, NOW + 1))
      .toEqual({ phase: 'idle', lastCheckedAt: NOW + 1, lastError: 'ENOTFOUND' })
  })

  it('再次检查保留已知发布；下载中 / 已下载 / 安装中 / 检查中拒绝重入', () => {
    const available: AppUpdateState = { phase: 'available', release, checkedAt: NOW }
    expect(reduceAppUpdate(available, { type: 'check_started' }, NOW)).toEqual({ phase: 'checking', startedAt: NOW, release })
    for (const state of [
      { phase: 'checking', startedAt: NOW },
      { phase: 'downloading', release, receivedBytes: 1, totalBytes: 2, startedAt: NOW },
      { phase: 'downloaded', release, downloadedAt: NOW },
      { phase: 'installing', release, startedAt: NOW }
    ] as AppUpdateState[]) {
      expect(reduceAppUpdate(state, { type: 'check_started' }, NOW)).toBe(state)
    }
  })

  it('下载：available → downloading（进度夹到非负）→ downloaded；取消回 available；失败进 failed(download) 并保留发布', () => {
    const available: AppUpdateState = { phase: 'available', release, checkedAt: NOW }
    const downloading = reduceAppUpdate(available, { type: 'download_started' }, NOW)
    expect(downloading).toEqual({ phase: 'downloading', release, receivedBytes: 0, totalBytes: release.sizeBytes, startedAt: NOW })
    const progressed = reduceAppUpdate(downloading, { type: 'download_progress', receivedBytes: 50, totalBytes: 100, bytesPerSecond: 7 }, NOW)
    expect(progressed).toMatchObject({ phase: 'downloading', receivedBytes: 50, totalBytes: 100, bytesPerSecond: 7 })
    expect(reduceAppUpdate(downloading, { type: 'download_progress', receivedBytes: -5, totalBytes: -1 }, NOW))
      .toMatchObject({ receivedBytes: 0, totalBytes: 0 })
    expect(reduceAppUpdate(progressed, { type: 'download_completed', filePath: 'C:\\x\\ShiGuang-Setup-0.3.3.exe' }, NOW + 5))
      .toEqual({ phase: 'downloaded', release, downloadedAt: NOW + 5, filePath: 'C:\\x\\ShiGuang-Setup-0.3.3.exe' })
    expect(reduceAppUpdate(progressed, { type: 'download_cancelled' }, NOW + 5)).toEqual({ phase: 'available', release, checkedAt: NOW + 5 })
    expect(reduceAppUpdate(progressed, { type: 'download_failed', message: 'sha512 mismatch' }, NOW + 5))
      .toEqual({ phase: 'failed', step: 'download', message: 'sha512 mismatch', at: NOW + 5, release })
    // 迟到的进度 / 完成事件在非下载相位被静默吸收
    expect(reduceAppUpdate(available, { type: 'download_progress', receivedBytes: 1, totalBytes: 1 }, NOW)).toBe(available)
    expect(reduceAppUpdate(idle, { type: 'download_completed' }, NOW)).toBe(idle)
  })

  it('安装：downloaded → installing；启动安装器失败进 failed(install)；dismissed 回 available（有发布）或 idle', () => {
    const downloaded: AppUpdateState = { phase: 'downloaded', release, downloadedAt: NOW }
    const installing = reduceAppUpdate(downloaded, { type: 'install_started' }, NOW)
    expect(installing).toEqual({ phase: 'installing', release, startedAt: NOW })
    const failed = reduceAppUpdate(installing, { type: 'install_failed', message: 'spawn EACCES' }, NOW + 1)
    expect(failed).toEqual({ phase: 'failed', step: 'install', message: 'spawn EACCES', at: NOW + 1, release })
    expect(reduceAppUpdate(failed, { type: 'dismissed' }, NOW + 2)).toEqual({ phase: 'available', release, checkedAt: NOW + 2 })
    expect(reduceAppUpdate({ phase: 'failed', step: 'check', message: 'x', at: NOW }, { type: 'dismissed' }, NOW + 2))
      .toEqual({ phase: 'idle', lastCheckedAt: NOW + 2 })
    expect(reduceAppUpdate(idle, { type: 'install_started' }, NOW)).toBe(idle)
  })

  it('unsupported 对任何事件都不动', () => {
    const unsupported: AppUpdateState = { phase: 'unsupported', reason: 'dev' }
    expect(reduceAppUpdate(unsupported, { type: 'check_started' }, NOW)).toBe(unsupported)
    expect(reduceAppUpdate(unsupported, { type: 'check_available', release }, NOW)).toBe(unsupported)
  })

  it('mac：不可下载的发布不进入 downloading；进度事件的 activity=verify 摘掉速率；rolling_back 只从空闲相位出发，失败进 failed(rollback)', () => {
    const notDownloadable: AppUpdateState = { phase: 'available', release: { ...release, downloadable: false }, checkedAt: NOW }
    expect(reduceAppUpdate(notDownloadable, { type: 'download_started' }, NOW)).toBe(notDownloadable)

    const downloading: AppUpdateState = { phase: 'downloading', release, receivedBytes: 50, totalBytes: 100, bytesPerSecond: 7, startedAt: NOW }
    // 传输事件不带速率 → 沿用上一次
    expect(reduceAppUpdate(downloading, { type: 'download_progress', receivedBytes: 60, totalBytes: 100 }, NOW)).toMatchObject({ receivedBytes: 60, bytesPerSecond: 7 })
    const verifying = reduceAppUpdate(downloading, { type: 'download_progress', receivedBytes: 100, totalBytes: 100, activity: 'verify' }, NOW)
    expect(verifying).toEqual({ phase: 'downloading', release, receivedBytes: 100, totalBytes: 100, activity: 'verify', startedAt: NOW })

    const idle: AppUpdateState = { phase: 'idle' }
    const rolling = reduceAppUpdate(idle, { type: 'rollback_started', targetVersion: '0.3.2' }, NOW)
    expect(rolling).toEqual({ phase: 'rolling_back', targetVersion: '0.3.2', startedAt: NOW })
    expect(reduceAppUpdate(rolling, { type: 'check_started' }, NOW)).toBe(rolling)
    expect(reduceAppUpdate(rolling, { type: 'rollback_failed', message: 'no backup' }, NOW + 1))
      .toEqual({ phase: 'failed', step: 'rollback', message: 'no backup', at: NOW + 1 })
    expect(reduceAppUpdate(downloading, { type: 'rollback_started', targetVersion: '0.3.2' }, NOW)).toBe(downloading)
    const installing: AppUpdateState = { phase: 'installing', release, startedAt: NOW }
    expect(reduceAppUpdate(installing, { type: 'rollback_started', targetVersion: '0.3.2' }, NOW)).toBe(installing)
    expect(shouldRemindAppUpdate(rolling, normalizeAppUpdateSettings({}), NOW)).toBe(false)
  })

  it('脚本结果解析：四种状态合法，缺字段 / 未知状态返回 undefined', () => {
    expect(parseAppUpdateApplyResult({ status: 'applied', from: '0.3.3', to: '0.3.4', backupDir: '/b' }))
      .toEqual({ status: 'applied', from: '0.3.3', to: '0.3.4', backupDir: '/b' })
    expect(parseAppUpdateApplyResult({ status: 'apply_failed', from: '0.3.3', to: '0.3.4', reason: 'codesign_failed' }))
      .toEqual({ status: 'apply_failed', from: '0.3.3', to: '0.3.4', reason: 'codesign_failed' })
    expect(parseAppUpdateApplyResult({ status: 'rolled_back', from: '0.3.4', to: '0.3.3' })).toMatchObject({ status: 'rolled_back' })
    expect(parseAppUpdateApplyResult({ status: 'rollback_failed', from: '0.3.4', to: '0.3.3', reason: 'x' })).toMatchObject({ status: 'rollback_failed' })
    expect(parseAppUpdateApplyResult({ status: 'exploded', from: 'a', to: 'b' })).toBeUndefined()
    expect(parseAppUpdateApplyResult({ status: 'applied', from: 'a' })).toBeUndefined()
    expect(parseAppUpdateApplyResult(null)).toBeUndefined()
  })
})

describe('app-update · 提醒判定与门禁', () => {
  const settings = normalizeAppUpdateSettings({})
  const available: AppUpdateState = { phase: 'available', release, checkedAt: NOW }

  it('available / downloaded 才提醒；跳过同版或更低版不提醒，更高版仍提醒；稍后期内不提醒，到期恢复', () => {
    expect(appUpdateReminderVersion(available, settings, NOW)).toBe('0.3.3')
    expect(appUpdateReminderVersion({ phase: 'downloaded', release, downloadedAt: NOW }, settings, NOW)).toBe('0.3.3')
    expect(appUpdateReminderVersion({ phase: 'downloading', release, receivedBytes: 0, totalBytes: 1, startedAt: NOW }, settings, NOW)).toBeUndefined()
    expect(appUpdateReminderVersion({ phase: 'up_to_date', checkedAt: NOW }, settings, NOW)).toBeUndefined()
    expect(appUpdateReminderVersion(available, { ...settings, skippedVersion: '0.3.3' }, NOW)).toBeUndefined()
    expect(appUpdateReminderVersion(available, { ...settings, skippedVersion: '0.3.4' }, NOW)).toBeUndefined()
    expect(appUpdateReminderVersion(available, { ...settings, skippedVersion: '0.3.2' }, NOW)).toBe('0.3.3')
    expect(appUpdateReminderVersion(available, { ...settings, snoozedUntil: NOW + 1 }, NOW)).toBeUndefined()
    expect(appUpdateReminderVersion(available, { ...settings, snoozedUntil: NOW }, NOW)).toBe('0.3.3')
    // shouldRemind 对 downloading 也成立（面板用），只有 checking / installing 例外
    expect(shouldRemindAppUpdate({ phase: 'downloading', release, receivedBytes: 0, totalBytes: 1, startedAt: NOW }, settings, NOW)).toBe(true)
    expect(shouldRemindAppUpdate({ phase: 'installing', release, startedAt: NOW }, settings, NOW)).toBe(false)
  })

  it('门禁：建会话在途 → block；席位在线 → confirm 且文案含数量；否则 allow', () => {
    expect(evaluateUpdateGate({ onlineSeats: 3, sessionLaunchRunning: true })).toMatchObject({ verdict: 'block' })
    const confirm = evaluateUpdateGate({ onlineSeats: 2, sessionLaunchRunning: false })
    expect(confirm.verdict).toBe('confirm')
    expect(confirm.verdict === 'confirm' && confirm.reasons[0]).toContain('2 个席位在线')
    expect(evaluateUpdateGate({ onlineSeats: 0, sessionLaunchRunning: false })).toEqual({ verdict: 'allow' })
  })

  it('自动检查节拍：从未检查 → 首检延迟；到期 → 至少首检延迟；未到期 → 剩余时间', () => {
    expect(nextAppUpdateCheckDelayMs(settings, undefined, NOW)).toBe(APP_UPDATE_FIRST_CHECK_DELAY_MS)
    expect(nextAppUpdateCheckDelayMs(settings, NOW - 7 * 3_600_000, NOW)).toBe(APP_UPDATE_FIRST_CHECK_DELAY_MS)
    expect(nextAppUpdateCheckDelayMs(settings, NOW - 3_600_000, NOW)).toBe(5 * 3_600_000)
    expect(nextAppUpdateCheckDelayMs({ ...settings, checkIntervalHours: 24 }, NOW, NOW)).toBe(24 * 3_600_000)
  })

  it('发布页 URL 与发布说明纯文本化', () => {
    expect(appUpdateReleaseUrl()).toBe('https://github.com/lyr339/SG-Team/releases/latest')
    expect(appUpdateReleaseUrl('v0.3.3')).toBe('https://github.com/lyr339/SG-Team/releases/tag/v0.3.3')
    expect(appUpdateReleaseUrl('0.3.3')).toBe('https://github.com/lyr339/SG-Team/releases/tag/v0.3.3')
    expect(releaseNotesToPlainText(undefined)).toEqual([])
    expect(releaseNotesToPlainText('<h2>v0.3.3 更新</h2>\n<ul><li><strong>热切</strong>修复 &amp; 提速</li><li>第二条</li></ul><p>尾注</p>'))
      .toEqual(['v0.3.3 更新', '- 热切修复 & 提速', '- 第二条', '尾注'])
    expect(releaseNotesToPlainText('## 标题\n- **加粗** 与 `代码`\n\n\n正文'))
      .toEqual(['标题', '- 加粗 与 代码', '正文'])
  })
})
