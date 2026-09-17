// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateRelease, AppUpdateStatus } from '../src/domain/app-update'
import { SettingsUpdate } from '../src/renderer/src/settings/SettingsUpdate'
import { UpdateReminder } from '../src/renderer/src/UpdateReminder'

const NOW = new Date(2026, 8, 17, 10, 30).getTime()
const release: AppUpdateRelease = {
  version: '0.3.3',
  releaseDate: '2026-09-17T02:00:00.000Z',
  releaseNotes: '<h2>v0.3.3</h2><ul><li>第一条</li></ul>',
  sizeBytes: 116_467_543,
  releaseUrl: 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.3'
}

function statusOf(state: AppUpdateStatus['state'], extra: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  const settings = extra.settings ?? { autoCheck: true, checkIntervalHours: 6 }
  const reminder = (state.phase === 'available' || state.phase === 'downloaded') && !settings.skippedVersion ? state.release.version : undefined
  return {
    currentVersion: '0.3.2',
    state,
    settings,
    ...(reminder ? { reminderVersion: reminder } : {}),
    launchedAfterUpdate: false,
    releaseUrl: release.releaseUrl,
    ...extra
  }
}

type Api = Window['sgDesktop']

function installApi(initial: AppUpdateStatus) {
  let current = initial
  const listeners = new Set<(status: AppUpdateStatus) => void>()
  const push = (next: AppUpdateStatus): AppUpdateStatus => {
    current = next
    for (const listener of listeners) listener(next)
    return next
  }
  const api = {
    getAppUpdateStatus: vi.fn(async () => current),
    checkAppUpdate: vi.fn(async () => push(statusOf({ phase: 'up_to_date', checkedAt: NOW }))),
    downloadAppUpdate: vi.fn(async () => push(statusOf({ phase: 'downloaded', release, downloadedAt: NOW }))),
    cancelAppUpdateDownload: vi.fn(async () => current),
    installAppUpdate: vi.fn(async ({ confirmed }: { confirmed: boolean }) => confirmed
      ? { gate: { verdict: 'allow' as const }, status: push(statusOf({ phase: 'installing', release, startedAt: NOW })) }
      : { gate: { verdict: 'confirm' as const, reasons: ['有 2 个席位在线。安装会退出拾光…'] }, status: current }),
    rollbackAppUpdate: vi.fn(async ({ confirmed }: { confirmed: boolean }) => confirmed
      ? { gate: { verdict: 'allow' as const }, status: push(statusOf({ phase: 'rolling_back', targetVersion: '0.3.2', startedAt: NOW })) }
      : { gate: { verdict: 'allow' as const }, status: current }),
    dismissAppUpdateApplyResult: vi.fn(async () => push({ ...current, applyResult: undefined })),
    skipAppUpdate: vi.fn(async () => push({ ...current, settings: { ...current.settings, skippedVersion: '0.3.3' }, reminderVersion: undefined })),
    unskipAppUpdate: vi.fn(async () => push({ ...current, settings: { autoCheck: true, checkIntervalHours: 6 }, reminderVersion: '0.3.3' })),
    snoozeAppUpdate: vi.fn(async () => push({ ...current, settings: { ...current.settings, snoozedUntil: NOW + 86_400_000 }, reminderVersion: undefined })),
    dismissAppUpdateFailure: vi.fn(async () => push(statusOf({ phase: 'available', release, checkedAt: NOW }))),
    saveAppUpdateSettings: vi.fn(async (settings: AppUpdateStatus['settings']) => push({ ...current, settings })),
    openAppUpdateReleasePage: vi.fn(async () => true),
    onAppUpdateStatus: vi.fn((listener: (status: AppUpdateStatus) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    })
  }
  ;(window as unknown as { sgDesktop: Api }).sgDesktop = api as unknown as Api
  return { api, push }
}

