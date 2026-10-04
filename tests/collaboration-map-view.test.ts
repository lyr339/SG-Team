import { describe, expect, it } from 'vitest'
import { emptyTeamCollaborationSnapshot, type TeamMessage } from '../src/domain/team-collaboration'
import { collaborationMapFacts, collaborationDisplayLink, visibleCollaborationLinks, groupCommunicationSummaries } from '../src/renderer/src/team/collaboration-map-view'
import { pooledTeam } from './run-fixtures'

const NOW = 100_000
function fixture() {
  const team = pooledTeam(['waiting', 'working', 'waiting'], [{ name: '接口组',
    members: [{ channelId: '1', roleTemplateKey: 'lead', roleName: '主控' }, { channelId: '2', roleTemplateKey: 'builder', roleName: '实现' }], leadChannelId: '1' }])
  const group = team.groups[0]!, run = team.activeRun!
  for (const member of group.members) member.slot.groupJoinedAt = 1
  const snapshot = emptyTeamCollaborationSnapshot(run.id)
  const message = (id: string, at = NOW - 1_000): TeamMessage => ({ id, runId: run.id, groupId: group.group.id,
    threadId: 'thread', clientMessageId: id, kind: 'question', content: id, createdAt: at,
    sender: { type: 'agent', slotId: group.members[0]!.slot.id }, recipient: { type: 'agent', slotId: group.members[1]!.slot.id },
    receipt: { notificationState: 'notified', notificationDetail: '', notifiedAt: at, updatedAt: at } })
  const put = (...items: TeamMessage[]) => { snapshot.messages = Object.fromEntries(items.map(m => [m.id, m])); snapshot.messageOrder = items.map(m => m.id) }
  const facts = () => collaborationMapFacts(group, run, snapshot)
  return { team, group, run, snapshot, message, put, facts }
}

