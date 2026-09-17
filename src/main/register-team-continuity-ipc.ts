import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamControlService } from '../application/team-control-service'
import type { TeamGroupService } from '../application/team-group-service'
import {
  transferMembershipWithContext,
  type MembershipTransferWithContextPorts
} from '../application/manual-handoff-with-context'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

/**
 * 连续性 IPC：成员身份迁移入口（快照读取由恢复流程在主进程内部完成，
 * 自动检查点由 TeamContinuityService 自身的 watcher 驱动，均不经渲染层）。
 * 「同时交接上下文文档」在主进程内与迁移串成一次调用（见 transferMembershipWithContext）。
 */
export function registerTeamContinuityIpc(
  groups: TeamGroupService,
  team: TeamControlService,
  getWindow: () => BrowserWindow | undefined,
  sessionHandoff: MembershipTransferWithContextPorts['handoff']
): () => void {
  ipcMain.handle(IPC.teamContinuityHandoffOptions, (event, slotId: unknown) => {
    assertTrustedSender(event, getWindow)
    if (typeof slotId !== 'string' || !slotId.trim() || slotId.length > 240) throw new Error('AgentSlot 无效')
    return groups.membershipTransferOptions(slotId)
  })
  ipcMain.handle(IPC.teamContinuityHandoff, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    if (!value || typeof value !== 'object') throw new Error('迁移参数无效')
    const input = value as Record<string, unknown>
    const validId = (candidate: unknown): candidate is string =>
      typeof candidate === 'string' && Boolean(candidate.trim()) && candidate.length <= 240
    if (!validId(input.groupId) || !validId(input.fromSlotId) || !validId(input.toSlotId)
      || (input.includeContext !== undefined && typeof input.includeContext !== 'boolean')) {
      throw new Error('迁移参数无效')
    }
    const outcome = transferMembershipWithContext(
      { groups, team, handoff: sessionHandoff },
      {
        groupId: input.groupId,
        fromSlotId: input.fromSlotId,
        toSlotId: input.toSlotId,
        includeContext: input.includeContext === true
      }
    )
    return { ...outcome, team: team.getSnapshot() }
  })

  return () => {
    ipcMain.removeHandler(IPC.teamContinuityHandoffOptions)
    ipcMain.removeHandler(IPC.teamContinuityHandoff)
  }
}
