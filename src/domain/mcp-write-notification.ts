import {
  NOTIFICATION_SOURCE_BATCH_LIMIT,
  validateNotificationDraft,
  type NotificationDraft,
  type NotificationScope
} from './notification'
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
  now: number
  monitorStartedAt: number
  signature: string
}
export interface McpWriteState {
  version: 1
  key: string
  seen: string[]
  attentionFamilies?: string[]
}
export function readMcpWriteState(value: unknown, key: string): McpWriteState | undefined {
  if (value === undefined) return
  const s = value as McpWriteState
  if (
    !s ||
    s.version !== 1 ||
    s.key !== key ||
    !Array.isArray(s.seen) ||
    s.seen.length > 20000 ||
    s.seen.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
    (s.attentionFamilies !== undefined && (!Array.isArray(s.attentionFamilies) || s.attentionFamilies.length > 10000 ||
      s.attentionFamilies.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))))
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
export function reduceMcpWriteNotifications(
  previous: McpWriteState | undefined,
  input: McpWriteInput,
  baseline: boolean,
  revision: number
) {
  const seen = new Set(previous?.seen),
    attentionFamilies = new Set(previous?.attentionFamilies),
    drafts: NotificationDraft[] = []
  let complete = true
  for (const f of input.facts) {
    if (f.status === 'returned') continue
    if (!/^[a-f0-9]{64}$/.test(f.attentionKey)) throw Error('MCP 写提醒身份无效')
    const family = f.attentionKey,
      meaningful = f.reason !== 'unclassified'
    // Each native attempt remains an immutable diagnostic. Repeated Agent
    // errors in the same native turn are quiet history, not a toast storm.
    // A later real turn is not silenced by an earlier failure in this session.
    if (seen.has(f.identity)) { if (meaningful) attentionFamilies.add(family); continue }
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) {
      complete = false
      break
    }
    seen.add(f.identity)
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
  return { state: { version: 1 as const, key: input.key, seen: [...seen], attentionFamilies: [...attentionFamilies] }, drafts, complete,
    ...(signals.length > 1 ? { group: { keys: signals.map(draft => draft.key), source: '协作工具', titleSuffix: '项协作写入结果待核对', tone: 'warning' as const,
      target: { kind: 'session' as const, scope: signals[0]!.scope } } } : {}) }
}
