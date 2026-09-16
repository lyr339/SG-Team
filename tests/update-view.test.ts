import { describe, expect, it } from 'vitest'
import type { AppUpdateRelease, AppUpdateStatus } from '../src/domain/app-update'
import { buildUpdatePanelView, formatReleaseDate, formatUpdateTime } from '../src/renderer/src/settings/update-view'

const NOW = new Date(2026, 8, 17, 10, 30).getTime()
const release: AppUpdateRelease = {
  version: '0.3.3',
  releaseDate: '2026-09-17T02:00:00.000Z',
  releaseNotes: '## v0.3.3\n- 第一条\n- 第二条',
  sizeBytes: 116_467_543,
  releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.3'
}

function statusOf(state: AppUpdateStatus['state'], settings: Partial<AppUpdateStatus['settings']> = {}): AppUpdateStatus {
  return {
    currentVersion: '0.3.2',
    state,
    settings: { autoCheck: true, checkIntervalHours: 6, ...settings },
    launchedAfterUpdate: false,
    releaseUrl: release.releaseUrl
  }
}

const actionIds = (status: AppUpdateStatus) => buildUpdatePanelView(status, NOW).actions.map((action) => action.id)

describe('软件更新 · 面板视图', () => {
  it('时间：今天只给时刻，其他日子带月-日；发布日期取 ISO 的年月日', () => {
    expect(formatUpdateTime(NOW - 60_000, NOW)).toBe('今天 10:29')
    expect(formatUpdateTime(new Date(2026, 8, 12, 8, 5).getTime(), NOW)).toBe('09-12 08:05')
    expect(formatReleaseDate('2026-09-17T02:00:00.000Z')).toMatch(/^2026-09-1[67]$/)
    expect(formatReleaseDate('garbage')).toBeUndefined()
    expect(formatReleaseDate(undefined)).toBeUndefined()
  })

  it('idle：当前版本 + 上次检查 / 失败原因；按钮立即检查 + 发布页', () => {
    const plain = buildUpdatePanelView(statusOf({ phase: 'idle' }), NOW)
    expect(plain).toMatchObject({ tone: 'neutral', headline: '当前版本 0.3.2', detail: '尚未检查过更新', busy: false })
    expect(plain.actions.map((action) => action.id)).toEqual(['check', 'open-release'])
    const failed = buildUpdatePanelView(statusOf({ phase: 'idle', lastCheckedAt: NOW - 5 * 60_000, lastError: 'ENOTFOUND' }), NOW)
    expect(failed.tone).toBe('danger')
    expect(failed.detail).toBe('上次检查失败（今天 10:25）：ENOTFOUND')
  })

  it('unsupported / checking / up_to_date 的文案与忙态', () => {
    expect(buildUpdatePanelView(statusOf({ phase: 'unsupported', reason: '开发模式下不检查更新。' }), NOW))
      .toMatchObject({ tone: 'muted', headline: '当前版本 0.3.2', detail: '开发模式下不检查更新。', actions: [{ id: 'open-release', label: '打开发布页', kind: 'link' }] })
    const checking = buildUpdatePanelView(statusOf({ phase: 'checking', startedAt: NOW }), NOW)
    expect(checking).toMatchObject({ tone: 'info', headline: '正在检查更新…', busy: true })
    expect(checking.actions[0]).toMatchObject({ id: 'check', disabled: true })
    expect(buildUpdatePanelView(statusOf({ phase: 'up_to_date', checkedAt: NOW - 30_000 }), NOW))
      .toMatchObject({ tone: 'success', headline: '已是最新版本 0.3.2', detail: '上次检查 今天 10:29' })
  })

  it('available：发布日期与体积、说明段落、下载 / 跳过 / 稍后；跳过后变 muted 且只剩取消跳过', () => {
    const view = buildUpdatePanelView(statusOf({ phase: 'available', release, checkedAt: NOW }), NOW)
    expect(view.tone).toBe('accent')
    expect(view.headline).toBe('发现新版本 0.3.3')
    expect(view.detail).toMatch(/^2026-09-1[67] 发布 · 111\.1 MB$/)
    expect(view.notes).toEqual(['v0.3.3', '- 第一条', '- 第二条'])
    expect(view.actions.map((action) => action.id)).toEqual(['download', 'skip', 'snooze', 'open-release'])
    expect(view.skippedNote).toBeUndefined()

    const skipped = buildUpdatePanelView(statusOf({ phase: 'available', release, checkedAt: NOW }, { skippedVersion: '0.3.3' }), NOW)
    expect(skipped.tone).toBe('muted')
    expect(skipped.skippedNote).toBe('已跳过 0.3.3，出现更高版本时再提醒')
    expect(skipped.actions.map((action) => action.id)).toEqual(['download', 'unskip', 'open-release'])

    const snoozed = buildUpdatePanelView(statusOf({ phase: 'available', release, checkedAt: NOW }, { snoozedUntil: NOW + 3_600_000 }), NOW)
    expect(snoozed.snoozedNote).toBe('已选择稍后，今天 11:30 后恢复提醒')
    expect(snoozed.actions.find((action) => action.id === 'snooze')?.disabled).toBe(true)
  })

  it('downloading：进度百分比与读数、取消；downloaded：安装并重启；installing：无按钮', () => {
    const downloading = buildUpdatePanelView(statusOf({ phase: 'downloading', release, receivedBytes: 58_233_772, totalBytes: 116_467_543, bytesPerSecond: 3_145_728, startedAt: NOW }), NOW)
    expect(downloading.progress).toEqual({ percent: 50, received: '55.5 MB', total: '111.1 MB', rate: '3.0 MB/s' })
    expect(downloading.actions.map((action) => action.id)).toEqual(['cancel', 'open-release'])
    expect(downloading.busy).toBe(true)
    const unknownTotal = buildUpdatePanelView(statusOf({ phase: 'downloading', release, receivedBytes: 10, totalBytes: 0, startedAt: NOW }), NOW)
    expect(unknownTotal.progress).toMatchObject({ percent: 0, total: '—' })

    const downloaded = buildUpdatePanelView(statusOf({ phase: 'downloaded', release, downloadedAt: NOW }), NOW)
    expect(downloaded.headline).toBe('0.3.3 已就绪')
    expect(downloaded.actions.map((action) => action.id)).toEqual(['install', 'skip', 'snooze', 'open-release'])

    const installing = buildUpdatePanelView(statusOf({ phase: 'installing', release, startedAt: NOW }), NOW)
    expect(installing).toMatchObject({ tone: 'info', headline: '正在安装 0.3.3…', actions: [], busy: true })
  })

  it('failed：步骤名 + 原因；有发布时按钮是重试，否则知道了', () => {
    expect(actionIds(statusOf({ phase: 'failed', step: 'download', message: 'sha512 mismatch', at: NOW, release }))).toEqual(['dismiss', 'open-release'])
    const view = buildUpdatePanelView(statusOf({ phase: 'failed', step: 'download', message: 'sha512 mismatch', at: NOW, release }), NOW)
    expect(view).toMatchObject({ tone: 'danger', headline: '下载失败', detail: 'sha512 mismatch' })
    expect(view.actions[0]?.label).toBe('重试')
    const check = buildUpdatePanelView(statusOf({ phase: 'failed', step: 'check', message: 'x', at: NOW }), NOW)
    expect(check.headline).toBe('检查失败')
    expect(check.actions[0]?.label).toBe('知道了')
    expect(buildUpdatePanelView(statusOf({ phase: 'failed', step: 'install', message: 'EACCES', at: NOW, release }), NOW).headline).toBe('安装失败')
  })
})
