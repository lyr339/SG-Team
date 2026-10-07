import { NOTIFICATION_SOURCE_BATCH_LIMIT, validateNotificationDraft, type NotificationDraft, type NotificationScope } from './notification'
const tools = ['team_check_in', 'team_tasks', 'team_task', 'team_review', 'team_message', 'team_memory', 'team_run'] as const
export type UnattributedMcpTool = typeof tools[number]
/** Exact native envelope flag + exact SG namespace. No prose inference, arguments, reason or business actor. */
export function unattributedMcpTool(toolName: string, resultError: boolean | undefined, output: string | undefined, input?: Record<string, unknown>): UnattributedMcpTool | undefined {
  const match = /^mcp-SG Team-(team_check_in|team_tasks|team_task|team_review|team_message|team_memory|team_run)$/.exec(toolName)
  if (!match || resultError !== true || output !== undefined && output.length > 12200) return
  // Only check native server/tool metadata for contradictions. Arguments still
  // cannot establish a validated channel, operation, entity or business actor.
  for (const field of ['providerIdentifier', 'server', 'serverName'])
    if (input?.[field] !== undefined && input[field] !== 'SG Team') return
  if (input?.toolName !== undefined && input.toolName !== match[1]) return
  try {
    const payload: unknown = output ? JSON.parse(output) : undefined
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const p = payload as Record<string, unknown>
      // Existing machine SG outcomes, including ordinary refusals, stay in their
      // original path. This diagnostic cannot turn them into an unknown actor.
      if (typeof p.ok === 'boolean' && typeof p.agentSessionId === 'string' && p.agentSessionId.length > 0 && p.agentSessionId.length <= 300) return
    }
  } catch { /* SDK errors may be plain content; their error flag, not this text, is the evidence. */ }
  return match[1] as UnattributedMcpTool
}
export interface UnattributedMcpFact { identity: string; family: string; tool: UnattributedMcpTool; scope: NotificationScope; blockId: string; entryId?: string; at: number }
export interface UnattributedMcpInput { key: string; facts: UnattributedMcpFact[]; signature: string; monitorStartedAt: number }
/** Intermediate reducer state only; persisted in the existing MCP write checkpoint, not a second source. */
export interface UnattributedMcpState { version: 1; key: string; seen: string[]; families: string[]; baselineAt?: number }
export function reduceUnattributedMcpCalls(old: UnattributedMcpState | undefined, input: UnattributedMcpInput, baseline: boolean, revision: number, limit = NOTIFICATION_SOURCE_BATCH_LIMIT) {
  const seen = new Set(old?.seen), families = new Set(old?.families), drafts: NotificationDraft[] = []
  const baselineAt = old?.baselineAt ?? (baseline ? input.monitorStartedAt : undefined)
  if (baselineAt !== undefined && (!Number.isSafeInteger(baselineAt) || baselineAt < 0)) throw Error('未归属 MCP 启动边界无效')
  let complete = true
  for (const fact of input.facts) {
    if (![fact.identity, fact.family].every(id => /^[a-f0-9]{64}$/.test(id)) || !tools.includes(fact.tool) || !Number.isSafeInteger(fact.at) || fact.at < 0) throw Error('未归属 MCP 原事实无效')
    if (seen.has(`~${fact.identity}`) || seen.has(fact.identity)) continue
    // Persist the first activation's boundary across batches, ACK/CAS reloads
    // and restarts. A later restart must not swallow newer missed invocations.
    const stock = baselineAt !== undefined && fact.at < baselineAt
    if (!stock && drafts.length >= limit) { complete = false; break }
    seen.add(`~${fact.identity}`)
    if (stock) continue
    const attention = !families.has(fact.family); families.add(fact.family)
    drafts.push({ key: `mcp-unattributed:${fact.identity}`, eventId: `mcp-unattributed:${fact.identity}`, eventType: 'mcp.call-unattributed', subjectState: 'call-error-unattributed',
      category: 'maintenance', source: 'MCP 工具', title: '工具返回错误，需查看原结果',
      detail: `${fact.tool}\n原生 MCP 结果明确带有错误标志，但没有可验证的业务主体与回执。这里只保留观察到的工具结果，不把参数中的通道或当前席位当成调用主体。\n不能据此判断失败发生在校验前、原操作未执行、事务已回滚或任务已失败；请打开原工具核对。通知不会重试、重放或修改业务。`,
      // Workspace/run below identify ONLY the verified native observation, not a business caller/entity.
      scope: { workspaceId: fact.scope.workspaceId, runId: fact.scope.runId },
      target: { kind: 'session', scope: fact.scope, blockId: fact.blockId, ...(fact.entryId ? { entryId: fact.entryId } : {}) },
      origin: { module: 'sessions', sessionId: fact.scope.sessionId }, tone: 'warning', attention: attention ? 'notice' : 'activity', state: 'active',
      occurredAt: fact.at, timeBasis: 'observed', sourceRevision: revision, announce: !baseline && attention && fact.at >= input.monitorStartedAt, renewAttention: attention })
  }
  if (seen.size > 20000 || families.size > 10000) throw Error('未归属 MCP 观察超出有界容量，历史保留')
  drafts.forEach(validateNotificationDraft)
  return { state: { version: 1 as const, key: input.key, seen: [...seen], families: [...families], ...(baselineAt === undefined ? {} : { baselineAt }) }, drafts, complete }
}
