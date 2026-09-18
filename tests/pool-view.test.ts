import { describe, expect, it } from 'vitest'
import type { TeamControlSnapshot, TeamMemberRuntime, TeamMemberView, TeamRunStatus } from '../src/domain/team-control'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import type { TeamTask } from '../src/domain/task-pool'
import {
  buildPoolView,
  consequenceOf,
  removeMembersConsequence,
  seatStateOf
} from '../src/renderer/src/run/pool-view'
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

/** 升级前的一次性团队 run：阶段 2 · 2B 起只作归档展示。 */
function legacyTeamRun(shape: SeatShape, status: TeamRunStatus = 'completed'): TeamControlSnapshot {
  const snapshot = structuredClone(teamControlSnapshot)
  snapshot.activeRun = { ...snapshot.activeRun!, templateId: 'software-core-v1', status }
  snapshot.members = snapshot.members.map((member) => ({
    ...member,
    runtime: runtimeOf(shape, member.slot.channelId ?? '9')
  }))
  return snapshot
}

describe('pool view · seats', () => {
  it('maps runtime evidence to waiting / working / offline / unconfirmed like the server guard', () => {
    const team = independentTeam(['waiting', 'working', 'offline', 'unconfirmed'])
    expect(team.members.map(seatStateOf)).toEqual(['waiting', 'working', 'offline', 'unconfirmed'])
    const view = buildPoolView(team)
    expect(view.pool?.templateId).toBe('independent-session-v1')
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
    const view = buildPoolView(independentTeam(['awaiting', 'waiting']))
    expect(view.seats[0]).toMatchObject({ state: 'awaiting', pending: false })
    expect(view.liveSeatCount).toBe(2)
    expect(view.state).toMatchObject({ label: '等待回答 1 · 待命 1 · 执行中 0', tone: 'warning' })
  })

  it('reads the pool state chip from the seats', () => {
    expect(buildPoolView(independentTeam(['waiting', 'waiting'])).state).toMatchObject({ label: '待命 2/2', tone: 'active' })
    expect(buildPoolView(independentTeam(['waiting', 'unconfirmed'])).state).toMatchObject({ label: '待命 1/2', tone: 'neutral' })
    expect(buildPoolView(independentTeam(['offline', 'offline'])).state).toMatchObject({ label: '全部离线', tone: 'warning' })
    expect(buildPoolView(independentTeam([])).state).toMatchObject({ label: '空批次', tone: 'neutral' })
  })

  it('an ended pool has no live seats and nothing pending to create', () => {
    const view = buildPoolView(independentTeam(['waiting', 'unconfirmed'], 'completed'))
    expect(view.phase).toBe('completed')
    expect(view.liveSeatCount).toBe(0)
    expect(view.pendingSeats).toEqual([])
    expect(view.evidencePending).toBe(false)
    expect(view.state).toMatchObject({ label: '批次已结束', tone: 'muted' })
  })

  it('has no pool and no seats before the first run', () => {
    const view = buildPoolView(emptyTeamControlSnapshot())
    expect(view).toMatchObject({ phase: 'none', pool: undefined, archivedLegacyTeam: false, seats: [], groups: [], liveSeatCount: 0 })
    expect(view.state.label).toBe('尚未开始运行')
  })

  it('treats an archived legacy team run as "no pool": start page, one explanatory chip, no seats or groups (2B)', () => {
    for (const status of ['completed', 'running'] as const) {
      const view = buildPoolView(legacyTeamRun('waiting', status))
      expect(view).toMatchObject({ phase: 'none', pool: undefined, archivedLegacyTeam: true, seats: [], groups: [], ungroupedSeats: [], liveSeatCount: 0 })
      expect(view.state).toMatchObject({ label: '旧团队运行已归档', tone: 'muted' })
      expect(view.state.hint).toContain('独立批次')
    }
    // 工作区仍然是它的：新建批次的目标工程照常显示。
    expect(buildPoolView(legacyTeamRun('waiting')).workspace?.id).toBe('wedge-demo')
  })

  it('flags a Cursor workspace switch relative to the pool workspace', () => {
    const pool = independentTeam(['waiting'])
    expect(buildPoolView(pool, { id: 'wedge-demo', name: 'wedge-demo', path: '/x' }).cursorWorkspaceChanged).toBe(false)
    expect(buildPoolView(pool, { id: 'other', name: '新工程', path: '/y' }).cursorWorkspaceChanged).toBe(true)
  })
})

