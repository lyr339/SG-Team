import { dialog, ipcMain, type BrowserWindow } from 'electron'
import type { TeamControlService } from '../application/team-control-service'
import type { DesktopSessionBridge } from '../application/desktop-session-service'
import { workspaceIdentityOf } from '../infrastructure/cursor/workspace-identity'
import type { TeamControlSnapshot } from '../domain/team-control'
import { IPC, type CreateIndependentSessionsInput } from '../shared/desktop-api'
import type { CursorModelSelection } from '../domain/cursor-model'
import { resolveIndependentSessionMembers } from '../application/team-setup'
import { assertTrustedSender } from './ipc-security'
import type { CursorWorkspaceDetection } from '../domain/cursor-workspace'

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} 无效`)
  }
  return value.trim()
}

export interface TeamControlIpcOptions {
  onRunEnded?: (snapshot: TeamControlSnapshot) => void | Promise<void>
  /** Cursor 当前 IDE 窗口的工作区（CDP 读窗口配置）：展示与创建前核对的唯一来源。 */
  detectCurrentWorkspace: () => Promise<CursorWorkspaceDetection>
  /** 一键会话创建是否仍在进行：创建/替换 run 期间换拓扑会让编排器对着错误的席位收尾。 */
  isSessionLaunchRunning?: () => boolean
}

/**
 * 会话池的池级 IPC（阶段 2 · 2B 起没有团队 run 的组队 / 启动 / 新一轮 / 运行目标）：
 * 读快照、识别 Cursor 工程、新建独立批次（会话池）、结束池、席位模型配置。
 * 组的建拆与目标在 `register-team-group-ipc.ts`。
 */
export function registerTeamControlIpc(
  service: TeamControlService,
  bridge: Pick<DesktopSessionBridge, 'getSnapshot'>,
  getWindow: () => BrowserWindow | undefined,
  options: TeamControlIpcOptions
): () => void {
  const assertNoSessionLaunch = (): void => {
    if (options.isSessionLaunchRunning?.()) {
      throw new Error('一键会话创建正在进行，请等待其完成后再替换或结束运行')
    }
  }

  ipcMain.handle(IPC.teamControlGet, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getSnapshot()
  })
  ipcMain.handle(IPC.teamControlDetectWorkspace, (event) => {
    assertTrustedSender(event, getWindow)
    return options.detectCurrentWorkspace()
  })
  ipcMain.handle(IPC.teamControlCreateIndependent, async (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('独立会话参数无效')
    const input = value as Partial<CreateIndependentSessionsInput>
    assertNoSessionLaunch()
    const workspacePath = requiredString(input.workspacePath, '工作区路径', 2_000)
    const workspace = workspaceIdentityOf(workspacePath)
    // 在替换旧 run / 签发新身份之前核对窗口；检测过程不产生业务写入。
    const detected = await options.detectCurrentWorkspace()
    if (detected.state !== 'detected' || !detected.workspace) throw new Error(detected.detail)
    if (detected.workspace.id !== workspace.id) {
      throw new Error(`Cursor 当前工程为「${detected.workspace.name}」，创建配置仍为「${workspace.name}」。请按当前工程重新发起；原批次已保留。`)
    }
    assertNoSessionLaunch()
    const members = resolveIndependentSessionMembers(
      bridge.getSnapshot().cursorModels ?? [],
      input as CreateIndependentSessionsInput
    )
    return service.createSessionPool({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      members
    })
  })
  ipcMain.handle(IPC.teamControlChooseIndependentWorkspace, async (event) => {
    assertTrustedSender(event, getWindow)
    const window = getWindow()
    if (!window) throw new Error('主窗口不可用')
    const selection = await dialog.showOpenDialog(window, {
      title: '选择独立会话使用的 Cursor 工作区',
      properties: ['openDirectory', 'createDirectory']
    })
    return selection.canceled || !selection.filePaths[0]
      ? undefined
      : workspaceIdentityOf(selection.filePaths[0])
  })
  ipcMain.handle(IPC.teamControlEndRun, async (event) => {
    assertTrustedSender(event, getWindow)
    assertNoSessionLaunch()
    const snapshot = service.endActiveRun()
    await options.onRunEnded?.(snapshot)
    return snapshot
  })
  ipcMain.handle(IPC.teamControlSetSlotModelSelection, (event, channelId: unknown, selection: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.setSlotModelSelection(requiredString(channelId, '通道号', 12), selection as CursorModelSelection)
  })

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.teamControlSnapshot, snapshot)
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.teamControlGet)
    ipcMain.removeHandler(IPC.teamControlDetectWorkspace)
    ipcMain.removeHandler(IPC.teamControlCreateIndependent)
    ipcMain.removeHandler(IPC.teamControlChooseIndependentWorkspace)
    ipcMain.removeHandler(IPC.teamControlEndRun)
    ipcMain.removeHandler(IPC.teamControlSetSlotModelSelection)
  }
}
