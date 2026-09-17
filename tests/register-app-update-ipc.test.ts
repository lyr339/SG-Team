import { describe, expect, it, vi } from 'vitest'
import type { AppUpdateService } from '../src/application/app-update-service'
import type { AppUpdateStatus } from '../src/domain/app-update'
import { registerAppUpdateIpc } from '../src/main/register-app-update-ipc'
import { IPC } from '../src/shared/desktop-api'

const { handlers, shell, assertTrustedSender } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  shell: { openExternal: vi.fn(async () => {}) },
  assertTrustedSender: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name)
  },
  shell
}))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender }))

function statusOf(releaseUrl = 'https://github.com/lyr339/SG-Team/releases/tag/v0.3.3'): AppUpdateStatus {
  return {
    currentVersion: '0.3.2',
    state: { phase: 'idle' },
    settings: { autoCheck: true, checkIntervalHours: 6 },
    launchedAfterUpdate: false,
    releaseUrl
  }
}

function harness(releaseUrl?: string) {
  handlers.clear()
  shell.openExternal.mockClear()
  assertTrustedSender.mockClear()
  let listener: ((status: AppUpdateStatus) => void) | undefined
  const unsubscribe = vi.fn()
  const service = {
    getStatus: vi.fn(() => statusOf(releaseUrl)),
    check: vi.fn(async (input: unknown) => ({ ...statusOf(), checked: input })),
    download: vi.fn(async () => statusOf()),
    cancelDownload: vi.fn(() => statusOf()),
    install: vi.fn((input: unknown) => ({ gate: { verdict: 'allow' }, status: statusOf(), input })),
    rollback: vi.fn((input: unknown) => ({ gate: { verdict: 'allow' }, status: statusOf(), input })),
    dismissApplyResult: vi.fn(() => statusOf()),
    skipCurrent: vi.fn(() => statusOf()),
    unskip: vi.fn(() => statusOf()),
    snooze: vi.fn(() => statusOf()),
    dismissFailure: vi.fn(() => statusOf()),
    saveSettings: vi.fn((raw: unknown) => ({ ...statusOf(), saved: raw })),
    onChange: vi.fn((next: (status: AppUpdateStatus) => void) => {
      listener = next
      return unsubscribe
    })
  }
  const send = vi.fn()
  const window = { isDestroyed: () => false, webContents: { send } }
  const dispose = registerAppUpdateIpc(service as unknown as AppUpdateService, () => window as never)
  const invoke = (channel: string, payload?: unknown): unknown => handlers.get(channel)!({ senderFrame: null }, payload)
  return { service, dispose, invoke, send, unsubscribe, emit: (status: AppUpdateStatus) => listener?.(status) }
}

describe('软件更新 IPC', () => {
  it('每个键路由到服务方法，且都先校验发送方；安装的 confirmed 只认布尔 true', async () => {
    const { service, invoke } = harness()
    expect(await invoke(IPC.appUpdateGetStatus)).toMatchObject({ currentVersion: '0.3.2' })
    await invoke(IPC.appUpdateCheck)
    expect(service.check).toHaveBeenCalledWith({ manual: true })
    await invoke(IPC.appUpdateDownload)
    await invoke(IPC.appUpdateCancelDownload)
    await invoke(IPC.appUpdateInstall, { confirmed: 'yes' })
    await invoke(IPC.appUpdateInstall, { confirmed: true })
    await invoke(IPC.appUpdateInstall, null)
    expect(service.install.mock.calls.map(([input]) => input)).toEqual([{ confirmed: false }, { confirmed: true }, { confirmed: false }])
    await invoke(IPC.appUpdateRollback, { confirmed: true })
    await invoke(IPC.appUpdateRollback, 'junk')
    expect(service.rollback.mock.calls.map(([input]) => input)).toEqual([{ confirmed: true }, { confirmed: false }])
    await invoke(IPC.appUpdateDismissApplyResult)
    await invoke(IPC.appUpdateSkip)
    await invoke(IPC.appUpdateUnskip)
    await invoke(IPC.appUpdateSnooze)
    await invoke(IPC.appUpdateDismissFailure)
    for (const method of [service.download, service.cancelDownload, service.dismissApplyResult, service.skipCurrent, service.unskip, service.snooze, service.dismissFailure]) {
      expect(method).toHaveBeenCalledTimes(1)
    }
    expect(assertTrustedSender).toHaveBeenCalledTimes(14)
  })

  it('保存设置先归一化：非法档位与垃圾字段不会到达服务', async () => {
    const { service, invoke } = harness()
    await invoke(IPC.appUpdateSaveSettings, { autoCheck: false, checkIntervalHours: 5, feedUrl: 'javascript:alert(1)', junk: 1 })
    expect(service.saveSettings).toHaveBeenCalledWith({ autoCheck: false, checkIntervalHours: 6 })
  })

  it('打开发布页只放行 github.com 下的 https 链接', async () => {
    const ok = harness()
    expect(await ok.invoke(IPC.appUpdateOpenReleasePage)).toBe(true)
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/lyr339/SG-Team/releases/tag/v0.3.3')
    const bad = harness('http://evil.example.com/')
    expect(await bad.invoke(IPC.appUpdateOpenReleasePage)).toBe(false)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('状态变化推送到窗口；dispose 退订并移除全部处理器', () => {
    const { dispose, send, unsubscribe, emit } = harness()
    emit(statusOf())
    expect(send).toHaveBeenCalledWith(IPC.appUpdateStatus, expect.objectContaining({ currentVersion: '0.3.2' }))
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(handlers.size).toBe(0)
  })
})