describe('pool view · one consequence template for every destructive action', () => {
  it('asks for confirmation only while seats are live, and always states the fence consequence', () => {
    const live = buildPoolView(independentTeam(['waiting', 'working', 'unconfirmed', 'offline']))
    const end = consequenceOf(live, { kind: 'end-pool' })
    expect(end).toMatchObject({ title: '结束当前独立批次', confirmLabel: '确认结束', needsConfirm: true, tone: 'danger' })
    expect(end.body).toContain('3 个会话仍在线或待确认')
    expect(end.body).toContain('下一次轮询（最长 60 秒）收到结束指令并自行退出')
    expect(end.body).toContain('尚未取走的排队消息将归档')

    const offline = buildPoolView(independentTeam(['offline', 'offline']))
    expect(consequenceOf(offline, { kind: 'end-pool' })).toMatchObject({ needsConfirm: false })
    expect(consequenceOf(offline, { kind: 'end-pool' }).body).toContain('所有会话已离线')
    expect(consequenceOf(offline, { kind: 'new-batch' }).body).toContain('所有会话已离线')
  })

  it('describes a new batch in terms of the current pool', () => {
    const independent = buildPoolView(independentTeam(['waiting']))
    const newBatch = consequenceOf(independent, { kind: 'new-batch', targetWorkspaceName: '新工程 B' })
    expect(newBatch).toMatchObject({ title: '在「新工程 B」新建批次', confirmLabel: '确认新建', needsConfirm: true, tone: 'neutral' })
    expect(newBatch.body).toContain('当前批次会结束')
    expect(consequenceOf(independent, { kind: 'new-batch' }).title).toBe('新建独立批次')
  })

  it('never asks for confirmation once the pool has ended', () => {
    const ended = buildPoolView(independentTeam(['waiting', 'waiting'], 'completed'))
    expect(consequenceOf(ended, { kind: 'end-pool' }).needsConfirm).toBe(false)
    expect(consequenceOf(ended, { kind: 'new-batch' }).needsConfirm).toBe(false)
  })
})

describe('pool view · 会话池的协作组', () => {
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
    const view = buildPoolView(pool())
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
    const view = buildPoolView(snapshot)
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
    // 独立席位与组成员互斥：入组席位不出现在建组候选里。
    expect(view.ungroupedSeats.every((seat) => !view.groups.some((group) => (
      group.status === 'active' && group.members.some((member) => member.slotId === seat.slotId)
    )))).toBe(true)
    // 已解散的组不占用席位，也不出现在席位的组标签里。
    expect(view.seats.find((seat) => seat.channelId === '5')?.groupName).toBeUndefined()
  })

  it('counts the group task board (open / review / done) from the task pool snapshot, scoped by run and group', () => {
    const snapshot = pool()
    const runId = snapshot.activeRun!.id
    const [refactorId, reviewId] = snapshot.groupIds
    const task = (id: string, status: TeamTask['status'], groupId?: string, taskRunId = runId): TeamTask => ({
      id, runId: taskRunId, key: id, title: id, description: '', acceptance: '', priority: 1,
      status, dependsOn: [], requiredCapabilities: [], maxAttempts: 3, attemptCount: 0, progress: 0,
      createdAt: 1, updatedAt: 1, groupId
    })
    const tasks = [
      task('t1', 'queued', refactorId),
      task('t2', 'leased', refactorId),
      task('t3', 'running', refactorId),
      task('t4', 'review', refactorId),
      task('t5', 'done', refactorId),
      task('t6', 'cancelled', refactorId),
      task('t7', 'queued', reviewId),
      // 其他 run / 无组的任务不计入。
      task('t8', 'queued', refactorId, 'other-run'),
      task('t9', 'queued', undefined)
    ]
    const view = buildPoolView(snapshot, undefined, {
      tasks: Object.fromEntries(tasks.map((item) => [item.id, item])),
      taskOrder: tasks.map((item) => item.id)
    })
    expect(view.groups[0]!.counters).toEqual({ open: 3, review: 1, done: 1 })
    expect(view.groups[1]!.counters).toEqual({ open: 1, review: 0, done: 0 })
    // 不带任务快照时计数为零（组卡片不显示计数区）。
    expect(buildPoolView(snapshot).groups[0]!.counters).toEqual({ open: 0, review: 0, done: 0 })
  })

  it('phrases the group consequences in terms of the group, not the run', () => {
    const view = buildPoolView(pool())
    const group = view.groups[0]!
    const member = group.members[1]!
    const remove = consequenceOf(view, { kind: 'remove-members', members: [{ channelId: member.channelId, groupName: group.name }] })
    expect(remove).toMatchObject({ title: '把 CH-2 移出「接口重构」', confirmLabel: '确认移出', needsConfirm: true, tone: 'neutral' })
    expect(remove.body).toContain('Cursor 会话、令牌与时间线不变')
    expect(remove.body).toContain('任务回到队列')
    const dissolve = consequenceOf(view, { kind: 'dissolve-group', group })
    expect(dissolve).toMatchObject({ title: '解散「接口重构」', confirmLabel: '确认解散', needsConfirm: true, tone: 'danger' })
    expect(dissolve.body).toContain('2 名成员恢复为独立会话')
    expect(dissolve.body).toContain('保留 24 小时')
  })

  it('aggregates a multi-select removal into one consequence (roster floating bar shares this copy)', () => {
    const sameGroup = removeMembersConsequence([
      { channelId: '1', groupName: '验收' },
      { channelId: '2', groupName: '验收' }
    ])
    expect(sameGroup.title).toBe('把 2 个会话移出「验收」')
    expect(sameGroup.body).toContain('这些席位恢复为独立会话')
    expect(sameGroup.needsConfirm).toBe(true)

    const acrossGroups = removeMembersConsequence([
      { channelId: '1', groupName: '验收' },
      { channelId: '3', groupName: '接口重构' }
    ])
    expect(acrossGroups.title).toBe('把 2 个会话移出协作组')
  })
})
