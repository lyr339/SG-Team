import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppUpdateService, type AppUpdateCheckOutcome, type AppUpdaterPort } from '../src/application/app-update-service'
import { AppUpdateSettingsStore } from '../src/application/app-update-settings-store'
import { APP_UPDATE_FIRST_CHECK_DELAY_MS, APP_UPDATE_SNOOZE_MS, type AppUpdateRelease, type AppUpdateStatus } from '../src/domain/app-update'

const release: AppUpdateRelease = {
  version: '0.3.3',
  sizeBytes: 100,
  releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.3'
}

/** 手动推进的假定时器：只在测试显式 fire 时触发，避免真实等待。 */
function fakeTimers() {
  const pending = new Map<number, { handler: () => void; ms: number }>()
  let seq = 0
  return {
    pending,
    timers: {
      setTimeout: (handler: () => void, ms: number) => {
        seq += 1
        pending.set(seq, { handler, ms })
        return seq
      },
      clearTimeout: (handle: unknown) => { pending.delete(handle as number) }
    },
    fire(): void {
      const [id, entry] = [...pending.entries()][0] ?? []
      if (id === undefined || !entry) throw new Error('no pending timer')
      pending.delete(id)
      entry.handler()
    },
    delays(): number[] {
      return [...pending.values()].map((entry) => entry.ms)
    }
  }
}

function fakePort(overrides: Partial<AppUpdaterPort> = {}) {
  const calls: string[] = []
  let checkOutcome: AppUpdateCheckOutcome | Error = { available: false }
  let downloadImpl: AppUpdaterPort['downloadUpdate'] = async ({ onProgress }) => {
    onProgress({ receivedBytes: 50, totalBytes: 100 })
    onProgress({ receivedBytes: 100, totalBytes: 100 })
    return { filePath: 'C:\\cache\\ShiGuang-Setup-0.3.3.exe' }
  }
  const port: AppUpdaterPort = {
    support: () => ({ ok: true }),
    setFeedUrl: (url) => { calls.push(`feed:${url ?? 'default'}`) },
    checkForUpdates: async () => {
      calls.push('check')
      if (checkOutcome instanceof Error) throw checkOutcome
      return checkOutcome
    },
    downloadUpdate: (input) => {
      calls.push('download')
      return downloadImpl(input)
    },
    quitAndInstall: () => { calls.push('install') },
    ...overrides
  }
  return {
    port,
    calls,
    setCheck(outcome: AppUpdateCheckOutcome | Error) { checkOutcome = outcome },
    setDownload(impl: AppUpdaterPort['downloadUpdate']) { downloadImpl = impl }
  }
}

function harness(input: { portOverrides?: Partial<AppUpdaterPort>; settingsFile?: unknown; launchedAfterUpdate?: boolean; gate?: { onlineSeats: number; sessionLaunchRunning: boolean } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sg-app-update-'))
  const store = new AppUpdateSettingsStore(join(dir, 'app-update.json'))
  if (input.settingsFile !== undefined) {
    store.save((input.settingsFile as { settings?: unknown }).settings, (input.settingsFile as { runtime?: { lastCheckedAt?: number } }).runtime)
  }
  const fake = fakePort(input.portOverrides)
  const clock = { now: 1_800_000_000_000 }
  const timers = fakeTimers()
  const statuses: AppUpdateStatus[] = []
  const logs: string[] = []
  const service = new AppUpdateService({
    currentVersion: '0.3.2',
    port: fake.port,
    settings: store,
    gateInput: () => input.gate ?? { onlineSeats: 0, sessionLaunchRunning: false },
    launchedAfterUpdate: input.launchedAfterUpdate,
    now: () => clock.now,
    timers: timers.timers,
    log: (message) => logs.push(message)
  })
  service.onChange((status) => statuses.push(status))
  return { service, store, fake, clock, timers, statuses, logs, dir }
}

describe('AppUpdateService · 启动与周期', () => {
  it('start：首检 45 秒后触发，随后按间隔排下一次；autoCheck 关时不排', async () => {
    const { service, fake, timers, clock } = harness()
    fake.setCheck({ available: false })
    expect(timers.delays()).toEqual([])
    service.start()
    expect(timers.delays()).toEqual([APP_UPDATE_FIRST_CHECK_DELAY_MS])
    timers.fire()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.calls).toEqual(['check'])
    expect(service.getStatus().state).toEqual({ phase: 'up_to_date', checkedAt: clock.now })
    expect(timers.delays()).toEqual([6 * 3_600_000])
    service.saveSettings({ autoCheck: false })
    expect(timers.delays()).toEqual([])
    service.stop()
  })

  it('持久化的 lastCheckedAt 决定首次排程：1 小时前检查过 → 5 小时后再查', () => {
    const now = 1_800_000_000_000
    const { service, timers, clock } = harness({ settingsFile: { settings: {}, runtime: { lastCheckedAt: now - 3_600_000 } } })
    clock.now = now
    service.start()
    expect(timers.delays()).toEqual([5 * 3_600_000])
    expect(service.getStatus().state).toEqual({ phase: 'idle', lastCheckedAt: now - 3_600_000 })
  })

  it('平台不支持：状态 unsupported，不排定时器，check 直接返回，端口不被调用', async () => {
    const { service, fake, timers } = harness({ portOverrides: { support: () => ({ ok: false, reason: '开发模式下不检查更新。' }) } })
    service.start()
    expect(timers.delays()).toEqual([])
    const status = await service.check({ manual: true })
    expect(status.state).toEqual({ phase: 'unsupported', reason: '开发模式下不检查更新。' })
    expect(fake.calls).toEqual([])
  })

  it('构造时把设置里的自定义源交给端口；改设置只在源变化时再交一次', () => {
    const { service, fake } = harness({ settingsFile: { settings: { feedUrl: 'https://mirror.example.com/sg/' } } })
    expect(fake.calls).toEqual(['feed:https://mirror.example.com/sg/'])
    service.saveSettings({ feedUrl: 'https://mirror.example.com/sg/', checkIntervalHours: 12 })
    expect(fake.calls).toEqual(['feed:https://mirror.example.com/sg/'])
    service.saveSettings({ checkIntervalHours: 12 })
    expect(fake.calls).toEqual(['feed:https://mirror.example.com/sg/', 'feed:default'])
  })
})

