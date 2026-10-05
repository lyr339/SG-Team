import {
  NOTIFICATION_SOURCE_BATCH_LIMIT,
  validateNotificationDraft,
  type NotificationDraft
} from './notification'
import {
  groupEffectsKey,
  groupEffectsEvent,
  groupEffectsLines,
  groupEffectsProblem,
  groupOperationName,
  validateGroupEffects,
  type GroupEffectsFrame
} from './group-effects'
import type { NotificationReference } from './notification-reference'
export const GROUP_EFFECTS_SOURCE_KEY = 'group-effects:v1'
interface Row {
  frame: GroupEffectsFrame
  recorded: boolean
  recovered?: boolean
  parent?: NotificationReference
}
export interface GroupEffectsState {
  version: 1
  key: string
  rows: Record<string, Row>
}
export type GroupEffectsInput =
  | { kind: 'observe'; frame: GroupEffectsFrame; parent?: NotificationReference }
  | { kind: 'recover'; owner: string; now: number }
const sameDefinition = (a: GroupEffectsFrame, b: GroupEffectsFrame) =>
  a.owner === b.owner &&
  a.kind === b.kind &&
  JSON.stringify(a.scope) === JSON.stringify(b.scope) &&
  a.name === b.name
export function readGroupEffectsState(value: unknown, key: string): GroupEffectsState | undefined {
  if (value === undefined) return
  const s = value as GroupEffectsState
  if (
    !s ||
    s.version !== 1 ||
    s.key !== key ||
    !s.rows ||
    typeof s.rows !== 'object' ||
    Array.isArray(s.rows) ||
    Object.keys(s.rows).length > 48
  )
    throw Error('组后续观察检查点无效')
  for (const [id, row] of Object.entries(s.rows)) {
    validateGroupEffects(row.frame)
    if (
      id !== row.frame.id ||
      typeof row.recorded !== 'boolean' ||
      (row.recovered !== undefined && typeof row.recovered !== 'boolean') ||
      (row.parent &&
        (!row.parent.key ||
          row.parent.key.length > 300 ||
          (row.parent.eventId !== undefined &&
            (typeof row.parent.eventId !== 'string' || row.parent.eventId.length > 300))))
    )
      throw Error('组后续观察身份无效')
  }
  return s
}
function draftFor(row: Row, revision: number, announce: boolean, renew: boolean): NotificationDraft {
  const f = row.frame,
    linked = Boolean(row.parent),
    key = groupEffectsKey(f.id)
  return {
    key,
    eventId: groupEffectsEvent(f.id),
    eventType: 'group.effects',
    subjectState: row.recovered ? 'unconfirmed' : 'partial',
    category: 'team',
    source: '协作组后续事项',
    title: row.recovered
      ? '上次组操作的后续结果待核对'
      : `${groupOperationName[f.kind]}已返回，部分后续事项未确认`,
    detail:
      `${f.name}\n这次组设置已返回，部分后续结果还需核对。以下是当时的回执，不代表之后没有变化。\n${groupEffectsLines(f).join('\n')}\n不会自动重做本次操作。${linked ? '\n这项结果已并入原迁移提醒，不重复提醒。' : ''}`.slice(
        0,
        4000
      ),
    scope: { ...f.scope, groupOperationId: f.id },
    target: { kind: 'run', runId: f.scope.runId, groupId: f.scope.groupId },
    origin: { module: 'run' },
    tone: 'warning',
    attention: linked ? 'activity' : 'notice',
    state: 'active',
    occurredAt: f.observedAt,
    timeBasis: 'observed',
    sourceRevision: revision,
    announce: announce && !linked,
    renewAttention: renew && !linked,
    respectCleared: true
  }
}
export function reduceGroupEffects(
  previous: GroupEffectsState | undefined,
  input: GroupEffectsInput,
  baseline: boolean,
  revision: number
) {
  const rows = { ...previous?.rows },
    drafts: NotificationDraft[] = []
  if (input.kind === 'recover') {
    for (const [id, old] of Object.entries(rows)) {
      if (old.frame.phase !== 'live' || old.frame.owner === input.owner || old.recovered) continue
      if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) break
      const row = { ...old, recovered: true, recorded: true }
      rows[id] = row
      drafts.push(draftFor(row, revision, false, !old.recorded))
    }
  } else {
    const f = input.frame
    validateGroupEffects(f)
    const old = rows[f.id]
    if (old && (!sameDefinition(old.frame, f) || f.sequence < old.frame.sequence))
      return { state: previous!, drafts: [] }
    if (old && old.frame.phase !== 'live' && f.phase === 'live') return { state: previous!, drafts: [] }
    const row: Row = {
      frame: f,
      recorded: old?.recorded ?? false,
      ...((input.parent ?? old?.parent) ? { parent: input.parent ?? old?.parent } : {})
    }
    if (f.phase === 'completed' && !groupEffectsProblem(f)) {
      delete rows[f.id]
    } else {
      if (f.phase !== 'live') {
        row.recorded = true
        if (JSON.stringify(old) !== JSON.stringify(row))
          drafts.push(draftFor(row, revision, !baseline && f.kind !== 'transfer', !old?.recorded))
      }
      rows[f.id] = row
    }
  }
  // Compact normal completions vanish without success history. Old completed
  // diagnostics can leave this transport checkpoint only after their record was
  // part of an atomic source commit; protected history remains in its ledger.
  while (Object.keys(rows).length > 48) {
    const victim = Object.values(rows)
      .filter((row) => row.recorded && (row.frame.phase !== 'live' || row.recovered))
      .sort((a, b) => a.frame.observedAt - b.frame.observedAt)[0]
    if (!victim) throw Error('并发组后续观察超过有界容量')
    delete rows[victim.frame.id]
  }
  drafts.forEach(validateNotificationDraft)
  return { state: { version: 1 as const, key: GROUP_EFFECTS_SOURCE_KEY, rows }, drafts }
}
