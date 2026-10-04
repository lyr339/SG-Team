import type { NotificationDraft, NotificationScope } from './notification'

export interface NotificationSessionFact {
  identity: string
  name: string
  scope: NotificationScope
  online: boolean
  evidence: 'active' | 'suspected' | 'stopped'
  retired: boolean
  /** Evidence association was checked by the application adapter; neither progress text nor elapsed silence decides death. */
  liveAt?: number
  boundAt?: number
  pendingWork: boolean
}
export interface SessionLifecycleObservation {
  scopeKey: string
  runId?: string
  workspaceId?: string
  runCompleted: boolean
  healthy: boolean
  baseline: boolean
  baselineIdentities?: string[]
  quietDelivery?: boolean
  monitorStartedAt: number
  now: number
  facts: NotificationSessionFact[]
  restart?: SessionNotificationRestart
}
export interface SessionNotificationRestart {
  id: string
  label: string
  section: 'accounts' | 'maintenance'
  status: 'running' | 'done' | 'failed' | 'unknown'
  startedAt?: number
  finalized?: boolean
  targets: Array<Pick<NotificationSessionFact, 'identity' | 'name' | 'scope'>>
}
interface Incident { key: string; startedAt: number; confirmed: boolean; signalled: boolean; needsAction?: boolean }
interface SessionCheckpoint { fact: NotificationSessionFact; onlineObserved: boolean; incident?: Incident; expectedRestartId?: string }
export interface SessionLifecycleCheckpoint {
  version: 1
  scopeKey: string
  runCompleted: boolean
  rows: Record<string, SessionCheckpoint>
  restart?: SessionNotificationRestart
}

export function readSessionLifecycleCheckpoint(value: unknown, scopeKey: string): SessionLifecycleCheckpoint | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw Error('会话通知检查点格式异常')
  const result = value as SessionLifecycleCheckpoint
  if (result.version !== 1 || result.scopeKey !== scopeKey || typeof result.runCompleted !== 'boolean'
    || !result.rows || typeof result.rows !== 'object' || Array.isArray(result.rows) || Object.keys(result.rows).length > 256) throw Error('会话通知检查点格式异常')
  for (const [identity, row] of Object.entries(result.rows)) {
    if (!row?.fact || row.fact.identity !== identity || typeof row.onlineObserved !== 'boolean' || typeof row.fact.online !== 'boolean'
      || !['active', 'suspected', 'stopped'].includes(row.fact.evidence) || typeof row.fact.name !== 'string' || !row.fact.scope) throw Error('会话通知检查点格式异常')
    if (row.incident && (typeof row.incident.key !== 'string' || !Number.isSafeInteger(row.incident.startedAt) || typeof row.incident.confirmed !== 'boolean' || typeof row.incident.signalled !== 'boolean')) throw Error('会话通知检查点格式异常')
    if (row.expectedRestartId !== undefined && (typeof row.expectedRestartId !== 'string' || row.expectedRestartId.length > 150)) throw Error('重启通知检查点格式异常')
  }
  if (result.restart && (typeof result.restart.id !== 'string' || !['running', 'done', 'failed', 'unknown'].includes(result.restart.status)
    || result.restart.startedAt !== undefined && (!Number.isSafeInteger(result.restart.startedAt) || result.restart.startedAt < 0)
    || !['accounts', 'maintenance'].includes(result.restart.section) || !Array.isArray(result.restart.targets) || result.restart.targets.length > 256)) throw Error('重启通知检查点格式异常')
  return result
}