describe('AppUpdateService · 检查', () => {
  it('发现更高版本 → available 并给出 reminderVersion；同版或更低 → up_to_date；记录 lastCheckedAt 落盘', async () => {
    const { service, fake, store, clock } = harness()
    fake.setCheck({ available: true, release })
    const status = await service.check({ manual: true })
    expect(status.state).toEqual({ phase: 'available', release, checkedAt: clock.now })
    expect(status.reminderVersion).toBe('0.3.3')
    expect(status.releaseUrl).toBe(release.releaseUrl)
    expect(store.load().runtime.lastCheckedAt).toBe(clock.now)

    fake.setCheck({ available: true, release: { ...release, version: '0.3.2' } })
    expect((await service.check({ manual: true })).state.phase).toBe('up_to_date')
  })

  it('网络失败静默：idle 带 lastError，只写日志，reminderVersion 缺省', async () => {
    const { service, fake, logs } = harness()
    fake.setCheck(new Error('net::ERR_NAME_NOT_RESOLVED'))
    const status = await service.check({ manual: false })
    expect(status.state).toMatchObject({ phase: 'idle', lastError: 'net::ERR_NAME_NOT_RESOLVED' })
    expect(status.reminderVersion).toBeUndefined()
    expect(logs.some((line) => line.includes('ERR_NAME_NOT_RESOLVED'))).toBe(true)
  })

  it('网络失败：不记 lastCheckedAt、自动检查按 2→10→30 分钟退避重排；成功后归零回正常间隔', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    const { service, fake, store, timers, clock } = harness()
    service.start()
    fake.setCheck(new Error('net::ERR_CONNECTION_CLOSED'))
    timers.fire(); await tick()
    expect(service.getStatus().state).toMatchObject({ phase: 'idle', lastError: 'net::ERR_CONNECTION_CLOSED', lastErrorKind: 'network' })
    expect(store.load().runtime.lastCheckedAt).toBeUndefined()
    expect(timers.delays()).toEqual([120_000])
    timers.fire(); await tick()
    expect(timers.delays()).toEqual([600_000])
    timers.fire(); await tick()
    expect(timers.delays()).toEqual([1_800_000])
    timers.fire(); await tick()
    expect(timers.delays()).toEqual([1_800_000]) // 封顶
    fake.setCheck({ available: false })
    timers.fire(); await tick()
    expect(service.getStatus().state.phase).toBe('up_to_date')
    expect(store.load().runtime.lastCheckedAt).toBe(clock.now)
    expect(timers.delays()).toEqual([6 * 3_600_000])
    service.stop()
  })

  it('明确错误（HTTP 500）：记 lastCheckedAt、kind=other、按正常间隔排', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    const { service, fake, store, timers, clock } = harness()
    service.start()
    fake.setCheck(new Error('更新清单返回 HTTP 500'))
    timers.fire(); await tick()
    expect(service.getStatus().state).toMatchObject({ phase: 'idle', lastErrorKind: 'other' })
    expect(store.load().runtime.lastCheckedAt).toBe(clock.now)
    expect(timers.delays()).toEqual([6 * 3_600_000])
    service.stop()
  })

  it('检查进行中重入返回当前状态且不再调端口', async () => {
    const { service, fake } = harness()
    let release_: (value: AppUpdateCheckOutcome) => void = () => {}
    fake.port.checkForUpdates = () => {
      fake.calls.push('check')
      return new Promise((resolve) => { release_ = resolve })
    }
    const first = service.check({ manual: true })
    const second = await service.check({ manual: true })
    expect(second.state.phase).toBe('checking')
    expect(fake.calls).toEqual(['check'])
    release_({ available: false })
    expect((await first).state.phase).toBe('up_to_date')
  })
})

