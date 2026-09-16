import { ipcMain, shell, type BrowserWindow } from 'electron'
import type { AppUpdateService } from '../application/app-update-service'
import { normalizeAppUpdateSettings } from '../domain/app-update'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

/**
 * 拾光自更新的 IPC 面：状态拉取 / 推送 + 用户意图（检查、下载、取消、安装、跳过、稍后、设置）。
 * 状态不进 DesktopSnapshot（那条推送有按版本瘦身的机制，改动面大），走独立通道 `app-update:status`。
 */
export function registerAppUpdateIpc(
  service: AppUpdateService,
  getWindow: () => BrowserWindow | undefined
): () => void {
  const handlers: Array<[string, (event: Electron.IpcMainInvokeEvent, payload?: unknown) => unknown]> = [
    [IPC.appUpdateGetStatus, () => service.getStatus()],
    [IPC.appUpdateCheck, () => service.check({ manual: true })],
    [IPC.appUpdateDownload, () => service.download()],
    [IPC.appUpdateCancelDownload, () => service.cancelDownload()],
    [IPC.appUpdateInstall, (_event, payload) => {
      const confirmed = Boolean(payload && typeof payload === 'object' && (payload as { confirmed?: unknown }).confirmed === true)
      return service.install({ confirmed })
    }],
    [IPC.appUpdateSkip, () => service.skipCurrent()],
    [IPC.appUpdateUnskip, () => service.unskip()],
    [IPC.appUpdateSnooze, () => service.snooze()],
    [IPC.appUpdateDismissFailure, () => service.dismissFailure()],
    [IPC.appUpdateSaveSettings, (_event, payload) => service.saveSettings(normalizeAppUpdateSettings(payload))],
    [IPC.appUpdateOpenReleasePage, async () => {
      const url = service.getStatus().releaseUrl
      if (!/^https:\/\/github\.com\//.test(url)) return false
      await shell.openExternal(url)
      return true
    }]
  ]
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, (event, payload) => {
      assertTrustedSender(event, getWindow)
      return handler(event, payload)
    })
  }
  const unsubscribe = service.onChange((status) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.appUpdateStatus, status)
  })
  return () => {
    unsubscribe()
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
  }
}
