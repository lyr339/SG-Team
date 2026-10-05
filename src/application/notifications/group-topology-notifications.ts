import { createHash } from 'node:crypto'
import type { NotificationService } from '../notification-service'
import { groupMembersMayPlan, type TeamControlSnapshot, type TeamControlReadObservation } from '../../domain/team-control'
import { notificationSafeText } from '../../domain/notification'
import {
  readGroupTopologyState,
  reduceGroupTopologyNotifications,
  type GroupTopologyInput,
  type GroupTopologyState
} from '../../domain/group-topology-notification'
import { NotificationProjectionSource } from './projection-source'
import { NativeReadOrder } from './native-read-order'

/** Actual topology only; no extra group-event query/poll or interpretation of absent clipped groups. */
export function connectGroupTopologyNotifications(
  team: {
    subscribe(listener: (value: TeamControlSnapshot) => void): () => void
    subscribeReadObservation?(listener: (value: TeamControlReadObservation) => void): () => void
    getReadOwnerId?(): string
  },
  owner: NotificationService
) {
  const signatures = new WeakMap<GroupTopologyInput['facts'], string>()
  const source = new NotificationProjectionSource<GroupTopologyInput, GroupTopologyState>(
    owner,
    readGroupTopologyState,
    reduceGroupTopologyNotifications,
    (input) => {
      let signature = signatures.get(input.facts)
      if (signature === undefined) {
        signature = JSON.stringify(input.facts)
        signatures.set(input.facts, signature)
      }
      return JSON.stringify([input.key, input.currentRead ? input.readOwner : null, input.currentRead ? input.readEpoch : null]) + signature
    }
  )
  const order = new NativeReadOrder(team.getReadOwnerId?.())
  const cache = new Map<string, { revision: number; facts: GroupTopologyInput['facts'] }>()
  const observe = (snapshot: TeamControlSnapshot, currentRead: boolean) => {
    try {
      const run = snapshot.activeRun
      if (!run || snapshot.activeWorkspaceId !== run.workspaceId) return
      const key =
        'group-topology:' +
        createHash('sha256')
          .update(JSON.stringify([run.workspaceId, run.id]))
          .digest('hex')
      const old = cache.get(key)
      const nativeVersion = order.version(key, snapshot.revision, currentRead)
      const facts =
        old?.revision === snapshot.revision
          ? old.facts
          : snapshot.groups
              .filter((view) => view.group.runId === run.id)
              .map((view) => ({
                id: view.group.id,
                identity: createHash('sha256')
                  .update(JSON.stringify([run.workspaceId, run.id, view.group.id]))
                  .digest('hex'),
                name: notificationSafeText(view.group.name).slice(0, 80),
                status: view.group.status,
                leadSlotId: view.effectiveLeadSlotId,
                planning: view.effectiveLeadSlotId
                  ? ('lead' as const)
                  : groupMembersMayPlan(view.group)
                    ? ('members' as const)
                    : ('operator' as const),
                members: view.members
                  .map((member) => ({
                    slotId: member.slot.id,
                    label: `${notificationSafeText(member.role.name).slice(0, 48)} · CH-${member.binding?.channelId ?? member.slot.channelId ?? '?'}`
                  }))
                  .sort((a, b) => a.slotId.localeCompare(b.slotId))
              }))
      cache.set(key, { revision: snapshot.revision, facts })
      if (cache.size > 16) cache.delete(cache.keys().next().value!)
      source.observe(key, {
        currentRead,
        readOwner: nativeVersion.owner,
        readEpoch: nativeVersion.epoch,
        rebaseFrom: nativeVersion.rebaseFrom,
        rebaseTo: nativeVersion.rebaseTo,
        key,
        workspaceId: run.workspaceId,
        runId: run.id,
        revision: snapshot.revision,
        now: Date.now(),
        facts
      })
    } catch {
      owner.reportHistoryGap()
    }
  }
  const detach = team.subscribeReadObservation
    ? team.subscribeReadObservation((value) => {
        const origin = order.accept(value.stamp)
        if (origin !== 'stale') observe(value.snapshot, origin === 'current')
      })
    : team.subscribe((snapshot) => observe(snapshot, false))
  let detached = false
  const stop = () => {
    if (!detached) {
      detached = true
      detach()
      cache.clear()
    }
  }
  return {
    source,
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
