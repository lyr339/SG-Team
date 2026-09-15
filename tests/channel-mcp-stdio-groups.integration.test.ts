import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { describe, expect, it } from 'vitest'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { LocalSessionBridge } from '../src/application/local-session-bridge'
import { TaskPoolService } from '../src/application/task-pool-service'
import { TeamControlService } from '../src/application/team-control-service'
import { TeamGroupService } from '../src/application/team-group-service'
import { MEMBERSHIP_NOTICE_PREFIX } from '../src/domain/channel-message'
import { createConfiguredTeamBundle, type RuntimeBinding, type WorkspaceTeamBundle } from '../src/domain/team-control'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamMemoryRepository } from '../src/infrastructure/team-memory/sqlite-team-memory-repository'

/**
 * 会话池 + 协作组 · 真实 stdio 集成（任务书 §10.4）：拉起真实的 `src/mcp/index.ts` 子进程
 *（与 Cursor 托管的进程同一入口、同一库文件），本进程扮演拾光桌面端（TeamGroupService 直写同一 SQLite）。
 * 锁定的是跨进程事实：入组 / 出组不重启 MCP 进程、不换令牌，身份在下一次工具调用时即生效；
 * 成员关系通知经 check_messages 以独立后缀投递、不开回复守门；任务视图按组隔离。
 */

const CHANNELS = ['1', '2', '3'] as const
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MCP_ENTRY = join(PROJECT_ROOT, 'src', 'mcp', 'index.ts')
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

type ToolResult = Awaited<ReturnType<Client['callTool']>>

function textOf(result: ToolResult): string {
  return (result.content as Array<{ type: string; text?: string }>).map((block) => block.text ?? '').join('\n')
}

function payloadOf<T extends Record<string, unknown>>(result: ToolResult): T {
  return result.structuredContent as T
}

/** 围栏比对只看身份与令牌：签到会刷新 lastCheckIn*，那不是成员关系要保护的字段。 */
function fenceIdentityOf(binding: RuntimeBinding) {
  const { slotId, channelId, agentSessionId, generation, sessionToken, composerBindingKey, composerId } = binding
  return { slotId, channelId, agentSessionId, generation, sessionToken, composerBindingKey, composerId }
}

/** 会话池：三个 solo 席位的独立批次 run + MCP 注册（签发令牌）；与生产 `configureIndependentWorkspace` 同形。 */
function installPool(repository: SqliteTeamControlRepository, workspacePath: string): WorkspaceTeamBundle {
  const pool = createConfiguredTeamBundle({
    workspaceId: 'pool', workspaceName: 'pool', workspacePath, now: 100, mode: 'independent', runKey: 'run-stdio-pool',
    members: CHANNELS.map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }))
  })
  repository.upsertWorkspaceTeam(pool)
  repository.recordInstallation({
    workspaceId: 'pool', runId: pool.run.id, generation: 'gen-stdio',
    agents: pool.slots.map((slot) => ({
      agentSessionId: `pool:ch-${slot.channelId}:gen-stdio`, workspaceId: 'pool',
      channelId: slot.channelId!, generation: 'gen-stdio', runId: pool.run.id, capabilities: []
    }))
  })
  return pool
}

async function spawnUnifiedServer(databasePath: string, workspacePath: string) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, MCP_ENTRY],
    cwd: PROJECT_ROOT,
    env: {
      ...inherited,
      SG_TEAM_DB: databasePath,
      SG_TEAM_SERVER_ROLE: 'unified',
      SG_TEAM_WORKSPACE_PATH: workspacePath,
      // 合法下限：空队列的 check_messages 最多等 10s 就返回 keepalive，测试不会卡在 5 分钟默认窗口。
      SG_TEAM_KEEPALIVE_MS: '10000'
    },
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  const client = new Client({ name: 'sg-team-stdio-groups', version: '1.0.0' })
  await client.connect(transport)
  return {
    client,
    stderr: () => stderr,
    call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, { timeout: 15_000 }),
    close: async () => {
      await client.close()
      await transport.close().catch(() => undefined)
    }
  }
}

