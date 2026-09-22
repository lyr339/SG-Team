import { ipcMain, type BrowserWindow } from 'electron'
import type { ProcessingProviderRegistry } from '../application/processing-provider-registry'
import type { CursorAccountVault } from '../application/cursor-account-vault'
import {
  normalizeProcessingProviderId,
  type ProcessingProgressEvent,
  type ProcessingProviderId
} from '../domain/processing-provider'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function providerIdOf(value: unknown): ProcessingProviderId {
  if (value !== 'aozai' && value !== 'henxin') throw new Error('处理服务无效')
  return normalizeProcessingProviderId(value)
}

function credentialInput(value: unknown): { providerId: ProcessingProviderId; code: string } {
  if (!value || typeof value !== 'object') throw new Error('卡密参数无效')
  const input = value as Record<string, unknown>
  const providerId = providerIdOf(input.providerId)
  if (typeof input.code !== 'string' || !input.code.trim() || input.code.length > 200) throw new Error('卡密无效')
  return { providerId, code: input.code.trim() }
}

function processInput(value: unknown, withAccount: boolean): {
  providerId: ProcessingProviderId
  accountId: string
  token: string
  requestId: string
} {
  if (!value || typeof value !== 'object') throw new Error('处理参数无效')
  const input = value as Record<string, unknown>
  const providerId = providerIdOf(input.providerId)
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : ''
  if (!requestId || requestId.length > 64) throw new Error('请求 ID 无效')
  const accountId = withAccount && typeof input.accountId === 'string' ? input.accountId.trim() : ''
  if (withAccount && (!accountId || accountId.length > 200)) throw new Error('Cursor 账号 ID 无效')
  const token = !withAccount && typeof input.token === 'string' ? input.token.trim() : ''
  if (!withAccount && (!token || token.length > 16_384)) throw new Error('Session Token 无效')
  return { providerId, accountId, token, requestId }
}

export function registerProcessingProviderIpc(
  providers: ProcessingProviderRegistry,
  cursorAccounts: CursorAccountVault,
  getWindow: () => BrowserWindow | undefined
): () => void {
  const emit = (providerId: ProcessingProviderId, requestId: string, accountId: string) =>
    (state: ProcessingProgressEvent['state'], message: string): void => {
      const window = getWindow()
      if (!window || window.isDestroyed()) return
      window.webContents.send(IPC.processingProgress, { providerId, requestId, accountId, state, message } satisfies ProcessingProgressEvent)
    }

  ipcMain.handle(IPC.processingGetStatuses, (event) => {
    assertTrustedSender(event, getWindow)
    return providers.statuses()
  })
  ipcMain.handle(IPC.processingRefreshBalance, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    return providers.status(providerIdOf(value), true)
  })
  ipcMain.handle(IPC.processingSaveCredential, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const input = credentialInput(value)
    return providers.saveCredential(input.providerId, input.code)
  })
  ipcMain.handle(IPC.processingClearCredential, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    return providers.clearCredential(providerIdOf(value))
  })
  ipcMain.handle(IPC.processingProcessAccount, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const input = processInput(value, true)
    return providers.require(input.providerId).service.processToken(
      cursorAccounts.credential(input.accountId),
      emit(input.providerId, input.requestId, input.accountId)
    )
  })
  ipcMain.handle(IPC.processingProcessToken, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const input = processInput(value, false)
    return providers.require(input.providerId).service.processToken(
      input.token,
      emit(input.providerId, input.requestId, '')
    )
  })

  return () => {
    ipcMain.removeHandler(IPC.processingGetStatuses)
    ipcMain.removeHandler(IPC.processingRefreshBalance)
    ipcMain.removeHandler(IPC.processingSaveCredential)
    ipcMain.removeHandler(IPC.processingClearCredential)
    ipcMain.removeHandler(IPC.processingProcessAccount)
    ipcMain.removeHandler(IPC.processingProcessToken)
  }
}
