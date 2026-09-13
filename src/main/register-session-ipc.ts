import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import type { DesktopSessionBridge } from '../application/desktop-session-service'
import {
  IPC,
  type DesktopSnapshot,
  type SendMessageInput
} from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'
import { deliveryStateOf, stripKnownSections, type SnapshotDeliveryState } from './snapshot-push'

/**
 * 每个渲染进程已持有的段落版本（推送瘦身的依据）。页面开始重新加载即清空——
 * 渲染层状态随之归零，下一份快照必须完整；webContents 销毁后由 WeakMap 自行回收。
 */
class SnapshotDeliveryLedger {
  private readonly known = new WeakMap<WebContents, SnapshotDeliveryState>()
  private readonly tracked = new WeakSet<WebContents>()

  private track(contents: WebContents): void {
    if (this.tracked.has(contents)) return
    this.tracked.add(contents)
    contents.on('did-start-loading', () => this.known.delete(contents))
  }

  knownOf(contents: WebContents): SnapshotDeliveryState | undefined {
    this.track(contents)
    return this.known.get(contents)
  }

  /** 这份（完整）快照已交给该渲染进程（推送或拉取回包）；无版本号的快照不改变已知状态。 */
  delivered(contents: WebContents, snapshot: DesktopSnapshot): void {
    this.track(contents)
    const state = deliveryStateOf(snapshot)
    if (state) this.known.set(contents, state)
  }
}

function attachmentOf(value: unknown): SendMessageInput['attachments'] {
  if (!Array.isArray(value)) return undefined
  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    if (typeof raw.name !== 'string' || typeof raw.mimeType !== 'string') return []
    return [{
      id: typeof raw.id === 'string' ? raw.id : '',
      name: raw.name,
      mimeType: raw.mimeType,
      size: typeof raw.size === 'number' ? raw.size : 0,
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
      ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
      ...(typeof raw.previewUrl === 'string' ? { previewUrl: raw.previewUrl } : {})
    }]
  })
  return attachments.length ? attachments : undefined
}

function sendInputOf(value: unknown): SendMessageInput {
  if (!value || typeof value !== 'object') throw new Error('消息参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.channelId !== 'string' || typeof raw.text !== 'string') {
    throw new Error('消息参数无效')
  }
  return {
    channelId: raw.channelId,
    text: raw.text,
    attachments: attachmentOf(raw.attachments),
    ...(raw.silent === true ? { silent: true } : {})
  }
}

/**
 * 拾光本地会话 IPC（一体化后无外置连接面）：
 * 快照读取/推送与消息发送直连 DesktopSessionService，
 * 内嵌通道经 SQLite 队列分流，其余通道无传输可走。
 *
 * 推送与拉取的分工：拉取（`getSnapshot`）永远返回完整快照；推送按版本号剔除渲染进程
 * 已持有的时间线与模型目录（`stripKnownSections`），渲染层按版本合并、缺口补拉。
 * 进程内的其他订阅者（调度器、团队服务）仍从 DesktopSessionService 拿完整快照，瘦身只发生在这条 IPC 边界。
 */
export function registerSessionIpc(
  bridge: DesktopSessionBridge,
  getWindow: () => BrowserWindow | undefined
): () => void {
  const ledger = new SnapshotDeliveryLedger()
  ipcMain.handle(IPC.getSnapshot, (event) => {
    assertTrustedSender(event, getWindow)
    const snapshot = bridge.getSnapshot()
    ledger.delivered(event.sender, snapshot)
    return snapshot
  })
  ipcMain.handle(IPC.sendMessage, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return bridge.sendMessage(sendInputOf(input))
  })
  const unsubscribe = bridge.subscribe((snapshot) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const contents = window.webContents
    contents.send(IPC.snapshot, stripKnownSections(snapshot, ledger.knownOf(contents)))
    ledger.delivered(contents, snapshot)
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.getSnapshot)
    ipcMain.removeHandler(IPC.sendMessage)
  }
}