describe('会话池协作组 · 真实 stdio MCP 进程', () => {
  it('solo → not_in_group；建组通知经 check_messages 投递 → team_check_in 见组简报；任务按组隔离；出组回 not_in_group；令牌与围栏全程不变', async () => {
    expect(existsSync(TSX_CLI), 'tsx CLI 应随 devDependencies 安装').toBe(true)
    const directory = mkdtempSync(join(tmpdir(), 'sg-team-stdio-groups-'))
    const databasePath = join(directory, 'task-pool.sqlite3')
    const workspacePath = join(directory, 'workspace')

    // ── 拾光桌面端一侧：与 MCP 子进程共用同一库文件 ──
    const controlRepository = new SqliteTeamControlRepository(databasePath)
    const pool = installPool(controlRepository, workspacePath)
    const taskRepository = new SqliteTaskPoolRepository(databasePath)
    const collaboration = new SqliteTeamCollaborationRepository(databasePath)
    const channelRepository = new SqliteChannelMessageRepository(databasePath)
    new SqliteTeamMemoryRepository(databasePath).close()
    for (const channelId of CHANNELS) channelRepository.markChannelEmbedded(channelId, 'pool', workspacePath)
    const relay = new ChannelMessageRelay(channelRepository)
    const bridge = new LocalSessionBridge(relay)
    const control = new TeamControlService(controlRepository, bridge)
    const tasks = new TaskPoolService(taskRepository, control)
    const groupErrors: unknown[] = []
    const groups = new TeamGroupService(controlRepository, control, tasks, collaboration, bridge, {
      onerror: (error) => groupErrors.push(error)
    })
    const slotOf = (channelId: string) => pool.slots.find((slot) => slot.channelId === channelId)!
    const bindingsNow = () => controlRepository.loadTeamControl().bindings
      .filter((binding) => binding.runId === pool.run.id)
      .sort((left, right) => left.channelId.localeCompare(right.channelId))
      .map(fenceIdentityOf)
    const fenceBaseline = bindingsNow()
    const tokenOf = (channelId: string) => fenceBaseline.find((binding) => binding.channelId === channelId)!.sessionToken!
    expect(fenceBaseline.map((binding) => binding.sessionToken)).toHaveLength(3)
    let enqueuedAt = 1_000
    const enqueueUser = (channelId: string, text: string) => channelRepository.enqueueOutbound(channelId, text, (enqueuedAt += 1))

    const server = await spawnUnifiedServer(databasePath, workspacePath)
    const { call } = server
    /** 用户消息投递后守门要求 record_reply；这里把「投递 → 同步」封成一步，只校验投递正文。 */
    const deliverUser = async (channelId: string, text: string): Promise<string> => {
      enqueueUser(channelId, text)
      const delivered = await call('check_messages', { channel_id: channelId, session: tokenOf(channelId) })
      expect(delivered.isError, textOf(delivered)).not.toBe(true)
      const deliveredText = textOf(delivered)
      expect(deliveredText).toContain(text)
      expect(deliveredText).toContain('【真实用户消息处理完后进入 check_messages 待命】')
      const recorded = await call('record_reply', { channel_id: channelId, session: tokenOf(channelId), content: `已收到：${text}` })
      expect(payloadOf<{ ok?: boolean }>(recorded).ok).toBe(true)
      return deliveredText
    }
    const membershipNotice = async (channelId: string): Promise<string> => {
      const delivered = await call('check_messages', { channel_id: channelId, session: tokenOf(channelId) })
      expect(delivered.isError, textOf(delivered)).not.toBe(true)
      const text = textOf(delivered)
      expect(text).toContain(MEMBERSHIP_NOTICE_PREFIX)
      expect(text).toContain(`【成员关系通知协议】这是拾光服务端对 CH-${channelId} 的成员关系变更`)
      expect(text).toContain('不要调用 record_reply')
      expect(text).not.toContain('【真实用户消息处理完后进入 check_messages 待命】')
      // 不能套内部协作后缀：成员关系通知没有 messageId，不得指引 team_message read / respond。
      expect(text).not.toContain('【内部协作通知协议】')
      expect(text).not.toContain("team_message({action:'read'")
      expect(text).toContain('本通知没有 messageId，不需要 team_message read')
      return text
    }

    try {
      const toolNames = (await server.client.listTools()).tools.map((tool) => tool.name)
      expect(toolNames).toEqual(expect.arrayContaining(['check_messages', 'record_reply', 'team_check_in', 'team_tasks', 'team_task', 'team_message']))

      // ── 1. 独立席位：team_* 一律 not_in_group + 指回通信待命；通信工具不受影响 ──
      const soloCheckIn = await call('team_check_in', { channel_id: '1' })
      expect(soloCheckIn.isError).toBe(true)
      expect(payloadOf(soloCheckIn)).toMatchObject({
        ok: false, code: 'not_in_group', nextAction: { type: 'enter_channel_wait', channelId: '1' }
      })
      expect(String(payloadOf(soloCheckIn).message)).toContain('CH-1 当前是独立席位')
      expect(payloadOf(await call('team_tasks', { channel_id: '3', view: 'available' }))).toMatchObject({ code: 'not_in_group' })
      await deliverUser('1', '基线：独立席位请待命')
      // 围栏确实在岗：错误令牌被退役，正确令牌放行（后续「围栏不变」的断言才有意义）
      const retired = await call('check_messages', { channel_id: '1', session: 'stale-token-0001' })
      expect(textOf(retired)).toContain('[system] 会话围栏：CH-1 已由新的会话接管')

      // ── 2. 操作员建组（本进程直写库）：MCP 进程不重启、不换令牌，成员关系通知进出站队列 ──
      const groupA = groups.createGroup({
        name: '验收组', goal: '把接口重构收尾',
        members: [{ slotId: slotOf('1').id, roleTemplateKey: 'lead' }, { slotId: slotOf('2').id, roleTemplateKey: 'specialist' }],
        leadSlotId: slotOf('1').id
      }).groups.find((view) => view.group.name === '验收组')!.group
      expect(groupErrors).toEqual([])
      expect(bindingsNow()).toEqual(fenceBaseline)

      const joinedLead = await membershipNotice('1')
      expect(joinedLead).toContain('你（CH-1）已加入协作组「验收组」，角色「主控协调」；lead：主控协调 · CH-1。')
      expect(joinedLead).toContain('组目标：把接口重构收尾')
      expect(joinedLead).toContain("team_check_in({channel_id:'1'})")
      const joinedMember = await membershipNotice('2')
      expect(joinedMember).toContain('你（CH-2）已加入协作组「验收组」，角色「专项实现 1」；lead：主控协调 · CH-1。')
      // 成员关系通知是 silent：不开回复守门，下一条用户消息直接投递
      await deliverUser('2', '入组后的第一条用户消息')

      // ── 3. 入组后身份在下一次调用即生效：简报以组为准 ──
      const leadCheckIn = await call('team_check_in', { channel_id: '1', note: 'lead 已读组目标' })
      expect(leadCheckIn.isError, textOf(leadCheckIn)).not.toBe(true)
      const leadPayload = payloadOf<{ receipt: { roleName: string }; briefing: string }>(leadCheckIn)
      expect(leadPayload.receipt.roleName).toBe('主控协调')
      expect(leadPayload.briefing).toContain('协作组「验收组」的「主控协调」Agent（组内 2 名成员；lead：主控协调 · CH-1）')
      expect(leadPayload.briefing).toContain('组目标：把接口重构收尾')
      expect(leadPayload.briefing).toContain(MEMBERSHIP_NOTICE_PREFIX)
      const memberCheckIn = await call('team_check_in', { channel_id: '2' })
      expect(memberCheckIn.isError, textOf(memberCheckIn)).not.toBe(true)
      expect(payloadOf<{ receipt: { roleName: string }; briefing: string }>(memberCheckIn).receipt.roleName).toBe('专项实现 1')
      expect(payloadOf<{ briefing: string }>(memberCheckIn).briefing).toContain('协作组「验收组」')
      const inbox = await call('team_message', { channel_id: '1', action: 'inbox' })
      expect(payloadOf<{ ok: boolean; messages: unknown[] }>(inbox)).toMatchObject({ ok: true, messages: [] })

      // ── 4. 第二个组：任务只在本组可见 ──
      const groupB = groups.createGroup({
        name: '调研组', goal: '梳理迁移风险', members: [{ slotId: slotOf('3').id, roleTemplateKey: 'lead' }], leadSlotId: slotOf('3').id
      }).groups.find((view) => view.group.name === '调研组')!.group
      expect(groupErrors).toEqual([])
      await membershipNotice('3')
      expect(payloadOf<{ receipt: { roleName: string } }>(await call('team_check_in', { channel_id: '3' })).receipt.roleName).toBe('主控协调')

      const plannedA = await call('team_task', { channel_id: '1', action: 'plan', tasks: [{
        key: 'refactor-api', title: '收尾接口重构', description: '按组目标完成接口重构', acceptance: '构建与测试通过',
        targetSlotId: slotOf('2').id, requiredCapabilities: ['code']
      }] })
      expect(plannedA.isError, textOf(plannedA)).not.toBe(true)
      const taskA = payloadOf<{ tasks: Array<{ id: string; groupId?: string }> }>(plannedA).tasks[0]!
      expect(taskA.groupId).toBe(groupA.id)
      const plannedB = await call('team_task', { channel_id: '3', action: 'plan', tasks: [{
        key: 'risk-survey', title: '梳理迁移风险', description: '列出迁移风险清单', acceptance: '清单覆盖全部模块'
      }] })
      expect(plannedB.isError, textOf(plannedB)).not.toBe(true)
      const taskB = payloadOf<{ tasks: Array<{ id: string; groupId?: string }> }>(plannedB).tasks[0]!
      expect(taskB.groupId).toBe(groupB.id)

      // `available` 返回裸 TeamTask[]；`board` / `mine` 返回 AgentTaskView[]（{ task, attempt }）。
      const idsOf = (result: ToolResult) => {
        expect(result.isError, textOf(result)).not.toBe(true)
        return payloadOf<{ tasks: Array<{ id?: string; task?: { id: string } }> }>(result).tasks.map((view) => view.task?.id ?? view.id)
      }
      expect(idsOf(await call('team_tasks', { channel_id: '2', view: 'available' }))).toEqual([taskA.id])
      expect(idsOf(await call('team_tasks', { channel_id: '3', view: 'available' }))).toEqual([taskB.id])
      expect(idsOf(await call('team_tasks', { channel_id: '1', view: 'board' }))).toEqual([taskA.id])
      expect(idsOf(await call('team_tasks', { channel_id: '3', view: 'board' }))).toEqual([taskB.id])

      // ── 5. 移出成员：出组通知 → 该席位回到 not_in_group；lead 收到 team notice；令牌不动 ──
      groups.removeGroupMember({ groupId: groupA.id, slotId: slotOf('2').id })
      expect(groupErrors).toEqual([])
      const leftNotice = await membershipNotice('2')
      expect(leftNotice).toContain('你（CH-2）已被移出协作组「验收组」，恢复为独立席位。')
      expect(payloadOf(await call('team_check_in', { channel_id: '2' }))).toMatchObject({ code: 'not_in_group' })
      expect(payloadOf(await call('team_tasks', { channel_id: '2', view: 'available' }))).toMatchObject({ code: 'not_in_group' })
      // inbox 条目是扁平摘要（kind / preview / stage），线程主题不在其中；正文说明了成员、组与任务回队。
      const leadInbox = payloadOf<{ messages: Array<{ kind: string; preview: string; sender: { type: string } }> }>(
        await call('team_message', { channel_id: '1', action: 'inbox' })
      )
      expect(leadInbox.messages).toHaveLength(1)
      expect(leadInbox.messages[0]).toMatchObject({ kind: 'notice', sender: { type: 'operator' } })
      expect(leadInbox.messages[0]!.preview).toContain('成员「专项实现 1 · CH-2」已被移出协作组「验收组」')
      expect(leadInbox.messages[0]!.preview).toContain('1 项任务已回到队列')
      // 定向给出组成员、尚未被领取的任务：清空定向、仍在队列、不算失败；lead 的任务板不受影响
      expect(taskRepository.load().tasks[taskA.id]).toMatchObject({ status: 'queued', groupId: groupA.id, targetSlotId: undefined, attemptCount: 0 })
      expect(taskRepository.load().events.at(-1)).toMatchObject({ type: 'task.untargeted_by_membership', taskId: taskA.id, detail: 'member_left' })
      expect(idsOf(await call('team_tasks', { channel_id: '1', view: 'board' }))).toEqual([taskA.id])

      // ── 6. 围栏与令牌全程不变：三席原令牌照常投递 ──
      expect(bindingsNow()).toEqual(fenceBaseline)
      await deliverUser('2', '出组后仍是同一会话')
      await deliverUser('1', '仍是 lead 的同一会话')
      const stillRetired = await call('check_messages', { channel_id: '2', session: 'stale-token-0001' })
      expect(textOf(stillRetired)).toContain('[system] 会话围栏：CH-2 已由新的会话接管')

      // ── 7. 审计：成员关系每一步都有事件，签到也进组事件 ──
      const eventsA = controlRepository.listGroupEvents(groupA.id).map((event) => event.type)
      expect(eventsA[0]).toBe('created')
      expect(eventsA.at(-1)).toBe('member_left')
      expect(eventsA.filter((type) => type === 'member_joined')).toHaveLength(2)
      expect(eventsA.filter((type) => type === 'member_checked_in')).toHaveLength(2)
      expect(eventsA).toContain('lead_changed')
      expect(control.getSnapshot().activeRun?.status).toBe('running')
      expect(server.stderr()).toContain('[sg-team-mcp] ready unified')
    } finally {
      await server.close()
      control.dispose()
      bridge.dispose()
      relay.stop()
      collaboration.close()
      taskRepository.close()
      channelRepository.close()
      controlRepository.close()
    }
  }, 90_000)
})
