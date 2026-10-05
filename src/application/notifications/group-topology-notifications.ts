import { createHash } from 'node:crypto'
import type { NotificationService } from '../notification-service'
import { groupMembersMayPlan, type TeamControlSnapshot } from '../../domain/team-control'
import { notificationSafeText } from '../../domain/notification'
import {
  readGroupTopologyState,
  reduceGroupTopologyNotifications,
  type GroupTopologyInput,
  type GroupTopologyState
} from '../../domain/group-topology-notification'
import { NotificationProjectionSource } from './projection-source'

/** Actual topology only; no extra group-event query/poll or interpretation of absent clipped groups. */
export function connectGroupTopologyNotifications(
  team: { subscribe(listener: (value: TeamControlSnapshot) => void): () => void },
  owner: NotificationService
) {
  const source = new NotificationProjectionSource<GroupTopologyInput, GroupTopologyState>(
    owner,
    readGroupTopologyState,
    reduceGroupTopologyNotifications,
    (input) => JSON.stringify([input.key, input.facts])
  )
  const detach = team.subscribe((snapshot) => {
    try {
      const run = snapshot.activeRun
      if (!run || snapshot.activeWorkspaceId !== run.workspaceId) return
      const key =
        'group-topology:' +
        createHash('sha256')
          .update(JSON.stringify([run.workspaceId, run.id]))
          .digest('hex')
      source.observe(key, {
        key,
        workspaceId: run.workspaceId,
        runId: run.id,
        revision: snapshot.revision,
        now: Date.now(),
        facts: snapshot.groups
          .filter((view) => view.group.runId === run.id)
          .map((view) => ({
            id: view.group.id,
            identity: createHash('sha256')
              .update(JSON.stringify([run.workspaceId, run.id, view.group.id]))
              .digest('hex'),
            name: notificationSafeText(view.group.name).slice(0, 80),
            status: view.group.status,
            leadSlotId: view.effectiveLeadSlotId,
            planning: view.effectiveLeadSlotId ? 'lead' : groupMembersMayPlan(view.group) ? 'members' : 'operator',
            members: view.members
              .map((member) => ({
                slotId: member.slot.id,
                label: `${notificationSafeText(member.role.name).slice(0, 48)} · CH-${member.binding?.channelId ?? member.slot.channelId ?? '?'}`
              }))
              .sort((a, b) => a.slotId.localeCompare(b.slotId))
          }))
      })
    } catch {
      owner.reportHistoryGap()
    }
  })
  let detached = false
  const stop = () => {
    if (!detached) {
      detached = true
      detach()
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
