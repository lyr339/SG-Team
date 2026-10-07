import {validateGroupEffectsDigest,type GroupEffectsDigest} from './group-effects'
import { NOTIFICATION_SOURCE_BATCH_LIMIT, type NotificationDraft, type NotificationScope } from './notification'

export type QueueNoticePhase = 'queued' | 'held' | 'delivered' | 'replied' | 'withdrawn' | 'retired' | 'unconfirmed'
const codes = { queued: 'q', held: 'h', delivered: 'd', replied: 'a', withdrawn: 'w', retired: 'r', unconfirmed: 'u' } as const
type Code = typeof codes[QueueNoticePhase] | 'b' // b = current original row conflicts with the retained past receipt
export interface QueueNotificationFact { id: string; entryId: string; channelId: string; phase: QueueNoticePhase; at: number; scope: NotificationScope; replyEntryId?: string; inspection?: { id: string; sequence: number }; currentInspection?: boolean; rowConfirmed?: boolean; takenAt?: number }
export interface QueueHandoffAnnotation {
  id: string; entryId: string; channelId: string; sourceChannelId: string; issuedAt: number
  transcript: 'expected' | 'older' | 'present' | 'unverified'; recordWritten: boolean
  scope: NotificationScope
  replyEntryId?: string
  takenAt?: number
  transfer?: { groupId: string; roleName: string; released: number; lead: boolean; effects?:GroupEffectsDigest }
}
export interface QueueNotificationInput { key: string; runId?: string; workspaceId?: string; now: number; facts: QueueNotificationFact[]; annotations: QueueHandoffAnnotation[]; signature?: string; monitorStartedAt?: number; inspectionId?: string }
export interface QueueNotificationState {
  version: 2; inspectionId?: string; key: string; runId?: string; workspaceId?: string
  /** Compact source identities; no message body or session token. One stable source per real DB run. */
  rows: Record<string, [Code, string, number?]>
  handoffs: Record<string, QueueHandoffAnnotation>
}
export function readQueueNotificationState(value: unknown, key: string): QueueNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as QueueNotificationState
  const version = (value as { version?: unknown })?.version
  if (!state || version !== 1 && version !== 2 || state.key !== key || !state.rows || !state.handoffs || Array.isArray(state.rows) || Array.isArray(state.handoffs)
    || Object.keys(state.rows).length > 50_000 || Object.keys(state.handoffs).length > 2_000) throw Error('队列通知检查点异常')
  for (const [id, row] of Object.entries(state.rows)) if (!/^[a-f0-9]{32}$/.test(id) || !Array.isArray(row) || row.length < 2 || row.length > (version === 1 ? 2 : 3) || ![...Object.values(codes), ...(version === 2 ? ['b'] : [])].includes(row[0]) || !/^\d+$/.test(row[1])
    || row[2] !== undefined && (!state.inspectionId || !Number.isSafeInteger(row[2]) || row[2] < 1)) throw Error('队列通知身份异常')
  for (const [id, annotation] of Object.entries(state.handoffs)) if (!annotation || annotation.id !== id || typeof annotation.entryId !== 'string'
    || !annotation.scope || !['expected', 'older', 'present', 'unverified'].includes(annotation.transcript) || typeof annotation.recordWritten !== 'boolean' || annotation.takenAt !== undefined && (!Number.isSafeInteger(annotation.takenAt) || annotation.takenAt < 0)) throw Error('交接通知检查点异常')
  for(const annotation of Object.values(state.handoffs))if(annotation.transfer?.effects)validateGroupEffectsDigest(annotation.transfer.effects)
  if (state.inspectionId !== undefined && !/^[a-f0-9-]{36}$/.test(state.inspectionId)) throw Error('队列原读取身份异常')
  return version === 1 ? { ...state, version: 2 } : state
}
const terminal = (code?: Code) => code === 'a' || code === 'd' || code === 'w' || code === 'r'
export const queueNotificationEvent = (id: string, phase: QueueNoticePhase) => `queue:${id}:${phase}`

