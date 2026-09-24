import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod/v4'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { createConfiguredTeamBundle } from '../src/domain/team-control'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { createTeamToolVisibility } from '../src/mcp/team-tool-visibility'
import { TEAM_TOOL_NAMES } from '../src/mcp/team-tools'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'

const COMMUNICATION_TOOLS = ['check_messages', 'record_reply']
const ALL_TOOLS = [...COMMUNICATION_TOOLS, ...TEAM_TOOL_NAMES].sort()

/**
 * 工具面按工作区分组状态启停（阶段 4 · 4A）：探针、切换与 list_changed 的契约，
 * 以及 SQLite 探针「活动 run 是否有活动协作组」的口径。
 */
describe('createTeamToolVisibility', () => {
  function bare() {
    const server = new McpServer({ name: 'visibility-test', version: '1.0.0' })
    const tools = ['a', 'b', 'c'].map((name) =>
      server.registerTool(name, { inputSchema: z.object({}) }, async () => ({ content: [] })))
    const notify = vi.spyOn(server, 'sendToolListChanged')
    return { server, tools, notify }
  }

  it('applies the probe at construction without a notification and toggles every tool with one list_changed per change', () => {
    const { server, tools, notify } = bare()
    let grouped = false
    const visibility = createTeamToolVisibility(server, tools, () => grouped)
    expect(visibility.visible).toBe(false)
    expect(tools.map((tool) => tool.enabled)).toEqual([false, false, false])
    expect(notify).not.toHaveBeenCalled()

    visibility.refresh()
    expect(notify).not.toHaveBeenCalled()

    grouped = true
    visibility.refresh()
    expect(visibility.visible).toBe(true)
    expect(tools.map((tool) => tool.enabled)).toEqual([true, true, true])
    expect(notify).toHaveBeenCalledTimes(1)

    grouped = false
    visibility.refresh()
    expect(tools.map((tool) => tool.enabled)).toEqual([false, false, false])
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('keeps the current surface when the probe throws and reports the error', () => {
    const { server, tools } = bare()
    const errors: unknown[] = []
    let grouped: boolean | Error = true
    const visibility = createTeamToolVisibility(server, tools, () => {
      if (grouped instanceof Error) throw grouped
      return grouped
    }, (error) => errors.push(error))
    expect(visibility.visible).toBe(true)

    grouped = new Error('database is locked')
    visibility.refresh()
    expect(visibility.visible).toBe(true)
    expect(tools.every((tool) => tool.enabled)).toBe(true)
    expect(errors).toHaveLength(1)

    // 起点为全部可见：构造时探测失败也不会藏起团队工具。
    const failing = createTeamToolVisibility(server, tools, () => { throw new Error('boom') })
    expect(failing.visible).toBe(true)
  })
})

describe('unified server tool surface follows the workspace group state', () => {
  async function fixture(teamToolsVisible?: () => boolean) {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-tool-surface-')), 'channel.sqlite3')
    const repository = new SqliteChannelMessageRepository(path)
    const service = new ChannelMessageService(repository)
    const server = createUnifiedChannelServer({
      runtimeFor: () => { throw new Error('工具面测试不应触达团队运行时') },
      channelServiceFor: () => service,
      keepaliveTimeoutMs: 1_000,
      teamToolsVisible
    })
    const refreshed: string[][] = []
    const client = new Client({ name: 'sg-surface-client', version: '1.0.0' }, {
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (!error && tools) refreshed.push(tools.map((tool) => tool.name).sort())
          }
        }
      }
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const names = async () => (await client.listTools()).tools.map((tool) => tool.name).sort()
    const waitForRefresh = async (count: number) => {
      for (let attempt = 0; attempt < 200 && refreshed.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return refreshed
    }
    return {
      repository, client, names, refreshed, waitForRefresh,
      close: async () => {
        await client.close()
        await server.close()
        repository.close()
      }
    }
  }

  it('exposes every tool when no probe is configured', async () => {
    const { names, close } = await fixture()
    try {
      expect(await names()).toEqual(ALL_TOOLS)
    } finally {
      await close()
    }
  })

  it('lists only the two communication tools for an ungrouped workspace, and a disabled team tool cannot be called', async () => {
    const { client, names, close } = await fixture(() => false)
    try {
      expect(await names()).toEqual(COMMUNICATION_TOOLS)
      await expect(client.callTool({ name: 'team_check_in', arguments: { channel_id: '1' } }))
        .rejects.toThrow(/team_check_in/)
    } finally {
      await close()
    }
  })

  it('re-probes before every check_messages return and announces the change with list_changed', async () => {
    let grouped = false
    const { repository, client, names, waitForRefresh, close } = await fixture(() => grouped)
    try {
      expect(await names()).toEqual(COMMUNICATION_TOOLS)

      // 建组 + 成员关系通知同时发生：通知随本次 check_messages 返回，工具面在返回前切换。
      grouped = true
      repository.enqueueOutbound('1', '【拾光成员关系通知】你（CH-1）已加入协作组「验收组」', 1_000, undefined, false, undefined, { kind: 'membership' })
      const joined = await client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } })
      expect(joined.isError).not.toBe(true)
      expect(await waitForRefresh(1)).toEqual([ALL_TOOLS])
      expect(await names()).toEqual(ALL_TOOLS)

      // 解散：下一次返回（这里是 keepalive）前再探测，团队工具收回。
      grouped = false
      const keepalive = await client.callTool({ name: 'check_messages', arguments: { channel_id: '1' } })
      expect(keepalive.isError).not.toBe(true)
      expect(await waitForRefresh(2)).toEqual([ALL_TOOLS, COMMUNICATION_TOOLS])
      expect(await names()).toEqual(COMMUNICATION_TOOLS)
    } finally {
      await close()
    }
  })
})

