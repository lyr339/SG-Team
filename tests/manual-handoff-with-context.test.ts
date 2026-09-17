import { describe, expect, it } from 'vitest'
import { transferMembershipWithContext, type MembershipTransferWithContextPorts } from '../src/application/manual-handoff-with-context'
import type { SessionHandoffContext, SessionHandoffResult } from '../src/domain/session-handoff'
import { emptyTeamControlSnapshot, type TeamControlSnapshot, type TeamMemberView } from '../src/domain/team-control'
import type { MembershipTransferResult } from '../src/domain/team-handoff'

const SOURCE_CONTEXT: SessionHandoffContext = {
  channelId: '2',
  displayName: '架构实现 · CH-2',
  role: { name: '架构实现', slotName: '实现席', templateKey: 'builder' },
  composerId: 'composer-2',
  transcript: { path: '/transcripts/composer-2.jsonl', exists: true, resolution: 'workspace' },
  holdSupported: true,
  userMessageCount: 3,
  assistantMessageCount: 3
}

function transferred(toChannelId: string | undefined): MembershipTransferResult {
  return {
    groupId: 'team-group:ws:g1',
    fromSlotId: 'slot-builder',
    toSlotId: 'slot-solo-7',
    toChannelId,
    roleName: '架构实现',
    transferredLead: false,
    failover: {
      id: 'team-handoff:membership:test', workspaceId: 'ws', runId: 'team-run:ws:main',
      slotId: 'slot-builder', roleName: '架构实现', fromChannelId: '2', fromAgentSessionId: 'agent-2',
      toChannelId, toAgentSessionId: toChannelId ? 'agent-7' : undefined,
      status: 'completed', reason: 'manual_membership_transfer', taskIds: [],
      detectedAt: 1, updatedAt: 1, completedAt: 1
    },
    releasedTaskIds: []
  }
}

function team(): TeamControlSnapshot {
  const run = {
    id: 'team-run:ws:main', workspaceId: 'ws', name: '会话池', goal: '',
    templateId: 'independent-session-v1', status: 'running' as const, createdAt: 1, updatedAt: 1
  }
  const builder: TeamMemberView = {
    slot: { id: 'slot-builder', runId: run.id, roleId: 'role-builder', name: '实现席', avatarId: 'architect', channelId: '2', order: 0, createdAt: 1, updatedAt: 1, groupId: 'team-group:ws:g1' },
    role: { id: 'role-builder', runId: run.id, key: 'builder', templateKey: 'builder', name: '架构实现', mission: '', instructions: '', capabilities: [], skills: [], accent: 'mint', order: 0 },
    binding: {
      id: 'b-2', workspaceId: 'ws', runId: run.id, slotId: 'slot-builder', channelId: '2', agentSessionId: 'agent-2', generation: 'g1',
      installedAt: 1, launchDetail: '', acknowledgedAt: 1, lastCheckInNote: '', composerBindingKey: 'k2', composerId: 'composer-2'
    },
    readiness: 'offline'
  }
  const target: TeamMemberView = {
    slot: { id: 'slot-solo-7', runId: run.id, roleId: 'role-solo-7', name: '独立席 7', avatarId: 'researcher', channelId: '7', order: 1, createdAt: 1, updatedAt: 1, solo: true },
    role: { id: 'role-solo-7', runId: run.id, key: 'solo-7', templateKey: 'solo', name: '独立会话', mission: '', instructions: '', capabilities: [], skills: [], accent: 'sky', order: 1 },
    binding: {
      id: 'b-7', workspaceId: 'ws', runId: run.id, slotId: 'slot-solo-7', channelId: '7', agentSessionId: 'agent-7', generation: 'g1',
      installedAt: 1, launchDetail: '', lastCheckInNote: '', composerBindingKey: 'k7'
    },
    readiness: 'ready'
  }
  return {
    ...emptyTeamControlSnapshot(),
    activeRun: run,
    runs: [run],
    members: [builder, target],
    bindings: [builder.binding!, target.binding!]
  }
}

