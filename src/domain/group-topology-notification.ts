import type { NotificationDraft } from './notification'
import { NOTIFICATION_SOURCE_BATCH_LIMIT, validateNotificationDraft } from './notification'
import { nativeRevisionRegressed, validateNativeRebaseState, type NativeVersionEvidence, type NativeRebaseState } from './native-rebase'
export interface GroupTopologyFact {
  id: string
  identity: string
  name: string
  status: 'active' | 'dissolved'
  leadSlotId?: string
  planning: 'lead' | 'members' | 'operator'
  members: Array<{ slotId: string; label: string }>
}
export interface GroupTopologyInput extends NativeVersionEvidence {
  key: string
  workspaceId: string
  runId: string
  revision: number
  now: number
  facts: GroupTopologyFact[]
}
export interface GroupTopologyState extends NativeRebaseState {
  priorData?: string[]
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
    typeof state.groups !== 'object' ||
    Array.isArray(state.groups) ||
    Object.keys(state.groups).length > 1024
  )
    throw Error('组通知检查点无效')
  validateNativeRebaseState(state, 1024)
  if (
    state.priorData !== undefined &&
    (!Array.isArray(state.priorData) || state.priorData.length > 1024 || state.priorData.some((id) => typeof id !== 'string' || !state.groups[id]))
  )
    throw Error('组先前数据标记无效')
  if (state.pendingRebase?.missing.some((id) => !state.groups[id])) throw Error('组恢复进度指向不存在的身份')
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
  if (previous && input.revision < previous.revision && !input.currentRead) return { state: previous, drafts }
  const regression = nativeRevisionRegressed(previous, input)
  const rebases = (previous?.rebases ?? 0) + (regression ? 1 : 0)
  const pending = regression
    ? {
        from: Math.max(previous!.revision, input.rebaseFrom ?? 0),
        to: input.rebaseTo ?? input.revision,
        missing: Object.keys(groups).filter((id) => !input.facts.some((fact) => fact.id === id))
      }
    : previous?.pendingRebase
      ? { ...previous.pendingRebase, missing: [...previous.pendingRebase.missing] }
      : undefined
  const priorData = new Set(previous?.priorData)
  if (pending) {
    while (pending.missing.length && drafts.length < NOTIFICATION_SOURCE_BATCH_LIMIT - 1) {
      const id = pending.missing.shift()!,
        old = groups[id]!
      if (priorData.has(id)) continue
      priorData.add(id)
      drafts.push({
        key: `group-topology:${old.identity}`,
        eventType: 'group.topology',
        eventId: `group-topology:${old.identity}:prior-data:${rebases}`,
        subjectState: 'prior-data',
        category: 'team',
        source: `协作组 · ${old.name}`,
        title: '此组关系摘要属于先前数据版本',
        detail: `此前修订 ${pending.from} 记录了该组。本次较早修订 ${pending.to} 的当前投影未包含它；不推断已解散、删除或收尾完成。`,
        scope: { workspaceId: input.workspaceId, runId: input.runId, groupId: id },
        tone: 'info',
        attention: 'activity',
        state: 'expired',
        occurredAt: input.now,
        timeBasis: 'observed',
        sourceRevision: revision,
        announce: false,
        respectCleared: true
      })
    }
  }
  let complete = true
  for (const fact of input.facts) {
    const old = groups[fact.id]
    if (JSON.stringify(old) === JSON.stringify(fact) && !priorData.has(fact.id)) continue
    if (drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT - (pending ? 1 : 0)) {
      complete = false
      break
    }
    groups[fact.id] = fact
    priorData.delete(fact.id)
    if (baseline && !old) continue // Hydration is not a fresh create/dissolve operation.
    const changes: string[] = []
    const title = pending
      ? '协作组关系已按当前读取重新核对'
      : fact.status === 'dissolved'
        ? '原记录确认协作组已解散'
        : !old
          ? '协作组已创建'
          : '协作组关系已变化'
    if (pending) changes.push(`源数据修订 ${pending.from} → ${pending.to}。之前的关系属于先前数据版本；这不是一次重新建组或恢复成功回执。`)
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
  if (pending) {
    complete &&= pending.missing.length === 0
    drafts.push({
      key: `group-rebase:${input.key.slice(-64)}:${rebases}`,
      eventType: 'group.rebase',
      subjectState: complete ? 'observed' : 'pending',
      category: 'team',
      source: '协作数据核对',
      title: '检测到较早的组关系数据版本',
      detail: `源修订 ${pending.from} → ${pending.to}。${complete ? '已按本次原读取重新投影通知。' : '旧摘要仍在分批核对。'}原业务没有被通知回放或改变，先前记录不作为当前关系证明。`,
      scope: { workspaceId: input.workspaceId, runId: input.runId },
      target: { kind: 'run', runId: input.runId },
      origin: { module: 'run' },
      tone: 'warning',
      attention: 'notice',
      state: complete ? 'resolved' : 'active',
      occurredAt: input.now,
      timeBasis: 'observed',
      sourceRevision: revision,
      announce: false,
      renewAttention: regression
    })
  }
  drafts.forEach(validateNotificationDraft)
  return {
    state: {
      version: 1 as const,
      key: input.key,
      revision: input.revision,
      groups,
      rebases,
      readOwner: input.readOwner ?? previous?.readOwner,
      readEpoch: input.readEpoch ?? previous?.readEpoch ?? 0,
      priorData: [...priorData],
      ...(!complete && pending ? { pendingRebase: pending } : {})
    },
    drafts,
    complete
  }
}
