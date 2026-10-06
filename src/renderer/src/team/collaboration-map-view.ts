import type { TeamGroupView, TeamRun, TeamControlSnapshot } from '../../../domain/team-control'
import type { TeamCollaborationSnapshot, TeamMessage } from '../../../domain/team-collaboration'
import { isOrphanedReceipt, teamMessageNeedsAgentResponse, teamMessageReceiptStage } from '../../../domain/team-collaboration'
import { hasConfirmedRuntimeStop } from '../../../domain/channel-message'
import { seatStateOf, SEAT_STATE_LABEL, type PoolSeatState } from '../run/pool-view'

/** A short visual acknowledgement of real message activity, never a transport/progress estimate. */
export const COLLABORATION_PULSE_MS = 6_000
export const COLLABORATION_VISIBLE_LINKS = 12

export interface CollaborationMapMember {
  id: string
  order: number
  name: string
  channelId?: string
  avatarId: string
  state: PoolSeatState | 'ended'
  stateLabel: string
  joinedAt?: number
}

export interface CollaborationMapLink {
  id: string
  a: string
  b: string
  latest: TeamMessage
  messages: TeamMessage[]
  pending: TeamMessage[]
}

export interface CollaborationMapFacts {
  workspaceId: string
  scopeKey: string
  runId: string
  groupId: string
  name: string
  goal: string
  closed: boolean
  dissolved: boolean
  scoped: boolean
  leadId?: string
  missingLead: boolean
  actingLead: boolean
  members: CollaborationMapMember[]
  links: CollaborationMapLink[]
  messages: TeamMessage[]
  threadSubjects: Record<string, string>
  pendingCount: number
  operatorCount: number
  formerMemberCount: number
}

export type CollaborationLinkKind = 'active' | 'reply' | 'waiting' | 'queued' | 'offline' | 'history' | 'failed' | 'uncertain'
export interface CollaborationMapDisplayLink {
  id: string
  from: string
  to: string
  kind: CollaborationLinkKind
  label: string
  message: TeamMessage
  count: number
  pendingCount: number
  pulseUntil?: number
}

export interface GroupCommunicationSummary { count: number; pending: number; latest?: TeamMessage }
/** Closed entry points use one cheap pass, not one graph projection per group or animation frame. */
export function groupCommunicationSummaries(team: TeamControlSnapshot, snapshot: TeamCollaborationSnapshot): Map<string, GroupCommunicationSummary> {
  const result = new Map<string, GroupCommunicationSummary>(), run = team.activeRun
  if (!run || snapshot.runId !== run.id) return result
  const groups = new Map(team.groups.filter(view => view.group.runId === run.id).map(view => [view.group.id, view]))
  const seen = new Set<string>()
  for (const id of snapshot.messageOrder) {
    const message = snapshot.messages[id]
    if (!message || seen.has(message.id) || message.runId !== run.id || !message.groupId || !groups.has(message.groupId)
      || snapshot.groupId && snapshot.groupId !== message.groupId) continue
    seen.add(message.id)
    const summary = result.get(message.groupId) ?? { count: 0, pending: 0 }
    summary.count++
    if (!summary.latest || message.createdAt > summary.latest.createdAt || message.createdAt === summary.latest.createdAt && message.id > summary.latest.id) summary.latest = message
    const group = groups.get(message.groupId)!
    if (run.status === 'running' && group.group.status === 'active' && message.sender.type === 'agent' && message.recipient.type === 'agent'
      && teamMessageNeedsAgentResponse(message) && message.receipt.respondedAt === undefined && !isOrphanedReceipt(message.receipt)) {
      const sender = message.sender.slotId, recipient = message.recipient.slotId
      const a = group.members.find(m => m.slot.id === sender && m.slot.groupId === group.group.id)
      const b = group.members.find(m => m.slot.id === recipient && m.slot.groupId === group.group.id)
      if (a?.slot.runId === run.id && b?.slot.runId === run.id && (a.slot.groupJoinedAt ?? 0) <= message.createdAt && (b.slot.groupJoinedAt ?? 0) <= message.createdAt) summary.pending++
    }
    result.set(message.groupId, summary)
  }
  return result
}

