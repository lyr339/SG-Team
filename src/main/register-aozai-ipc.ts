import { ipcMain, type BrowserWindow } from 'electron'
import type { AozaiCardVault } from '../application/aozai-card-vault'
import type { AozaiService } from '../application/aozai-service'
import type { CursorAccountVault } from '../application/cursor-account-vault'
import type { AozaiCardStatus, AozaiProgressEvent } from '../domain/aozai-service'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function savedStatus(maskedCode: string, info: Awaited<ReturnType<AozaiService['refreshBalance']>>): AozaiCardStatus {
  return { saved: true, maskedCode, ...info }
}

function cardCodeOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('卡密无效')
  return value.trim()
}

function processInputOf(value: unknown): { accountId: string; requestId: string } {
  if (!value || typeof value !== 'object') throw new Error('处理参数无效')
  const input = value as Record<string, unknown>
  if (typeof input.accountId !== 'string' || !input.accountId.trim() || input.accountId.length > 200) throw new Error('Cursor 账号 ID 无效')
  if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 64) throw new Error('请求 ID 无效')
  return { accountId: input.accountId.trim(), requestId: input.requestId.trim() }
}

function processTokenInputOf(value: unknown): { token: string; requestId: string } {
  if (!value || typeof value !== 'object') throw new Error('处理参数无效')
  const input = value as Record<string, unknown>
  if (typeof input.token !== 'string' || !input.token.trim() || input.token.length > 16384) throw new Error('Session Token 无效')
  if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 64) throw new Error('请求 ID 无效')
  return { token: input.token.trim(), requestId: input.requestId.trim() }
}

export function registerAozaiIpc(
  cardVault: AozaiCardVault,
  service: AozaiService,
  cursorAccounts: CursorAccountVault,
  getWindow: () => BrowserWindow | undefined
): () => void {
  const status = async (refresh: boolean): Promise<AozaiCardStatus> => {
    const maskedCode = cardVault.maskedCode()
    if (!maskedCode) return { saved: false }
    if (!refresh) return { saved: true, maskedCode }
    return savedStatus(maskedCode, await service.refreshBalance())
  }

  ipcMain.handle(IPC.aozaiGetCardStatus, (event) => {
    assertTrustedSender(event, getWindow)
    return status(false)
  })
  ipcMain.handle(IPC.aozaiRefreshBalance, (event) => {
    assertTrustedSender(event, getWindow)
    return status(true)
  })
  ipcMain.handle(IPC.aozaiSaveCard, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const cardCode = cardCodeOf(value)
    service.resetAuthorization()
    const info = await service.verifyCard(cardCode)
    try {
      return savedStatus(cardVault.save(cardCode), info)
    } catch (error) {
      // 验证成功但本地保存失败时，不得继续持有一张未落盘新卡的 Bearer。
      service.resetAuthorization()
      throw error
    }
  })
  ipcMain.handle(IPC.aozaiClearCard, (event) => {
    assertTrustedSender(event, getWindow)
    service.resetAuthorization()
    cardVault.clear()
    return { saved: false } satisfies AozaiCardStatus
  })
  ipcMain.handle(IPC.aozaiProcessAccount, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const { accountId, requestId } = processInputOf(value)
    const token = cursorAccounts.credential(accountId)
    const emit = (state: AozaiProgressEvent['state'], message: string): void => {
      const window = getWindow()
      if (window && !window.isDestroyed()) {
        const payload: AozaiProgressEvent = { requestId, accountId, state, message }
        window.webContents.send(IPC.aozaiProgress, payload)
      }
    }
    return service.processToken(token, emit)
  })
  // 手动模式：token 由用户粘贴、经渲染进程传入（与保险库取数的账号处理不同，是有意的边界）；
  // 进度事件的 accountId 置空串 = 无账号归属，不会匹配任何账号卡片的「处理中」标记。
  ipcMain.handle(IPC.aozaiProcessToken, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const { token, requestId } = processTokenInputOf(value)
    const emit = (state: AozaiProgressEvent['state'], message: string): void => {
      const window = getWindow()
      if (window && !window.isDestroyed()) {
        const payload: AozaiProgressEvent = { requestId, accountId: '', state, message }
        window.webContents.send(IPC.aozaiProgress, payload)
      }
    }
    return service.processToken(token, emit)
  })
  return () => {
    ipcMain.removeHandler(IPC.aozaiGetCardStatus)
    ipcMain.removeHandler(IPC.aozaiRefreshBalance)
    ipcMain.removeHandler(IPC.aozaiSaveCard)
    ipcMain.removeHandler(IPC.aozaiClearCard)
    ipcMain.removeHandler(IPC.aozaiProcessAccount)
    ipcMain.removeHandler(IPC.aozaiProcessToken)
  }
}
