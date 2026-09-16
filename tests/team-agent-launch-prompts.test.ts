import { describe, expect, it } from 'vitest'
import {
  createConfiguredTeamBundle,
  type RuntimeBinding,
  type TeamControlSnapshot,
  type WorkspaceTeamBundle
} from '../src/domain/team-control'
import { createTeamAgentLaunchPromptPort } from '../src/application/team-agent-launch-prompts'
import { createDefaultTeamBundle } from './legacy-team-fixtures'

function poolBundle(): WorkspaceTeamBundle {
  return createConfiguredTeamBundle({
    workspaceId: 'workspace-a', workspaceName: 'alpha', workspacePath: '/workspace/alpha', now: 100, mode: 'independent',
    members: ['1', '2', '3'].map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }))
  })
}

function snapshotOf(bundle: WorkspaceTeamBundle, bindings: RuntimeBinding[]): TeamControlSnapshot {
  return {
    schemaVersion: 9,
    revision: 1,
    activeWorkspaceId: bundle.workspace.id,
    workspaces: [bundle.workspace],
    runs: [bundle.run],
    roles: bundle.roles,
    slots: bundle.slots,
    bindings,
    updatedAt: 100,
    activeRun: bundle.run,
    members: [],
    runtimeChannels: [],
    standbyChannels: [],
    failovers: [],
    groups: [],
    preflight: {
      bridgeConnected: true,
      workspaceBound: true,
      goalDefined: false,
      mcpInstalled: bindings.length > 0,
      agentsWaiting: false,
      canLaunch: bindings.length > 0,
      blockers: []
    }
  }
}

function bindingFor(bundle: WorkspaceTeamBundle, channelId: string, sessionToken?: string): RuntimeBinding {
  const slot = bundle.slots.find((candidate) => candidate.channelId === channelId)!
  return {
    id: `binding-${channelId}`,
    workspaceId: bundle.workspace.id,
    runId: bundle.run.id,
    slotId: slot.id,
    channelId,
    agentSessionId: `${bundle.workspace.id}:ch-${channelId}:generation1`,
    generation: 'generation1',
    installedAt: 100,
    launchStatus: 'not_started',
    launchDetail: '',
    lastCheckInNote: '',
    composerBindingKey: 'generation1',
    sessionToken
  }
}

describe('team agent launch prompts (session pool)', () => {
  it('gives every installed pool seat the compact isolated long-poll prompt with its seat token', async () => {
    const bundle = poolBundle()
    const prompts = createTeamAgentLaunchPromptPort({
      getSnapshot: () => snapshotOf(bundle, [bindingFor(bundle, '2', 'seat-token-0002')])
    })
    const prompt = await prompts.fetchStartPrompt('2')
    expect(prompt).toContain('SG Team')
    expect(prompt).toContain('CH-2 · 独立会话')
    expect(prompt).toContain('不要回复本条')
    expect(prompt).toContain("check_messages({channel_id:'2', session:'seat-token-0002'})")
    expect(prompt).toContain('通信工具沿用同一参数')
    expect(prompt).not.toContain('team_check_in')
    expect(prompt).not.toContain('会话围栏')
    expect(prompt).not.toContain('核心职责')
    expect(prompt.length).toBeLessThan(260)
  })

  it('omits the session argument for a pre-fence binding that has no token', async () => {
    const bundle = poolBundle()
    const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => snapshotOf(bundle, [bindingFor(bundle, '2')]) })
    const prompt = await prompts.fetchStartPrompt('2')
    expect(prompt).toContain("check_messages({channel_id:'2'})")
    expect(prompt).not.toContain('session')
  })

  it('gives a seat of a legacy team run (or a grouped pool seat) the same isolated prompt — no team launch prompt exists any more (2B)', async () => {
    // 入组 / legacy 团队席位的角色简报由 team_check_in 在首个轮询后交付；开场一律是独立会话。
    const legacy = createDefaultTeamBundle({
      workspaceId: 'workspace-a', workspaceName: 'alpha', workspacePath: '/workspace/alpha', channelIds: ['1', '2', '3'], now: 100,
      goal: '完成真实 lead/builder/reviewer 协作闭环'
    })
    const prompts = createTeamAgentLaunchPromptPort({
      getSnapshot: () => snapshotOf(legacy, [bindingFor(legacy, '1', 'seat-token-lead')])
    })
    const prompt = await prompts.fetchStartPrompt('1')
    expect(prompt).toContain('独立会话')
    expect(prompt).toContain("check_messages({channel_id:'1', session:'seat-token-lead'})")
    expect(prompt).not.toContain('team_check_in')
    expect(prompt).not.toContain(legacy.run.goal)
  })

  it('fails before CDP launch when the channel has no installed runtime binding, and when there is no pool at all', async () => {
    const bundle = poolBundle()
    const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => snapshotOf(bundle, []) })
    await expect(prompts.fetchStartPrompt('2')).rejects.toThrowError(/尚未安装 Team MCP/)
    await expect(prompts.fetchStartPrompt('x')).rejects.toThrowError(/通道号无效/)

    const empty = snapshotOf(bundle, [])
    empty.activeRun = undefined
    const noPool = createTeamAgentLaunchPromptPort({ getSnapshot: () => empty })
    await expect(noPool.fetchStartPrompt('2')).rejects.toThrowError(/没有可启动的会话池/)
  })

  it('only answers for bindings of the active run', async () => {
    const bundle = poolBundle()
    const stale = { ...bindingFor(bundle, '2', 'stale-token-0002'), runId: 'session-run:workspace-a:older' }
    const prompts = createTeamAgentLaunchPromptPort({ getSnapshot: () => snapshotOf(bundle, [stale]) })
    await expect(prompts.fetchStartPrompt('2')).rejects.toThrowError(/尚未安装 Team MCP/)
  })
})