describe('设置 › 软件更新', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (window as unknown as { sgDesktop?: Api }).sgDesktop
  })

  const render = async (): Promise<void> => { await act(async () => root.render(<SettingsUpdate now={() => NOW} />)) }
  const button = (text: string): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === text)!
  const click = async (text: string): Promise<void> => { await act(async () => button(text).click()) }
  /** 英雄行里的大号版本数字（当前版本，以及有目标时的新版本 / 回滚目标）。 */
  const numbers = (): string[] => [...container.querySelectorAll('.app-update__number')].map((node) => node.textContent ?? '')

  it('挂载即拉一次状态并订阅推送；idle 显示当前版本与「立即检查」，检查后变已是最新', async () => {
    const { api } = installApi(statusOf({ phase: 'idle', lastCheckedAt: NOW - 60_000 }))
    await render()
    expect(api.getAppUpdateStatus).toHaveBeenCalledTimes(1)
    expect(api.onAppUpdateStatus).toHaveBeenCalledTimes(1)
    // 英雄行：只有当前版本一个数字、没有圆点、没有胶囊；状态句说上次检查
    expect(numbers()).toEqual(['0.3.2'])
    expect(container.querySelector('.app-update__dot')).toBeNull()
    expect(container.querySelector('.app-update__badge')).toBeNull()
    expect(container.querySelector('.app-update__headline')?.textContent).toBe('上次检查 今天 10:29')
    await click('立即检查')
    expect(api.checkAppUpdate).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('已是最新')
    expect(container.querySelector('.app-update__badge')?.className).toContain('is-success')
  })

  it('有新版：胶囊、英雄行「当前 → 新版本」、发布说明纯文本、下载 → 待安装；安装先过门禁，确认后才真正安装', async () => {
    const { api } = installApi(statusOf({ phase: 'available', release, checkedAt: NOW }))
    await render()
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('有新版本')
    expect(numbers()).toEqual(['0.3.2', '0.3.3'])
    expect([...container.querySelectorAll('.app-update__eyebrow')].map((node) => node.textContent)).toEqual(['当前版本', '新版本'])
    expect(container.querySelector('.app-update__headline')?.textContent).toMatch(/发布 · 111\.1 MB$/)
    expect([...container.querySelectorAll('.app-update__notes p')].map((node) => node.textContent)).toEqual(['v0.3.3', '- 第一条'])
    expect(container.querySelector('.app-update__notes')?.innerHTML).not.toContain('<h2>')
    await click('下载')
    expect(api.downloadAppUpdate).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('待安装')

    await click('安装并重启')
    expect(api.installAppUpdate).toHaveBeenLastCalledWith({ confirmed: false })
    const confirm = container.querySelector('.app-update__confirm')!
    expect(confirm.textContent).toContain('有 2 个席位在线')
    // 确认块出现时普通操作按钮收起，避免双入口
    expect(button('安装并重启')).toBeUndefined()
    await click('取消')
    expect(container.querySelector('.app-update__confirm')).toBeNull()
    expect(api.installAppUpdate).toHaveBeenCalledTimes(1)

    await click('安装并重启')
    await click('仍然安装并重启')
    expect(api.installAppUpdate).toHaveBeenLastCalledWith({ confirmed: true })
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('正在安装')
    expect(container.querySelector('.app-update__headline')?.textContent).toBe('拾光即将退出；安装完成后会自动重新打开。')
    expect(container.querySelectorAll('.app-update__card .app-update__button')).toHaveLength(0)
  })

  it('跳过 / 取消跳过 / 稍后只改设置：面板文案跟随，胶囊变「已跳过」再变回', async () => {
    const { api } = installApi(statusOf({ phase: 'available', release, checkedAt: NOW }))
    await render()
    await click('跳过此版本')
    expect(api.skipAppUpdate).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.app-update__note')?.textContent).toBe('已跳过 0.3.3，出现更高版本时再提醒')
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('已跳过')
    expect(container.querySelector('.app-update__badge')?.className).toContain('is-muted')
    await click('取消跳过')
    expect(container.querySelector('.app-update__note')).toBeNull()
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('有新版本')
    await click('稍后')
    expect(api.snoozeAppUpdate).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.app-update__note')?.textContent).toMatch(/^已选择稍后，.*后恢复提醒$/)
    expect(button('稍后').disabled).toBe(true)
  })

  it('失败态：原因 + 重试回到有新版；打开发布页只调 IPC', async () => {
    const { api } = installApi(statusOf({ phase: 'failed', step: 'download', message: 'sha512 mismatch', at: NOW, release }))
    await render()
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('下载失败')
    expect(container.querySelector('.app-update__badge')?.className).toContain('is-danger')
    expect(container.querySelector('.app-update__headline')?.textContent).toBe('sha512 mismatch')
    expect(numbers()).toEqual(['0.3.2', '0.3.3'])
    await click('重试')
    expect(api.dismissAppUpdateFailure).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('有新版本')
    await click('打开发布页')
    expect(api.openAppUpdateReleasePage).toHaveBeenCalledTimes(1)
  })

  it('下载中：进度条 aria 值与读数、取消按钮；推送更新会刷新进度', async () => {
    const { push } = installApi(statusOf({ phase: 'downloading', release, receivedBytes: 29_116_886, totalBytes: 116_467_543, bytesPerSecond: 3_145_728, startedAt: NOW }))
    await render()
    const bar = container.querySelector<HTMLElement>('.app-update__bar')!
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(container.querySelector('.app-update__readout')?.textContent).toBe('27.8 MB / 111.1 MB · 3.0 MB/s')
    expect(button('取消下载')).toBeDefined()
    await act(async () => { push(statusOf({ phase: 'downloading', release, receivedBytes: 87_350_658, totalBytes: 116_467_543, startedAt: NOW })) })
    expect(bar.getAttribute('aria-valuenow')).toBe('75')
    expect(container.querySelector('.app-update__readout')?.textContent).toBe('83.3 MB / 111.1 MB')
  })

  it('下载 IPC 直到下载结束才返回：下载期间「取消下载」仍可点，取消后回到有新版', async () => {
    const { api, push } = installApi(statusOf({ phase: 'available', release, checkedAt: NOW }))
    let finishDownload: ((status: AppUpdateStatus) => void) | undefined
    api.downloadAppUpdate.mockImplementation(() => new Promise<AppUpdateStatus>((resolve) => { finishDownload = resolve }))
    api.cancelAppUpdateDownload.mockImplementation(async () => {
      // 主进程：取消先返回仍在下载的状态，端口随后以取消结束 → 推送回 available，并让下载 IPC 返回
      const cancelled = statusOf({ phase: 'available', release, checkedAt: NOW })
      queueMicrotask(() => { push(cancelled); finishDownload?.(cancelled) })
      return statusOf({ phase: 'downloading', release, receivedBytes: 10, totalBytes: 100, startedAt: NOW })
    })
    await render()
    await click('下载')
    expect(api.downloadAppUpdate).toHaveBeenCalledTimes(1)
    await act(async () => { push(statusOf({ phase: 'downloading', release, receivedBytes: 10, totalBytes: 100, startedAt: NOW })) })
    const cancel = button('取消下载')
    expect(cancel.disabled).toBe(false)
    await click('取消下载')
    expect(api.cancelAppUpdateDownload).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('有新版本')
    expect(button('下载').disabled).toBe(false)
  })

  it('检查设置：开关与间隔经归一化保存，关掉开关间隔子组收起；不支持的平台禁用；自定义源保存与恢复默认', async () => {
    const { api } = installApi(statusOf({ phase: 'up_to_date', checkedAt: NOW }))
    await render()
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="自动检查新版本"]')!
    expect(toggle.checked).toBe(true)
    const collapse = container.querySelector('.settings-collapse')!
    expect(collapse.classList.contains('is-open')).toBe(true)
    expect(collapse.textContent).toContain('检查间隔')
    await act(async () => { toggle.click() })
    expect(api.saveAppUpdateSettings).toHaveBeenLastCalledWith({ autoCheck: false, checkIntervalHours: 6 })
    expect(collapse.classList.contains('is-open')).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('.menu-select__button')?.disabled).toBe(true)

    const input = container.querySelector<HTMLInputElement>('input[aria-label="自定义更新源"]')!
    const save = button('保存')
    expect(save.disabled).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' https://mirror.example.com/sg/ ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(save.disabled).toBe(false)
    await click('保存')
    expect(api.saveAppUpdateSettings).toHaveBeenLastCalledWith({ autoCheck: false, checkIntervalHours: 6, feedUrl: 'https://mirror.example.com/sg/' })
    await click('恢复默认')
    expect(api.saveAppUpdateSettings).toHaveBeenLastCalledWith({ autoCheck: false, checkIntervalHours: 6 })
  })

  it('镜像预设：点胶囊只填入输入框（仍要保存）；保存后胶囊点亮为当前源，恢复默认后熄灭', async () => {
    const { api } = installApi(statusOf({ phase: 'up_to_date', checkedAt: NOW }))
    await render()
    const preset = button('gh-proxy 镜像')
    const input = container.querySelector<HTMLInputElement>('input[aria-label="自定义更新源"]')!
    expect(preset.title).toBe('https://gh-proxy.com/https://github.com/lyr339/SG-Team/releases/latest/download/')
    expect(preset.classList.contains('is-active')).toBe(false)
    await click('gh-proxy 镜像')
    expect(input.value).toBe(preset.title)
    expect(api.saveAppUpdateSettings).not.toHaveBeenCalled()
    expect(preset.classList.contains('is-active')).toBe(false) // 只是草稿：胶囊表示「当前源」，保存前不亮
    expect(button('保存').disabled).toBe(false)
    await click('保存')
    expect(api.saveAppUpdateSettings).toHaveBeenLastCalledWith({ autoCheck: true, checkIntervalHours: 6, feedUrl: preset.title })
    expect(button('gh-proxy 镜像').classList.contains('is-active')).toBe(true)
    await click('恢复默认')
    expect(input.value).toBe('')
    expect(button('gh-proxy 镜像').classList.contains('is-active')).toBe(false)
  })

  it('平台不支持：状态卡说明原因、只剩发布页，开关禁用', async () => {
    installApi(statusOf({ phase: 'unsupported', reason: '此平台的应用内更新尚未提供：请到发布页下载新版后手动替换。' }))
    await render()
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('不支持应用内更新')
    expect(container.querySelector('.app-update__headline')?.textContent).toContain('发布页')
    expect([...container.querySelectorAll('.app-update__card button')].map((node) => node.textContent)).toEqual(['打开发布页'])
    expect(container.querySelector<HTMLInputElement>('input[aria-label="自动检查新版本"]')?.disabled).toBe(true)
  })

  it('更新后首次启动：绿色提示可收起', async () => {
    installApi(statusOf({ phase: 'idle' }, { launchedAfterUpdate: true }))
    await render()
    expect(container.querySelector('.app-update__updated')?.textContent).toContain('已更新到 0.3.2')
    await act(async () => container.querySelector<HTMLButtonElement>('.app-update__updated button')!.click())
    expect(container.querySelector('.app-update__updated')).toBeNull()
  })

  it('mac 脚本回执：applied 绿色横幅、收起走 IPC；apply_failed 红色 alert 带原因', async () => {
    const { api, push } = installApi(statusOf({ phase: 'idle' }, { applyResult: { status: 'applied', from: '0.3.2', to: '0.3.3' } }))
    await render()
    const banner = container.querySelector('.app-update__updated')!
    expect(banner.className).toContain('is-success')
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.textContent).toContain('已更新到 0.3.3（原 0.3.2）')
    await act(async () => banner.querySelector('button')!.click())
    expect(api.dismissAppUpdateApplyResult).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.app-update__updated')).toBeNull()

    await act(async () => {
      push(statusOf({ phase: 'idle' }, { applyResult: { status: 'apply_failed', from: '0.3.2', to: '0.3.3', reason: 'codesign_failed' } }))
    })
    const failed = container.querySelector('.app-update__updated')!
    expect(failed.className).toContain('is-danger')
    expect(failed.getAttribute('role')).toBe('alert')
    expect(failed.textContent).toContain('更新到 0.3.3 失败，已恢复 0.3.2（codesign_failed）')
  })

  it('回滚：脚注按钮先拿门禁、必出确认块（含数据回退警告），确认后才真正回滚', async () => {
    const backup = { version: '0.3.2', createdAt: NOW - 3_600_000, dir: 'D:\\backup\\0.3.2-1' }
    const { api } = installApi(statusOf({ phase: 'idle', lastCheckedAt: NOW }, { rollback: backup }))
    await render()
    expect(container.querySelector('.app-update__rollback')?.textContent).toContain('保留了 0.3.2 的备份')
    await click('回滚到 0.3.2…')
    expect(api.rollbackAppUpdate).toHaveBeenLastCalledWith({ confirmed: false })
    const confirm = container.querySelector('.app-update__confirm')!
    expect(confirm.getAttribute('aria-label')).toBe('确认回滚')
    expect(confirm.textContent).toContain('回滚会退出拾光')
    // 确认块出现时脚注按钮收起，避免双入口
    expect(container.querySelector('.app-update__rollback')).toBeNull()
    await click('取消')
    expect(api.rollbackAppUpdate).toHaveBeenCalledTimes(1)

    await click('回滚到 0.3.2…')
    await click('回滚到 0.3.2 并重启')
    expect(api.rollbackAppUpdate).toHaveBeenLastCalledWith({ confirmed: true })
    expect(container.querySelector('.app-update__badge')?.textContent).toBe('正在回滚')
    expect(numbers()).toEqual(['0.3.2', '0.3.2'])
    expect([...container.querySelectorAll('.app-update__eyebrow')].map((node) => node.textContent)).toEqual(['当前版本', '回滚到'])
    expect(container.querySelector('.app-update__rollback')).toBeNull()
  })
})

