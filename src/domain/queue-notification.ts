import { NOTIFICATION_SOURCE_BATCH_LIMIT, type NotificationDraft, type NotificationScope } from './notification'

export type QueueNoticePhase = 'queued' | 'held' | 'delivered' | 'replied' | 'withdrawn' | 'retired' | 'unconfirmed'
const codes = { queued: 'q', held: 'h', delivered: 'd', replied: 'a', withdrawn: 'w', retired: 'r', unconfirmed: 'u' } as const
type Code = typeof codes[QueueNoticePhase]
export interface QueueNotificationFact { id: string; entryId: string; channelId: string; phase: QueueNoticePhase; at: number; scope: NotificationScope; replyEntryId?: string }
export interface QueueHandoffAnnotation {
  id: string; entryId: string; channelId: string; sourceChannelId: string; issuedAt: number
  transcript: 'expected' | 'older' | 'present' | 'unverified'; recordWritten: boolean
  scope: NotificationScope
  replyEntryId?: string
  transfer?: { groupId: string; roleName: string; released: number; lead: boolean }
}
export interface QueueNotificationInput { key: string; runId?: string; workspaceId?: string; now: number; facts: QueueNotificationFact[]; annotations: QueueHandoffAnnotation[]; signature?: string; monitorStartedAt?: number }
export interface QueueNotificationState {
  version: 1; key: string; runId?: string; workspaceId?: string
  /** Compact source identities; no message body or session token. One stable source per real DB run. */
  rows: Record<string, [Code, string]>
  handoffs: Record<string, QueueHandoffAnnotation>
}
export function readQueueNotificationState(value: unknown, key: string): QueueNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as QueueNotificationState
  if (!state || state.version !== 1 || state.key !== key || !state.rows || !state.handoffs || Array.isArray(state.rows) || Array.isArray(state.handoffs)
    || Object.keys(state.rows).length > 50_000 || Object.keys(state.handoffs).length > 2_000) throw Error('队列通知检查点异常')
  for (const [id, row] of Object.entries(state.rows)) if (!/^[a-f0-9]{32}$/.test(id) || !Array.isArray(row) || row.length !== 2 || !Object.values(codes).includes(row[0]) || !/^\d+$/.test(row[1])) throw Error('队列通知身份异常')
  for (const [id, annotation] of Object.entries(state.handoffs)) if (!annotation || annotation.id !== id || typeof annotation.entryId !== 'string'
    || !annotation.scope || !['expected', 'older', 'present', 'unverified'].includes(annotation.transcript) || typeof annotation.recordWritten !== 'boolean') throw Error('交接通知检查点异常')
  return state
}
const terminal = (code?: Code) => code === 'a' || code === 'd' || code === 'w' || code === 'r'
export const queueNotificationEvent = (id: string, phase: QueueNoticePhase) => `queue:${id}:${phase}`

