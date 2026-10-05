import type { NotificationDraft } from './notification'
import { NOTIFICATION_SOURCE_BATCH_LIMIT, validateNotificationDraft } from './notification'
export interface GroupTopologyFact {
  id: string
  identity: string
  name: string
  status: 'active' | 'dissolved'
  leadSlotId?: string
  planning: 'lead' | 'members' | 'operator'
  members: Array<{ slotId: string; label: string }>
}
export interface GroupTopologyInput {
  key: string
  workspaceId: string
  runId: string
  revision: number
  now: number
  facts: GroupTopologyFact[]
}
export interface GroupTopologyState {
  version: 1
  key: string
  revision: number
  groups: Record<string, GroupTopologyFact>
}
export function readGroupTopologyState(value: unknown, key: string): GroupTopologyState | undefined {
  if (value === undefined) return undefined
  const state = value as GroupTopologyState
  if (
    !state ||
    state.version !== 1 ||
    state.key !== key ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !state.groups ||
    typeof state.groups!=='object' ||
    Array.isArray(state.groups) ||
    Object.keys(state.groups).length > 1024
  )
    throw Error('组通知检查点无效')
  for (const [id, fact] of Object.entries(state.groups))
    if (
      !fact ||
      fact.id !== id ||
      !/^[a-f0-9]{64}$/.test(fact.identity) ||
      !['active', 'dissolved'].includes(fact.status) ||
      !['lead', 'members', 'operator'].includes(fact.planning) ||
      !Array.isArray(fact.members) ||
      fact.members.length > 64 ||
      typeof fact.name !== 'string' ||
      fact.name.length > 80 ||
      fact.members.some(
        (member) =>
          !member ||
          typeof member.slotId !== 'string' ||
          !member.slotId ||
          member.slotId.length > 300 ||
          typeof member.label !== 'string' ||
          member.label.length > 80
      )
    )
      throw Error('组通知事实无效')
  return state
}
export function reduceGroupTopologyNotifications(
  previous: GroupTopologyState | undefined,
  input: GroupTopologyInput,
  baseline: boolean,
  revision: number
) {
  const groups = { ...previous?.groups },
    drafts: NotificationDraft[] = []
  if (previous && input.revision < previous.revision) return { state: previous, drafts }
  let complete = true
  for (const fact of input.facts) {
    const old = groups[fact.id]
    if (JSON.stringify(old) === JSON.stringify(fact)) continue
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) {
      complete = false
      break
    }
    groups[fact.id] = fact
    if (baseline && !old) continue // Hydration is not a fresh create/dissolve operation.
    const changes: string[] = []
    const title = fact.status === 'dissolved' ? '原记录确认协作组已解散' : !old ? '协作组已创建' : '协作组关系已变化'
    if (old && old.status !== fact.status) changes.push('组状态已按原记录更新。')
    if (old && old.leadSlotId !== fact.leadSlotId) changes.push(fact.leadSlotId ? '有效主控已变化。' : '当前没有有效主控。')
    if (old && old.planning !== fact.planning)
      changes.push(fact.planning === 'lead' ? '规划权归有效主控。' : fact.planning === 'members' ? '组内成员可规划任务。' : '当前由用户规划任务。')
    if (!old || JSON.stringify(old.members) !== JSON.stringify(fact.members))
      changes.push(`当前成员：${fact.members.map((value) => value.label).join('、') || '无'}。`)
    drafts.push({
      key: `group-topology:${fact.identity}`,
      eventType: 'group.topology',
      eventId: `group-topology:${fact.identity}:${input.revision}`,
      subjectState: fact.status,
      category: 'team',
      source: `协作组 · ${fact.name}`,
      title,
      detail: [...changes, '这是已确认的组关系快照，不证明所有成员通知已投递、任务/消息收尾已完成，也不改变会话身份或运行范围。']
        .join('\n')
        .slice(0, 3900),
      scope: { workspaceId: input.workspaceId, runId: input.runId, groupId: fact.id },
      target: { kind: 'run', runId: input.runId, groupId: fact.id },
      origin: { module: 'run' },
      tone: 'info',
      attention: 'activity',
      state: 'resolved',
      timeBasis: 'observed',
      occurredAt: input.now,
      sourceRevision: revision,
      announce: false,
      respectCleared: true
    })
  }
  if (Object.keys(groups).length > 1024) throw Error('本轮组关系通知身份容量不足')
  drafts.forEach(validateNotificationDraft)
  return { state: { version: 1 as const, key: input.key, revision: input.revision, groups }, drafts, complete }
}
