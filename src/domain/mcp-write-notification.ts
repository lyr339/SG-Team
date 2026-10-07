import {
  NOTIFICATION_SOURCE_BATCH_LIMIT,
  validateNotificationDraft,
  type NotificationDraft,
  type NotificationScope,
  type NotificationRecord
} from './notification'
import type { UnattributedMcpFact } from './mcp-unattributed-call'
import type { McpWriteObservation } from './mcp-write-observation'
export interface McpWriteFact extends McpWriteObservation {
  identity: string
  attentionKey: string
  blockId: string
  entryId?: string
  at: number
  name: string
  scope: NotificationScope
}
export interface McpWriteInput {
  key: string
  facts: McpWriteFact[]
  calls?: UnattributedMcpFact[]
  now: number
  monitorStartedAt: number
  signature: string
}
export interface McpWriteState {
  version: 1 | 2
  key: string
  seen: string[]
  attentionFamilies?: string[]
  /** First activation's cold-stock boundary for native calls without a business receipt. */
  unattributedBaselineAt?: number
}
export function readMcpWriteState(value: unknown, key: string): McpWriteState | undefined {
  if (value === undefined) return
  const s = value as McpWriteState
  if (
    !s ||
    ![1, 2].includes(s.version) ||
    s.key !== key ||
    !Array.isArray(s.seen) ||
    s.seen.length > 20000 ||
    s.seen.some((id) => typeof id !== 'string' || !(s.version === 1 ? /^[a-f0-9]{64}$/ : /^~?[a-f0-9]{64}$/).test(id)) ||
    new Set(s.seen.map(id => id.replace(/^~/, ''))).size !== s.seen.length ||
    (s.attentionFamilies !== undefined && (!Array.isArray(s.attentionFamilies) || s.attentionFamilies.length > 10000 ||
      s.attentionFamilies.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) ||
    (s.unattributedBaselineAt !== undefined && (!Number.isSafeInteger(s.unattributedBaselineAt) || s.unattributedBaselineAt < 0))
  )
    throw Error('MCP 写观察检查点无效')
  return s
}
const verbs: Record<McpWriteObservation['tool'], string> = {
  team_task: '任务操作',
  team_review: '任务审核',
  team_message: '协作写入',
  team_memory: '记忆写入',
  team_run: '主控变更'
}
const reasons: Record<McpWriteObservation['reason'], string> = {
  storage: '原入口报告存储读写异常；未据此推断事务已回滚或完全未执行。',
  permission: '原入口报告本机访问权限不足；原写入结果未确认。',
  timeout: '原入口没有及时返回确认；超时不是未执行的证明。',
  coordination: '原操作返回了结果，但原协调／审计步骤没有确认；不能因此重做已经返回的操作。',
  unclassified: '原入口返回未分类异常；原因见原工具结果。'
}
/** One prefix byte denotes inspected native identity, not historical proof or a human receipt. */
export function legacyMcpWriteCandidates(previous: McpWriteState | undefined, input: McpWriteInput): McpWriteFact[] {
  if (!previous || !previous.seen.some(id => !id.startsWith('~'))) return []
  const seen = new Set(previous?.seen)
  return input.facts.filter(f => f.status !== 'returned' && seen.has(f.identity)).slice(0, NOTIFICATION_SOURCE_BATCH_LIMIT)
}
export type McpWriteRecordMetadata = Pick<NotificationRecord, 'key' | 'eventId' | 'subjectState' | 'scope' | 'target' | 'title' | 'detail' | 'source' | 'tone' | 'state' | 'attention' | 'occurredAt' | 'timeBasis' | 'sourceRevision' | 'archivedAt' | 'origin'>
const sameScope = (a: NotificationScope, b: NotificationScope) => JSON.stringify(Object.entries(a).filter(([, value]) => value !== undefined).sort()) === JSON.stringify(Object.entries(b).filter(([, value]) => value !== undefined).sort())
function legacyComparison(f: McpWriteFact, row: McpWriteRecordMetadata | undefined, revision: number): NotificationDraft | undefined {
  const key = `mcp-write:${f.identity}`, scope = f.scope
  if (!row || row.archivedAt !== undefined || row.key !== key || row.eventId !== key || row.state !== 'active'
    || row.subjectState !== f.status || row.title !== (f.status === 'secondary-unconfirmed' ? '原操作已返回，协作后续记录未确认' : `${verbs[f.tool]}结果待核对`)
    || row.detail !== `${f.tool} · ${f.action}\n${reasons[f.reason]}` || row.occurredAt !== f.at || row.timeBasis !== 'observed'
    || !['notice', 'activity'].includes(row.attention) || !sameScope(row.scope, scope) || row.target?.kind !== 'session'
    || row.target.surface !== undefined || row.target.mcpWrite !== undefined || row.target.blockId !== f.blockId || !sameScope(row.target.scope, scope)
    || row.target.entryId !== undefined && row.target.entryId !== f.entryId
    || !scope.workspaceId || !scope.runId || !scope.slotId || !scope.bindingGeneration || !scope.composerId || !scope.sessionId || scope.channelId !== f.channelId
    // This is the registration format enforced by agent-registrations, not a guess from CH or role name.
    || f.agentSessionId !== `${scope.workspaceId}:ch-${f.channelId}:${scope.bindingGeneration}`) return
  return { key, category: 'team', eventId: `${key}:comparison:1`, eventType: 'mcp.write-result', subjectState: 'legacy-comparison', scope: row.scope,
    title: row.title, source: row.source, tone: row.tone, attention: row.attention, state: row.state, occurredAt: row.occurredAt, timeBasis: row.timeBasis, origin: row.origin,
    detail: `旧记录缺少完整操作信息。当前结果仅供对照，不代表当时结果已确认；旧摘要不会自动标为已读。\n\n${row.detail}`,
    target: { ...row.target, mcpWrite: { tool: f.tool, action: f.action, status: f.status, reason: f.reason, channelId: f.channelId, agentSessionId: f.agentSessionId,
      ...(f.entity ? { entity: { ...f.entity } } : {}) }, ...(f.entryId ? { entryId: f.entryId } : {}) },
    sourceRevision: Math.max(revision, row.sourceRevision + 1), announce: false, renewAttention: false, respectCleared: true }
}
export function reduceMcpWriteNotifications(
  previous: McpWriteState | undefined,
  input: McpWriteInput,
  baseline: boolean,
  revision: number,
  metadata?: readonly McpWriteRecordMetadata[]
) {
  const seen = new Set(previous?.seen),
    attentionFamilies = new Set(previous?.attentionFamilies),
    drafts: NotificationDraft[] = []
  let complete = true
  const legacy = legacyMcpWriteCandidates(previous, input)
  if (legacy.length) {
    if (metadata === undefined) throw Error('旧 MCP 摘要需要私有元数据核对')
    const rows = new Map(metadata.map(row => [row.key, row]))
    for (const f of legacy) {
      seen.delete(f.identity); seen.add(`~${f.identity}`)
      const draft = legacyComparison(f, rows.get(`mcp-write:${f.identity}`), revision)
      if (draft) drafts.push(draft)
    }
    drafts.forEach(validateNotificationDraft)
    // Inspected/missing/cleared/ambiguous rows advance alike. No endless first-page loop.
    const remaining = input.facts.some(f => f.status !== 'returned' && !seen.has(`~${f.identity}`))
    return { state: { ...previous!, version: 2 as const, seen: [...seen] }, drafts, complete: !remaining }
  }
  for (const f of input.facts) {
    if (f.status === 'returned') continue
    if (!/^[a-f0-9]{64}$/.test(f.attentionKey)) throw Error('MCP 写提醒身份无效')
    const family = f.attentionKey,
      meaningful = f.reason !== 'unclassified'
    // Each native attempt remains an immutable diagnostic. Repeated Agent
    // errors in the same native turn are quiet history, not a toast storm.
    // A later real turn is not silenced by an earlier failure in this session.
    if (seen.has(`~${f.identity}`)) { if (meaningful) attentionFamilies.add(family); continue }
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) {
      complete = false
      break
    }
    seen.add(`~${f.identity}`)
    const attention = meaningful && !attentionFamilies.has(family),
      key = `mcp-write:${f.identity}`
    if (meaningful) attentionFamilies.add(family)
    drafts.push({
      key,
      eventId: key,
      eventType: 'mcp.write-result',
      subjectState: f.status,
      category: 'team',
      source: `协作工具 · ${f.name}`,
      title:
        f.status === 'secondary-unconfirmed'
          ? '原操作已返回，协作后续记录未确认'
          : `${verbs[f.tool]}结果待核对`,
      detail: `${f.tool} · ${f.action}\n${reasons[f.reason]}`,
      scope: f.scope,
      target: {
        kind: 'session',
        scope: f.scope,
        blockId: f.blockId,
        mcpWrite: { tool: f.tool, action: f.action, status: f.status, reason: f.reason, channelId: f.channelId, agentSessionId: f.agentSessionId, ...(f.entity ? { entity: { ...f.entity } } : {}) },
        ...(f.entryId ? { entryId: f.entryId } : {})
      },
      origin: { module: 'sessions', sessionId: f.scope.sessionId },
      tone: 'warning',
      attention: attention ? 'notice' : 'activity',
      state: 'active',
      occurredAt: f.at,
      timeBasis: 'observed',
      sourceRevision: revision,
      renewAttention: true,
      announce: !baseline && attention && f.at >= input.monitorStartedAt
    })
  }
  if (seen.size > 20000) throw Error('MCP 写观察身份超过有界容量')
  if (attentionFamilies.size > 10000) throw Error('MCP 写提醒身份超过有界容量')
  drafts.forEach(validateNotificationDraft)
  const signals = drafts.filter(draft => draft.announce)
  return { state: { version: 2 as const, key: input.key, seen: [...seen], attentionFamilies: [...attentionFamilies] }, drafts, complete,
    ...(signals.length > 1 ? { group: { keys: signals.map(draft => draft.key), source: '协作工具', titleSuffix: '项协作写入结果待核对', tone: 'warning' as const,
      target: { kind: 'session' as const, scope: signals[0]!.scope } } } : {}) }
}