export function reduceQueueNotifications(old: QueueNotificationState | undefined, input: QueueNotificationInput, baseline: boolean, revision: number) {
  const state: QueueNotificationState = { version: 1, key: input.key, ...(input.runId ? { runId: input.runId } : {}),
    ...(input.workspaceId ?? old?.workspaceId ? { workspaceId: input.workspaceId ?? old?.workspaceId } : {}), rows: { ...old?.rows }, handoffs: { ...old?.handoffs } }
  const annotations = new Map(input.annotations.map(value => [value.id, value]))
  const drafts: NotificationDraft[] = []; let complete = true
  for (const fact of input.facts) {
    const previous = old?.rows[fact.id]?.[0], oldHandoff = old?.handoffs[fact.id], annotation = annotations.get(fact.id) ?? oldHandoff
    let phase = fact.phase, code: Code = codes[phase]
    // Confirmed taking/withdrawal/retirement cannot roll back on a late queued frame.
    if (terminal(previous) && (code === 'q' || code === 'h' || code === 'u')) { code = previous!; phase = (Object.keys(codes) as QueueNoticePhase[]).find(key => codes[key] === code)! }
    if (previous === 'a') { code = 'a'; phase = 'replied' }
    if (previous === 'd' && (code === 'w' || code === 'r')) { code = 'd'; phase = 'delivered' }
    const handoff = annotation ? { ...annotation, scope: fact.scope.sessionId ? fact.scope : oldHandoff?.scope ?? annotation.scope,
      ...(fact.replyEntryId ?? oldHandoff?.replyEntryId ? { replyEntryId: fact.replyEntryId ?? oldHandoff?.replyEntryId } : {}) } : undefined
    const changed = previous !== code || JSON.stringify(oldHandoff) !== JSON.stringify(handoff)
    if (!changed) continue
    const stock = !old && baseline && !handoff && (input.monitorStartedAt === undefined || fact.at < input.monitorStartedAt)
    if (!stock && drafts.length >= NOTIFICATION_SOURCE_BATCH_LIMIT) { complete = false; break }
    state.rows[fact.id] = [code, fact.channelId]
    if (handoff) state.handoffs[fact.id] = handoff
    if (stock) continue
    const meaningful = Boolean(handoff)
    const key = `queue:${fact.id}`, scope = handoff?.scope ?? fact.scope
    const title = handoff?.transfer ? phase === 'queued' || phase === 'held' ? '成员身份已迁移，上下文消息已排队' : phase === 'delivered' ? '成员身份已迁移，目标已取走上下文消息'
      : phase === 'replied' ? '成员身份已迁移，目标已返回交接回复' : '成员已迁移，原上下文消息已退出队列'
      : handoff ? phase === 'held' ? '上下文交接等待新会话取走' : phase === 'queued' ? '上下文交接已入队'
        : phase === 'delivered' ? '目标通道已取走上下文消息' : phase === 'replied' ? '目标已返回本次交接的回复' : '原上下文消息已退出队列'
        : ({ queued: '消息已入队', held: '消息等待新会话', delivered: '通道已取走消息', replied: '已收到对应回复', withdrawn: '消息已撤回', retired: '未送达消息已退役', unconfirmed: '原队列消息结果待核对' })[phase]
    const stage = ({ queued: '本地入队不等于实际取走；不据此确认回复。', held: '原会话无法取走保持位消息，需等该席位的新会话或由用户在原入口放行。',
      delivered: '通道服务已记录取走，未据此声称目标已读完上下文或已完成任务。', replied: '存在与本次出站消息明确关联的完整回复；交接内容和后续工作请以原回复为准。',
      withdrawn: '原队列事务确认撤回；不会自动重新投递。', retired: '原业务状态确认该未投递消息退役；它不再是即将送达的消息。',
      unconfirmed: '原作用域已切换，但旧行的最终状态未能核对。不会称它即将送达，也不猜撤回、退役或交接失败。' })[phase]
    const document = handoff ? `\n交接时转录${handoff.transcript === 'expected' ? '尚未创建' : handoff.transcript === 'older' ? '早于本次发出时间' : handoff.transcript === 'present' ? '路径已存在' : '新鲜度未确认'}；不保证原会话已经完整落盘。`
      + (handoff.recordWritten ? ' 拾光补充记录已写入。' : ' 拾光补充记录未写入，原转录路径仍已入队。') : ''
    const identity = handoff?.transfer ? `\n目标接过角色 ${handoff.transfer.roleName}；释放 ${handoff.transfer.released} 个任务${handoff.transfer.lead ? '，主控身份随迁' : ''}。身份迁移不因后续交接状态回滚。` : ''
    drafts.push({ key, eventId: queueNotificationEvent(fact.id, phase), eventType: 'queue.state', subjectState: phase, category: 'sessions', source: handoff?.transfer ? '成员迁移与上下文' : handoff ? '上下文交接' : `会话队列 · CH-${fact.channelId}`,
      title: phase === 'unconfirmed' && handoff ? '原上下文消息结果待核对' : title, detail: `CH-${fact.channelId} · ${stage}${document}${identity}`, scope, ...(scope.sessionId && phase !== 'retired' && phase !== 'withdrawn' && phase !== 'unconfirmed'
        ? { target: { kind: 'session' as const, scope, entryId: phase === 'replied' ? fact.replyEntryId ?? handoff?.replyEntryId ?? fact.entryId : fact.entryId,
          ...(phase === 'queued' || phase === 'held' ? { surface: 'queue' as const } : {}) } } : {}),
      origin: { module: handoff?.transfer ? 'run' : 'sessions', sessionId: scope.sessionId },
      attention: meaningful ? 'notice' : 'activity', tone: meaningful && (phase === 'retired' || phase === 'withdrawn' || phase === 'unconfirmed' || !handoff!.recordWritten || handoff!.transcript !== 'present') ? 'warning' : 'info',
      state: phase === 'retired' || phase === 'withdrawn' ? 'expired' : phase === 'queued' || phase === 'held' || phase === 'unconfirmed' ? 'active' : 'resolved',
      occurredAt: fact.at, sourceRevision: revision, renewAttention: meaningful && (previous !== code || !oldHandoff), respectCleared: previous === code && Boolean(oldHandoff),
      announce: !baseline && meaningful && previous !== code && (phase === 'retired' || phase === 'unconfirmed') })
  }
  if (Object.keys(state.rows).length > 50_000 || Object.keys(state.handoffs).length > 2_000) throw Error('队列通知检查点超过容量')
  return { state, drafts, complete }
}
