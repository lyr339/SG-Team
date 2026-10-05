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
import { NotificationProjectionSource } from './projection-source'
export function connectMemoryIssueNotifications(
  memory: { subscribeReadObservation(listener: (value: TeamMemoryReadObservation) => void): () => void },
  getTeam: () => TeamControlSnapshot,
  owner: NotificationService
) {
  const signatures = new WeakMap<MemoryIssueInput['facts'], string>()
  const source = new NotificationProjectionSource<MemoryIssueInput, MemoryIssueState>(
    owner,
    readMemoryIssueState,
    reduceMemoryIssueNotifications,
    (input) => {
      let signature = signatures.get(input.facts)
      if (signature === undefined) {
        signature = JSON.stringify([input.key, input.facts])
        signatures.set(input.facts, signature)
      }
      return signature
    }
  )
  const last = new Map<string, { input: MemoryIssueInput; teamStamp: string }>()
  const detach = memory.subscribeReadObservation((observation) => {
    try {
      const team = observation.context??getTeam(),
        run = team.activeRun
      if (observation.kind === 'unavailable') {
        if (!run || run.id !== observation.runId || run.workspaceId !== observation.workspaceId) return
        const key =
            'memory-issues:' +
            createHash('sha256')
              .update(JSON.stringify([run.workspaceId, run.id]))
              .digest('hex'),
          old = last.get(key)
        if (old)
          source.observe(key, {
            ...old.input,
            now: Date.now(),
            facts: old.input.facts.map((fact) => (fact.state === 'conflict' ? { ...fact, state: 'unconfirmed' } : fact))
          })
        return
      }
      const snapshot = observation.snapshot
      if (!run || snapshot.runId !== run.id || snapshot.workspaceId !== run.workspaceId || team.activeWorkspaceId !== run.workspaceId) return
      const key =
        'memory-issues:' +
        createHash('sha256')
          .update(JSON.stringify([run.workspaceId, run.id]))
          .digest('hex')
      const teamStamp = JSON.stringify([
          run.status,
          team.groups
            .filter((view) => view.group.status === 'dissolved')
            .map((view) => view.group.id)
            .sort()
        ]),
        cached = last.get(key)
      // Existing orchestration reads every second. Native metadata revision and
      // explicit termination scope are authoritative; don't rehash all history
      // on unchanged reads. Still offer it so unknown private writes can recover.
      if (cached?.input.revision === snapshot.revision && cached.teamStamp === teamStamp) {
        source.observe(key, { ...cached.input, now: Date.now() })
        return
      }
      const input: MemoryIssueInput = {
        key,
        revision: snapshot.revision,
        now: Date.now(),
        facts: snapshot.itemOrder.flatMap((id) => {
          const item = snapshot.items[id]
          if (!item || !item.supersedesId || item.runId !== run.id || item.workspaceId !== run.workspaceId) return []
          const state = memoryRevisionIssue(item, item.supersedesId ? snapshot.items[item.supersedesId] : undefined)
          return [
            {
              identity: createHash('sha256')
                .update(JSON.stringify([item.workspaceId, item.runId, item.id, item.version]))
                .digest('hex'),
              id: item.id,
              version: item.version,
              title: notificationSafeText(item.title).slice(0, 120),
              state,
              scope: { workspaceId: item.workspaceId, runId: item.runId, ...(item.groupId ? { groupId: item.groupId } : {}) },
              ceased:
                run.status === 'completed' ||
                Boolean(item.groupId && team.groups.some((view) => view.group.id === item.groupId && view.group.status === 'dissolved'))
            }
          ]
        })
      }
      last.set(key, { input, teamStamp })
      if (last.size > 16) last.delete(last.keys().next().value!)
      source.observe(key, input)
    } catch {
      owner.reportHistoryGap()
    }
  })
  let detached = false
  const stop = () => {
    if (!detached) {
      detached = true
      detach()
      last.clear()
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