function harness(options: {
  deliverError?: string
  transferError?: string
  contextError?: string
  toChannelId?: string | undefined
} = {}) {
  const calls: string[] = []
  const snapshot = team()
  const result = transferred('toChannelId' in options ? options.toChannelId : '7')
  const ports: MembershipTransferWithContextPorts = {
    groups: {
      transferMembership: (input) => {
        calls.push(`transfer:${input.fromSlotId}->${input.toSlotId}@${input.groupId}`)
        if (options.transferError) throw new Error(options.transferError)
        return result
      }
    },
    team: { getSnapshot: () => snapshot },
    handoff: {
      context: (channelId) => {
        calls.push(`context:${channelId}`)
        if (options.contextError) throw new Error(options.contextError)
        return SOURCE_CONTEXT
      },
      deliverFrom: (source, target): SessionHandoffResult => {
        calls.push(`deliver:${source.channelId}->${target.kind === 'channel' ? target.channelId : 'self'}`)
        if (options.deliverError) throw new Error(options.deliverError)
        return { targetChannelId: target.kind === 'channel' ? target.channelId : source.channelId, held: false, transcriptPath: source.transcript!.path, commandId: 'cmd-1', issuedAt: 1 }
      }
    }
  }
  return { ports, calls, result }
}

const INPUT = { groupId: 'team-group:ws:g1', fromSlotId: 'slot-builder', toSlotId: 'slot-solo-7' }

describe('transferMembershipWithContext', () => {
  it('resolves the source context before the transfer and delivers it to the target channel afterwards', () => {
    const { ports, calls, result } = harness()
    const outcome = transferMembershipWithContext(ports, { ...INPUT, includeContext: true })
    expect(calls).toEqual(['context:2', 'transfer:slot-builder->slot-solo-7@team-group:ws:g1', 'deliver:2->7'])
    expect(outcome.transfer).toBe(result)
    expect(outcome.contextHandoff).toMatchObject({ ok: true, result: { targetChannelId: '7', transcriptPath: '/transcripts/composer-2.jsonl' } })
  })

  it('reports a failed context delivery without undoing the transfer', () => {
    const { ports, calls, result } = harness({ deliverError: 'CH-2 尚未绑定 Cursor Composer，找不到它的上下文文档' })
    const outcome = transferMembershipWithContext(ports, { ...INPUT, includeContext: true })
    expect(calls).toEqual(['context:2', 'transfer:slot-builder->slot-solo-7@team-group:ws:g1', 'deliver:2->7'])
    expect(outcome.transfer).toBe(result)
    expect(outcome.contextHandoff).toEqual({ ok: false, error: 'CH-2 尚未绑定 Cursor Composer，找不到它的上下文文档' })
  })

  it('propagates a failed transfer and never delivers anything', () => {
    const { ports, calls } = harness({ transferError: '席位 slot-solo-7 已在其他协作组内（一个席位同一时刻只属于一个组）' })
    expect(() => transferMembershipWithContext(ports, { ...INPUT, includeContext: true }))
      .toThrowError('席位 slot-solo-7 已在其他协作组内（一个席位同一时刻只属于一个组）')
    expect(calls).toEqual(['context:2', 'transfer:slot-builder->slot-solo-7@team-group:ws:g1'])
  })

  it('still transfers when resolving the source context throws, and reports that error', () => {
    const { ports, calls, result } = harness({ contextError: 'EACCES: transcript directory unreadable' })
    const outcome = transferMembershipWithContext(ports, { ...INPUT, includeContext: true })
    expect(calls).toEqual(['context:2', 'transfer:slot-builder->slot-solo-7@team-group:ws:g1'])
    expect(outcome.transfer).toBe(result)
    expect(outcome.contextHandoff).toEqual({ ok: false, error: 'EACCES: transcript directory unreadable' })
  })

  it('is a plain transfer without includeContext', () => {
    const { ports, calls, result } = harness()
    const outcome = transferMembershipWithContext(ports, INPUT)
    expect(calls).toEqual(['transfer:slot-builder->slot-solo-7@team-group:ws:g1'])
    expect(outcome).toEqual({ transfer: result })
  })

  it('falls back to the team snapshot for the target channel when the result omits it', () => {
    const { ports, calls } = harness({ toChannelId: undefined })
    const outcome = transferMembershipWithContext(ports, { ...INPUT, includeContext: true })
    // 结果没带 toChannelId：从迁移前快照里按 toSlotId 找到 CH-7 照常投递。
    expect(calls).toEqual(['context:2', 'transfer:slot-builder->slot-solo-7@team-group:ws:g1', 'deliver:2->7'])
    expect(outcome.contextHandoff).toMatchObject({ ok: true, result: { targetChannelId: '7' } })
  })
})
