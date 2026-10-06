import { createHash } from 'node:crypto'
import type { TeamCollaborationSnapshot, TeamCollaborationReadObservation } from '../../domain/team-collaboration'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import { readOperatorMessageState, reduceOperatorMessages, preserveOperatorMessageMetadata, type OperatorMessageInput, type OperatorMessageState, type NotificationOperatorMessageFact } from '../../domain/team-message-notification'
import { NotificationProjectionSource } from './projection-source'
import { NativeReadOrder } from './native-read-order'
import { operatorMessageNativeFields } from '../../domain/operator-message-read'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// The native digest already covers ID/kind/thread/time/group/subject. Role name
// is presentation only; compare this fixed-length digest + label without another per-row SHA pass.
const presentation = (fact: NotificationOperatorMessageFact) => JSON.stringify([fact.digest, fact.sender])
interface PowerPort { on(name: 'suspend' | 'resume', listener: () => void): unknown; removeListener(name: 'suspend' | 'resume', listener: () => void): unknown }
export function connectOperatorMessageNotifications(messages: {
  subscribe(listener: (snapshot: TeamCollaborationSnapshot) => void): () => void
  subscribeReadObservation?(listener: (value: TeamCollaborationReadObservation) => void): () => void
  getReadOwnerId?(): string
}, getTeam: () => TeamControlSnapshot, owner: NotificationService, options: { power?: PowerPort } = {}) {
  const order = new NativeReadOrder(messages.getReadOwnerId?.())
  const confirmed = new Map<string, { signature: string; facts: Map<string, string> }>()
  let storageEpoch = owner.sourceStorageEpoch(), closed = false, sleeping = false, activeKey: string | undefined, activation = 0
  const source = new NotificationProjectionSource<OperatorMessageInput, OperatorMessageState>(owner, readOperatorMessageState, async (previous, input, baseline, revision) => {
    const projection = reduceOperatorMessages(previous, input, baseline, revision)
    if (input.currentRead && projection.drafts.length)
      projection.drafts = preserveOperatorMessageMetadata(projection.drafts, await owner.operatorMessageRecords(projection.drafts.map(draft => draft.key)))
    return projection
  }, input => JSON.stringify([input.key, input.currentRead ? input.readOwner : null, input.currentRead ? input.readEpoch : null, input.activation, input.signature ?? input.facts]),
  (input, state) => {
    if (closed || !input.currentRead || !input.signature || state.pendingMessages || state.scopeMissing) return
    confirmed.set(input.key, { signature: input.signature, facts: new Map(input.facts.map(fact => [fact.id, presentation(fact)])) })
    // Presentation optimization only; evicted keys safely use full durable recheck.
    while (confirmed.size > 8 || [...confirmed.values()].reduce((sum, value) => sum + value.facts.size, 0) > 50_000)
      confirmed.delete(confirmed.keys().next().value!)
  }, 512) // 50,000 retained identities / 100 per transaction, still a finite no-progress guard.
  const observe = (snapshot: TeamCollaborationSnapshot, currentRead: boolean, context?: TeamControlSnapshot) => {
    if (closed || sleeping) return
    try {
      const team = context ?? getTeam(), run = team.activeRun
      if (!run) { activeKey = undefined; return }
      if (snapshot.runId !== run.id || currentRead && (team.activeWorkspaceId !== run.workspaceId || snapshot.groupId !== undefined)) return
      if (currentRead && (snapshot.schemaVersion !== 1 || new Set(snapshot.messageOrder).size !== snapshot.messageOrder.length
        || snapshot.messageOrder.length !== Object.keys(snapshot.messages).length)) throw Error('原协作消息读取并非完整身份集合')
      if (owner.sourceStorageEpoch() !== storageEpoch) { storageEpoch = owner.sourceStorageEpoch(); confirmed.clear() }
      const key = `operator-messages:${hash([run.workspaceId, run.id])}`
      if (currentRead && activeKey !== key) {
        activeKey = key; ++activation
        source.invalidateCheckpoint(key) // Re-entered original scope is a quiet private verification, not a second original read.
      }
      const members = new Map(team.members.filter(member => member.slot.runId === run.id).map(member => [member.slot.id, member.role.name])), threads = new Map(snapshot.threads.map(thread => [thread.id, thread]))
      const facts: NotificationOperatorMessageFact[] = [], nativeFacts: unknown[][] = []
      for (const id of snapshot.messageOrder) {
        const message = snapshot.messages[id]
        if (currentRead && (!message || message.id !== id || message.runId !== run.id)) throw Error('原协作消息范围或身份无法确认')
        if (!message || message.id !== id || message.runId !== run.id || message.recipient.type !== 'operator' || message.sender.type !== 'agent') continue
        const thread = threads.get(message.threadId), subject = thread?.runId === run.id ? thread.subject : undefined
        const native = operatorMessageNativeFields(message, subject)
        if (!native) throw Error('原协作消息阅读身份无法确认')
        nativeFacts.push(native)
        facts.push(Object.freeze({ id, kind: message.kind, at: message.createdAt, sender: members.get(message.sender.slotId) ?? '原成员', ...(subject ? { subject } : {}),
          scope: Object.freeze({ workspaceId: run.workspaceId, runId: run.id, ...(message.groupId ? { groupId: message.groupId } : {}) }), digest: hash(native) }))
      }
      Object.freeze(facts) // Private thin observations stay stable while async metadata/CAS work is pending.
      const readSignature = hash(nativeFacts.sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))
      const signature = hash([...facts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), version = order.version(key, snapshot.revision, currentRead, readSignature)
      const previous = confirmed.get(key), changedIds = previous ? new Set(facts.filter(fact => previous.facts.get(fact.id) !== presentation(fact)).map(fact => fact.id)) : undefined
      source.observe(key, { key, facts, now: Date.now(), scope: { workspaceId: run.workspaceId, runId: run.id }, nativeRevision: snapshot.revision, signature,
        currentRead, readOwner: version.owner, readEpoch: version.epoch, readSignature: version.readSignature, rebaseFrom: version.rebaseFrom, rebaseTo: version.rebaseTo,
        ...(currentRead ? { activation } : {}),
        ...(previous ? { previousSignature: previous.signature, changedIds } : {}) })
    } catch { owner.reportHistoryGap() }
  }
  const stop = messages.subscribeReadObservation
    ? messages.subscribeReadObservation(value => { const origin = order.accept(value.stamp); if (origin !== 'stale') observe(value.snapshot, origin === 'current', value.context) })
    : messages.subscribe(snapshot => observe(snapshot, false))
  const suspend = () => { sleeping = true; source.quietNextObservation() }, resume = () => { sleeping = false; source.quietNextObservation() }
  options.power?.on('suspend', suspend); options.power?.on('resume', resume)
  const detach = () => { if (!closed) { closed = true; stop(); confirmed.clear(); options.power?.removeListener('suspend', suspend); options.power?.removeListener('resume', resume) } }
  return { source, close: () => { detach(); return source.close() }, dispose: () => { detach(); source.stop() } }
}
