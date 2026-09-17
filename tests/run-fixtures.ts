import { defaultGroupPlanPolicy, type TeamControlSnapshot, type TeamMemberRuntime, type TeamMemberView, type TeamRunStatus } from '../src/domain/team-control'
import { teamControlSnapshot } from '../src/renderer/src/preview/mock-data'

/** 席位运行形态：与服务端守卫口径一致（在岗 / 执行租约 / 离线 / 无证据）。 */
export type SeatShape = 'waiting' | 'working' | 'awaiting' | 'offline' | 'unconfirmed'

export function runtimeOf(shape: SeatShape, channelId: string): TeamMemberRuntime | undefined {
  if (shape === 'unconfirmed') return undefined
  const base = { channelId, queueDepth: 0, lastSeenAt: Date.now() - 5_000, healthEvidence: [], workingFiles: [] }
  if (shape === 'waiting') return { ...base, status: 'waiting', online: true, waiting: true, connectionPhase: 'waiting' }
  if (shape === 'awaiting') return { ...base, status: 'running', online: true, awaitingUser: true, waiting: false, connectionPhase: 'processing' }
  // 执行租约：已取走消息、长任务期间心跳停刷（online=false）仍算在岗执行中。
  if (shape === 'working') return { ...base, status: 'running', online: false, waiting: false, connectionPhase: 'processing' }
  return { ...base, status: 'offline', online: false, waiting: false, connectionPhase: 'offline' }
}

/** 独立批次快照：按形态给每个独立席位一个运行态（团队席位一律剔除）。 */
export function independentTeam(shapes: SeatShape[], status: TeamRunStatus = 'running'): TeamControlSnapshot {
  const snapshot = structuredClone(teamControlSnapshot)
  const solo = snapshot.members.find((member) => member.slot.solo === true)!
  snapshot.activeRun = { ...snapshot.activeRun!, templateId: 'independent-session-v1', status }
  snapshot.members = shapes.map((shape, index): TeamMemberView => {
    const channelId = String(index + 1)
    return {
      ...solo,
      slot: { ...solo.slot, id: `slot:solo-${channelId}`, name: `独立席 ${channelId}`, channelId },
      binding: solo.binding ? { ...solo.binding, channelId } : undefined,
      runtime: runtimeOf(shape, channelId)
    }
  })
  return snapshot
}

/**
 * 会话池快照：`independentTeam` 之上把若干席位编进协作组（每组 = 成员通道 + 每人模板 + 可空 lead），
 * 并可附一个刚解散的组。返回 groupId 便于测试按 id 定位。
 */
export function pooledTeam(
  shapes: SeatShape[],
  groups: Array<{ name: string; goal?: string; members: Array<{ channelId: string; roleTemplateKey: string; roleName: string }>; leadChannelId?: string; attention?: boolean }>,
  options: { dissolved?: { name: string; goal?: string }; status?: TeamRunStatus } = {}
): TeamControlSnapshot & { groupIds: string[] } {
  const snapshot = independentTeam(shapes, options.status)
  const now = Date.now()
  const groupIds: string[] = []
  snapshot.groups = groups.map((group, index) => {
    const groupId = `team-group:wedge-demo:g${index + 1}`
    groupIds.push(groupId)
    const members = group.members.map((config, order) => {
      const member = snapshot.members.find((candidate) => candidate.slot.channelId === config.channelId)!
      const role = { ...member.role, id: `team-role:${groupId}:${member.slot.id}`, key: `g${index + 1}:${config.roleTemplateKey}`, templateKey: config.roleTemplateKey, name: config.roleName, groupId, order }
      const grouped: TeamMemberView = { ...member, role, slot: { ...member.slot, solo: false, groupId, roleId: role.id, homeRoleId: member.slot.roleId, groupJoinedAt: now - 60_000 } }
      snapshot.members = snapshot.members.map((candidate) => candidate.slot.id === grouped.slot.id ? grouped : candidate)
      return grouped
    })
    const leadSlotId = group.leadChannelId ? members.find((member) => member.slot.channelId === group.leadChannelId)?.slot.id : undefined
    return {
      group: { id: groupId, runId: snapshot.activeRun!.id, name: group.name, goal: group.goal ?? '', status: 'active', leadSlotId, planPolicy: defaultGroupPlanPolicy(leadSlotId), createdAt: now - 120_000, updatedAt: now - 60_000 },
      members,
      effectiveLeadSlotId: leadSlotId,
      attention: group.attention ?? false
    }
  })
  if (options.dissolved) {
    const groupId = `team-group:wedge-demo:dissolved`
    groupIds.push(groupId)
    snapshot.groups.push({
      group: { id: groupId, runId: snapshot.activeRun!.id, name: options.dissolved.name, goal: options.dissolved.goal ?? '', status: 'dissolved', planPolicy: 'lead_only', createdAt: now - 300_000, updatedAt: now - 30_000, dissolvedAt: now - 30_000 },
      members: [],
      effectiveLeadSlotId: undefined,
      attention: false
    })
  }
  snapshot.slots = snapshot.members.map((member) => member.slot)
  snapshot.roles = [...snapshot.roles, ...snapshot.members.filter((member) => member.slot.groupId).map((member) => member.role)]
  return Object.assign(snapshot, { groupIds })
}

/** 团队快照：所有席位按同一形态；独立席位保留在快照里（页面必须自己过滤掉）。 */
export function teamRun(shape: SeatShape, status: TeamRunStatus = 'running'): TeamControlSnapshot {
  const snapshot = structuredClone(teamControlSnapshot)
  snapshot.activeRun = { ...snapshot.activeRun!, status }
  snapshot.members = snapshot.members.map((member) => ({
    ...member,
    runtime: runtimeOf(shape, member.slot.channelId ?? '9')
  }))
  return snapshot
}
