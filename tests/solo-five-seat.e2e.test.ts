import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTeamAgentLaunchPromptPort } from '../src/application/team-agent-launch-prompts'
import { TeamControlService, type TeamControlBridge } from '../src/application/team-control-service'
import { workspaceRunMode } from '../src/domain/team-control'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import type { DesktopSnapshot, SendMessageInput } from '../src/shared/desktop-api'

class Bridge implements TeamControlBridge {
  readonly sent: SendMessageInput[] = []
  private listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  constructor(private snapshot: DesktopSnapshot) {}
  getSnapshot(): DesktopSnapshot { return structuredClone(this.snapshot) }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }
  sendMessage(input: SendMessageInput) {
    const commandId = `cmd-${this.sent.length + 1}`
    this.sent.push(input)
    return { commandId }
  }
}

function waitingSessions(channelIds: string[]): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: 'local', attempt: 0, lastError: '' },
    sessions: channelIds.map((channelId) => ({
      id: `session-${channelId}`, channelId, generation: 1, displayName: `CH-${channelId}`,
      roleName: '', status: 'waiting', currentTask: '', queueDepth: 0, connectionPhase: 'waiting',
      online: true, connected: true, waiting: true, workingFiles: [], healthEvidence: ['waiting']
    })),
    conversations: {}, protocolIssues: [], updatedAt: 1
  }
}

const solo = (channelId: string) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true })

function install(service: TeamControlService, workspaceId: string) {
  const created = service.getSnapshot()
  return service.recordInstallation({
    workspaceId, runId: created.activeRun!.id, generation: 'generation123',
    agents: created.members.map((member) => ({
      agentSessionId: `${workspaceId}:ch-${member.slot.channelId}:generation123`,
      workspaceId, channelId: member.slot.channelId!, generation: 'generation123',
      runId: created.activeRun!.id, capabilities: []
    }))
  })
}

describe('session pool five-seat end-to-end composition', () => {
  it('persists an independent-only pool and gives every channel the isolated long-poll prompt', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-independent-e2e-')), 'team.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const bridge = new Bridge(waitingSessions([]))
    const service = new TeamControlService(repository, bridge)
    try {
      service.createSessionPool({
        workspaceId: 'independent-three', workspaceName: 'independent-three', workspacePath: '/workspace/independent-three',
        members: ['1', '2', '3'].map(solo)
      })
      install(service, 'independent-three')
      const restored = service.getSnapshot()
      expect(workspaceRunMode(restored.activeRun)).toBe('independent')
      expect(restored.bindings).toHaveLength(3)
      const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => service.getSnapshot() })
      for (const channelId of ['1', '2', '3']) {
        const prompt = await prompts.fetchStartPrompt(channelId)
        // 精简开场：只在首次 check_messages 中交付一次席位令牌；后续通信工具沿用同参，
        // 完整围栏与静默规则由 MCP Server instructions 承担。
        const token = restored.bindings.find((binding) => binding.channelId === channelId)?.sessionToken
        expect(token).toMatch(/^[a-zA-Z0-9_-]{8,128}$/)
        expect(prompt).toContain(`check_messages({channel_id:'${channelId}', session:'${token}'})`)
        expect(prompt.split(token!).length - 1).toBe(1)
        expect(prompt).toContain('通信工具沿用同一参数')
        expect(prompt).not.toContain('会话围栏')
        expect(prompt.length).toBeLessThan(260)
        expect(prompt).not.toContain('team_check_in')
        expect(() => repository.resolveChannelAgentIdentity(channelId)).toThrowError(/独立席位/)
      }
      expect(bridge.sent).toEqual([])
    } finally {
      service.dispose()
      repository.close()
    }
  })

  it('groups three of five pool seats: the group members check in as a team while every seat, grouped or not, keeps the isolated prompt', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-pool-group-e2e-')), 'team.sqlite3')
    const repository = new SqliteTeamControlRepository(path)
    const collaboration = new SqliteTeamCollaborationRepository(path)
    const bridge = new Bridge(waitingSessions(['1', '2', '3', '4', '5']))
    const service = new TeamControlService(repository, bridge)
    try {
      service.createSessionPool({
        workspaceId: 'mixed-five', workspaceName: 'mixed-five', workspacePath: '/workspace/mixed-five',
        members: ['1', '2', '3', '4', '5'].map(solo)
      })
      install(service, 'mixed-five')
      const pool = service.getSnapshot()
      expect(pool.members).toHaveLength(5)
      expect(pool.preflight).toMatchObject({ mcpInstalled: true, blockers: [] })
      const slotOf = (channelId: string) => pool.members.find((member) => member.slot.channelId === channelId)!.slot.id

      // 池内建组 = 阶段 1 的成员关系操作：不触碰令牌 / 绑定，run 状态不变，也没有任何「启动」投递。
      const { group } = repository.createGroup({
        runId: pool.activeRun!.id, name: '三人组', goal: '三人团队协作，两个独立会话由用户单独指派',
        leadSlotId: slotOf('1'),
        members: [
          { slotId: slotOf('1'), roleTemplateKey: 'lead' },
          { slotId: slotOf('2'), roleTemplateKey: 'builder' },
          { slotId: slotOf('3'), roleTemplateKey: 'reviewer' }
        ]
      })
      expect(bridge.sent).toEqual([])
      expect(service.getSnapshot().activeRun?.status).toBe('running')

      for (const channelId of ['1', '2', '3']) {
        const identity = repository.resolveChannelAgentIdentity(channelId)
        expect(identity.groupId).toBe(group.id)
        repository.recordAgentCheckIn(identity, 'ready')
      }
      const grouped = service.getSnapshot()
      expect(grouped.activeRun?.status).toBe('running')
      expect(grouped.groups.map((view) => [view.group.id, view.members.length])).toEqual([[group.id, 3]])
      expect(grouped.members.filter((member) => member.slot.solo !== true).map((member) => member.readiness)).toEqual(['active', 'active', 'active'])
      expect(collaboration.listRunMembers(pool.activeRun!.id, group.id)).toHaveLength(3)

      const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => service.getSnapshot() })
      for (const channelId of ['1', '2', '3', '4', '5']) {
        const prompt = await prompts.fetchStartPrompt(channelId)
        expect(prompt).toContain('check_messages')
        expect(prompt).not.toContain('team_check_in')
      }
      for (const channelId of ['4', '5']) {
        expect(() => repository.resolveChannelAgentIdentity(channelId)).toThrowError(/独立席位/)
      }
    } finally {
      service.dispose()
      collaboration.close()
      repository.close()
    }
  })
})
