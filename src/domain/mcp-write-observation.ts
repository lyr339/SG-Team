/** Additive observation only. Never a retry grant, permission or business command. */
export interface McpWriteFailureHint {
  version: 1
  reason: 'storage' | 'permission' | 'timeout'
}
export function mcpWriteFailureHint(error: unknown): McpWriteFailureHint | undefined {
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (typeof code !== 'string') return
    const sqlite =
      code === 'ERR_SQLITE_ERROR' &&
      'errcode' in (error as object) &&
      typeof (error as { errcode?: unknown }).errcode === 'number' &&
      [5, 6, 8, 10, 13, 14].includes((error as { errcode: number }).errcode)
    const reason =
      code === 'EACCES' || code === 'EPERM'
        ? 'permission'
        : code === 'ETIMEDOUT'
          ? 'timeout'
          : sqlite || ['SQLITE_BUSY', 'SQLITE_LOCKED', 'ENOSPC', 'EROFS', 'EIO'].includes(code)
            ? 'storage'
            : undefined
    return reason ? { version: 1, reason } : undefined
  } catch {
    return undefined
  }
}
/** Existing tool JSON only, from an exact native SG Team invocation; no log/body heuristic. */
export interface McpWriteObservation {
  tool: 'team_task' | 'team_review' | 'team_message' | 'team_memory' | 'team_run'
  action: string
  channelId: string
  agentSessionId: string
  status: 'unconfirmed' | 'secondary-unconfirmed' | 'returned'
  reason: 'storage' | 'permission' | 'timeout' | 'unclassified' | 'coordination'
  entity?: { kind: 'task' | 'memory' | 'message'; id: string }
}
const actions: Record<McpWriteObservation['tool'], readonly string[]> = {
  team_task: ['claim', 'start', 'progress', 'submit', 'fail', 'plan'],
  team_review: ['claim', 'submit'],
  team_message: ['send', 'respond', 'broadcast'],
  team_memory: ['propose', 'review'],
  team_run: ['transfer_lead', 'claim_lead', 'clear_acting_lead']
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
const id = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : undefined
/** Bounded native receipt metadata only, not prose interpretation or an execution grant. */
export function validMcpWriteReadProof(value: unknown): value is McpWriteObservation {
  const proof = object(value)
  if (!proof || !Object.keys(proof).every(key => ['tool', 'action', 'channelId', 'agentSessionId', 'status', 'reason', 'entity'].includes(key))
    || typeof proof.tool !== 'string' || !Object.hasOwn(actions, proof.tool) || typeof proof.action !== 'string' || !actions[proof.tool as McpWriteObservation['tool']]!.includes(proof.action)
    || !id(proof.channelId) || !/^\d+$/.test(proof.channelId as string) || !id(proof.agentSessionId)
    || typeof proof.status !== 'string' || !['unconfirmed', 'secondary-unconfirmed', 'returned'].includes(proof.status)
    || typeof proof.reason !== 'string' || !['storage', 'permission', 'timeout', 'unclassified', 'coordination'].includes(proof.reason)) return false
  const entity = proof.entity === undefined ? undefined : object(proof.entity)
  return proof.entity === undefined || Boolean(entity && Object.keys(entity).every(key => ['kind', 'id'].includes(key)) && typeof entity.kind === 'string' && ['task', 'memory', 'message'].includes(entity.kind) && id(entity.id))
}
export function mcpWriteReadIdentity(proof: McpWriteObservation): string {
  return JSON.stringify([proof.tool, proof.action, proof.channelId, proof.agentSessionId, proof.status, proof.reason, proof.entity?.kind ?? null, proof.entity?.id ?? null])
}
export function observedMcpWrite(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: string | undefined
): McpWriteObservation | undefined {
  const match = /^mcp-SG Team-(team_task|team_review|team_message|team_memory|team_run)$/.exec(toolName)
  if (!match || !output || output.length > 12000) return
  const tool = match[1] as McpWriteObservation['tool']
  // Prefer the native invocation envelope. A malformed envelope must not fall
  // through to a convenient top-level action or a different argument alias.
  const nested = [input?.args, input?.arguments, input?.parameters].find(value => value !== undefined)
  let args = nested === undefined ? input : object(nested)
  if (typeof nested === 'string' && nested.length <= 30000) {
    try { args = object(JSON.parse(nested)) } catch { return }
  }
  for (const name of ['providerIdentifier', 'server', 'serverName'])
    if (input?.[name] !== undefined && input[name] !== 'SG Team') return
  if (input?.toolName !== undefined && input.toolName !== tool) return
  const action = typeof args?.action === 'string' ? args.action : undefined
  const channelId = id(args?.channel_id)
  if (!action || !actions[tool].includes(action) || !channelId || !/^\d+$/.test(channelId)) return
  let payload: Record<string, unknown> | undefined
  try {
    payload = object(JSON.parse(output))
  } catch {
    return
  }
  if (!payload || typeof payload.ok !== 'boolean' || !id(payload.agentSessionId)) return
  const hint = object(payload.sgWriteFailure)
  const reason =
    hint?.version === 1 &&
    typeof hint.reason === 'string' &&
    ['storage', 'permission', 'timeout'].includes(hint.reason)
      ? (hint!.reason as McpWriteObservation['reason'])
      : undefined
  if (payload.ok === false && payload.code !== 'internal_error' && !reason) return // Ordinary authorisation/input/domain refusals stay at their original point.
  const secondary =
    payload.ok === true &&
    ((typeof payload.coordinationWarning === 'string' && payload.coordinationWarning.length > 0) ||
      (typeof payload.recoveryWarning === 'string' && payload.recoveryWarning.length > 0) ||
      (typeof payload.auditWarning === 'string' && payload.auditWarning.length > 0))
  const kind =
    tool === 'team_task' || tool === 'team_review'
      ? 'task'
      : tool === 'team_memory'
        ? 'memory'
        : tool === 'team_message'
          ? 'message'
          : undefined
  const original = kind ? object(payload[kind]) : undefined
  const returnedEntity = object(original?.task) ?? original ?? object(object(payload.assignment)?.task) ?? object(object(payload.review)?.task)
  const requestedId = id(kind === 'task' ? args?.taskId : kind === 'memory' ? args?.memoryId : kind === 'message' ? args?.messageId : undefined)
  if (kind !== 'message' && requestedId && id(returnedEntity?.id) && requestedId !== returnedEntity!.id) return
  const entityId =
    requestedId ?? id(returnedEntity?.id)
  // A null/missing result is not confirmation that a mutation succeeded.
  const returned =
    payload.ok === true &&
    payload.action === action &&
    Boolean((kind && returnedEntity && id(returnedEntity.id)) || (tool === 'team_run' && id(payload.actingLeadSlotId)))
  if (payload.ok === true && !returned) return
  return {
    tool,
    action,
    channelId,
    agentSessionId: payload.agentSessionId as string,
    status: payload.ok === false ? 'unconfirmed' : secondary ? 'secondary-unconfirmed' : 'returned',
    reason: secondary ? 'coordination' : reason ?? 'unclassified',
    ...(kind && entityId ? { entity: { kind, id: entityId } } : {})
  }
}