export function collaborationPairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a])
}

function beforeCurrentMembership(message: TeamMessage, members: ReadonlyMap<string, CollaborationMapMember>): boolean {
  return [message.sender, message.recipient].some(actor => actor.type === 'agent'
    && (members.get(actor.slotId)?.joinedAt ?? -Infinity) > message.createdAt)
}

/** Read-only projection. Slot/group/run identity is authoritative; CH numbers are only current display labels. */
export function collaborationMapFacts(
  view: TeamGroupView,
  run: TeamRun,
  snapshot: TeamCollaborationSnapshot
): CollaborationMapFacts {
  const group = view.group
  const matchingRun = group.runId === run.id
  const closed = !matchingRun || run.status !== 'running' || group.status !== 'active'
  const members: CollaborationMapMember[] = matchingRun ? view.members
    .filter(member => member.slot.runId === run.id && member.slot.groupId === group.id)
    .map(member => {
      const state = closed ? 'ended' as const : member.runtime && hasConfirmedRuntimeStop(member.runtime)
        ? 'offline' as const : seatStateOf(member)
      return {
        id: member.slot.id, order: member.slot.order, name: member.role.name,
        channelId: member.binding?.channelId ?? member.slot.channelId,
        avatarId: member.slot.avatarId, state,
        stateLabel: state === 'ended' ? '批次已结束' : SEAT_STATE_LABEL[state],
        joinedAt: member.slot.groupJoinedAt
      }
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) : []
  const memberById = new Map(members.map(member => [member.id, member]))
  const scoped = matchingRun && snapshot.runId === run.id && (!snapshot.groupId || snapshot.groupId === group.id)
  const messages: TeamMessage[] = []
  const seen = new Set<string>()
  if (scoped) for (const id of snapshot.messageOrder) {
    const message = snapshot.messages[id]
    if (!message || seen.has(message.id) || message.runId !== run.id || message.groupId !== group.id) continue
    seen.add(message.id)
    messages.push(message)
  }
  messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const links = new Map<string, CollaborationMapLink>()
  let operatorCount = 0, formerMemberCount = 0
  for (const message of messages) {
    if (message.sender.type !== 'agent' || message.recipient.type !== 'agent') { operatorCount++; continue }
    const a = message.sender.slotId, b = message.recipient.slotId
    if (a === b) continue
    if (!memberById.has(a) || !memberById.has(b)) { formerMemberCount++; continue }
    const id = collaborationPairKey(a, b)
    const link = links.get(id) ?? { id, a: a < b ? a : b, b: a < b ? b : a, latest: message, messages: [], pending: [] }
    link.messages.push(message)
    link.latest = message
    if (!closed && teamMessageNeedsAgentResponse(message) && message.receipt.respondedAt === undefined
      && !isOrphanedReceipt(message.receipt) && !beforeCurrentMembership(message, memberById)) link.pending.push(message)
    links.set(id, link)
  }
  const leadId = view.effectiveLeadSlotId && memberById.has(view.effectiveLeadSlotId) ? view.effectiveLeadSlotId : undefined
  // Keep each native thread subject once; do not duplicate it for every message.
  const threadSubjects = scoped ? Object.fromEntries(snapshot.threads.filter(thread => thread.runId === run.id).map(thread => [thread.id, thread.subject])) : {}
  return {
    workspaceId: run.workspaceId, scopeKey: `${run.id}:${group.id}`, runId: run.id, groupId: group.id, name: group.name, goal: group.goal,
    closed, dissolved: group.status === 'dissolved', scoped,
    leadId, missingLead: !closed && !!view.effectiveLeadSlotId && !leadId, actingLead: !!leadId && group.actingLeadSlotId === leadId,
    members, links: [...links.values()].sort((a, b) => a.id.localeCompare(b.id)), messages, threadSubjects,
    pendingCount: [...links.values()].reduce((total, link) => total + link.pending.length, 0),
    operatorCount, formerMemberCount
  }
}

export function collaborationDisplayLink(
  facts: CollaborationMapFacts,
  link: CollaborationMapLink,
  now: number,
  selectedMessageId?: string
): CollaborationMapDisplayLink {
  const message = link.messages.find(item => item.id === selectedMessageId) ?? link.latest
  // Map links never contain operator/self/foreign-member messages.
  const from = message.sender.type === 'agent' ? message.sender.slotId : link.a
  const to = message.recipient.type === 'agent' ? message.recipient.slotId : link.b
  const members = new Map(facts.members.map(member => [member.id, member]))
  const base = { id: link.id, from, to, message, count: link.messages.length, pendingCount: link.pending.length }
  if (facts.closed || beforeCurrentMembership(message, members) || isOrphanedReceipt(message.receipt))
    return { ...base, kind: 'history', label: facts.closed ? '历史记录' : '之前的记录' }
  const states = [members.get(from)?.state, members.get(to)?.state]
  if (states.includes('offline')) return { ...base, kind: 'offline', label: '成员离线 · 历史方向' }
  if (states.includes('unconfirmed')) return { ...base, kind: 'history', label: '运行状态待确认' }
  const receipt = message.receipt
  const stage = teamMessageReceiptStage(receipt)
  if (stage === 'responded') return { ...base, kind: 'history', label: '已回复' }
  if (stage === 'failed') return { ...base, kind: 'failed', label: '投递失败' }
  if (stage === 'uncertain') return { ...base, kind: 'uncertain', label: '投递待核对' }
  if (stage === 'queued' && receipt.notificationState !== 'sending') return { ...base, kind: 'queued', label: '待送达' }
  // Responded/acknowledged timestamps are NOT new outbound messages. Never replay their old direction.
  const activityAt = Math.max(message.createdAt, receipt.notifiedAt ?? 0, receipt.readAt ?? 0)
  const pulseUntil = activityAt + COLLABORATION_PULSE_MS
  const fresh = now >= activityAt - 500 && now < pulseUntil
  if (fresh) return { ...base, kind: message.kind === 'response' ? 'reply' : 'active',
    label: receipt.notificationState === 'sending' ? '投递中' : message.kind === 'response' ? '最近回传' : '最近通信', pulseUntil }
  if (receipt.notificationState === 'sending' && stage === 'queued') return { ...base, kind: 'queued', label: '投递中' }
  if (teamMessageNeedsAgentResponse(message) && receipt.respondedAt === undefined)
    return { ...base, kind: 'waiting', label: '待回应' }
  return { ...base, kind: 'history', label: stage === 'acknowledged' ? '已确认' : stage === 'read' ? '已读' : '已投递' }
}

/** Keep the graph readable without silently dropping records: all messages remain in the dialog list. */
export function visibleCollaborationLinks(
  facts: CollaborationMapFacts,
  now: number,
  selectedLinkId?: string,
  selectedMemberId?: string,
  selectedMessageId?: string
): { links: CollaborationMapDisplayLink[]; hiddenCount: number; nextPulseUntil?: number } {
  const display = facts.links.map(link => collaborationDisplayLink(facts, link, now, selectedMessageId))
  const priority = (link: CollaborationMapDisplayLink): number => link.id === selectedLinkId ? 0
    : selectedMemberId && [link.from, link.to].includes(selectedMemberId) ? 1
      : link.kind === 'active' || link.kind === 'reply' ? 2 : link.pendingCount ? 3 : 4
  display.sort((a, b) => priority(a) - priority(b) || b.message.createdAt - a.message.createdAt || a.id.localeCompare(b.id))
  const links = display.slice(0, COLLABORATION_VISIBLE_LINKS).sort((a, b) => a.id.localeCompare(b.id))
  const expiries = display.flatMap(link => link.pulseUntil && link.pulseUntil > now ? [link.pulseUntil] : [])
  return { links, hiddenCount: Math.max(0, display.length - links.length),
    nextPulseUntil: expiries.length ? Math.min(...expiries) : undefined }
}

export function collaborationActorLabel(facts: CollaborationMapFacts, message: TeamMessage, sender: boolean): string {
  const actor = sender ? message.sender : message.recipient
  if (actor.type === 'operator') return sender && message.kind === 'notice' ? '拾光系统' : '操作端'
  const member = facts.members.find(item => item.id === actor.slotId)
  return member ? `${member.name} · CH-${member.channelId ?? '?'}` : '原组员'
}
