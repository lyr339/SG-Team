import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamGroupService } from '../application/team-group-service'
import type { PlanTaskInput } from '../domain/task-pool'
import { TEAM_ROLE_TEMPLATES, type TeamGroupPlanPolicy } from '../domain/team-control'
import { IPC, type TeamGroupMemberInput } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

const GROUP_MEMBERS_MAX = 64
const GROUP_NAME_MAX = 80
const GROUP_GOAL_MAX = 8_000
const PLAN_TASKS_MAX = 30
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

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${field}无效`)
  return value
}

function optionalStringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field}无效`)
  return value.map((item) => requiredString(item, field, maxLength))
}

/** 任务清单：字段与 `team_task plan` 的 zod schema 同界（key / title 必填，其余可选），业务校验交给聚合与 TeamGroupService。 */
function planTasksOf(value: unknown): PlanTaskInput[] {
  if (!Array.isArray(value) || !value.length || value.length > PLAN_TASKS_MAX) throw new Error('任务清单无效')
  return value.map((item) => {
    const raw = objectOf(item, '任务')
    const task: PlanTaskInput = {
      key: requiredString(raw.key, '任务 key', 160),
      title: requiredString(raw.title, '任务标题', 160)
    }
    const description = optionalText(raw.description, '任务描述', 8_000)
    const acceptance = optionalText(raw.acceptance, '验收标准', 4_000)
    const priority = optionalInteger(raw.priority, '优先级', 0, 3)
    const maxAttempts = optionalInteger(raw.maxAttempts, '最大尝试次数', 1, 10)
    const dependsOn = optionalStringList(raw.dependsOn, '依赖任务', 30, 160)
    const requiredCapabilities = optionalStringList(raw.requiredCapabilities, '所需能力', 32, 80)
    const targetSlotId = raw.targetSlotId === undefined || raw.targetSlotId === null
      ? undefined
      : requiredString(raw.targetSlotId, '目标席位', 240)
    if (description !== undefined) task.description = description
    if (acceptance !== undefined) task.acceptance = acceptance
    if (priority !== undefined) task.priority = priority
    if (maxAttempts !== undefined) task.maxAttempts = maxAttempts
    if (dependsOn !== undefined) task.dependsOn = dependsOn
    if (requiredCapabilities !== undefined) task.requiredCapabilities = requiredCapabilities
    if (targetSlotId !== undefined) task.targetSlotId = targetSlotId
    return task
  })
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
  // 规划任务不改成员关系，不受一键会话创建阻塞：任务只是入池，派单由编排器在成员就绪后进行。
  ipcMain.handle(IPC.teamGroupPlanTasks, (event, value: unknown) => {
    assertTrustedSender(event, getWindow)
    const raw = objectOf(value, '规划任务参数')
    return service.planGroupTasks({
      groupId: requiredString(raw.groupId, '协作组 id', 240),
      tasks: planTasksOf(raw.tasks)
    })
  })
  return () => {
    ipcMain.removeHandler(IPC.teamGroupCreate)
    ipcMain.removeHandler(IPC.teamGroupAddMembers)
    ipcMain.removeHandler(IPC.teamGroupRemoveMember)
    ipcMain.removeHandler(IPC.teamGroupSetLead)
    ipcMain.removeHandler(IPC.teamGroupUpdateGoal)
    ipcMain.removeHandler(IPC.teamGroupSetPlanPolicy)
    ipcMain.removeHandler(IPC.teamGroupDissolve)
    ipcMain.removeHandler(IPC.teamGroupPlanTasks)
  }
}
