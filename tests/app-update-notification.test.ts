import { describe, expect, it } from 'vitest'
import { appUpdateNotification, appUpdateReceiptNotification } from '../src/domain/app-update-notification'
import type { AppUpdateState, AppUpdateStatus } from '../src/domain/app-update'

const release = { version: '0.6.0', releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.6.0' }
const status = (state: AppUpdateState, reminderVersion?: string): AppUpdateStatus => ({ state, currentVersion: '0.5.15', settings: { autoCheck: true, checkIntervalHours: 6 }, launchedAfterUpdate: false, releaseUrl: release.releaseUrl, reminderVersion })
describe('real update milestone mapping', () => {
  it('startup receipts neither replay a toast nor swallow a later new-version milestone', () => {
    const value = { ...status({ phase: 'available', release, checkedAt: 100 }, release.version), launchedAfterUpdate: true,
      applyResult: { status: 'applied' as const, from: '0.5.14', to: '0.5.15' } }
    expect(appUpdateReceiptNotification(value)).toMatchObject({ title: '拾光已更新到 0.5.15', timeBasis: 'observed', announce: false })
    expect(appUpdateNotification(value, true)).toMatchObject({ title: '拾光 0.6.0 可用', announce: true })
    expect(appUpdateReceiptNotification({ ...value, currentVersion: '0.5.16' })).toMatchObject({ attention: 'activity', title: '已读取历史更新结果' })
  })
  it('records available versions but honors snooze/skip authority and suppresses startup replay', () => {
    expect(appUpdateNotification(status({ phase: 'available', release, checkedAt: 100 }, '0.6.0'), true)?.announce).toBe(true)
    expect(appUpdateNotification(status({ phase: 'available', release, checkedAt: 100 }), true)?.announce).toBe(false)
    expect(appUpdateNotification(status({ phase: 'available', release, checkedAt: 100 }, '0.6.0'), false)?.announce).toBe(false)
  })
  it('keeps one version thread, renews meaningful completion and excludes percentages or automatic network check failures', () => {
    const available = appUpdateNotification(status({ phase: 'available', release, checkedAt: 100 }), false)!
    const done = appUpdateNotification(status({ phase: 'downloaded', release, downloadedAt: 200 }, release.version), true)!
    expect(done.key).toBe(available.key); expect(done.renewAttention).toBe(true)
    expect(appUpdateNotification(status({ phase: 'downloading', release, receivedBytes: 10, totalBytes: 100, startedAt: 150 }), true)).toBeUndefined()
    expect(appUpdateNotification(status({ phase: 'idle', lastError: 'temporary network failure', lastErrorKind: 'network' }), true)).toBeUndefined()
  })
})
