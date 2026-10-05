import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamMemoryService } from '../application/team-memory-service'
import type { TeamControlSnapshot } from '../domain/team-control'
import type { TeamMemoryInspectionRequest, TeamMemoryInspection } from '../domain/team-memory-inspection'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'
function requestOf(value: unknown): TeamMemoryInspectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('记忆查看参数无效')
  const raw = value as Record<string, unknown>
  for (const key of ['workspaceId', 'runId', 'memoryId'])
    if (typeof raw[key] !== 'string' || !(raw[key] as string).trim() || (raw[key] as string).length > 300) throw Error('记忆查看身份无效')
  if (
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 1 ||
    (raw.groupId !== undefined && (typeof raw.groupId !== 'string' || !raw.groupId || raw.groupId.length > 300))
  )
    throw Error('记忆查看范围无效')
  return {
    workspaceId: raw.workspaceId as string,
    runId: raw.runId as string,
    memoryId: raw.memoryId as string,
    version: raw.version as number,
    ...(raw.groupId ? { groupId: raw.groupId as string } : {})
  }
}
/** Explicit human read only. It never creates/reviews memory or sends an Agent receipt. */
export function registerTeamMemoryInspectionIpc(
  memory: Pick<TeamMemoryService, 'getSnapshot'>,
  getTeam: () => TeamControlSnapshot,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.teamMemoryInspect, (event, input): TeamMemoryInspection => {
    assertTrustedSender(event, getWindow)
    const request = requestOf(input),
      team = getTeam()
    if (
      team.activeWorkspaceId !== request.workspaceId ||
      team.activeRun?.id !== request.runId ||
      (request.groupId && !team.groups.some((view) => view.group.id === request.groupId && view.group.runId === request.runId))
    )
      throw Error('记忆原运行范围已变化，原通知仍可查看')
    const snapshot = memory.getSnapshot(),
      item = snapshot.items[request.memoryId]
    if (
      snapshot.workspaceId !== request.workspaceId ||
      snapshot.runId !== request.runId ||
      !item ||
      item.workspaceId !== request.workspaceId ||
      item.runId !== request.runId ||
      item.version !== request.version ||
      item.groupId !== request.groupId
    )
      throw Error('这项原记忆已不在当前查看范围')
    return {
      item,
      ...(item.supersedesId && snapshot.items[item.supersedesId] ? { predecessor: snapshot.items[item.supersedesId] } : {}),
      revision: snapshot.revision,
      observedAt: Date.now()
    }
  })
  return () => {
    ipcMain.removeHandler(IPC.teamMemoryInspect)
  }
}
