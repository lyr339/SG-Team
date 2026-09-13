import { ipcMain, type BrowserWindow } from 'electron'
import type { SeatRotationSettingsStore } from '../application/seat-rotation-settings-store'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

/**
 * 席位自动轮换的 IPC 面：只有设置读写。轮换过程与结果不走独立通道——
 * 它们投影在会话快照的 `seatRotation` 字段与一键建会话的进度推送里。
 */
export function registerSeatRotationIpc(
  store: SeatRotationSettingsStore,
  getWindow: () => BrowserWindow | undefined,
  options: { onSettingsSaved?: () => void } = {}
): () => void {
  ipcMain.handle(IPC.seatRotationGetSettings, (event) => {
    assertTrustedSender(event, getWindow)
    return store.load()
  })
  ipcMain.handle(IPC.seatRotationSaveSettings, (event, settings: unknown) => {
    assertTrustedSender(event, getWindow)
    const saved = store.save(settings)
    options.onSettingsSaved?.()
    return saved
  })
  return () => {
    ipcMain.removeHandler(IPC.seatRotationGetSettings)
    ipcMain.removeHandler(IPC.seatRotationSaveSettings)
  }
}
