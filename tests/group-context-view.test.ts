import { describe, expect, it } from 'vitest'
import { emptyTaskPoolSnapshot, type TeamTask } from '../src/domain/task-pool'
import { emptyTeamCollaborationSnapshot, type TeamMessage } from '../src/domain/team-collaboration'
import { groupContextView } from '../src/renderer/src/team/group-context-view'
import { pooledTeam } from './run-fixtures'

function fixture() {
  const team = pooledTeam(
    ['waiting', 'working', 'waiting'],
    [
      {
        name: '接口组',
        members: [
          { channelId: '1', roleTemplateKey: 'lead', roleName: '主控' },
          { channelId: '2', roleTemplateKey: 'builder', roleName: '实现' }
        ],
        leadChannelId: '1'
      }
    ]
  )
  const runId = team.activeRun!.id,
    groupId = team.groups[0]!.group.id
  const tasks = { ...emptyTaskPoolSnapshot(), runId }
  const messages = emptyTeamCollaborationSnapshot(runId)
  const task = (id: string, gid = groupId, rid = runId): TeamTask => ({
    id,
    key: id,
    title: id,
    description: '',
    acceptance: '',
    priority: 1,
    status: 'queued',
    dependsOn: [],
    requiredCapabilities: [],
    maxAttempts: 3,
    attemptCount: 0,
    progress: 0,
    createdAt: 1,
    updatedAt: 1,
    groupId: gid,
    runId: rid
  })
  const message = (id: string, gid = groupId, rid = runId): TeamMessage => ({
    id,
    runId: rid,
    groupId: gid,
    threadId: 'thread',
    sender: { type: 'agent', slotId: team.members[0]!.slot.id },
    recipient: { type: 'agent', slotId: team.members[1]!.slot.id },
    kind: 'question',
    content: id,
    clientMessageId: id,
    createdAt: 1,
    receipt: { notificationState: 'not_required', notificationDetail: '', updatedAt: 1 }
  })
  return { team, runId, groupId, tasks, messages, task, message }
}

describe('in-session same-group context projection', () => {
  it('uses authoritative slot membership and never includes another run/group or duplicate IDs', () => {
    const f = fixture()
    const tasks = [f.task('own'), f.task('other-group', 'foreign'), f.task('other-run', f.groupId, 'old-run')]
    f.tasks.tasks = Object.fromEntries(tasks.map((task) => [task.id, task]))
    f.tasks.taskOrder = [...tasks.map((task) => task.id), 'own']
    const messages = [
      f.message('own-message'),
      f.message('foreign-message', 'foreign'),
      f.message('old-message', f.groupId, 'old-run')
    ]
    f.messages.messages = Object.fromEntries(messages.map((message) => [message.id, message]))
    f.messages.messageOrder = [...messages.map((message) => message.id), 'own-message']
    const view = groupContextView(f.team, '1', f.tasks, f.messages)
    expect(view.tasks.map((task) => task.id)).toEqual(['own'])
    expect(view.messages.map((message) => message.id)).toEqual(['own-message'])
    expect(view.mutable).toBe(true)
    expect(view.planningLabel).toBe('主控规划')
    expect(groupContextView(f.team, '3', f.tasks, f.messages).group).toBeUndefined()
  })
  it('does not trust a stale group view after a slot has left the group', () => {
    const f = fixture()
    f.team.members[0]!.slot.groupId = undefined
    expect(groupContextView(f.team, '1', f.tasks, f.messages).group).toBeUndefined()
  })
  it('keeps same-run ended context readable but disables all planning', () => {
    const f = fixture()
    f.team.activeRun!.status = 'completed'
    const view = groupContextView(f.team, '1', f.tasks, f.messages)
    expect(view.group?.group.id).toBe(f.groupId)
    expect(view.mutable).toBe(false)
  })
  it('excludes stale scoped snapshots and orphaned unanswered messages from pending reply counts', () => {
    const f = fixture(),
      m = f.message('orphan')
    m.receipt.notificationDetail = 'orphaned: member left'
    f.messages.messages[m.id] = m
    f.messages.messageOrder = [m.id]
    expect(groupContextView(f.team, '1', f.tasks, f.messages).pendingReplies).toBe(0)
    f.messages.groupId = 'foreign'
    expect(groupContextView(f.team, '1', f.tasks, f.messages).messages).toEqual([])
    f.tasks.tasks.own = f.task('own')
    f.tasks.taskOrder = ['own']
    f.tasks.runId = 'old-run'
    expect(groupContextView(f.team, '1', f.tasks, f.messages).tasks).toEqual([])
  })
})