describe('AppUpdateService · 下载 / 安装 / 跳过 / 稍后', () => {
  async function availableService(gate?: { onlineSeats: number; sessionLaunchRunning: boolean }) {
    const h = harness({ gate })
    h.fake.setCheck({ available: true, release })
    await h.service.check({ manual: true })
    h.statuses.length = 0
    return h
  }

  it('下载：进度按 ≥1% 推送、完成进 downloaded；只在 available 相位接受', async () => {
    const h = await availableService()
    const status = await h.service.download()
    expect(status.state).toEqual({ phase: 'downloaded', release, downloadedAt: h.clock.now, filePath: 'C:\\cache\\ShiGuang-Setup-0.3.3.exe' })
    expect(h.statuses.map((entry) => entry.state.phase)).toEqual(['downloading', 'downloading', 'downloading', 'downloaded'])
    expect(h.statuses[1]?.state).toMatchObject({ receivedBytes: 50, totalBytes: 100 })
    // 已下载：再下载 / 再检查都不动
    expect((await h.service.download()).state.phase).toBe('downloaded')
    expect((await h.service.check({ manual: true })).state.phase).toBe('downloaded')
    expect(h.fake.calls.filter((call) => call === 'check')).toHaveLength(1)
  })

  it('下载失败进 failed(download) 并保留发布；dismiss 回 available 可重试', async () => {
    const h = await availableService()
    h.fake.setDownload(async () => { throw new Error('sha512 checksum mismatch') })
    const status = await h.service.download()
    expect(status.state).toEqual({ phase: 'failed', step: 'download', message: 'sha512 checksum mismatch', at: h.clock.now, release })
    expect(h.service.dismissFailure().state).toEqual({ phase: 'available', release, checkedAt: h.clock.now })
  })

  it('取消下载：signal 中止后端口 reject 或 resolve 都判为取消，回到 available', async () => {
    const h = await availableService()
    h.fake.setDownload(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }))
    const pending = h.service.download()
    expect(h.service.getStatus().state.phase).toBe('downloading')
    h.service.cancelDownload()
    expect((await pending).state).toEqual({ phase: 'available', release, checkedAt: h.clock.now })
  })

  it('安装门禁：建会话在途 block；席位在线需确认；确认后 installing 并调 quitAndInstall', async () => {
    const blocked = await availableService({ onlineSeats: 1, sessionLaunchRunning: true })
    await blocked.service.download()
    const blockedResult = blocked.service.install({ confirmed: true })
    expect(blockedResult.gate.verdict).toBe('block')
    expect(blockedResult.status.state.phase).toBe('downloaded')
    expect(blocked.fake.calls).not.toContain('install')

    const online = await availableService({ onlineSeats: 2, sessionLaunchRunning: false })
    await online.service.download()
    const needConfirm = online.service.install({ confirmed: false })
    expect(needConfirm.gate.verdict).toBe('confirm')
    expect(needConfirm.status.state.phase).toBe('downloaded')
    const confirmed = online.service.install({ confirmed: true })
    expect(confirmed.status.state).toEqual({ phase: 'installing', release, startedAt: online.clock.now })
    expect(online.fake.calls.at(-1)).toBe('install')
  })

  it('安装器启动失败进 failed(install)；未下载时 install 不动', async () => {
    const h = await availableService()
    expect(h.service.install({ confirmed: true }).status.state.phase).toBe('available')
    await h.service.download()
    h.fake.port.quitAndInstall = () => { throw new Error('spawn EACCES') }
    const result = h.service.install({ confirmed: true })
    expect(result.status.state).toEqual({ phase: 'failed', step: 'install', message: 'spawn EACCES', at: h.clock.now, release })
  })

  it('跳过：设置记版本、状态不变、提醒消失；取消跳过恢复；更高版本仍提醒', async () => {
    const h = await availableService()
    const skipped = h.service.skipCurrent()
    expect(skipped.settings.skippedVersion).toBe('0.3.3')
    expect(skipped.state.phase).toBe('available')
    expect(skipped.reminderVersion).toBeUndefined()
    expect(JSON.parse(readFileSync(h.store.path, 'utf8')).settings.skippedVersion).toBe('0.3.3')
    expect(h.service.unskip().reminderVersion).toBe('0.3.3')
    h.service.skipCurrent()
    h.fake.setCheck({ available: true, release: { ...release, version: '0.3.4' } })
    expect((await h.service.check({ manual: false })).reminderVersion).toBe('0.3.4')
  })

  it('稍后：24 小时内 reminderVersion 缺省，到期恢复；自动检查照常', async () => {
    const h = await availableService()
    const snoozed = h.service.snooze()
    expect(snoozed.settings.snoozedUntil).toBe(h.clock.now + APP_UPDATE_SNOOZE_MS)
    expect(snoozed.reminderVersion).toBeUndefined()
    h.clock.now += APP_UPDATE_SNOOZE_MS
    expect(h.service.getStatus().reminderVersion).toBe('0.3.3')
  })

  it('launchedAfterUpdate 透传给状态', () => {
    const { service } = harness({ launchedAfterUpdate: true })
    expect(service.getStatus().launchedAfterUpdate).toBe(true)
    expect(harness().service.getStatus().launchedAfterUpdate).toBe(false)
  })

  it('监听器抛错不影响其他监听器与状态推进', async () => {
    const h = harness()
    h.fake.setCheck({ available: true, release })
    h.service.onChange(() => { throw new Error('boom') })
    const seen: string[] = []
    h.service.onChange((status) => seen.push(status.state.phase))
    await h.service.check({ manual: true })
    expect(seen).toEqual(['checking', 'available'])
    expect(h.logs.some((line) => line.includes('boom'))).toBe(true)
  })
})

