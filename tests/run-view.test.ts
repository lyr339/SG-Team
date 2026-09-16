import { describe, expect, it } from 'vitest'
import type { TeamControlSnapshot, TeamMemberRuntime, TeamMemberView, TeamRunStatus } from '../src/domain/team-control'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import {
  buildRunView,
  groupActionConsequence,
  replaceRunConsequence,
  seatStateOf
} from '../src/renderer/src/run/run-view'
import { teamControlSnapshot } from '../src/renderer/src/preview/mock-data'
import { pooledTeam } from './run-fixtures'

type SeatShape = 'waiting' | 'working' | 'awaiting' | 'offline' | 'unconfirmed'

function runtimeOf(shape: SeatShape, channelId: string): TeamMemberRuntime | undefined {
  if (shape === 'unconfirmed') return undefined
  const base = { channelId, queueDepth: 0, lastSeenAt: Date.now() - 5_000, healthEvidence: [], workingFiles: [] }
  if (shape === 'waiting') return { ...base, status: 'waiting', online: true, waiting: true, connectionPhase: 'waiting' }
  if (shape === 'awaiting') return { ...base, status: 'running', online: true, awaitingUser: true, waiting: false, connectionPhase: 'processing' }
  // 执行租约：已取走消息、长任务期间心跳停刷（online=false）仍算在岗执行中。
  if (shape === 'working') return { ...base, status: 'running', online: false, waiting: false, connectionPhase: 'processing' }
  return { ...base, status: 'offline', online: false, waiting: false, connectionPhase: 'offline' }
}

