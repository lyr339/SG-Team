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
    dissolveGroup: record('dissolveGroup')
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
      name: '验收组', goal: '目标', leadSlotId: 'slot-1',
      members: [{ slotId: 'slot-1', roleTemplateKey: 'lead' }, { slotId: 'slot-2', roleTemplateKey: 'builder' }]
    }])
    // lead 可省略 / 为 null；目标可省略。
    invoke(IPC.teamGroupCreate, { name: 'G', members: [{ slotId: 'slot-1', roleTemplateKey: 'specialist' }], leadSlotId: null })
    expect(calls.at(-1)).toEqual(['createGroup', { name: 'G', goal: undefined, leadSlotId: undefined, members: [{ slotId: 'slot-1', roleTemplateKey: 'specialist' }] }])

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

    // 形状校验在 IPC 层就拒绝：不到服务。
    const before = calls.length
    expect(() => invoke(IPC.teamGroupCreate, 'garbage')).toThrowError(/建组参数无效/)
    expect(() => invoke(IPC.teamGroupCreate, { name: '', members: [{ slotId: 'slot-1', roleTemplateKey: 'lead' }] })).toThrowError(/协作组名称无效/)
    expect(() => invoke(IPC.teamGroupCreate, { name: 'G', members: [] })).toThrowError(/组成员列表无效/)
    expect(() => invoke(IPC.teamGroupCreate, { name: 'G', members: [{ slotId: 'slot-1', roleTemplateKey: 'wizard' }] })).toThrowError(/未知团队角色模板：wizard/)
    expect(() => invoke(IPC.teamGroupCreate, { name: 'G', members: [{ slotId: '', roleTemplateKey: 'lead' }] })).toThrowError(/席位 id无效/)
    expect(() => invoke(IPC.teamGroupCreate, { name: 'G', goal: 'x'.repeat(8_001), members: [{ slotId: 'slot-1', roleTemplateKey: 'lead' }] })).toThrowError(/组目标无效/)
    expect(() => invoke(IPC.teamGroupRemoveMember, { groupId: 'g-1' })).toThrowError(/席位 id无效/)
    expect(() => invoke(IPC.teamGroupSetLead, { groupId: 'g-1', slotId: 42 })).toThrowError(/lead 席位无效/)
    expect(() => invoke(IPC.teamGroupDissolve, {})).toThrowError(/协作组 id无效/)
    expect(calls).toHaveLength(before)

    dispose()
    for (const channel of [
      IPC.teamGroupCreate, IPC.teamGroupAddMembers, IPC.teamGroupRemoveMember,
      IPC.teamGroupSetLead, IPC.teamGroupUpdateGoal, IPC.teamGroupDissolve
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
      [IPC.teamGroupDissolve, { groupId: 'g-1' }]
    ]
    for (const [channel, payload] of payloads) {
      expect(() => invoke(channel, payload)).toThrowError(/一键会话创建正在进行/)
    }
    expect(calls).toEqual([])
    dispose()
  })
})
