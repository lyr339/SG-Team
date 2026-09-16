import { describe, expect, it } from 'vitest'
import {
  buildSoloLaunchHint,
  buildTeamRoleBriefing,
  createConfiguredTeamBundle,
  workspaceRunMode,
  type RuntimeBinding
} from '../src/domain/team-control'
import { createDefaultTeamBundle } from './legacy-team-fixtures'

describe('team control domain', () => {
  it('creates explicit durable roles and slots for the discovered channels', () => {
    const bundle = createDefaultTeamBundle({
      workspaceId: 'workspace-a',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      channelIds: ['3', '1', '2', '2'],
      now: 100
    })

    expect(bundle.run.id).toBe('team-run:workspace-a:main')
    expect(bundle.roles.map((role) => [role.key, role.capabilities])).toEqual([
      ['lead', ['coordination', 'planning']],
      ['builder', ['code', 'architecture']],
      ['reviewer', ['qa', 'testing']]
    ])
    expect(bundle.slots.map((slot) => [slot.id, slot.channelId])).toEqual([
      ['agent-slot:workspace-a:lead', '1'],
      ['agent-slot:workspace-a:builder', '2'],
      ['agent-slot:workspace-a:reviewer', '3']
    ])
  })

  it('adds explicit specialist roles without guessing capabilities from display names', () => {
    const bundle = createDefaultTeamBundle({
      workspaceId: 'workspace-b',
      workspaceName: 'beta',
      workspacePath: '/workspace/beta',
      channelIds: ['1', '2', '3', '4'],
      now: 100
    })
    expect(bundle.roles[3]).toMatchObject({
      key: 'specialist-1',
      name: '专项实现 1',
      capabilities: ['code', 'implementation']
    })
  })

  it('builds a bounded launch contract that requires explicit agent acknowledgement', () => {
    const bundle = createDefaultTeamBundle({
      workspaceId: 'workspace-a',
      workspaceName: 'alpha',
      workspacePath: '/workspace/alpha',
      channelIds: ['2'],
      now: 100
    })
    bundle.run.goal = '完成 Bridge v2，并提供回归测试证据'
    const binding: RuntimeBinding = {
      id: 'binding-1',
      workspaceId: bundle.workspace.id,
      runId: bundle.run.id,
      slotId: bundle.slots[0]!.id,
      channelId: '2',
      agentSessionId: 'workspace-a:ch-2:generation123',
      generation: 'generation123',
      composerBindingKey: 'generation123',
      installedAt: 100,
      launchDetail: '',
      lastCheckInNote: ''
    }
    // 简报只对组成员存在（阶段 2 · 2B）：目标来自组，不来自 run。
    const prompt = buildTeamRoleBriefing({
      run: bundle.run,
      role: bundle.roles[0]!,
      slot: bundle.slots[0]!,
      binding,
      group: { name: 'Bridge 组', goal: '完成 Bridge v2，并提供回归测试证据', leadLabel: '主控协调 · CH-2', memberCount: 1 }
    })

    expect(prompt).toContain('team_check_in')
    expect(prompt).toContain('组目标：完成 Bridge v2，并提供回归测试证据')
    expect(prompt).toContain(`TeamRun：${bundle.run.id}`)
    expect(prompt).toContain("channel_id:'2'")
    expect(prompt).toContain('SG Team')
    expect(prompt).toContain('[[SG_TEAM_BIND:generation123:CH-2]]')
    expect(prompt).toContain('停止自动重试')
    expect(prompt).toContain('默认控制在 1—4 句')
    expect(prompt).toContain('不要固定输出“当前结论 / 下一步 / 阻塞项”')
    expect(prompt).toContain(bundle.slots[0]!.id)
    expect(prompt).toContain('不要依据团队目标自行调用 team_task plan')
    expect(prompt).toContain('只有收到用户明确要求“开始 / 分配 / 拆任务 / 执行”后')
  })

  it('builds an arbitrary channel subset with user-selected roles, skills and avatars', () => {
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'workspace-configured',
      workspaceName: 'configured',
      workspacePath: '/workspace/configured',
      members: [
        { channelId: '2', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '7', roleTemplateKey: 'backend', avatarId: 'architect', skills: [{ id: 'project:mcp', name: 'mcp-builder', description: 'MCP', scope: 'project' }] },
        { channelId: '11', roleTemplateKey: 'backend', avatarId: 'devops', skills: [] },
        { channelId: '19', roleTemplateKey: 'reviewer', avatarId: 'reviewer', skills: [] },
        { channelId: '23', roleTemplateKey: 'researcher', avatarId: 'researcher', skills: [] }
      ],
      now: 100
    })

    expect(bundle.slots.map((slot) => slot.channelId)).toEqual(['2', '7', '11', '19', '23'])
    expect(bundle.roles.map((role) => role.key)).toEqual(['lead', 'backend', 'backend-2', 'reviewer', 'researcher'])
    expect(bundle.roles[1]).toMatchObject({
      templateKey: 'backend',
      name: '后端实现 1',
      skills: [{ name: 'mcp-builder' }]
    })
    expect(bundle.roles[2]).toMatchObject({ templateKey: 'backend', name: '后端实现 2' })
    expect(bundle.slots[1]).toMatchObject({ avatarId: 'architect' })

    const prompt = buildTeamRoleBriefing({
      run: bundle.run,
      role: bundle.roles[1]!,
      slot: bundle.slots[1]!,
      binding: {
        id: 'binding-configured', workspaceId: bundle.workspace.id, runId: bundle.run.id,
        slotId: bundle.slots[1]!.id, channelId: '7', agentSessionId: 'configured:ch-7:generation123',
        generation: 'generation123', installedAt: 100, launchDetail: '',
        lastCheckInNote: '', composerBindingKey: 'generation123'
      },
      group: { name: '技能组', goal: '按用户选择的技能协作', leadLabel: '主控协调 · CH-2', memberCount: 5 }
    })
    expect(prompt).toContain('/mcp-builder')
    expect(prompt).toContain('CH-7')
  })

  it('briefs an acting lead with real coordinator duties while retaining the specialist role', () => {
    const bundle = createDefaultTeamBundle({
      workspaceId: 'acting', workspaceName: 'acting', workspacePath: '/workspace/acting',
      channelIds: ['1', '2'], now: 100
    })
    const role = bundle.roles.find((candidate) => candidate.templateKey === 'builder')!
    const slot = bundle.slots.find((candidate) => candidate.roleId === role.id)!
    const prompt = buildTeamRoleBriefing({
      run: bundle.run,
      role,
      slot,
      effectiveLead: true,
      binding: {
        id: 'binding-acting', workspaceId: bundle.workspace.id, runId: bundle.run.id,
        slotId: slot.id, channelId: '2', agentSessionId: 'acting:ch-2:generation123',
        generation: 'generation123', installedAt: 100, acknowledgedAt: 100,
        launchDetail: '', lastCheckInNote: '', composerBindingKey: 'generation123'
      },
      group: { name: '交接组', goal: '完成真实主控交接', leadLabel: '架构实现 · CH-2', memberCount: 2 }
    })
    expect(prompt).toContain('协作组「交接组」的唯一有效主控')
    expect(prompt).toContain('全局规划、消息协调与向用户汇报的责任（分派与催办由拾光自动完成）')
    expect(prompt).toContain("team_tasks({channel_id:'2', view:'board'})")
    expect(prompt).toContain('team_message broadcast + collect')
  })

  it('briefs lead and members for an orchestrator-driven team: no manual dispatch / chase / review scheduling, no hand-written status reports (2A)', () => {
    const bundle = createDefaultTeamBundle({
      workspaceId: 'orch', workspaceName: 'orch', workspacePath: '/workspace/orch',
      channelIds: ['1', '2', '3'], now: 100
    })
    const bindingFor = (slot: (typeof bundle.slots)[number]) => ({
      id: `binding-${slot.channelId}`, workspaceId: bundle.workspace.id, runId: bundle.run.id,
      slotId: slot.id, channelId: slot.channelId!, agentSessionId: `orch:ch-${slot.channelId}:g`,
      generation: 'g', installedAt: 100, acknowledgedAt: 100,
      launchDetail: '', lastCheckInNote: '', composerBindingKey: 'g'
    })
    // 缺省组：有 lead（CH-1）的三人组；无 lead 组由各用例显式传入。
    const ledGroup = { name: '编排组', goal: '编排边界', leadLabel: '主控协调 · CH-1', memberCount: 3 }
    const briefingOf = (templateKey: string, group: Parameters<typeof buildTeamRoleBriefing>[0]['group'] = ledGroup) => {
      const role = bundle.roles.find((candidate) => candidate.templateKey === templateKey)!
      const slot = bundle.slots.find((candidate) => candidate.roleId === role.id)!
      return buildTeamRoleBriefing({ run: bundle.run, role, slot, binding: bindingFor(slot), effectiveLead: templateKey === 'lead', group })
    }

    const lead = briefingOf('lead')
    // lead：规划 + 答用户 + 汇总真实上报；催办 / 安排验收 / 打回返工三句删除，禁止代答保留。
    expect(lead).toContain('分派、催办、派验收、打回后的重派由拾光自动完成')
    expect(lead).toContain('不要催办、不要安排验收、不要打回返工')
    expect(lead).toContain('【任务完成】/【任务失败】/【成员离线提醒】')
    expect(lead).toContain('禁止代答')
    expect(lead).not.toContain('安排验收、打回返工、收尾')
    expect(lead).not.toContain('才主动调度、催办')
    expect(lead).not.toContain('team_message send 询问成员')

    const builder = briefingOf('builder')
    // 成员：上报由 team_task / team_review 动作自动生成，不再要求手写 team_message；respond 义务保留。
    expect(builder).toContain('自动上报主控，不要再另发 team_message 复述')
    expect(builder).not.toContain('静默干活即失职')
    expect(builder).not.toContain('关键节点主动向主控上报')
    expect(builder).toContain("team_message({action:'respond', messageId, content})")
    expect(builder).not.toContain('本组允许全体成员规划')

    // 无 lead 组：any_member 时成员简报带规划规则；lead_only 时说明任务由用户创建、成员只共享。
    const flat = briefingOf('builder', { name: '扁平组', goal: '', memberCount: 2, membersMayPlan: true })
    expect(flat).toContain('lead：无——任务由用户在拾光里创建，或由任一成员规划，系统自动分派')
    expect(flat).toContain('本组允许全体成员规划：只有收到用户明确要求')
    expect(flat).toContain('或按第 2 条由成员规划')
    const sharing = briefingOf('builder', { name: '共享组', goal: '', memberCount: 2, membersMayPlan: false })
    expect(sharing).toContain('lead：无——任务由用户在拾光里创建并自动分派，组内成员只共享目标、消息与记忆')
    expect(sharing).not.toContain('本组允许全体成员规划')
    expect(sharing).not.toContain('由成员规划')
  })

  it('requires exactly one lead regardless of team size', () => {
    expect(() => createConfiguredTeamBundle({
      workspaceId: 'invalid', workspaceName: 'invalid', workspacePath: '/workspace/invalid',
      members: [{ channelId: '1', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }]
    })).toThrowError(/只能有 1 名主控/)
    expect(() => createConfiguredTeamBundle({
      workspaceId: 'invalid', workspaceName: 'invalid', workspacePath: '/workspace/invalid',
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '2', roleTemplateKey: 'lead', avatarId: 'architect', skills: [] }
      ]
    })).toThrowError(/只能有 1 名主控/)
  })

  it('builds one TeamRun with team members plus numbered solo seats without counting solo as lead', () => {
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'mixed', workspaceName: 'mixed', workspacePath: '/workspace/mixed', now: 100,
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] },
        { channelId: '3', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true },
        // 防御：solo=true 时即使上游传入 lead/skills，也强制落为 solo 空能力模板。
        { channelId: '4', roleTemplateKey: 'lead', avatarId: 'devops', skills: [{ id: 'x', name: 'x', description: 'x', scope: 'project' }], solo: true }
      ]
    })
    expect(bundle.roles.map((role) => [role.templateKey, role.name, role.capabilities, role.skills])).toEqual([
      ['lead', '主控协调', ['coordination', 'planning'], []],
      ['builder', '架构实现', ['code', 'architecture'], []],
      ['solo', '独立执行 1', [], []],
      ['solo', '独立执行 2', [], []]
    ])
    expect(bundle.slots.map((slot) => [slot.name, slot.solo])).toEqual([
      ['主控席', false], ['实现席', false], ['独立席 1', true], ['独立席 2', true]
    ])
  })

  it('rejects an all-solo bundle and builds a solo launch loop without team_check_in', () => {
    expect(() => createConfiguredTeamBundle({
      workspaceId: 'solo-only', workspaceName: 'solo-only', workspacePath: '/workspace/solo-only',
      members: [{ channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }]
    })).toThrowError(/至少需要 1 个非独立席位/)

    const prompt = buildSoloLaunchHint({ channelId: '8' })
    expect(prompt).toContain('独立会话')
    expect(prompt).toContain("check_messages({channel_id:'8'})")
    expect(prompt).toContain('通信工具沿用同一参数')
    expect(prompt).not.toContain('team_check_in')
  })

  it('creates an explicit independent run made only of isolated solo slots', () => {
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'independent', workspaceName: 'independent', workspacePath: '/workspace/independent',
      mode: 'independent', now: 100,
      members: [
        { channelId: '1', roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true },
        { channelId: '2', roleTemplateKey: 'solo', avatarId: 'devops', skills: [], solo: true }
      ]
    })
    expect(workspaceRunMode(bundle.run)).toBe('independent')
    expect(bundle.run.id).toContain('session-run:')
    expect(bundle.run.status).toBe('running')
    expect(bundle.slots.every((slot) => slot.solo === true)).toBe(true)
    expect(() => createConfiguredTeamBundle({
      workspaceId: 'invalid-independent', workspaceName: 'invalid', workspacePath: '/workspace/invalid',
      mode: 'independent',
      members: [{ channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] }]
    })).toThrowError(/只接受独立席位/)
  })
})