describe('real collaboration diagram projection', () => {
  it('uses slot identity, exact run/group scope and deduplicated written messages', () => {
    const f = fixture(), own = f.message('own'), foreign = { ...f.message('foreign'), groupId: 'other' }, old = { ...f.message('old'), runId: 'old-run' }
    f.put(own, foreign, old)
    f.snapshot.messages.alias = own
    f.snapshot.messageOrder.push('own', 'alias')
    expect(f.facts().messages.map(m => m.id)).toEqual(['own'])
    expect(f.facts().links).toHaveLength(1)
    expect(f.facts().links[0]!.latest.sender).toEqual(own.sender)
    f.snapshot.groupId = 'other'
    expect(f.facts().messages).toEqual([])
    f.snapshot.groupId = undefined; f.snapshot.runId = 'old-run'
    expect(f.facts().links).toEqual([])
  })
  it('never invents operator agents or rewires former members via reused CH numbers', () => {
    const f = fixture(), operator = { ...f.message('operator'), sender: { type: 'operator' as const } }, former = f.message('former')
    former.sender = { type: 'agent', slotId: 'old-slot-with-same-CH-1' }
    f.put(operator, former)
    expect(f.facts().links).toEqual([])
    expect(f.facts().messages).toHaveLength(2)
    expect(f.facts().operatorCount).toBe(1)
    expect(f.facts().formerMemberCount).toBe(1)
  })
  it('has no phantom lead in flat groups and follows the real acting lead, not CH-1', () => {
    const f = fixture()
    f.group.effectiveLeadSlotId = undefined
    expect(f.facts().leadId).toBeUndefined()
    f.group.effectiveLeadSlotId = f.group.members[1]!.slot.id
    f.group.group.actingLeadSlotId = f.group.effectiveLeadSlotId
    expect(f.facts()).toMatchObject({ leadId: f.group.members[1]!.slot.id, actingLead: true })
    f.group.members[1]!.slot.groupId = undefined
    expect(f.facts().leadId).toBeUndefined()
    expect(f.facts().members).toHaveLength(1)
  })
  it('briefly shows real recent communication but not perpetual animation from working runtimes', () => {
    const f = fixture(); f.put(f.message('request'))
    const facts = f.facts(), link = facts.links[0]!
    expect(facts.members[1]!.state).toBe('working') // positive execution lease, even with online=false
    expect(collaborationDisplayLink(facts, link, NOW).kind).toBe('active')
    expect(collaborationDisplayLink(facts, link, NOW + 7_000).kind).toBe('waiting')
    expect(visibleCollaborationLinks(facts, NOW).nextPulseUntil).toBe(NOW + 5_000)
    expect(visibleCollaborationLinks(facts, NOW + 7_000).nextPulseUntil).toBeUndefined()
  })
  it('never treats updated receipts or acknowledgement/response clocks as new sends', () => {
    const f = fixture(), old = f.message('old', NOW - 60_000)
    old.receipt.updatedAt = NOW; old.receipt.acknowledgedAt = NOW
    f.put(old)
    expect(collaborationDisplayLink(f.facts(), f.facts().links[0]!, NOW).kind).toBe('waiting')
    old.receipt.respondedAt = NOW
    expect(collaborationDisplayLink(f.facts(), f.facts().links[0]!, NOW).kind).toBe('history')
    const response = f.message('response'); response.kind = 'response'
    response.sender = old.recipient; response.recipient = old.sender; response.replyToMessageId = old.id
    f.put(old, response)
    const shown = collaborationDisplayLink(f.facts(), f.facts().links[0]!, NOW)
    expect(shown).toMatchObject({ kind: 'reply', from: f.group.members[1]!.slot.id, to: f.group.members[0]!.slot.id })
  })
  it('keeps queued/failed/uncertain/offline/ended histories static and membership epochs isolated', () => {
    const f = fixture(), m = f.message('request'); f.put(m)
    for (const [state, kind] of [['queued', 'queued'], ['failed', 'failed'], ['uncertain', 'uncertain']] as const) {
      m.receipt.notifiedAt = undefined; m.receipt.notificationState = state
      expect(collaborationDisplayLink(f.facts(), f.facts().links[0]!, NOW).kind).toBe(kind)
    }
    m.receipt.notificationState = 'notified'; m.receipt.notifiedAt = m.createdAt
    f.group.members[1]!.runtime!.status = 'offline'; f.group.members[1]!.runtime!.connectionPhase = 'offline'; f.group.members[1]!.runtime!.online = false
    expect(collaborationDisplayLink(f.facts(), f.facts().links[0]!, NOW).kind).toBe('offline')
    f.run.status = 'completed'
    expect(f.facts().pendingCount).toBe(0)
    expect(f.facts().members.every(n => n.state === 'ended')).toBe(true)
    expect(collaborationDisplayLink(f.facts(), f.facts().links[0]!, NOW).kind).toBe('history')
    f.run.status = 'running'; f.group.members[1]!.slot.groupJoinedAt = NOW
    expect(f.facts().pendingCount).toBe(0)
    expect(collaborationDisplayLink(f.facts(), f.facts().links[0]!, NOW).kind).toBe('history')
  })
  it('honours authoritative read/response receipts over a late failed notification', () => {
    const f = fixture(), m = f.message('read'); m.receipt.readAt = NOW - 100; m.receipt.notificationState = 'failed'; f.put(m)
    expect(collaborationDisplayLink(f.facts(), f.facts().links[0]!, NOW).kind).toBe('active')
    m.receipt.respondedAt = NOW
    expect(collaborationDisplayLink(f.facts(), f.facts().links[0]!, NOW)).toMatchObject({ kind: 'history', label: '已回复' })
  })
  it('group-card and inspector summary share current scope/pending rules without replaying orphaned history', () => {
    const f = fixture(), pending = f.message('pending'), old = f.message('before-join', 0), foreign = { ...f.message('foreign'), groupId: 'other' }
    const orphan = f.message('orphan'); orphan.receipt.notificationDetail = 'orphaned: member left'
    f.put(pending, old, foreign, orphan)
    expect(groupCommunicationSummaries(f.team, f.snapshot).get(f.group.group.id)).toMatchObject({ count: 3, pending: 1 })
    f.run.status = 'completed'
    expect(groupCommunicationSummaries(f.team, f.snapshot).get(f.group.group.id)?.pending).toBe(0)
    f.snapshot.runId = 'old-run'
    expect(groupCommunicationSummaries(f.team, f.snapshot).size).toBe(0)
  })
  it('dense graphs prioritize the explicitly selected channel and retain every record', () => {
    const team = pooledTeam(Array.from({ length: 8 }, () => 'waiting'), [{ name: '大组', members: Array.from({ length: 8 }, (_, i) =>
      ({ channelId: String(i + 1), roleTemplateKey: 'builder', roleName: `成员 ${i + 1}` })) }])
    const group = team.groups[0]!, snapshot = emptyTeamCollaborationSnapshot(team.activeRun!.id), rows: TeamMessage[] = []
    group.members.forEach(member => { member.slot.groupJoinedAt = 1 })
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) rows.push({
      id: `dense:${a}:${b}`, clientMessageId: `dense:${a}:${b}`, threadId: 'thread', runId: team.activeRun!.id, groupId: group.group.id,
      sender: { type: 'agent', slotId: group.members[a]!.slot.id }, recipient: { type: 'agent', slotId: group.members[b]!.slot.id },
      kind: 'status', content: '完成检查', createdAt: NOW - 10_000 - rows.length,
      receipt: { notificationState: 'not_required', notificationDetail: '', updatedAt: NOW - 10_000 }
    })
    snapshot.messages = Object.fromEntries(rows.map(message => [message.id, message])); snapshot.messageOrder = rows.map(message => message.id)
    const facts = collaborationMapFacts(group, team.activeRun!, snapshot), selected = facts.links.at(-1)!
    const display = visibleCollaborationLinks(facts, NOW, selected.id)
    expect(facts.messages).toHaveLength(28); expect(facts.links).toHaveLength(28)
    expect(display.links).toHaveLength(12); expect(display.hiddenCount).toBe(16)
    expect(display.links.some(link => link.id === selected.id)).toBe(true)
  })
})
