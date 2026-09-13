import { ipcMain, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  CHAT_HISTORY_OLDER_THAN_OPTIONS,
  CURSOR_STORAGE_CATALOG,
  type CursorStorageCleanupRequest,
  type CursorStorageItemId
} from '../domain/cursor-storage-cleanup'
import type { CursorStorageScanner } from '../infrastructure/cursor/cursor-storage-scanner'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

const ITEM_IDS = new Set<string>(CURSOR_STORAGE_CATALOG.map((spec) => spec.id))

function parseOlderThanDays(value: unknown): number | undefined {
  return typeof value === 'number' && (CHAT_HISTORY_OLDER_THAN_OPTIONS as readonly number[]).includes(value) ? value : undefined
}

function parseCleanupRequest(value: unknown): CursorStorageCleanupRequest {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const ids = Array.isArray(record.ids)
    ? record.ids.filter((id): id is CursorStorageItemId => typeof id === 'string' && ITEM_IDS.has(id))
    : []
  if (!ids.length) throw new Error('没有选择任何清理项')
  const olderThanDays = parseOlderThanDays(record.chatHistoryOlderThanDays)
  return {
    ids,
    ...(olderThanDays === undefined ? {} : { chatHistoryOlderThanDays: olderThanDays }),
    compactDatabase: record.compactDatabase === true
  }
}

/** 各项在文件管理器里的定位目标（相对 Cursor 用户数据目录）。 */
function revealTarget(userDataRoot: string, id: CursorStorageItemId): string {
  switch (id) {
    case 'chat-history':
    case 'stale-backups': return join(userDataRoot, 'User', 'globalStorage', 'state.vscdb')
    case 'snapshots': return join(userDataRoot, 'snapshots')
    case 'local-history': return join(userDataRoot, 'User', 'History')
    case 'orphan-workspaces': return join(userDataRoot, 'User', 'workspaceStorage')
    case 'caches': return join(userDataRoot, 'Cache')
    case 'logs': return join(userDataRoot, 'logs')
    case 'legacy-patch': return userDataRoot
  }
}

export function registerCursorStorageIpc(
  scanner: CursorStorageScanner,
  options: { userDataRoot: string; workbenchBundlePath?: string },
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.cursorStorageScan, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const olderThanDays = parseOlderThanDays(record.chatHistoryOlderThanDays)
    return scanner.scan(olderThanDays === undefined ? {} : { chatHistoryOlderThanDays: olderThanDays })
  })
  ipcMain.handle(IPC.cursorStorageCleanup, (event, request: unknown) => {
    assertTrustedSender(event, getWindow)
    return scanner.cleanup(parseCleanupRequest(request))
  })
  ipcMain.handle(IPC.cursorStorageReveal, (event, id: unknown) => {
    assertTrustedSender(event, getWindow)
    if (typeof id !== 'string' || !ITEM_IDS.has(id)) throw new Error('未知的清理项')
    const target = id === 'legacy-patch' && options.workbenchBundlePath
      ? options.workbenchBundlePath
      : revealTarget(options.userDataRoot, id as CursorStorageItemId)
    shell.showItemInFolder(target)
  })
  return () => {
    ipcMain.removeHandler(IPC.cursorStorageScan)
    ipcMain.removeHandler(IPC.cursorStorageCleanup)
    ipcMain.removeHandler(IPC.cursorStorageReveal)
  }
}
