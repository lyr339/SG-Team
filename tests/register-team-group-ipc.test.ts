import { describe, expect, it, vi } from 'vitest'
import type { TeamGroupService } from '../src/application/team-group-service'
import { registerTeamGroupIpc } from '../src/main/register-team-group-ipc'
import { IPC } from '../src/shared/desktop-api'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name)
  }
}))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: vi.fn() }))

function fakeService() {
  const calls: Array<[string, unknown]> = []
  const snapshot = { tag: 'snapshot' }
  const record = (name: string) => (input: unknown) => {
    calls.push([name, input])
    return snapshot
  }
  const service = {
    createGroup: record('createGroup'),
    addGroupMembers: record('addGroupMembers'),
    removeGroupMember: record('removeGroupMember'),
    setGroupLead: record('setGroupLead'),
    updateGroupGoal: record('updateGroupGoal'),
    setGroupPlanPolicy: record('setGroupPlanPolicy'),
    dissolveGroup: record('dissolveGroup'),
    planGroupTasks: record('planGroupTasks')
  } as unknown as TeamGroupService
  return { service, calls, snapshot }
}

describe('协作组 IPC', () => {
  it('normalizes and validates the six membership operations before handing them to the service', () => {
    handlers.clear()
    const { service, calls, snapshot } = fakeService()
    const dispose = registerTeamGroupIpc(service, () => undefined)
    const invoke = (channel: string, payload?: unknown): unknown => handlers.get(channel)!({ senderFrame: null }, payload)

    expect(invoke(IPC.teamGroupCreate, {
      name: '  验收组 ', goal: '目标', leadSlotId: 'slot-1',
      members: [{ slotId: ' slot-1 ', roleTemplateKey: 'lead' }, { slotId: 'slot-2', roleTemplateKey: 'builder' }]
    })).toBe(snapshot)
    expect(calls.at(-1)).toEqual(['createGroup', {
      name: '验收组', goal: '目标', leadSlotId: 'slot-1', planPolicy: undefined,
      members: [{ slotId: 'slot-1', roleTemplateKey: 'lead' }, { slotId: 'slot-2', roleTemplateKey: 'builder' }]
    }])
    // lead 可省略 / 为 null；目标可省略；规划策略可省略（服务按 lead 取默认）或显式给出。
    invoke(IPC.teamGroupCreate, { name: 'G', members: [{ slotId: 'slot-1', roleTemplateKey: 'specialist' }], leadSlotId: null })
    expect(calls.at(-1)).toEqual(['createGroup', { name: 'G', goal: undefined, leadSlotId: undefined, planPolicy: undefined, members: [{ slotId: 'slot-1', roleTemplateKey: 'specialist' }] }])
    invoke(IPC.teamGroupCreate, { name: 'G', members: [{ slotId: 'slot-1', roleTemplateKey: 'specialist' }], planPolicy: 'lead_only' })
    expect(calls.at(-1)?.[1]).toMatchObject({ planPolicy: 'lead_only' })
    invoke(IPC.teamGroupSetPlanPolicy, { groupId: 'g-1', planPolicy: 'any_member' })
    expect(calls.at(-1)).toEqual(['setGroupPlanPolicy', { groupId: 'g-1', planPolicy: 'any_member' }])

    invoke(IPC.teamGroupAddMembers, { groupId: 'g-1', members: [{ slotId: 'slot-3', roleTemplateKey: 'reviewer' }] })
    expect(calls.at(-1)).toEqual(['addGroupMembers', { groupId: 'g-1', members: [{ slotId: 'slot-3', roleTemplateKey: 'reviewer' }] }])
    invoke(IPC.teamGroupRemoveMember, { groupId: 'g-1', slotId: 'slot-3' })
    expect(calls.at(-1)).toEqual(['removeGroupMember', { groupId: 'g-1', slotId: 'slot-3' }])
    invoke(IPC.teamGroupSetLead, { groupId: 'g-1', slotId: 'slot-2' })
    expect(calls.at(-1)).toEqual(['setGroupLead', { groupId: 'g-1', slotId: 'slot-2' }])
    invoke(IPC.teamGroupSetLead, { groupId: 'g-1', slotId: null })
    expect(calls.at(-1)).toEqual(['setGroupLead', { groupId: 'g-1', slotId: null }])
    invoke(IPC.teamGroupUpdateGoal, { groupId: 'g-1', goal: '' })
    expect(calls.at(-1)).toEqual(['updateGroupGoal', { groupId: 'g-1', goal: '' }])
    invoke(IPC.teamGroupDissolve, { groupId: 'g-1' })
    expect(calls.at(-1)).toEqual(['dissolveGroup', { groupId: 'g-1' }])
    // 规划任务：key / title 必填、其余可选字段按 team_task plan 的界限透传，未给的字段不出现。
    invoke(IPC.teamGroupPlanTasks, {
      groupId: 'g-1',
      tasks: [
        { key: ' impl ', title: '实现', description: '边界', acceptance: '测试通过', priority: 1, maxAttempts: 2, dependsOn: [], requiredCapabilities: ['code'], targetSlotId: 'slot-2' },
        { key: 'verify', title: '验证', dependsOn: ['impl'], targetSlotId: null }
      ]
    })
    expect(calls.at(-1)).toEqual(['planGroupTasks', {
      groupId: 'g-1',
      tasks: [
        { key: 'impl', title: '实现', description: '边界', acceptance: '测试通过', priority: 1, maxAttempts: 2, dependsOn: [], requiredCapabilities: ['code'], targetSlotId: 'slot-2' },
        { key: 'verify', title: '验证', dependsOn: ['impl'] }
      ]
    }])

    // 形状校验在 IPC 层就拒绝：不到服务。
    const before = calls.length
    expect(() => invoke(IPC.teamGroupPlanTasks, { groupId: 'g-1', tasks: [] })).toThrowError(/任务清单无效/)
    expect(() => invoke(IPC.teamGroupPlanTasks, { groupId: 'g-1', tasks: [{ key: 'k' }] })).toThrowError(/任务标题无效/)
    expect(() => invoke(IPC.teamGroupPlanTasks, { groupId: 'g-1', tasks: [{ key: 'k', title: 't', priority: 9 }] })).toThrowError(/优先级无效/)
    expect(() => invoke(IPC.teamGroupPlanTasks, { groupId: 'g-1', tasks: [{ key: 'k', title: 't', requiredCapabilities: 'code' }] })).toThrowError(/所需能力无效/)
    expect(() => invoke(IPC.teamGroupPlanTasks, { groupId: 'g-1', tasks: Array.from({ length: 31 }, (_, index) => ({ key: `k${index}`, title: 't' })) })).toThrowError(/任务清单无效/)
    expect(() => invoke(IPC.teamGroupCreate, 'garbage')).toThrowError(/建组参数无效/)
    expect(() => invoke(IPC.teamGroupCreate, { name: '', members: [{ slotId: 'slot-1', roleTemplateKey: 'lead' }] })).toThrowError(/协作组名称无效/)
    expect(() => invoke(IPC.teamGroupCreate, { name: 'G', members: [] })).toThrowError(/组成员列表无效/)
    expect(() => invoke(IPC.teamGroupCreate, { name: 'G', members: [{ slotId: 'slot-1', roleTemplateKey: 'wizard' }] })).toThrowError(/未知团队角色模板：wizard/)
    expect(() => invoke(IPC.teamGroupCreate, { name: 'G', members: [{ slotId: '', roleTemplateKey: 'lead' }] })).toThrowError(/席位 id无效/)
    expect(() => invoke(IPC.teamGroupCreate, { name: 'G', goal: 'x'.repeat(8_001), members: [{ slotId: 'slot-1', roleTemplateKey: 'lead' }] })).toThrowError(/组目标无效/)
    expect(() => invoke(IPC.teamGroupRemoveMember, { groupId: 'g-1' })).toThrowError(/席位 id无效/)
    expect(() => invoke(IPC.teamGroupSetLead, { groupId: 'g-1', slotId: 42 })).toThrowError(/lead 席位无效/)
    expect(() => invoke(IPC.teamGroupDissolve, {})).toThrowError(/协作组 id无效/)
    expect(() => invoke(IPC.teamGroupCreate, { name: 'G', members: [{ slotId: 'slot-1', roleTemplateKey: 'lead' }], planPolicy: 'everyone' })).toThrowError(/规划策略无效/)
    expect(() => invoke(IPC.teamGroupSetPlanPolicy, { groupId: 'g-1' })).toThrowError(/规划策略无效/)
    expect(calls).toHaveLength(before)

    dispose()
    for (const channel of [
      IPC.teamGroupCreate, IPC.teamGroupAddMembers, IPC.teamGroupRemoveMember,
      IPC.teamGroupSetLead, IPC.teamGroupUpdateGoal, IPC.teamGroupSetPlanPolicy, IPC.teamGroupDissolve, IPC.teamGroupPlanTasks
    ]) expect(handlers.has(channel)).toBe(false)
  })

  it('blocks every membership change while a one-click session launch is still running', () => {
    handlers.clear()
    const { service, calls } = fakeService()
    const dispose = registerTeamGroupIpc(service, () => undefined, { isSessionLaunchRunning: () => true })
    const invoke = (channel: string, payload?: unknown): unknown => handlers.get(channel)!({ senderFrame: null }, payload)
    const payloads: Array<[string, unknown]> = [
      [IPC.teamGroupCreate, { name: 'G', members: [{ slotId: 'slot-1', roleTemplateKey: 'lead' }] }],
      [IPC.teamGroupAddMembers, { groupId: 'g-1', members: [{ slotId: 'slot-2', roleTemplateKey: 'builder' }] }],
      [IPC.teamGroupRemoveMember, { groupId: 'g-1', slotId: 'slot-2' }],
      [IPC.teamGroupSetLead, { groupId: 'g-1', slotId: null }],
      [IPC.teamGroupUpdateGoal, { groupId: 'g-1', goal: 'x' }],
      [IPC.teamGroupSetPlanPolicy, { groupId: 'g-1', planPolicy: 'any_member' }],
      [IPC.teamGroupDissolve, { groupId: 'g-1' }]
    ]
    for (const [channel, payload] of payloads) {
      expect(() => invoke(channel, payload)).toThrowError(/一键会话创建正在进行/)
    }
    expect(calls).toEqual([])
    // 规划任务不改成员关系，不受阻塞。
    invoke(IPC.teamGroupPlanTasks, { groupId: 'g-1', tasks: [{ key: 'k', title: 't' }] })
    expect(calls).toEqual([['planGroupTasks', { groupId: 'g-1', tasks: [{ key: 'k', title: 't' }] }]])
    dispose()
  })
})