/** Presentation reducer only: cannot change a session, run, task, account or presence lease. */
export function reduceSessionLifecycleNotifications(previous: SessionLifecycleCheckpoint | undefined, observation: SessionLifecycleObservation,
  sourceRevision: number, newIncidentId: () => string): { checkpoint: SessionLifecycleCheckpoint; drafts: NotificationDraft[] } {
  const old = previous?.scopeKey === observation.scopeKey ? previous : undefined
  let restart = observation.restart ?? old?.restart
  if (restart && old?.restart?.id === restart.id && old.restart.status === restart.status && old.restart.finalized) restart = { ...restart, finalized: true }
  if (!observation.restart && observation.baseline && restart?.status === 'running') restart = { ...restart, status: 'unknown' }
  const checkpoint: SessionLifecycleCheckpoint = { version: 1, scopeKey: observation.scopeKey, runCompleted: observation.runCompleted, rows: {}, ...(restart ? { restart } : {}) }
  const drafts: NotificationDraft[] = []
  const event = (fact: NotificationSessionFact, fields: Pick<NotificationDraft, 'key' | 'title' | 'detail' | 'tone' | 'attention' | 'state'> & Partial<NotificationDraft>): NotificationDraft => ({
    category: 'sessions', source: `会话 · ${fact.name}`, scope: fact.scope, target: { kind: 'session', scope: fact.scope },
    origin: { module: 'sessions', sessionId: fact.scope.sessionId }, occurredAt: observation.now, timeBasis: 'observed', sourceRevision, ...fields
  })
  const current = new Map(observation.facts.map(fact => [fact.identity, fact]))
  if (old && observation.runCompleted && !old.runCompleted && observation.runId) {
    drafts.push({ key: `run:${observation.runId}:monitoring-ended`, category: 'run', source: '运行', title: '本轮会话监测已结束',
      detail: `批次已结束，旧会话将按原规则退出；任务和回复结果仍保留在原记录。\n${Object.values(old.rows).map(row => row.fact.name).join('、').slice(0, 1_000)}`,
      tone: 'info', attention: 'activity', state: 'resolved', scope: { ...(observation.workspaceId ? { workspaceId: observation.workspaceId } : {}), runId: observation.runId },
      target: { kind: 'run', runId: observation.runId }, occurredAt: observation.now, timeBasis: 'observed', sourceRevision, announce: false })
  }
  for (const fact of observation.facts) {
    const row = old?.rows[fact.identity]
    const baseline = observation.baseline || observation.baselineIdentities?.includes(fact.identity) === true
    const next: SessionCheckpoint = { fact, onlineObserved: baseline && !row?.incident ? fact.online : row?.onlineObserved === true || fact.online,
      ...(row?.incident ? { incident: { ...row.incident } } : {}), ...(row?.expectedRestartId ? { expectedRestartId: row.expectedRestartId } : {}) }
    checkpoint.rows[fact.identity] = next
    if (observation.runCompleted || fact.retired) {
      if (row?.incident) drafts.push(event(fact, { key: row.incident.key, title: `${fact.name} 的连接记录已结束`, detail: '运行或会话已正常退役。此记录不代表未完成任务或回复已被处理。',
        tone: 'info', attention: 'activity', state: 'expired', announce: false }))
      delete next.incident
      delete next.expectedRestartId
      continue
    }
    if (!row) {
      // New hydration of an old binding is a baseline, not a freshly created session. Unknown timestamps stay conservative.
      if (fact.online && fact.boundAt !== undefined && fact.boundAt >= observation.monitorStartedAt) {
        drafts.push(event(fact, { key: `session:${fact.identity}:online`, title: `${fact.name} 已上线`, detail: '已观察到当前会话的真实接入。', tone: 'info', attention: 'activity', state: 'resolved', announce: false,
          ...(!baseline ? { liveSignal: 'connection' as const } : {}) }))
      }
      continue
    }
    const expected = !row.incident && (row.expectedRestartId || restart?.status === 'running' && restart.targets.some(target => target.identity === fact.identity))
    if (expected && !fact.online) { next.expectedRestartId = row.expectedRestartId ?? restart!.id; continue }
    if (fact.online && next.expectedRestartId) delete next.expectedRestartId
    if (fact.online) {
      if (row.incident) {
        const restored = fact.liveAt !== undefined ? fact.liveAt > row.incident.startedAt : !baseline && !row.fact.online
        if (!restored) continue
        drafts.push(event(fact, { key: row.incident.key, title: `${fact.name} 已恢复连接`, detail: '当前同一会话已出现新的生命证据。连接异常已收口，任务和回复结果仍以原记录为准。',
          tone: 'success', attention: row.incident.signalled ? 'notice' : 'activity', state: 'resolved', renewAttention: row.incident.signalled && !baseline,
          announce: row.incident.signalled && !baseline, ...(!baseline ? { liveSignal: 'connection' as const } : {}) }))
        delete next.incident
      } else if (!row.onlineObserved && (!baseline || fact.boundAt !== undefined && fact.boundAt >= observation.monitorStartedAt)
        && (observation.healthy || fact.evidence === 'active')) {
        drafts.push(event(fact, { key: `session:${fact.identity}:online`, title: `${fact.name} 已上线`, detail: '已观察到当前会话的真实接入。', tone: 'info', attention: 'activity', state: 'resolved', announce: false,
          ...(!baseline ? { liveSignal: 'connection' as const } : {}) }))
      }
      continue
    }
    // No observer, source hydration or startup baseline can manufacture a new outage.
    if (baseline || !observation.healthy && fact.evidence !== 'stopped') continue
    if (!row.onlineObserved && !row.incident) continue
    const confirmed = fact.evidence === 'stopped'
    const incident = row.incident ? { ...row.incident } : { key: `session:${fact.identity}:outage:${newIncidentId()}`, startedAt: observation.now, confirmed: false, signalled: false }
    const upgrade = confirmed && fact.pendingWork && !incident.needsAction
    if (!row.incident || confirmed && !incident.confirmed || upgrade) {
      const signalled = confirmed
      drafts.push(event(fact, { key: incident.key, title: confirmed ? `${fact.name} 已离线` : `${fact.name} 暂时失联`,
        detail: confirmed ? fact.pendingWork ? '当前会话有明确终止证据，已离线，仍有执行或回复待同步。请查看原会话和任务结果。' : '当前会话有明确终止证据，已离线；是否需要重新建立会话由你决定。'
          : '当前活性证据不足，尚未确认 Cursor 会话已停止。长任务及任务结果不据此判失败。',
        tone: confirmed ? 'warning' : 'info', attention: confirmed ? fact.pendingWork || incident.needsAction ? 'action' : 'notice' : 'activity', state: 'active',
        renewAttention: signalled && !incident.signalled, announce: signalled && !incident.signalled }))
      incident.confirmed ||= confirmed; incident.signalled ||= signalled
      incident.needsAction ||= confirmed && fact.pendingWork
    }
    next.incident = incident
  }
  for (const row of Object.values(old?.rows ?? {})) {
    if (current.has(row.fact.identity)) continue
    const replacement = observation.facts.find(fact => fact.scope.channelId === row.fact.scope.channelId && fact.identity !== row.fact.identity)
    if (row.incident && observation.runCompleted) drafts.push(event(row.fact, { key: row.incident.key, title: `${row.fact.name} 的连接记录已结束`,
      detail: '本轮监测已结束。任务和回复结果以原记录为准，不因停止监测而视为完成。', tone: 'info', attention: 'activity', state: 'expired', announce: false }))
    else if (row.incident && replacement) drafts.push(event(row.fact, { key: row.incident.key, title: `${row.fact.name} 的旧会话已停止监测`,
      detail: '该通道已绑定新会话。旧任务和待同步回复不会因为新会话上线而被当作完成。', tone: 'info', attention: 'activity', state: 'expired', announce: false }))
    // Disappearance without a replacement or real stop is not proof of death. Retain until the scope explicitly ends.
    if (!replacement && !observation.runCompleted) checkpoint.rows[row.fact.identity] = row
  }
  if (restart && !restart.finalized) {
    const states = restart.targets.map(target => {
      const same = current.get(target.identity)
      const replacement = observation.facts.find(fact => fact.scope.channelId === target.scope.channelId && fact.identity !== target.identity)
      const newerLife = restart.startedAt !== undefined && same?.online && same.liveAt !== undefined && same.liveAt > restart.startedAt
      const newerBinding = restart.startedAt !== undefined && replacement?.online && (replacement.liveAt !== undefined && replacement.liveAt > restart.startedAt || replacement.boundAt !== undefined && replacement.boundAt > restart.startedAt)
      return { target, status: newerLife ? '已重新接入' : newerBinding ? '新会话已接入，旧记录保留' : restart.status === 'running' ? '等待重启后生命证据' : '原会话尚未恢复' }
    })
    const missing = states.filter(value => value.status !== '已重新接入' && value.status !== '新会话已接入，旧记录保留').length
    const final = restart.status !== 'running'
    const title = observation.runCompleted ? '本轮的重启监测已结束' : restart.startedAt === undefined ? '上次重启缺少时间基准，请核对当前状态' : restart.status === 'running' ? `${restart.label}进行中`
      : restart.status === 'failed' ? `${restart.label}未完成` : restart.status === 'unknown' ? '上次重启结果待核对'
        : missing ? `Cursor 已重启，${missing} 个原会话尚未恢复` : 'Cursor 重启已完成'
    drafts.push({ key: `cursor-restart:${restart.id}`, category: 'maintenance', source: restart.label, eventId: `cursor-restart:${restart.id}:${restart.status}:${missing}`,
      title, detail: `${restart.status === 'unknown' ? '上次操作没有可恢复的最终结果；不会自动重跑，请查看原功能。\n' : ''}${states.map(value => `${value.target.name}：${value.status}`).join('\n') || '没有已确认在线的会话受到这次重启影响。'}\n任务和回复结果仍以原记录为准。`,
      scope: { ...(observation.workspaceId ? { workspaceId: observation.workspaceId } : {}), ...(observation.runId ? { runId: observation.runId } : {}) },
      target: { kind: 'settings', section: restart.section }, origin: { module: 'account', section: restart.section },
      occurredAt: observation.now, timeBasis: 'observed', sourceRevision, tone: restart.status === 'failed' || restart.status === 'unknown' || final && missing > 0 ? 'warning' : final ? 'success' : 'info',
      attention: observation.runCompleted || !final ? 'activity' : 'notice', state: observation.runCompleted ? 'expired' : restart.status === 'done' && missing === 0 ? 'resolved' : 'active',
      renewAttention: !observation.baseline && final && old?.restart?.status !== restart.status, announce: false })
    if (observation.runCompleted || restart.status === 'done' && missing === 0) checkpoint.restart = { ...restart, finalized: true }
  }
  return { checkpoint, drafts }
}