describe('小提醒框', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    delete (window as unknown as { sgDesktop?: Api }).sgDesktop
  })

  it('有可提醒版本才出现；查看回调后收起；15 秒自动收起；同一版本不再出现，更高版本重新出现', async () => {
    const onOpen = vi.fn()
    const render = async (status: AppUpdateStatus | undefined): Promise<void> => {
      await act(async () => root.render(<UpdateReminder status={status} onOpen={onOpen} autoHideMs={15_000} />))
    }
    await render(statusOf({ phase: 'up_to_date', checkedAt: NOW }))
    expect(container.querySelector('.update-reminder')).toBeNull()

    await render(statusOf({ phase: 'available', release, checkedAt: NOW }))
    expect(container.querySelector('.update-reminder strong')?.textContent).toBe('拾光 0.3.3 可用')
    await act(async () => { vi.advanceTimersByTime(14_000) })
    expect(container.querySelector('.update-reminder')).not.toBeNull()
    await act(async () => { vi.advanceTimersByTime(1_500) })
    expect(container.querySelector('.update-reminder')).toBeNull()

    // 同一版本的后续推送（例如下载完成）不再弹出
    await render(statusOf({ phase: 'downloaded', release, downloadedAt: NOW }))
    expect(container.querySelector('.update-reminder')).toBeNull()

    // 更高版本重新弹出，「查看」触发回调并收起
    const newer = { ...release, version: '0.3.4' }
    await render(statusOf({ phase: 'available', release: newer, checkedAt: NOW }))
    expect(container.querySelector('.update-reminder strong')?.textContent).toBe('拾光 0.3.4 可用')
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '查看')!.click() })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.update-reminder')).toBeNull()
  })

  it('「稍后」调用主进程的 snooze 并收起；已下载好时文案改为提示安装', async () => {
    const { api } = installApi(statusOf({ phase: 'downloaded', release, downloadedAt: NOW }))
    await act(async () => root.render(<UpdateReminder status={statusOf({ phase: 'downloaded', release, downloadedAt: NOW })} onOpen={() => {}} />))
    expect(container.querySelector('.update-reminder strong')?.textContent).toBe('拾光 0.3.3 已下载好')
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '稍后')!.click() })
    expect(api.snoozeAppUpdate).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.update-reminder')).toBeNull()
  })
})
