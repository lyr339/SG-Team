import { isAbsolute } from 'node:path'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { TaskAgentService } from '../application/task-agent-service'
import { SqliteTaskPoolRepository } from '../infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamControlRepository } from '../infrastructure/team-control/sqlite-team-control-repository'
import { SqliteTeamCollaborationRepository } from '../infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { TeamCollaborationAgentService } from '../application/team-collaboration-agent-service'
import { SqliteTeamMemoryRepository } from '../infrastructure/team-memory/sqlite-team-memory-repository'
import { TeamMemoryAgentService } from '../application/team-memory-agent-service'
import { SqliteChannelMessageRepository } from '../infrastructure/channel-messages/sqlite-channel-message-repository'
import { ChannelMessageService } from '../application/channel-message-service'
import { createChannelTeamInbox } from '../application/channel-team-inbox'
import { buildTeamRoleBriefing, effectiveGroupLeadSlotId, groupMembersMayPlan } from '../domain/team-control'
import { TaskPoolError } from '../domain/task-pool'
import { isPresenceOnline, resolveKeepaliveTimeoutMs } from '../domain/channel-message'
import { createUnifiedChannelServer } from './unified-channel-server'
import type { TeamChannelRuntime } from './team-tools'

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim() || ''
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function databasePathOf(): string {
  const databasePath = requiredEnvironment('SG_TEAM_DB')
  if (!isAbsolute(databasePath)) throw new Error('SG_TEAM_DB 必须是绝对路径')
  return databasePath
}

/**
 * 拾光单一 MCP 服务器进程：
 * 一条「SG Team」条目承载团队工具 + 通信保活工具，channel_id 区分通道；
 * 运行时按通道懒加载缓存，身份每次调用前实时解析（团队换届零配置重写）。
 */