/** 会话池快照：按形态给每个独立席位一个运行态。 */
function independentTeam(shapes: SeatShape[], status: TeamRunStatus = 'running'): TeamControlSnapshot {
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

/** 升级前的一次性团队 run（mock-data 的基础快照就是一个）：阶段 2 · 2B 起只作归档展示。 */
function legacyTeamRun(shape: SeatShape, status: TeamRunStatus = 'completed'): TeamControlSnapshot {
  const snapshot = structuredClone(teamControlSnapshot)
  snapshot.activeRun = { ...snapshot.activeRun!, status }
  snapshot.members = snapshot.members.map((member) => ({
    ...member,
    runtime: runtimeOf(shape, member.slot.channelId ?? '9')
  }))
  return snapshot
}

describe('run view · seats', () => {
  it('maps runtime evidence to waiting / working / offline / unconfirmed like the server guard', () => {
    const team = independentTeam(['waiting', 'working', 'offline', 'unconfirmed'])
    expect(team.members.map(seatStateOf)).toEqual(['waiting', 'working', 'offline', 'unconfirmed'])
    const view = buildRunView(team)
    expect(view.run?.templateId).toBe('independent-session-v1')
    expect(view).toMatchObject({ phase: 'active', archivedLegacyTeam: false })
    // 执行中的席位不算待重建：它在干活，只是长任务期间心跳停刷。
    expect(view.seats.map((seat) => [seat.channelId, seat.state, seat.pending])).toEqual([
      ['1', 'waiting', false],
      ['2', 'working', false],
      ['3', 'offline', true],
      ['4', 'unconfirmed', true]
    ])
    // 软守卫口径：在线 / 执行中 / 尚无证据 都算 live；离线不算。
    expect(view.liveSeatCount).toBe(3)
    expect(view.evidencePending).toBe(true)
    expect(view.pendingSeats.map((seat) => seat.channelId)).toEqual(['3', '4'])
    expect(view.state).toMatchObject({ label: '待命 1 · 执行中 1', tone: 'neutral' })
  })

  it('surfaces a pending user decision as attention without treating the seat as offline or rebuildable', () => {
    const view = buildRunView(independentTeam(['awaiting', 'waiting']))
    expect(view.seats[0]).toMatchObject({ state: 'awaiting', pending: false })
    expect(view.liveSeatCount).toBe(2)
    expect(view.state).toMatchObject({ label: '等待回答 1 · 待命 1 · 执行中 0', tone: 'warning' })
  })

  it('reads the pool state chip from the seats', () => {
    expect(buildRunView(independentTeam(['waiting', 'waiting'])).state).toMatchObject({ label: '待命 2/2', tone: 'active' })
    expect(buildRunView(independentTeam(['waiting', 'unconfirmed'])).state).toMatchObject({ label: '待命 1/2', tone: 'neutral' })
    expect(buildRunView(independentTeam(['offline', 'offline'])).state).toMatchObject({ label: '全部离线', tone: 'warning' })
    expect(buildRunView(independentTeam([])).state).toMatchObject({ label: '空批次', tone: 'neutral' })
  })

  it('an ended run has no live seats and nothing pending to create', () => {
    const view = buildRunView(independentTeam(['waiting', 'unconfirmed'], 'completed'))
    expect(view.phase).toBe('completed')
    expect(view.liveSeatCount).toBe(0)
    expect(view.pendingSeats).toEqual([])
    expect(view.evidencePending).toBe(false)
    expect(view.state).toMatchObject({ label: '批次已结束', tone: 'muted' })
  })

  it('has no run and no seats before the first run', () => {
    const view = buildRunView(emptyTeamControlSnapshot())
    expect(view).toMatchObject({ phase: 'none', run: undefined, archivedLegacyTeam: false, seats: [], groups: [], liveSeatCount: 0 })
    expect(view.state.label).toBe('尚未开始运行')
  })

  it('treats an archived legacy team run as "no run": start page, one explanatory chip, no seats or groups (2B)', () => {
    for (const status of ['completed', 'running'] as const) {
      const view = buildRunView(legacyTeamRun('waiting', status))
      expect(view).toMatchObject({ phase: 'none', run: undefined, archivedLegacyTeam: true, seats: [], groups: [], ungroupedSeats: [], liveSeatCount: 0 })
      expect(view.state).toMatchObject({ label: '旧团队运行已归档', tone: 'muted' })
      expect(view.state.hint).toContain('独立批次')
    }
    // 工作区仍然是它的：新建批次的目标工程照常显示。
    expect(buildRunView(legacyTeamRun('waiting')).workspace?.id).toBe('wedge-demo')
  })

  it('flags a Cursor workspace switch relative to the run workspace', () => {
    expect(buildRunView(teamControlSnapshot, { id: 'wedge-demo', name: 'wedge-demo', path: '/x' }).cursorWorkspaceChanged).toBe(false)
    expect(buildRunView(teamControlSnapshot, { id: 'other', name: '新工程', path: '/y' }).cursorWorkspaceChanged).toBe(true)
  })
})

describe('run view · one consequence template for every destructive action', () => {
  it('asks for confirmation only while seats are live, and always states the fence consequence', () => {
    const live = buildRunView(independentTeam(['waiting', 'working', 'unconfirmed', 'offline']))
    const end = replaceRunConsequence(live, { kind: 'end' })
    expect(end).toMatchObject({ title: '结束当前独立批次', confirmLabel: '确认结束', needsConfirm: true })
    expect(end.body).toContain('3 个会话仍在线或待确认')
    expect(end.body).toContain('下一次轮询（最长 60 秒）收到结束指令并自行退出')
    expect(end.body).toContain('尚未取走的排队消息将归档')

    const offline = buildRunView(independentTeam(['offline', 'offline']))
    expect(replaceRunConsequence(offline, { kind: 'end' })).toMatchObject({ needsConfirm: false })
    expect(replaceRunConsequence(offline, { kind: 'end' }).body).toContain('所有会话已离线')
    expect(replaceRunConsequence(offline, { kind: 'new-batch' }).body).toContain('所有会话已离线')
  })

  it('describes a new batch in terms of the current run', () => {
    const independent = buildRunView(independentTeam(['waiting']))
    const newBatch = replaceRunConsequence(independent, { kind: 'new-batch', targetWorkspaceName: '新工程 B' })
    expect(newBatch).toMatchObject({ title: '在「新工程 B」新建批次', confirmLabel: '确认新建', needsConfirm: true })
    expect(newBatch.body).toContain('当前批次会结束')
    expect(replaceRunConsequence(independent, { kind: 'new-batch' }).title).toBe('新建独立批次')
  })

  it('never asks for confirmation once the run has ended', () => {
    const ended = buildRunView(independentTeam(['waiting', 'waiting'], 'completed'))
    expect(replaceRunConsequence(ended, { kind: 'end' }).needsConfirm).toBe(false)
    expect(replaceRunConsequence(ended, { kind: 'new-batch' }).needsConfirm).toBe(false)
  })
})

describe('run view · 会话池的协作组', () => {
  const pool = () => pooledTeam(
    ['waiting', 'working', 'waiting', 'offline', 'waiting'],
    [
      { name: '接口重构', goal: '收口查询路径', members: [
        { channelId: '1', roleTemplateKey: 'lead', roleName: '主控协调' },
        { channelId: '2', roleTemplateKey: 'builder', roleName: '架构实现' }
      ], leadChannelId: '1' },
      { name: '验收', members: [
        { channelId: '3', roleTemplateKey: 'lead', roleName: '主控协调' },
        { channelId: '4', roleTemplateKey: 'reviewer', roleName: '质量验证' }
      ], leadChannelId: '3', attention: true }
    ],
    { dissolved: { name: '文档整理' } }
  )

  it('keeps grouped seats on the run page (they are still pool members) and labels them with their group', () => {
    const view = buildRunView(pool())
    expect(view).toMatchObject({ phase: 'active', archivedLegacyTeam: false })
    expect(view.seats.map((seat) => [seat.channelId, seat.solo, seat.groupName ?? null, seat.roleName])).toEqual([
      ['1', false, '接口重构', '主控协调'],
      ['2', false, '接口重构', '架构实现'],
      ['3', false, '验收', '主控协调'],
      ['4', false, '验收', '质量验证'],
      ['5', true, null, expect.any(String)]
    ])
    // 批次概况与在线数把入组席位一并计入。
    expect(view.liveSeatCount).toBe(4)
    expect(view.state.label).toBe('待命 3 · 执行中 1')
  })

  it('projects the group cards, lead marks, attention and the ungrouped candidates', () => {
    const snapshot = pool()
    const view = buildRunView(snapshot)
    expect(view.groups.map((group) => [group.name, group.status, group.attention, group.members.length])).toEqual([
      ['接口重构', 'active', false, 2], ['验收', 'active', true, 2], ['文档整理', 'dissolved', false, 0]
    ])
    const refactor = view.groups[0]!
    expect(refactor.goal).toBe('收口查询路径')
    expect(refactor.members.map((member) => [member.channelId, member.roleName, member.state, member.isLead])).toEqual([
      ['1', '主控协调', 'waiting', true], ['2', '架构实现', 'working', false]
    ])
    expect(refactor.leadSlotId).toBe(refactor.members[0]!.slotId)
    expect(view.groups[1]!.members.map((member) => member.state)).toEqual(['waiting', 'offline'])
    expect(view.ungroupedSeats.map((seat) => seat.channelId)).toEqual(['5'])
    // 已解散的组不占用席位，也不出现在席位的组标签里。
    expect(view.seats.find((seat) => seat.channelId === '5')?.groupName).toBeUndefined()
  })

  it('phrases the group consequences in terms of the group, not the run', () => {
    const view = buildRunView(pool())
    const group = view.groups[0]!
    const remove = groupActionConsequence({ kind: 'remove', group, member: group.members[1]! })
    expect(remove).toMatchObject({ title: '把 CH-2 移出「接口重构」', confirmLabel: '确认移出', needsConfirm: true })
    expect(remove.body).toContain('Cursor 会话、令牌与时间线不变')
    expect(remove.body).toContain('任务回到队列')
    const dissolve = groupActionConsequence({ kind: 'dissolve', group })
    expect(dissolve).toMatchObject({ title: '解散「接口重构」', confirmLabel: '确认解散', needsConfirm: true })
    expect(dissolve.body).toContain('2 名成员恢复为独立会话')
    expect(dissolve.body).toContain('保留 24 小时')
  })
})
