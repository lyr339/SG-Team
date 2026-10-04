import { createHash } from 'node:crypto'
import type { TeamCollaborationSnapshot } from '../../domain/team-collaboration'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import { readOperatorMessageState, reduceOperatorMessages, type OperatorMessageInput, type OperatorMessageState } from '../../domain/team-message-notification'
import { NotificationProjectionSource } from './projection-source'

export function connectOperatorMessageNotifications(messages: { subscribe(listener: (snapshot: TeamCollaborationSnapshot) => void): () => void }, getTeam: () => TeamControlSnapshot, owner: NotificationService) {
  const source = new NotificationProjectionSource<OperatorMessageInput, OperatorMessageState>(owner, readOperatorMessageState, reduceOperatorMessages, input => JSON.stringify([input.key, input.facts]))
  const stop = messages.subscribe(snapshot => {
    try {
      const team = getTeam(); const run = team.activeRun
      if (!run || snapshot.runId !== run.id) return
      const key = `operator-messages:${createHash('sha256').update(JSON.stringify([run.workspaceId, run.id])).digest('hex')}`
      const facts = snapshot.messageOrder.flatMap(id => {
        const message = snapshot.messages[id]
        if (!message || message.runId !== run.id || message.recipient.type !== 'operator' || message.sender.type !== 'agent') return []
        const sender = team.members.find(member => message.sender.type === 'agent' && member.slot.id === message.sender.slotId)
        const thread = snapshot.threads.find(thread => thread.id === message.threadId && thread.runId === run.id)
        return [{ id: message.id, kind: message.kind, at: message.createdAt, sender: sender?.role.name ?? '原成员', ...(thread?.subject ? { subject: thread.subject } : {}),
          scope: { workspaceId: run.workspaceId, runId: run.id, ...(message.groupId ? { groupId: message.groupId } : {}) } }]
      })
      source.observe(key, { key, facts, now: Date.now() })
    } catch { owner.reportHistoryGap() }
  })
  return { source, dispose: () => { stop(); source.stop() } }
}
