import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { createUnifiedChannelServer } from '../src/mcp/unified-channel-server'

/**
 * MCP 工具面契约（阶段 4）：Cursor 每一轮都把全部工具定义连同服务器 instructions 发给模型，
 * 这里锁住模型看到的形状——参数集合、动作枚举、JSON Schema 顶层形态与总体积。任何一项变化都该是
 * 有意的协议变更，并同步 docs/TASK-MCP.md 与两个 smoke。
 */
const DEFINITION_BUDGET_CHARS = 9_700

type ToolSchema = { type?: string; properties?: Record<string, { enum?: string[] }> }

async function listSurface() {
  const server = createUnifiedChannelServer({
    runtimeFor: () => { throw new Error('工具面测试不应触达团队运行时') },
    channelServiceFor: () => { throw new Error('工具面测试不应触达通道服务') }
  })
  const client = new Client({ name: 'sg-surface-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close()
    await server.close()
  }
}

describe('MCP 工具面契约', () => {
  it('每个工具的 inputSchema 顶层都是扁平 object：Anthropic 拒收顶层 oneOf / anyOf / allOf，一个坏工具会让整轮请求 400', async () => {
    for (const tool of await listSurface()) {
      const schema = tool.inputSchema as ToolSchema
      expect(schema.type, tool.name).toBe('object')
      for (const combinator of ['oneOf', 'anyOf', 'allOf', 'not']) {
        expect(schema, `${tool.name} 顶层不能有 ${combinator}`).not.toHaveProperty(combinator)
      }
    }
  })

  it('参数集合与动作枚举与协议文档一致', async () => {
    const surface = Object.fromEntries((await listSurface()).map((tool) => {
      const properties = (tool.inputSchema as ToolSchema).properties ?? {}
      const actions = properties.action?.enum ?? properties.view?.enum
      return [tool.name, { params: Object.keys(properties).sort(), ...(actions ? { actions } : {}) }]
    }))
    expect(surface).toEqual({
      check_messages: { params: ['channel_id', 'session', 'tick'] },
      record_reply: { params: ['channel_id', 'content', 'session', 'title'] },
      team_check_in: { params: ['channel_id', 'note'] },
      team_tasks: { params: ['channel_id', 'taskId', 'view'], actions: ['mine', 'available', 'reviews', 'board'] },
      team_task: {
        params: ['action', 'channel_id', 'output', 'progress', 'reason', 'summary', 'taskId', 'tasks'],
        actions: ['claim', 'start', 'progress', 'submit', 'fail', 'plan']
      },
      team_review: {
        params: ['action', 'channel_id', 'decision', 'evidence', 'reason', 'taskId'],
        actions: ['claim', 'submit']
      },
      team_message: {
        params: ['action', 'channel_id', 'clientMessageId', 'content', 'kind', 'limit', 'messageId', 'messageIds', 'recipientSlotId', 'subject', 'unreadOnly'],
        actions: ['inbox', 'read', 'send', 'respond', 'broadcast', 'collect']
      },
      team_memory: {
        params: ['action', 'channel_id', 'clientProposalId', 'content', 'decision', 'includeProposed', 'kind', 'kinds', 'limit', 'memoryId', 'note', 'query', 'sources', 'supersedesId', 'title'],
        actions: ['search', 'propose', 'review']
      },
      team_run: {
        params: ['action', 'channel_id', 'reason', 'targetSlotId'],
        actions: ['transfer_lead', 'claim_lead', 'clear_acting_lead']
      }
    })
  })

  it('工具定义总体积有上限：描述文字只能变短，要变长先改这个预算并说明理由', async () => {
    expect(JSON.stringify(await listSurface()).length).toBeLessThanOrEqual(DEFINITION_BUDGET_CHARS)
  })
})
