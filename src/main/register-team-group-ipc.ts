import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamGroupService } from '../application/team-group-service'
import { TEAM_ROLE_TEMPLATES, type TeamGroupPlanPolicy } from '../domain/team-control'
import { IPC, type TeamGroupMemberInput } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

const GROUP_MEMBERS_MAX = 64
const GROUP_NAME_MAX = 80
const GROUP_GOAL_MAX = 8_000
const ROLE_TEMPLATE_KEYS = new Set(TEAM_ROLE_TEMPLATES.map((template) => template.key))

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}无效`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field}无效`)
  }
  return value.trim()
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${field}无效`)
  return value
}

function optionalPlanPolicy(value: unknown): TeamGroupPlanPolicy | undefined {
  if (value === undefined || value === null) return undefined
  return requiredPlanPolicy(value)
}

function requiredPlanPolicy(value: unknown): TeamGroupPlanPolicy {
  if (value === 'lead_only' || value === 'any_member') return value
  throw new Error('规划策略无效')
}

/** 组内角色模板：只认 TEAM_ROLE_TEMPLATES 里的键；solo 由 domain 再拒（`group_role_solo_forbidden`）。 */
function membersOf(value: unknown): TeamGroupMemberInput[] {
  if (!Array.isArray(value) || !value.length || value.length > GROUP_MEMBERS_MAX) throw new Error('组成员列表无效')
  return value.map((item) => {
    const raw = objectOf(item, '组成员')
    const roleTemplateKey = requiredString(raw.roleTemplateKey, '组内角色模板', 40)
    if (!ROLE_TEMPLATE_KEYS.has(roleTemplateKey)) throw new Error(`未知团队角色模板：${roleTemplateKey}`)
    return { slotId: requiredString(raw.slotId, '席位 id', 240), roleTemplateKey }
  })
}

export interface TeamGroupIpcOptions {
  /** 一键会话创建进行中不得改成员关系：新席位的注册与绑定尚未落定。 */
  isSessionLaunchRunning?: () => boolean
}

/**
 * 会话池 · 协作组的 IPC 面（任务书 §5.7 + 阶段 2 · 2A 的规划策略）：成员关系操作全部只做形状校验后交给
 * TeamGroupService；业务校验（池状态、席位归属、lead 规则）在仓储事务里，以异常传播给渲染层。
 * 快照推送仍走 team-control 的订阅通道（成员关系变化会推进 team-control revision）。
 */
export function registerTeamGroupIpc(
  service: TeamGroupService,
  getWindow: () => BrowserWindow | undefined,
  options: TeamGroupIpcOptions = {}
): () => void {
  const assertNoSessionLaunch = (): void => {
    if (options.isSessionLaunchRunning?.()) {
      throw new Error('一键会话创建正在进行，请等待其完成后再变更协作组')
    }
  }
  ipcMain.handle(IPC.teamGroupCreate, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    assertNoSessionLaunch()
    const raw = objectOf(value, '建组参数')
    return service.createGroup({
      name: requiredString(raw.name, '协作组名称', GROUP_NAME_MAX),
      goal: optionalText(raw.goal, '组目标', GROUP_GOAL_MAX),
      members: membersOf(raw.members),
      leadSlotId: raw.leadSlotId === undefined || raw.leadSlotId === null
        ? undefined
        : requiredString(raw.leadSlotId, 'lead 席位', 240),
      planPolicy: optionalPlanPolicy(raw.planPolicy)
    })
  })
  ipcMain.handle(IPC.teamGroupAddMembers, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    assertNoSessionLaunch()
    const raw = objectOf(value, '加人参数')
    return service.addGroupMembers({
      groupId: requiredString(raw.groupId, '协作组 id', 240),
      members: membersOf(raw.members)
    })
  })
  ipcMain.handle(IPC.teamGroupRemoveMember, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    assertNoSessionLaunch()
    const raw = objectOf(value, '移出参数')
    return service.removeGroupMember({
      groupId: requiredString(raw.groupId, '协作组 id', 240),
      slotId: requiredString(raw.slotId, '席位 id', 240)
    })
  })
  ipcMain.handle(IPC.teamGroupSetLead, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    assertNoSessionLaunch()
    const raw = objectOf(value, '换 lead 参数')
    return service.setGroupLead({
      groupId: requiredString(raw.groupId, '协作组 id', 240),
      slotId: raw.slotId === null || raw.slotId === undefined ? null : requiredString(raw.slotId, 'lead 席位', 240)
    })
  })
  ipcMain.handle(IPC.teamGroupUpdateGoal, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    assertNoSessionLaunch()
    const raw = objectOf(value, '组目标参数')
    return service.updateGroupGoal({
      groupId: requiredString(raw.groupId, '协作组 id', 240),
      goal: optionalText(raw.goal, '组目标', GROUP_GOAL_MAX) ?? ''
    })
  })
  ipcMain.handle(IPC.teamGroupSetPlanPolicy, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    assertNoSessionLaunch()
    const raw = objectOf(value, '规划策略参数')
    return service.setGroupPlanPolicy({
      groupId: requiredString(raw.groupId, '协作组 id', 240),
      planPolicy: requiredPlanPolicy(raw.planPolicy)
    })
  })
  ipcMain.handle(IPC.teamGroupDissolve, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    assertNoSessionLaunch()
    const raw = objectOf(value, '解散参数')
    return service.dissolveGroup({ groupId: requiredString(raw.groupId, '协作组 id', 240) })
  })
  return () => {
    ipcMain.removeHandler(IPC.teamGroupCreate)
    ipcMain.removeHandler(IPC.teamGroupAddMembers)
    ipcMain.removeHandler(IPC.teamGroupRemoveMember)
    ipcMain.removeHandler(IPC.teamGroupSetLead)
    ipcMain.removeHandler(IPC.teamGroupUpdateGoal)
    ipcMain.removeHandler(IPC.teamGroupSetPlanPolicy)
    ipcMain.removeHandler(IPC.teamGroupDissolve)
  }
}
