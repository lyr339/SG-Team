import { ipcMain, type BrowserWindow } from 'electron'
import type { SessionWarmupService } from '../application/session-warmup-service'
import type { SessionWarmupRun } from '../domain/session-warmup'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

/**
 * 会话预热 IPC：无入参（候选模型由主进程从遥测目录解析），
 * 运行全程经 progress 事件推送，invoke 返回终态 run。
 */
export function registerSessionWarmupIpc(
  service: SessionWarmupService,
  getWindow: () => BrowserWindow | undefined
): () => void {
  const emitProgress = (run: SessionWarmupRun): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.sessionWarmupProgress, run)
  }

  ipcMain.handle(IPC.sessionWarmupRun, async (event) => {
    assertTrustedSender(event, getWindow)
    return service.warmup()
  })
  ipcMain.handle(IPC.sessionWarmupGet, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getRun()
  })

  const unsubscribe = service.onProgress(emitProgress)
  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.sessionWarmupRun)
    ipcMain.removeHandler(IPC.sessionWarmupGet)
  }
}
