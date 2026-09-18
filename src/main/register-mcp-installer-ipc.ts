import { app, ipcMain, type BrowserWindow } from 'electron'
import type { SqliteTaskPoolRepository } from '../infrastructure/task-pool/sqlite-task-pool-repository'
import { CursorMcpInstaller } from '../infrastructure/cursor/cursor-mcp-installer'
import type { TeamControlService } from '../application/team-control-service'
import { IPC, type McpInstallationResult } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'
import { resolveTaskMcpServerPath } from './task-mcp-runtime'
import type { SqliteChannelMessageRepository } from '../infrastructure/channel-messages/sqlite-channel-message-repository'

/**
 * MCP 接入 IPC：通道服务器条目由启动时的全局 ~/.cursor/mcp.json 注册器承载，
 * 这里只负责按当前会话池登记 Agent 注册表并接管内嵌通道（渲染层在 createIndependentSessions 后立即调用）。
 */
export function registerMcpInstallerIpc(
  teamService: TeamControlService,
  repository: SqliteTaskPoolRepository,
  getWindow: () => BrowserWindow | undefined,
  channelMessages?: SqliteChannelMessageRepository
): () => void {
  ipcMain.handle(IPC.taskMcpInstall, async (event) => {
    assertTrustedSender(event, getWindow)
    const window = getWindow()
    if (!window) throw new Error('主窗口不可用')
    const team = teamService.getSnapshot()
    const run = team.activeRun
    const workspace = team.workspaces.find((item) => item.id === team.activeWorkspaceId)
    if (!run || !workspace) throw new Error('当前没有活动的会话池，请先在「运行」页创建')
    if (!team.members.length) throw new Error('当前会话池没有席位')
    if (team.members.some((member) => !member.slot.channelId)) throw new Error('存在尚未绑定通道的席位')

    const installChannels = team.members.map((member) => ({
      channelId: member.slot.channelId!,
      slotId: member.slot.id,
      capabilities: member.role.capabilities
    }))
    if (!installChannels.length) throw new Error('当前会话池没有可安装的通道')

    const result = new CursorMcpInstaller().install({
      workspacePath: workspace.path,
      channels: installChannels,
      command: process.execPath,
      serverPath: resolveTaskMcpServerPath({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath
      }),
      databasePath: repository.path,
      runId: run.id,
      activateAgents: (batch) => teamService.recordInstallation(batch)
    })
    // 一体化接管落成：SG Team 统一条目已指向拾光内嵌 server，
    // 登记内嵌通道，发送链路与活性投影自此改道 SQLite。
    if (channelMessages) {
      channelMessages.replaceEmbeddedChannels(
        result.workspaceId,
        result.workspacePath,
        result.registrations.agents.map((agent) => agent.channelId)
      )
    }
    const installation: McpInstallationResult = {
      workspacePath: result.workspacePath,
      workspaceId: result.workspaceId,
      runId: result.registrations.runId,
      serverNames: result.serverNames
    }
    return installation
  })

  return () => ipcMain.removeHandler(IPC.taskMcpInstall)
}
