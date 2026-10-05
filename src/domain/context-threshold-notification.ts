import type { NotificationDraft, NotificationScope } from './notification'
import { validateNotificationDraft, NOTIFICATION_SOURCE_BATCH_LIMIT } from './notification'

export type ContextThresholdZone = 'low' | 'near-high' | 'high' | 'near-critical' | 'critical'
export interface ContextThresholdFact {
  identity: string
  scope: NotificationScope
  name: string
  domain?: string
  domainKey?: string
  zone?: ContextThresholdZone
  ended: boolean
}
export interface ContextThresholdInput {
  key: string
  facts: ContextThresholdFact[]
  completed: boolean
  now: number
}
export interface ContextThresholdOutcome {
  state: ContextThresholdState
  drafts: NotificationDraft[]
  complete: boolean
}
interface ContextThresholdRow extends ContextThresholdFact {
  band: 0 | 80 | 95
  seen80: boolean
  seen95: boolean
  recorded: boolean
  status: 'active' | 'resolved' | 'unconfirmed' | 'expired'
}
export interface ContextThresholdState {
  version: 1
  key: string
  rows: Record<string, ContextThresholdRow>
  active: Record<string, string>
}
export function contextThresholdZone(ratio: number): ContextThresholdZone {
  return ratio >= 0.95 ? 'critical' : ratio >= 0.92 ? 'near-critical' : ratio >= 0.8 ? 'high' : ratio >= 0.77 ? 'near-high' : 'low'
}
function bandFor(zone: ContextThresholdZone, previous: 0 | 80 | 95): 0 | 80 | 95 {
  if (zone === 'critical' || (previous === 95 && zone === 'near-critical')) return 95
  if (['high', 'near-critical'].includes(zone) || (previous > 0 && zone === 'near-high')) return 80
  return 0
}
const recordKey = (row: ContextThresholdRow) => `context-threshold:${row.identity}:${row.domainKey}`
function draft(row: ContextThresholdRow, revision: number, now: number, announce = false, renew = false): NotificationDraft {
  const ended = row.status === 'expired',
    unknown = row.status === 'unconfirmed',
    active = row.status === 'active'
  return {
    key: recordKey(row),
    eventId: `${recordKey(row)}:${row.status}:${row.band}`,
    eventType: 'context.threshold',
    subjectState: unknown ? 'unconfirmed' : ended ? 'expired' : String(row.band),
    category: 'usage',
    source: '上下文 · ' + row.name,
    scope: { ...row.scope, contextDomain: row.domain },
    target: { kind: 'session', scope: { ...row.scope, contextDomain: row.domain }, surface: 'context' },
    origin: { module: 'sessions', sessionId: row.scope.sessionId },
    attention: 'notice',
    state: ended ? 'expired' : active || unknown ? 'active' : 'resolved',
    tone: active || unknown ? 'warning' : 'info',
    title: ended
      ? '这笔上下文提醒已不再适用'
      : unknown
        ? '上下文提醒读数待更新'
        : active
          ? row.band === 95
            ? '上下文已接近上限'
            : '上下文占用偏高'
          : '上下文占用已回到提醒阈值以下',
    detail: ended
      ? '会话已明确结束，或绑定身份/模型/容量范围已变化。这笔提醒只保留历史，不说明其他会话的状态。'
      : unknown
        ? `上次原生读数已达到 ${row.band}% 提醒级别。当前没有新鲜的绑定读数，不能判断是否仍处于该级别，也不会据此自动交接。`
        : active
          ? `这笔新鲜的 Cursor 绑定读数已达到 ${row.band}% 提醒级别。可查看原生上下文统计并准备交接；这不是计费 Token 或官方账单，也不代表会话已完成。`
          : '新鲜的绑定读数已降到提醒阈值以下；未据此改变会话、模型设置或交接状态。',
    occurredAt: now,
    timeBasis: 'observed',
    sourceRevision: revision,
    announce,
    renewAttention: renew,
    respectCleared: !renew
  }
}
export function readContextThresholdState(value: unknown, key: string): ContextThresholdState | undefined {
  if (value === undefined) return undefined
  const state = value as ContextThresholdState
  if (
    !state ||
    state.version !== 1 ||
    state.key !== key ||
    !state.rows ||
    Array.isArray(state.rows) ||
    !state.active ||
    Array.isArray(state.active) ||
    Object.keys(state.rows).length > 1024
  )
    throw Error('上下文通知检查点无效，原数据保留')
  for (const [id, row] of Object.entries(state.rows)) {
    if (
      !row ||
      !/^[a-f0-9]{64}$/.test(row.identity) ||
      id !== `${row.identity}:${row.domainKey}` ||
      ![0, 80, 95].includes(row.band) ||
      !['active', 'resolved', 'unconfirmed', 'expired'].includes(row.status) ||
      typeof row.seen80 !== 'boolean' ||
      typeof row.seen95 !== 'boolean' ||
      typeof row.recorded !== 'boolean'
    )
      throw Error('上下文通知身份或阶段无效')
    if (
      !row.domain ||
      !row.domainKey ||
      !/^[a-f0-9]{64}$/.test(row.domainKey) ||
      typeof row.ended !== 'boolean' ||
      (row.zone !== undefined && !['low', 'near-high', 'high', 'near-critical', 'critical'].includes(row.zone))
    )
      throw Error('上下文通知范围缺失')
    validateNotificationDraft(draft(row, 1, 0))
  }
  for (const [id, key] of Object.entries(state.active))
    if (!/^[a-f0-9]{64}$/.test(id) || state.rows[key]?.identity !== id) throw Error('上下文通知活动范围无效')
  return state
}
export function reduceContextThresholdNotifications(
  previous: ContextThresholdState | undefined,
  input: ContextThresholdInput,
  baseline: boolean,
  revision: number
): ContextThresholdOutcome {
  const rows = { ...previous?.rows },
    active = { ...previous?.active },
    drafts: NotificationDraft[] = []
  let complete = true
  const end = (old: ContextThresholdRow) => {
    if (!old.recorded || old.status === 'expired') return
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) {
      complete = false
      return
    }
    const next: ContextThresholdRow = { ...old, ended: true, status: 'expired' }
    rows[`${old.identity}:${old.domainKey}`] = next
    drafts.push(draft(next, revision, input.now))
  }
  if (input.completed) {
    for (const old of Object.values(rows)) end(old)
    return { state: { version: 1, key: input.key, rows, active }, drafts, complete }
  }
  for (const fact of input.facts) {
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) {
      complete = false
      break
    }
    // A positively projected replacement identity invalidates an old reminder,
    // not the old session's business outcome. Mere absence never does this.
    if (fact.scope.slotId) for (const row of Object.values(rows)) {
      if (row.identity !== fact.identity && row.scope.slotId === fact.scope.slotId && row.scope.workspaceId === fact.scope.workspaceId && row.scope.runId === fact.scope.runId) end(row)
    }
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) { complete = false; continue }
    const lastKey = active[fact.identity],
      last = lastKey ? rows[lastKey] : undefined
    if (fact.ended) {
      for (const row of Object.values(rows)) if (row.identity === fact.identity) end(row)
      continue
    }
    if (!fact.zone || !fact.domain || !fact.domainKey) {
      if (last?.recorded && last.band && !['unconfirmed', 'expired'].includes(last.status)) {
        const next: ContextThresholdRow = { ...last, status: 'unconfirmed' }
        rows[lastKey!] = next
        drafts.push(draft(next, revision, input.now))
      }
      continue
    }
    const rowKey = `${fact.identity}:${fact.domainKey}`,
      old = rows[rowKey],
      changedDomain = lastKey && lastKey !== rowKey
    if (changedDomain && last) end(last)
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) {
      complete = false
      continue
    }
    const band = bandFor(fact.zone, old?.band ?? 0)
    const freshCross = band === 95 ? !old?.seen95 : band === 80 ? !old?.seen80 : false
    const next: ContextThresholdRow = {
      ...fact,
      band,
      seen80: Boolean(old?.seen80 || band >= 80),
      seen95: Boolean(old?.seen95 || band === 95),
      recorded: Boolean(old?.recorded || band),
      status: band ? 'active' : 'resolved'
    }
    // Value growth inside a zone is not a new business fact or unread record.
    const presentationChanged =
      !old || JSON.stringify([old.band, old.status, old.name, old.scope]) !== JSON.stringify([next.band, next.status, next.name, next.scope])
    if (presentationChanged && next.recorded)
      drafts.push(draft(next, revision, input.now, Boolean(freshCross && !baseline && !changedDomain && old), Boolean(freshCross)))
    rows[rowKey] = next
    active[fact.identity] = rowKey
  }
  if (Object.keys(rows).length > 1024) throw Error('上下文通知身份容量不足，不能截掉重要记录')
  return { state: { version: 1, key: input.key, rows, active }, drafts, complete }
}