async function serveUnified(databasePath: string): Promise<void> {
  const repository = new SqliteTaskPoolRepository(databasePath)
  const teamRepository = new SqliteTeamControlRepository(databasePath)
  const collaborationRepository = new SqliteTeamCollaborationRepository(databasePath)
  const memoryRepository = new SqliteTeamMemoryRepository(databasePath)
  const channelRepository = new SqliteChannelMessageRepository(databasePath)

  const runtimes = new Map<string, TeamChannelRuntime>()
  const channelServices = new Map<string, ChannelMessageService>()

  const runtimeFor = (channelId: string): TeamChannelRuntime => {
    const cached = runtimes.get(channelId)
    if (cached) return cached
    const standbyIdentity = {
      agentSessionId: `sg-team:ch-${channelId}:standby`,
      runId: 'runtime-unassigned',
      slotId: `standby-slot:${channelId}`,
      capabilities: [] as string[]
    }
    // 租约在岗判定（阶段 2 · 2F）：agentSessionId → 绑定通道 → presence，与主进程清扫器同一口径。
    // 只有到期的租约才会问到这里，所以每次现查 bindings 足够便宜。
    const holderOnline = (agentSessionId: string): boolean => {
      const binding = teamRepository.loadTeamControl().bindings
        .find((candidate) => candidate.agentSessionId === agentSessionId)
      return binding !== undefined && isPresenceOnline(channelRepository.getPresence(binding.channelId), Date.now())
    }
    const service = new TaskAgentService(repository, standbyIdentity, repository, teamRepository, holderOnline)
    const collaboration = new TeamCollaborationAgentService(
      collaborationRepository,
      { ...standbyIdentity },
      service
    )
    const memory = new TeamMemoryAgentService(
      memoryRepository,
      collaborationRepository,
      collaboration.identity
    )
    const runtime: TeamChannelRuntime = {
      service,
      collaboration,
      memory,
      controlRepository: teamRepository,
      isChannelOnline: (targetChannelId) => {
        // 与主进程 relay 同一判定（domain 收口）：终止相位 + processing 三段窗口。
        // CDP 探测写入的 runtimeActiveAt 让长任务期间通道保持可达。
        return isPresenceOnline(channelRepository.getPresence(targetChannelId), Date.now())
      },
      channelPresence: (targetChannelId) => channelRepository.getPresence(targetChannelId)
    }
    runtimes.set(channelId, runtime)
    return runtime
  }

  // 工具调用即活性证据；身份换届在调用间实时生效，无需重启进程。
  // 纯心跳写入会在 repository.touchPresence 内自动清除残留终止相位。
  const refreshIdentity = (channelId: string): void => {
    try {
      channelRepository.touchPresence(channelId, { lastSeenAt: Date.now() })
    } catch (error) {
      process.stderr.write(`[sg-team-mcp] presence 刷新失败：${error instanceof Error ? error.message : String(error)}\n`)
    }
    const runtime = runtimeFor(channelId)
    const identity = teamRepository.resolveChannelAgentIdentity(channelId)
    Object.assign(runtime.service.identity, identity)
    if (runtime.collaboration) Object.assign(runtime.collaboration.identity, identity)
  }

  const briefingFor = (channelId: string): string | undefined => {
    const runtime = runtimeFor(channelId)
    const identity = runtime.service.identity
    const state = teamRepository.loadTeamControl()
    const run = state.runs.find((candidate) => candidate.id === identity.runId)
    const slot = state.slots.find((candidate) => candidate.runId === identity.runId && candidate.id === identity.slotId)
    const role = slot
      ? state.roles.find((candidate) => candidate.runId === identity.runId && candidate.id === slot.roleId)
      : undefined
    const binding = state.bindings.find((candidate) => candidate.runId === identity.runId && candidate.slotId === identity.slotId)
    if (!run || !slot || !role || !binding) return undefined
    // 简报只对入组席位存在：目标、lead 与权限都以组行为准（lead 与角色模板解耦）。未入组席位在 refreshIdentity
    // 已得到 not_in_group，走不到这里；legacy 团队 run 已归档（阶段 2 · 2B），没有 run 级 lead 简报。
    const group = slot.groupId ? state.groups.find((candidate) => candidate.id === slot.groupId) : undefined
    if (!group) return undefined
    const members = state.slots.filter((candidate) => candidate.groupId === group.id)
    const effectiveLeadSlotId = effectiveGroupLeadSlotId(group)
    const leadSlot = members.find((candidate) => candidate.id === effectiveLeadSlotId)
    const leadRole = leadSlot ? state.roles.find((candidate) => candidate.id === leadSlot.roleId) : undefined
    const leadBinding = leadSlot ? state.bindings.find((candidate) => candidate.runId === run.id && candidate.slotId === leadSlot.id) : undefined
    return buildTeamRoleBriefing({
      run,
      role,
      slot,
      binding,
      effectiveLead: slot.id === effectiveLeadSlotId,
      originalLeadDemoted: role.templateKey === 'lead' && effectiveLeadSlotId !== undefined && slot.id !== effectiveLeadSlotId,
      group: {
        name: group.name,
        goal: group.goal,
        leadLabel: leadSlot ? `${leadRole?.name ?? '主控'} · CH-${leadBinding?.channelId ?? leadSlot.channelId ?? '?'}` : undefined,
        memberCount: members.length,
        membersMayPlan: groupMembersMayPlan(group)
      }
    })
  }

  // 团队消息随 check_messages 内联投递（阶段 4 · 4C）：MCP 进程直接从 SQLite 取本席位的未读消息，
  // 不再依赖桌面端把信封写进 outbox——桌面端关着时团队消息照样送达。
  const teamInbox = createChannelTeamInbox({
    ownershipFor: (channelId) => teamRepository.resolveChannelSessionOwner(channelId),
    collaboration: collaborationRepository
  })

  const channelServiceFor = (channelId: string): ChannelMessageService => {
    const cached = channelServices.get(channelId)
    if (cached) return cached
    const service = new ChannelMessageService(channelRepository, teamInbox)
    channelServices.set(channelId, service)
    return service
  }

  // keepalive 窗口：默认 5 分钟（domain 常量）；mcp.json 的 env.SG_TEAM_KEEPALIVE_MS 可覆盖，
  // 越界/非法回落默认，作为不重新打包即可回退到 60s 的开关。
  const keepaliveTimeoutMs = resolveKeepaliveTimeoutMs(process.env.SG_TEAM_KEEPALIVE_MS)
  const handle = serveStdio(() => createUnifiedChannelServer({
    runtimeFor,
    channelServiceFor,
    keepaliveTimeoutMs,
    // 会话围栏：通道在当前活动 run 内的席位归属；查询异常由工具层按「无法判定」放行。
    ownershipFor: (channelId) => teamRepository.resolveChannelSessionOwner(channelId),
    refreshIdentity: (channelId) => {
      try {
        refreshIdentity(channelId)
      } catch (error) {
        // 未注册/未接替属正常待机：保留 standby 身份，由调用时围栏拒绝业务操作。
        // 注意 run_completed / not_in_group 有意不在容忍名单里——它们必须直接
        // 传播为工具结果，让模型得到「run 已结束 / 未入组」的指引而非笼统报错；
        // 出组后残留在运行时里的旧 groupId 也因此永不会被业务操作用到（刷新失败即返回）。
        if (!(error instanceof TaskPoolError)
          || (error.code !== 'standby_not_assigned' && error.code !== 'agent_not_authorized')) {
          throw error
        }
      }
    },
    briefingFor
  }), {
    onerror: (error) => process.stderr.write(`[sg-team-mcp] ${error.stack ?? error.message}\n`)
  })

  process.stderr.write(`[sg-team-mcp] ready unified (keepalive ${Math.round(keepaliveTimeoutMs / 1_000)}s)\n`)

  let closing = false
  async function shutdown(): Promise<void> {
    if (closing) return
    closing = true
    try {
      await handle.close()
    } finally {
      channelRepository.close()
      memoryRepository.close()
      collaborationRepository.close()
      teamRepository.close()
      repository.close()
    }
  }
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
}

// 只有一种服务器角色；启动时的全局注册器写入 unified，缺省亦按 unified。
const role = process.env.SG_TEAM_SERVER_ROLE?.trim() || 'unified'
if (role !== 'unified') throw new Error(`SG_TEAM_SERVER_ROLE 无效：${role}`)
await serveUnified(databasePathOf())