describe('SqliteTeamControlRepository.hasActiveGroup', () => {
  it('is true only while the newest run of the active workspace is running with at least one active group', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sg-active-group-')), 'team.sqlite3')
    const control = new SqliteTeamControlRepository(path)
    try {
      expect(control.hasActiveGroup()).toBe(false)
      const bundle = createConfiguredTeamBundle({
        workspaceId: 'pool', workspaceName: 'pool', workspacePath: '/workspace/pool', now: 100,
        mode: 'independent', runKey: 'run-pool',
        members: ['1', '2'].map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }))
      })
      control.upsertWorkspaceTeam(bundle)
      expect(control.hasActiveGroup()).toBe(false)

      const slotIdOf = (channelId: string) => bundle.slots.find((slot) => slot.channelId === channelId)!.id
      const first = control.createGroup({
        runId: bundle.run.id, name: 'A 组', leadSlotId: slotIdOf('1'),
        members: [{ slotId: slotIdOf('1'), roleTemplateKey: 'lead' }]
      }).group
      expect(control.hasActiveGroup()).toBe(true)
      const second = control.createGroup({
        runId: bundle.run.id, name: 'B 组', leadSlotId: slotIdOf('2'),
        members: [{ slotId: slotIdOf('2'), roleTemplateKey: 'lead' }]
      }).group

      control.dissolveGroup({ groupId: first.id })
      expect(control.hasActiveGroup()).toBe(true)
      control.dissolveGroup({ groupId: second.id })
      expect(control.hasActiveGroup()).toBe(false)

      control.createGroup({
        runId: bundle.run.id, name: 'C 组', leadSlotId: slotIdOf('1'),
        members: [{ slotId: slotIdOf('1'), roleTemplateKey: 'lead' }]
      })
      expect(control.hasActiveGroup()).toBe(true)
      control.completeRun(bundle.run.id, 200)
      expect(control.hasActiveGroup()).toBe(false)
    } finally {
      control.close()
    }
  })
})
