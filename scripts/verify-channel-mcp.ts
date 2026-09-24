/**
 * 一体化 S3-1 统一通道 MCP 冒烟（真实 stdio + 构建产物）：
 * - unified 角色（SG Team 单条目）：两项通信工具 + 团队工具同服，
 *   投递/守门/同步/再投递全链路，身份按 channelId 实时解析；
 * - 工具面按工作区分组状态启停：无组只见两项通信工具，建组后经 list_changed 出现全部 9 个（阶段 4 · 4A）；
 * - 活性钩子：团队工具调用同样刷新通道 presence（S2 红利保留）；
 * - 团队消息随 check_messages 内联送达、投递即已读（阶段 4 · 4C）。
 *
 * 运行：npm run build:mcp 之后 npx tsx scripts/verify-channel-mcp.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { MEMBERSHIP_NOTICE_PREFIX } from '../src/domain/channel-message'
import { createConfiguredTeamBundle } from '../src/domain/team-control'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { TEAM_TOOL_NAMES } from '../src/mcp/team-tools'

const directory = mkdtempSync(join(tmpdir(), 'sg-team-channel-mcp-smoke-'))
const databasePath = join(directory, 'task-pool.sqlite3')
const mcpServerPath = resolve('out/mcp/index.mjs')

// 真实模型：会话池里的两个独立席位（CH-1、CH-2）。工作区没有协作组时 Cursor 只看到两项通信工具；
// CH-1 入组后团队工具随 list_changed 出现，仍未入组的 CH-2 调用团队工具得到 not_in_group。
const bundle = createConfiguredTeamBundle({
  workspaceId: 'smoke',
  workspaceName: 'smoke',
  workspacePath: join(directory, 'workspace'),
  mode: 'independent',
  runKey: 'run-smoke-channel',
  members: ['1', '2'].map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true })),
  now: Date.now()
})
const teamRepository = new SqliteTeamControlRepository(databasePath)
teamRepository.upsertWorkspaceTeam(bundle)
teamRepository.recordInstallation({
  workspaceId: 'smoke',
  generation: 'generation1',
  runId: bundle.run.id,
  agents: bundle.slots.map((slot) => ({
    agentSessionId: `smoke:ch-${slot.channelId}:generation1`,
    workspaceId: 'smoke',
    channelId: slot.channelId!,
    generation: 'generation1',
    runId: bundle.run.id,
    capabilities: []
  }))
})
// 触发任务池库结构创建（与生产同库）
new SqliteTaskPoolRepository(databasePath).close()

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
)

async function openUnifiedClient(channelId: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    env: {
      ...inheritedEnvironment,
      SG_TEAM_DB: databasePath,
      SG_TEAM_SERVER_ROLE: 'unified',
      SG_TEAM_WORKSPACE_PATH: join(directory, 'workspace')
    },
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  // 与 Cursor 一样订阅工具列表变更：服务器发 list_changed 后客户端重拉 tools/list。
  const refreshedSurfaces: string[][] = []
  const client = new Client({ name: 'sg-team-channel-smoke', version: '1.0.0' }, {
    listChanged: {
      tools: {
        onChanged: (error, tools) => {
          if (!error && tools) refreshedSurfaces.push(tools.map((tool) => tool.name).sort())
        }
      }
    }
  })
  await client.connect(transport)
  return {
    client,
    stderr: () => stderr,
    refreshedSurfaces,
    async toolNames() {
      return (await client.listTools()).tools.map((tool) => tool.name).sort()
    },
    async close() {
      await client.close()
      await transport.close().catch(() => undefined)
    }
  }
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? '')
    .join('\n')
}

// ── 统一服务器：两项通信工具 + 团队工具同服 ──────────────────────────
const repository = new SqliteChannelMessageRepository(databasePath)
repository.enqueueOutbound('1', '冒烟：请审查统一通道服务器', 1_000)

const channel = await openUnifiedClient('1')
const COMMUNICATION_TOOLS = ['check_messages', 'record_reply']
const ALL_TOOLS = [...COMMUNICATION_TOOLS, ...TEAM_TOOL_NAMES].sort()
const ungroupedTools = await channel.toolNames()
if (JSON.stringify(ungroupedTools) !== JSON.stringify(COMMUNICATION_TOOLS)) {
  throw new Error(`无协作组的工作区应只暴露两项通信工具：${ungroupedTools.join(', ')}`)
}

// ── 投递 → 守门 → 同步 → 再投递 ─────────────────────────────────────
const delivered = await channel.client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, { timeout: 10_000 })
if (delivered.isError) throw new Error(`投递失败：${textOf(delivered)}`)
const deliveredText = textOf(delivered)
if (!deliveredText.includes('冒烟：请审查统一通道服务器')) throw new Error('投递正文缺失')
if (!deliveredText.includes('【真实用户消息处理完后进入 check_messages 待命】')) throw new Error('真实消息回合标记缺失')
if (!deliveredText.includes('CH-1：可见回复后 record_reply')) throw new Error('紧凑回复循环提醒缺失')
if (!deliveredText.includes('[轮次 #1 · 队列剩余 0 条]')) throw new Error('轮次后缀缺失')

repository.enqueueOutbound('1', '第二条消息', 2_000)
const fenced = await channel.client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, { timeout: 10_000 })
if (!fenced.isError) throw new Error('回复同步守门未生效')
const fencedPayload = JSON.parse(textOf(fenced)) as { needReplySync?: boolean }
if (fencedPayload.needReplySync !== true) throw new Error(`守门返回结构异常：${textOf(fenced)}`)

const recorded = await channel.client.callTool({
  name: 'record_reply',
  arguments: { channel_id: '1', content: '冒烟回复：审查完成，无阻塞问题。' }
}, { timeout: 10_000 })
if (recorded.isError) throw new Error(`record_reply 失败：${textOf(recorded)}`)
if ((recorded.structuredContent as { ok?: boolean })?.ok !== true) throw new Error('record_reply 未返回 ok')

const second = await channel.client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, { timeout: 10_000 })
if (second.isError || !textOf(second).includes('第二条消息')) {
  throw new Error(`守门放行后投递失败：${textOf(second)}`)
}

const presence = repository.getPresence('1')
if (!presence || presence.deliveredCount !== 2 || presence.turnCount < 3) {
  throw new Error(`presence 计数异常：${JSON.stringify(presence)}`)
}
if (Date.now() - presence.lastSeenAt > 10_000) throw new Error('presence 心跳未刷新')
await channel.close()
if (!channel.stderr().includes('[sg-team-mcp] ready unified')) {
  throw new Error(`统一服务器就绪日志缺失：${channel.stderr()}`)
}

// ── 工具面按工作区分组状态启停（阶段 4 · 4A）────────────────────────
// 无协作组：团队工具不在 tools/list 里，按名字硬调也被 SDK 以「disabled」拒绝（模型根本看不到它们）。
const team = await openUnifiedClient('1')
const hiddenCheckIn = await team.client.callTool({ name: 'team_check_in', arguments: { channel_id: '1' } }, { timeout: 10_000 })
  .then(() => undefined, (error: unknown) => error)
if (!(hiddenCheckIn instanceof Error) || !/team_check_in/.test(hiddenCheckIn.message)) {
  throw new Error(`无协作组时团队工具应不可调用：${String(hiddenCheckIn)}`)
}

// 操作员建组：拾光同时向成员投递成员关系通知；成员的 check_messages 返回前重新探测，
// list_changed 先于通知正文到达客户端，客户端重拉后看到全部 9 个工具。
const synced = await team.client.callTool({
  name: 'record_reply',
  arguments: { channel_id: '1', content: '冒烟回复：第二条已处理。' }
}, { timeout: 10_000 })
if (synced.isError) throw new Error(`record_reply 失败：${textOf(synced)}`)
const groupName = '冒烟组'
teamRepository.createGroup({
  runId: bundle.run.id,
  name: groupName,
  goal: '通道冒烟',
  leadSlotId: bundle.slots[0]!.id,
  members: [{ slotId: bundle.slots[0]!.id, roleTemplateKey: 'lead' }]
})
repository.enqueueOutbound('1', `${MEMBERSHIP_NOTICE_PREFIX}你（CH-1）已加入协作组「${groupName}」`, Date.now(), undefined, true, undefined, { kind: 'membership' })
const joined = await team.client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, { timeout: 10_000 })
if (joined.isError || !textOf(joined).includes('【成员关系通知协议】')) throw new Error(`成员关系通知投递失败：${textOf(joined)}`)
for (let attempt = 0; attempt < 200 && team.refreshedSurfaces.length === 0; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
if (JSON.stringify(team.refreshedSurfaces[0]) !== JSON.stringify(ALL_TOOLS)) {
  throw new Error(`建组后客户端应经 list_changed 重拉到全部工具：${JSON.stringify(team.refreshedSurfaces)}`)
}
const groupedTools = await team.toolNames()
if (JSON.stringify(groupedTools) !== JSON.stringify(ALL_TOOLS)) throw new Error(`建组后 tools/list 异常：${groupedTools.join(', ')}`)

// ── 团队工具同服：调用刷新通道 presence（S2 活性钩子保留）；入组席位直接拿到组简报 ──
// refreshIdentity 先于业务校验执行——即使业务拒绝（未入组席位 not_in_group），
// 活性也必须已刷新（工具被调用本身即 Agent 存活证据）。
const before = Date.now() - 60_000
repository.touchPresence('1', { lastSeenAt: before })
repository.touchPresence('2', { lastSeenAt: before })
const groupedCheckIn = await team.client.callTool({ name: 'team_check_in', arguments: { channel_id: '1' } }, { timeout: 10_000 })
if (groupedCheckIn.isError) throw new Error(`入组后 team_check_in 失败：${textOf(groupedCheckIn)}`)
const briefing = (groupedCheckIn.structuredContent as { briefing?: string })?.briefing ?? ''
if (!briefing.includes(`协作组「${groupName}」`)) throw new Error(`入组简报缺少组名：${briefing.slice(0, 200)}`)
const soloCheckIn = await team.client.callTool({ name: 'team_check_in', arguments: { channel_id: '2' } }, { timeout: 10_000 })
if (!soloCheckIn.isError || (soloCheckIn.structuredContent as { code?: string })?.code !== 'not_in_group') {
  throw new Error(`未入组席位调用团队工具应得到 not_in_group：${textOf(soloCheckIn)}`)
}
for (const channelId of ['1', '2']) {
  const touched = repository.getPresence(channelId)
  if (!touched || touched.lastSeenAt <= before) throw new Error(`统一服务器团队工具调用未刷新 CH-${channelId} 的 presence`)
}

// ── 团队消息随 check_messages 内联送达（阶段 4 · 4C）：MCP 进程直接读协作库，投递即已读，不开守门 ──
const collaboration = new SqliteTeamCollaborationRepository(databasePath)
const teamMessage = collaboration.createMessage({
  runId: bundle.run.id,
  sender: { type: 'operator' },
  recipient: { type: 'agent', slotId: bundle.slots[0]!.id },
  kind: 'directive',
  subject: '冒烟调度',
  content: '【冒烟】请按组目标开始。',
  clientMessageId: 'smoke:inline-team-message'
})
const inline = await team.client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } }, { timeout: 10_000 })
if (inline.isError) throw new Error(`团队消息内联投递失败：${textOf(inline)}`)
const inlineText = textOf(inline)
if (!inlineText.startsWith('【拾光团队消息】CH-1 · 1 条')) throw new Error(`团队消息标题缺失：${inlineText.slice(0, 120)}`)
if (!inlineText.includes('【冒烟】请按组目标开始。') || !inlineText.includes(`messageId: ${teamMessage.id}`)) {
  throw new Error(`团队消息正文缺失：${inlineText.slice(0, 300)}`)
}
if (inlineText.includes('【真实用户消息处理完后进入 check_messages 待命】')) throw new Error('团队消息不得套用用户消息协议')
const receipt = collaboration.loadRun(bundle.run.id).messages[teamMessage.id]?.receipt
if (receipt?.readAt === undefined || receipt.notificationState !== 'notified') {
  throw new Error(`投递后回执应为 notified + read：${JSON.stringify(receipt)}`)
}
if (repository.getPresence('1')?.pendingReplySyncSince !== undefined) throw new Error('团队消息不得打开回复守门')
collaboration.close()
await team.close()
teamRepository.close()
repository.close()

process.stdout.write(JSON.stringify({
  ok: true,
  ungroupedTools,
  groupedTools,
  deliveredWithCompactSuffix: true,
  channelIdentityInSuffix: true,
  replySyncGateEnforced: true,
  recordReplyReleased: true,
  secondDeliveryOk: true,
  presenceHeartbeatFresh: true,
  teamToolsHiddenWithoutGroup: true,
  teamToolsAppearViaListChanged: true,
  ungroupedSeatFenced: true,
  teamToolCallRefreshesPresence: true,
  groupedCheckInBriefed: true,
  teamMessageDeliveredInline: true
}, null, 2) + '\n')
