import { createHash } from 'node:crypto'
import type { TeamMemoryReadObservation } from '../../domain/team-memory'
import type { TeamControlSnapshot } from '../../domain/team-control'
import type { NotificationService } from '../notification-service'
import { notificationSafeText } from '../../domain/notification'
import { memoryRevisionIssue } from '../../domain/team-memory-inspection'
import {
  readMemoryIssueState,
  reduceMemoryIssueNotifications,
  type MemoryIssueInput,
  type MemoryIssueState
} from '../../domain/memory-issue-notification'
import {
  validateMemoryOperatorProof,
  type MemoryOperatorReviewObservation,
  type MemoryOperatorReviewProof
} from '../../domain/memory-operator-review'
import { NotificationProjectionSource } from './projection-source'
import { NativeReadOrder } from './native-read-order'

const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const sourceKey = (workspaceId: string, runId: string) => 'memory-issues:' + hash([workspaceId, runId])
const identityOf = (workspaceId: string, runId: string, id: string, version: number) =>
  hash([workspaceId, runId, id, version])
const terminal = (state: MemoryIssueInput['facts'][number]['state']) =>
  ['accepted', 'rejected', 'superseded'].includes(state ?? '')

export function connectMemoryIssueNotifications(
  memory: {
    subscribeReadObservation(listener: (value: TeamMemoryReadObservation) => void): () => void
    getReadOwnerId?(): string
  },
  getTeam: () => TeamControlSnapshot,
  owner: NotificationService
) {
  const startedAt = Date.now()
  const proofs = new Map<string, { proof: MemoryOperatorReviewProof; groupId?: string }>()
  const order = new NativeReadOrder(memory.getReadOwnerId?.())
  const signatures = new WeakMap<MemoryIssueInput['facts'], string>()
  const source = new NotificationProjectionSource<MemoryIssueInput, MemoryIssueState>(
    owner,
    readMemoryIssueState,
    reduceMemoryIssueNotifications,
    (input) => {
      let signature = signatures.get(input.facts)
      if (signature === undefined) {
        signature = JSON.stringify(input.facts)
        signatures.set(input.facts, signature)
      }
      return (
        JSON.stringify([
          input.key,
          input.currentRead ? input.readOwner : null,
          input.currentRead ? input.readEpoch : null
        ]) + signature
      )
    }
  )
  const last = new Map<
    string,
    { input: MemoryIssueInput; teamStamp: string; verified: boolean; activeGroups: Set<string> }
  >()
  let activeKey: string | undefined

  // Proof belongs to the original successful read and request, not just an ID.
  // Keep saved history unconfirmed when that scope is no longer observable.
  const revoke = (key: string): void => {
    const cached = last.get(key)
    if (!cached) return
    for (const fact of cached.input.facts) proofs.delete(fact.identity)
    if (!cached.verified) return
    const input: MemoryIssueInput = {
      ...cached.input,
      currentRead: false,
      now: Date.now(),
      facts: cached.input.facts.map((fact) => {
        if (fact.ceased || terminal(fact.state)) return fact
        return fact.state === 'conflict' || fact.state === 'unconfirmed' || fact.operatorReview
          ? { ...fact, state: 'unconfirmed', operatorReview: undefined }
          : fact
      })
    }
    last.set(key, { ...cached, input, verified: false })
    source.observe(key, input)
  }
  const detach = memory.subscribeReadObservation((observation) => {
    try {
      if (observation.kind === 'unavailable') {
        if (observation.workspaceId && observation.runId) {
          const key = sourceKey(observation.workspaceId, observation.runId)
          revoke(key)
          if (activeKey === key) activeKey = undefined
        }
        return
      }
      const origin = order.accept(observation.stamp)
      if (origin === 'stale') return
      const currentRead = origin === 'current'
      const team = observation.context ?? getTeam(),
        run = team.activeRun,
        snapshot = observation.snapshot
      const key =
        run &&
        snapshot.runId === run.id &&
        snapshot.workspaceId === run.workspaceId &&
        team.activeWorkspaceId === run.workspaceId
          ? sourceKey(run.workspaceId, run.id)
          : undefined
      if (activeKey && activeKey !== key) revoke(activeKey)
      activeKey = key
      if (!key || !run) return

      const nativeVersion = order.version(key, snapshot.revision, currentRead)
      const activeGroups = new Set(
        team.groups
          .filter((view) => view.group.runId === run.id && view.group.status === 'active')
          .map((view) => view.group.id)
      )
      const teamStamp = JSON.stringify([
        run.status,
        team.groups.map((view) => JSON.stringify([view.group.id, view.group.status])).sort()
      ])
      const cached = last.get(key)
      if (currentRead && cached && nativeVersion.epoch !== cached.input.readEpoch) {
        // A genuine lower native read may contain the same item IDs. A request
        // from the newer database is not evidence in this earlier data version.
        for (const fact of cached.input.facts) proofs.delete(fact.identity)
      }
      if (
        cached?.verified &&
        cached.input.revision === snapshot.revision &&
        cached.teamStamp === teamStamp &&
        cached.input.readEpoch === nativeVersion.epoch
      ) {
        // Original reads already happen in orchestration. Offer unchanged facts
        // again so an unknown private ACK can reload its CAS checkpoint.
        source.observe(key, {
          ...cached.input,
          currentRead,
          readOwner: nativeVersion.owner,
          readEpoch: nativeVersion.epoch,
          rebaseFrom: nativeVersion.rebaseFrom,
          rebaseTo: nativeVersion.rebaseTo,
          now: Date.now()
        })
        return
      }
      const input: MemoryIssueInput = {
        scope: { workspaceId: run.workspaceId, runId: run.id },
        currentRead,
        readOwner: nativeVersion.owner,
        readEpoch: nativeVersion.epoch,
        rebaseFrom: nativeVersion.rebaseFrom,
        rebaseTo: nativeVersion.rebaseTo,
        key,
        revision: snapshot.revision,
        now: Date.now(),
        facts: snapshot.itemOrder.flatMap((id) => {
          const item = snapshot.items[id]
          if (!item || item.runId !== run.id || item.workspaceId !== run.workspaceId) return []
          const identity = identityOf(item.workspaceId, item.runId, item.id, item.version)
          if (proofs.get(identity)?.groupId !== item.groupId) proofs.delete(identity)
          const scopeVerified = !item.groupId || activeGroups.has(item.groupId)
          const state =
            !scopeVerified && item.status === 'proposed'
              ? 'unconfirmed'
              : memoryRevisionIssue(item, item.supersedesId ? snapshot.items[item.supersedesId] : undefined)
          const ceased =
            run.status === 'completed' ||
            Boolean(
              item.groupId &&
                team.groups.some(
                  (view) => view.group.id === item.groupId && view.group.status === 'dissolved'
                )
            )
          if (ceased || terminal(state) || !scopeVerified) proofs.delete(identity)
          return [
            {
              identity,
              id: item.id,
              version: item.version,
              title: notificationSafeText(item.title).slice(0, 120),
              state,
              ...(proofs.has(identity) ? { operatorReview: proofs.get(identity)!.proof } : {}),
              scope: {
                workspaceId: item.workspaceId,
                runId: item.runId,
                ...(item.groupId ? { groupId: item.groupId } : {})
              },
              ceased
            }
          ]
        })
      }
      const present = new Set(input.facts.map((fact) => fact.identity))
      for (const fact of cached?.input.facts ?? [])
        if (!present.has(fact.identity)) proofs.delete(fact.identity)
      last.set(key, { input, teamStamp, verified: true, activeGroups })
      if (last.size > 16) {
        const oldest = last.keys().next().value!
        for (const fact of last.get(oldest)!.input.facts) proofs.delete(fact.identity)
        last.delete(oldest)
      }
      source.observe(key, input)
    } catch {
      owner.reportHistoryGap()
    }
  })
  let detached = false
  const stop = () => {
    if (detached) return
    detached = true
    detach()
    last.clear()
    proofs.clear()
  }
  return {
    source,
    observeOperatorReview(value: MemoryOperatorReviewObservation): void {
      if (detached) return
      try {
        validateMemoryOperatorProof(value.proof)
        const identity = identityOf(value.workspaceId, value.runId, value.memoryId, value.memoryVersion)
        const key = sourceKey(value.workspaceId, value.runId),
          cached = last.get(key)
        const fact =
          cached?.verified && activeKey === key
            ? cached.input.facts.find((fact) => fact.identity === identity && !fact.ceased)
            : undefined
        if (
          !fact ||
          fact.scope.groupId !== value.groupId ||
          Boolean(value.groupId && !cached!.activeGroups.has(value.groupId)) ||
          terminal(fact.state)
        )
          return
        const proof = {
          messageId: value.proof.messageId,
          createdAt: value.proof.createdAt,
          reason: value.proof.reason,
          live: value.proof.createdAt >= startedAt
        }
        const old = proofs.get(identity)?.proof
        if (
          old &&
          old.messageId === proof.messageId &&
          old.createdAt === proof.createdAt &&
          old.reason === proof.reason &&
          old.live === proof.live
        ) {
          // Reuse the already signed thin frame, but still let a previously
          // unknown private ACK reconcile. No full memory rehash on each tick.
          source.observe(key, { ...cached!.input, now: Date.now() })
          return
        }
        if (!proofs.has(identity) && proofs.size >= 4096) {
          owner.reportHistoryGap()
          return
        }
        proofs.set(identity, { proof, groupId: value.groupId })
        const input = {
          ...cached!.input,
          now: Date.now(),
          facts: cached!.input.facts.map((row) =>
            row.identity === identity ? { ...row, operatorReview: proof } : row
          )
        }
        last.set(key, { ...cached!, input })
        // Same receipt is still a genuine source frame. The projection transport,
        // not this proof map, decides whether its atomic checkpoint is committed.
        source.observe(key, input)
      } catch {
        owner.reportHistoryGap()
      }
    },
    operatorReviewProof(request: {
      workspaceId: string
      runId: string
      memoryId: string
      version: number
      groupId?: string
    }): MemoryOperatorReviewProof | undefined {
      const key = sourceKey(request.workspaceId, request.runId),
        cached = last.get(key)
      if (
        !cached?.verified ||
        activeKey !== key ||
        (request.groupId && !cached.activeGroups.has(request.groupId))
      )
        return undefined
      const id = identityOf(request.workspaceId, request.runId, request.memoryId, request.version)
      const fact = cached.input.facts.find(
        (row) => row.identity === id && !row.ceased && !terminal(row.state)
      )
      const proof = fact?.scope.groupId === request.groupId ? proofs.get(id)?.proof : undefined
      return proof ? { ...proof } : undefined
    },
    close: () => {
      stop()
      return source.close()
    },
    dispose: () => {
      stop()
      source.stop()
    }
  }
}