describe('AppUpdateService · mac 回执与回滚', () => {
  const backup = { version: '0.3.1', createdAt: 1_700_000_000_000, dir: 'D:\\data\\updates\\backup\\0.3.1-1' }

  it('构造时取走上次的 applyResult 并入状态；dismiss 清掉并推送一次', () => {
    const h = harness({ portOverrides: { takePendingApplyResult: () => ({ status: 'applied', from: '0.3.1', to: '0.3.2' }) } })
    expect(h.service.getStatus().applyResult).toEqual({ status: 'applied', from: '0.3.1', to: '0.3.2' })
    const cleared = h.service.dismissApplyResult()
    expect(cleared.applyResult).toBeUndefined()
    expect(h.statuses).toHaveLength(1)
    h.service.dismissApplyResult()
    expect(h.statuses).toHaveLength(1) // 没有回执时不再推送
  })

  it('takePendingApplyResult 抛错只记日志，服务照常可用', () => {
    const h = harness({ portOverrides: { takePendingApplyResult: () => { throw new Error('EACCES') } } })
    expect(h.service.getStatus().applyResult).toBeUndefined()
    expect(h.logs.some((line) => line.includes('EACCES'))).toBe(true)
  })

  it('status.rollback 来自端口 backupInfo；读取抛错时缺省；unsupported 不问端口', () => {
    const h = harness({ portOverrides: { backupInfo: () => backup } })
    expect(h.service.getStatus().rollback).toEqual(backup)

    const broken = harness({ portOverrides: { backupInfo: () => { throw new Error('EIO') } } })
    expect(broken.service.getStatus().rollback).toBeUndefined()
    expect(broken.logs.some((line) => line.includes('EIO'))).toBe(true)

    let asked = 0
    const unsupported = harness({ portOverrides: {
      support: () => ({ ok: false, reason: '开发模式下不检查更新。' }),
      backupInfo: () => { asked += 1; return backup }
    } })
    expect(unsupported.service.getStatus().rollback).toBeUndefined()
    expect(asked).toBe(0)
  })

  it('rollback：无备份原样返回；block 拦下；未确认只给门禁结论；确认后 rolling_back 并调端口', () => {
    const bare = harness()
    expect(bare.service.rollback({ confirmed: true })).toMatchObject({ gate: { verdict: 'allow' }, status: { state: { phase: 'idle' } } })

    const rollbackCalls: string[] = []
    const portOverrides = {
      backupInfo: () => backup,
      rollback: () => { rollbackCalls.push('rollback') }
    }
    const blocked = harness({ portOverrides, gate: { onlineSeats: 1, sessionLaunchRunning: true } })
    expect(blocked.service.rollback({ confirmed: true }).gate.verdict).toBe('block')
    expect(rollbackCalls).toEqual([])

    const confirmFirst = harness({ portOverrides, gate: { onlineSeats: 2, sessionLaunchRunning: false } })
    const asked = confirmFirst.service.rollback({ confirmed: false })
    expect(asked.gate.verdict).toBe('confirm')
    expect(asked.status.state.phase).toBe('idle')
    expect(rollbackCalls).toEqual([])
    const done = confirmFirst.service.rollback({ confirmed: true })
    expect(done.status.state).toEqual({ phase: 'rolling_back', targetVersion: '0.3.1', startedAt: confirmFirst.clock.now })
    expect(rollbackCalls).toEqual(['rollback'])

    // 门禁 allow 也必须显式确认（回滚会覆盖数据库）
    const idle = harness({ portOverrides })
    expect(idle.service.rollback({ confirmed: false }).status.state.phase).toBe('idle')
    expect(rollbackCalls).toEqual(['rollback'])
  })

  it('rollback：下载进行中 reducer 拒绝换相 → 不调端口；端口抛错 → failed(rollback)', async () => {
    const rollbackCalls: string[] = []
    const h = harness({ portOverrides: { backupInfo: () => backup, rollback: () => { rollbackCalls.push('rollback') } } })
    h.fake.setCheck({ available: true, release })
    await h.service.check({ manual: true })
    h.fake.setDownload(() => new Promise(() => {}))
    void h.service.download()
    expect(h.service.getStatus().state.phase).toBe('downloading')
    expect(h.service.rollback({ confirmed: true }).status.state.phase).toBe('downloading')
    expect(rollbackCalls).toEqual([])
    h.service.stop()

    const failing = harness({ portOverrides: { backupInfo: () => backup, rollback: () => { throw new Error('EPERM') } } })
    const result = failing.service.rollback({ confirmed: true })
    expect(result.status.state).toEqual({ phase: 'failed', step: 'rollback', message: 'EPERM', at: failing.clock.now })
  })

  it('下载进度的 activity 透传：切到 verify 立即推送、状态携带 activity 且速率摘除', async () => {
    const h = harness()
    h.fake.setCheck({ available: true, release })
    await h.service.check({ manual: true })
    h.fake.setDownload(async ({ onProgress }) => {
      onProgress({ receivedBytes: 50, totalBytes: 100, bytesPerSecond: 1_000, activity: 'transfer' })
      onProgress({ receivedBytes: 100, totalBytes: 100, activity: 'verify' })
      return { filePath: '/staging/拾光.app' }
    })
    h.statuses.length = 0
    await h.service.download()
    const verifying = h.statuses.find((status) => status.state.phase === 'downloading' && status.state.activity === 'verify')
    expect(verifying?.state).toMatchObject({ receivedBytes: 100, activity: 'verify' })
    expect(verifying?.state).not.toHaveProperty('bytesPerSecond')
    expect(h.statuses.at(-1)?.state).toMatchObject({ phase: 'downloaded', filePath: '/staging/拾光.app' })
  })
})

describe('AppUpdateSettingsStore', () => {
  it('缺文件 / 坏文件 / 版本不符回默认；保存归一化并保留 runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-app-update-store-'))
    const store = new AppUpdateSettingsStore(join(dir, 'app-update.json'))
    expect(store.load()).toEqual({ settings: { autoCheck: true, checkIntervalHours: 6 }, runtime: {} })
    store.save({ autoCheck: false, checkIntervalHours: 99, skippedVersion: '0.3.3' }, { lastCheckedAt: 123 })
    expect(store.load()).toEqual({ settings: { autoCheck: false, checkIntervalHours: 6, skippedVersion: '0.3.3' }, runtime: { lastCheckedAt: 123 } })
    // 不传 runtime 时沿用文件里的
    store.save({ autoCheck: true })
    expect(store.load().runtime).toEqual({ lastCheckedAt: 123 })
    const parsed = JSON.parse(readFileSync(store.path, 'utf8'))
    expect(parsed.version).toBe(1)
  })
})