export function reduceQueueNotifications(old: QueueNotificationState | undefined, input: QueueNotificationInput, baseline: boolean, revision: number) {
  const state: QueueNotificationState = { version: 2, key: input.key, ...(input.runId ? { runId: input.runId } : {}),
    ...(input.workspaceId ?? old?.workspaceId ? { workspaceId: input.workspaceId ?? old?.workspaceId } : {}), ...(input.inspectionId ? { inspectionId: input.inspectionId } : old?.inspectionId ? { inspectionId: old.inspectionId } : {}),
    rows: Object.fromEntries(Object.entries(old?.rows ?? {}).map(([id, row]) => [id, input.inspectionId && input.inspectionId !== old?.inspectionId ? [row[0], row[1]] : row])), handoffs: { ...old?.handoffs } }
  const annotations = new Map(input.annotations.map(value => [value.id, value]))
  const drafts: NotificationDraft[] = []; let complete = true
  for (const fact of input.facts) {
    const previous = old?.rows[fact.id]?.[0], oldHandoff = old?.handoffs[fact.id], annotation = annotations.get(fact.id) ?? oldHandoff
    const inspected = fact.currentInspection === true && fact.inspection?.id === input.inspectionId
    const previousInspection = old?.inspectionId === input.inspectionId ? old?.rows[fact.id]?.[2] : undefined
    if (inspected && previousInspection !== undefined && fact.inspection!.sequence < previousInspection) continue
    const fresh = inspected && (previousInspection === undefined || fact.inspection!.sequence > previousInspection)
    let phase = fact.phase, code: Code = codes[phase]
    if (previous === 'b') {
      if (!fresh || !fact.rowConfirmed) { code = 'b'; phase = 'unconfirmed' }
    } else if (terminal(previous) && fresh && fact.rowConfirmed === false) {
      code = 'b'; phase = 'unconfirmed'
    } else {
      // Without a new original row inspection, queued replay is not a rollback.
      if (terminal(previous) && (code === 'q' || code === 'h' || code === 'u')) { code = previous!; phase = (Object.keys(codes) as QueueNoticePhase[]).find(key => codes[key] === code)! }
      if (previous === 'a') { code = 'a'; phase = 'replied' }
      if (previous === 'd' && (code === 'w' || code === 'r')) { code = 'd'; phase = 'delivered' }
    }
    const newTaking = oldHandoff?.takenAt !== undefined && fact.takenAt !== undefined && fact.takenAt !== oldHandoff.takenAt
    const newReply = Boolean(fact.replyEntryId && fact.replyEntryId !== oldHandoff?.replyEntryId)
    const keepReceiver = Boolean(oldHandoff && (code === 'b' || terminal(previous) && !newTaking && !newReply || code === 'a' && !fact.replyEntryId))
    const handoff = annotation ? { ...annotation, scope: keepReceiver ? oldHandoff!.scope : fact.scope.sessionId ? fact.scope : oldHandoff?.scope ?? annotation.scope,
      ...(fact.takenAt !== undefined || oldHandoff?.takenAt !== undefined ? { takenAt: fact.takenAt ?? oldHandoff?.takenAt } : {}),
      ...(fact.replyEntryId ?? oldHandoff?.replyEntryId ? { replyEntryId: fact.replyEntryId ?? oldHandoff?.replyEntryId } : {}) } : undefined
    const changed = previous !== code || JSON.stringify(oldHandoff) !== JSON.stringify(handoff)
    if (!changed) {
      if (inspected) state.rows[fact.id] = [code, fact.channelId, fact.inspection!.sequence]
      continue
    }
    const stock = !old && baseline && !handoff && (input.monitorStartedAt === undefined || fact.at < input.monitorStartedAt)
    if (!stock && drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) { complete = false; break }
    state.rows[fact.id] = inspected ? [code, fact.channelId, fact.inspection!.sequence] : [code, fact.channelId, ...(previousInspection !== undefined ? [previousInspection] : [])] as [Code, string, number?]
    if (handoff) state.handoffs[fact.id] = handoff
    if (stock) continue
    const meaningful = Boolean(handoff)
    const effects=handoff?.transfer?.effects,effectProblem=Boolean(effects?.problem),newEffectProblem=effectProblem&&oldHandoff?.transfer?.effects?.id!==effects?.id
    const key = `queue:${fact.id}`, scope = {...(handoff?.scope ?? fact.scope),...(effects?{groupOperationId:effects.id,groupId:handoff!.transfer!.groupId}:{})}
    const title = handoff?.transfer ? phase === 'queued' || phase === 'held' ? '成员身份已迁移，上下文消息已排队' : phase === 'delivered' ? '成员身份已迁移，目标已取走上下文消息'
      : phase === 'replied' ? '成员身份已迁移，目标已返回交接回复' : '成员已迁移，原上下文消息已退出队列'
      : handoff ? phase === 'held' ? '上下文交接等待新会话取走' : phase === 'queued' ? '上下文交接已入队'
        : phase === 'delivered' ? '目标通道已取走上下文消息' : phase === 'replied' ? '目标已返回本次交接的回复' : '原上下文消息已退出队列'
        : ({ queued: '消息已入队', held: '消息等待新会话', delivered: '通道已取走消息', replied: '已收到对应回复', withdrawn: '消息已撤回', retired: '未送达消息已退役', unconfirmed: '原队列消息结果待核对' })[phase]
    const stage = ({ queued: '本地入队不等于实际取走；不据此确认回复。', held: '原会话无法取走保持位消息，需等该席位的新会话或由用户在原入口放行。',
      delivered: '通道服务已记录取走，未据此声称目标已读完上下文或已完成任务。', replied: '存在与本次出站消息明确关联的完整回复；交接内容和后续工作请以原回复为准。',
      withdrawn: '原队列事务确认撤回；不会自动重新投递。', retired: '原业务状态确认该未投递消息退役；它不再是即将送达的消息。',
      unconfirmed: '原队列行缺席、来源变化或与既有确认结果不一致。保留过去的事实；不会称它即将送达，也不猜撤回、退役或交接失败。' })[phase]
    const document = handoff ? `\n交接时转录${handoff.transcript === 'expected' ? '尚未创建' : handoff.transcript === 'older' ? '早于本次发出时间' : handoff.transcript === 'present' ? '路径已存在' : '新鲜度未确认'}；不保证原会话已经完整落盘。`
      + (handoff.recordWritten ? ' 拾光补充记录已写入。' : ' 拾光补充记录未写入，原转录路径仍已入队。') : ''
    const identity = handoff?.transfer ? `\n目标接过角色 ${handoff.transfer.roleName}；${effects&&!effects.releaseConfirmed?'任务释放结果尚未确认':`释放 ${handoff.transfer.released} 个任务`}${handoff.transfer.lead ? '，主控身份随迁' : ''}。身份迁移不因后续交接状态回滚。${effectProblem&&effects?`\n${effects.detail}`:''}` : ''
    drafts.push({ key, eventId: queueNotificationEvent(fact.id, phase), eventType: 'queue.state', subjectState: phase, category: 'sessions', source: handoff?.transfer ? '成员迁移与上下文' : handoff ? '上下文交接' : `会话队列 · CH-${fact.channelId}`,
      title: effectProblem?`${title} · 组后续事项待核对`:phase === 'unconfirmed' && handoff ? '原上下文消息结果待核对' : title, detail: `CH-${fact.channelId} · ${stage}${document}${identity}`, scope, ...(scope.sessionId && phase !== 'retired' && phase !== 'withdrawn' && phase !== 'unconfirmed'
        ? { target: { kind: 'session' as const, scope, entryId: phase === 'replied' ? fact.replyEntryId ?? handoff?.replyEntryId ?? fact.entryId : fact.entryId,
          ...(phase === 'replied' ? { queueEntryId: fact.entryId } : {}),
          ...(phase === 'queued' || phase === 'held' ? { surface: 'queue' as const } : {}) } } : {}),
      origin: { module: handoff?.transfer ? 'run' : 'sessions', sessionId: scope.sessionId },
      attention: meaningful ? 'notice' : 'activity', tone: effectProblem||meaningful && (phase === 'retired' || phase === 'withdrawn' || phase === 'unconfirmed' || !handoff!.recordWritten || handoff!.transcript !== 'present') ? 'warning' : 'info',
      state: phase === 'retired' || phase === 'withdrawn' ? 'expired' : effectProblem||phase === 'queued' || phase === 'held' || phase === 'unconfirmed' ? 'active' : 'resolved',
      occurredAt: code === 'b' ? input.now : fact.at, ...(code === 'b' ? { timeBasis: 'observed' as const } : {}), sourceRevision: revision, renewAttention: meaningful && (previous !== code || !oldHandoff||newEffectProblem), respectCleared: !newEffectProblem&&previous === code && Boolean(oldHandoff),
      announce: !baseline && meaningful && (newEffectProblem||previous !== code && (phase === 'retired' || phase === 'unconfirmed')) })
  }
  if (Object.keys(state.rows).length > 50_000 || Object.keys(state.handoffs).length > 2_000) throw Error('队列通知检查点超过容量')
  return { state, drafts, complete }
}
