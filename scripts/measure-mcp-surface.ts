/**
 * MCP 工具面度量（阶段 4 验收工具，CI 不跑）：对构建产物 out/mcp/index.mjs 走真实 stdio，
 * 在「会话池无分组」与「有一个协作组」两种状态下统计 Cursor 每轮吃进去的固定预付——
 * 工具定义（tools/list 原样 JSON）与服务器 instructions，外加三种角色的 team_check_in 简报体积。
 *
 * token 为粗估：CJK 字符 × 0.7 + 其余字符 ÷ 4（按 2026-09-13 基线的口径校准），只用于前后对比。
 *
 * 运行：npm run build:mcp && npm run measure:mcp
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { SqliteTaskPoolRepository } from '../src/infrastructure/task-pool/sqlite-task-pool-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'
import { createConfiguredTeamBundle } from '../src/domain/team-control'

const CJK = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/g

function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return Math.round(cjk * 0.7 + (text.length - cjk) / 4)
}

interface ToolDefinition {
  name: string
  inputSchema?: { properties?: Record<string, { enum?: unknown[] }> }
}

function actionPaths(tool: ToolDefinition): number {
  const properties = tool.inputSchema?.properties ?? {}
  return (properties.action?.enum ?? properties.view?.enum)?.length ?? 1
}

function parameterSlots(tool: ToolDefinition): number {
  return Object.keys(tool.inputSchema?.properties ?? {}).length
}

const directory = mkdtempSync(join(tmpdir(), 'sg-team-mcp-measure-'))
const databasePath = join(directory, 'task-pool.sqlite3')
const mcpServerPath = resolve('out/mcp/index.mjs')
const bundle = createConfiguredTeamBundle({
  workspaceId: 'measure',
  workspaceName: 'measure',
  workspacePath: join(directory, 'workspace'),
  mode: 'independent',
  runKey: 'run-measure',
  members: ['1', '2', '3'].map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true })),
  now: Date.now()
})
const teamRepository = new SqliteTeamControlRepository(databasePath)
teamRepository.upsertWorkspaceTeam(bundle)
teamRepository.recordInstallation({
  workspaceId: 'measure',
  generation: 'generation1',
  runId: bundle.run.id,
  agents: bundle.slots.map((slot) => ({
    agentSessionId: `measure:ch-${slot.channelId}:generation1`,
    workspaceId: 'measure',
    channelId: slot.channelId!,
    generation: 'generation1',
    runId: bundle.run.id,
    capabilities: []
  }))
})
new SqliteTaskPoolRepository(databasePath).close()

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
)

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    env: { ...inheritedEnvironment, SG_TEAM_DB: databasePath },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'sg-team-measure', version: '1.0.0' })
  await client.connect(transport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await transport.close().catch(() => undefined)
  }
}

async function surface(label: string) {
  return withClient(async (client) => {
    const { tools } = await client.listTools()
    const instructions = client.getInstructions() ?? ''
    const definitions = JSON.stringify(tools)
    return {
      label,
      tools: tools.length,
      actionPaths: (tools as ToolDefinition[]).reduce((sum, tool) => sum + actionPaths(tool), 0),
      parameterSlots: (tools as ToolDefinition[]).reduce((sum, tool) => sum + parameterSlots(tool), 0),
      definitionChars: definitions.length,
      definitionTokens: estimateTokens(definitions),
      instructionChars: instructions.length,
      instructionTokens: estimateTokens(instructions),
      fixedTokensPerTurn: estimateTokens(definitions) + estimateTokens(instructions),
      perTool: tools.map((tool) => ({ name: tool.name, chars: JSON.stringify(tool).length, tokens: estimateTokens(JSON.stringify(tool)) }))
    }
  })
}

const independent = await surface('会话池 · 无分组')

const slotOf = (channelId: string) => bundle.slots.find((slot) => slot.channelId === channelId)!
teamRepository.createGroup({
  runId: bundle.run.id,
  name: '度量组',
  goal: '度量 MCP 工具面',
  leadSlotId: slotOf('1').id,
  members: [
    { slotId: slotOf('1').id, roleTemplateKey: 'lead' },
    { slotId: slotOf('2').id, roleTemplateKey: 'builder' },
    { slotId: slotOf('3').id, roleTemplateKey: 'reviewer' }
  ]
})
teamRepository.close()

const grouped = await surface('会话池 · 一个协作组')
const briefings = await withClient(async (client) => {
  const sizes: Record<string, { chars: number; tokens: number }> = {}
  for (const [role, channelId] of [['lead', '1'], ['builder', '2'], ['reviewer', '3']] as const) {
    const result = await client.callTool({ name: 'team_check_in', arguments: { channel_id: channelId } })
    const briefing = String((result.structuredContent as { briefing?: string } | undefined)?.briefing ?? '')
    sizes[role] = { chars: briefing.length, tokens: estimateTokens(briefing) }
  }
  return sizes
})

const row = (item: typeof independent) =>
  `| ${item.label} | ${item.tools} | ${item.actionPaths} | ${item.parameterSlots} | ${item.definitionChars} ≈ ${item.definitionTokens} | ${item.instructionChars} ≈ ${item.instructionTokens} | ≈ ${item.fixedTokensPerTurn} |`

process.stdout.write([
  '| 状态 | 工具 | 动作路径 | 参数槽 | 工具定义 字符 ≈ tokens | instructions 字符 ≈ tokens | 每轮固定预付 tokens |',
  '|---|---|---|---|---|---|---|',
  row(independent),
  row(grouped),
  '',
  `team_check_in 简报：${Object.entries(briefings).map(([role, size]) => `${role} ${size.chars} 字符 ≈ ${size.tokens} tokens`).join(' · ')}`,
  '',
  JSON.stringify({ independent, grouped, briefings }, null, 2),
  ''
].join('\n'))
