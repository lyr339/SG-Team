import { createHash } from 'node:crypto'
import type { TeamControlReadObservation } from '../../domain/team-control'
import { NATIVE_SCOPE_SOURCE_PREFIXES, validNativeScope, validateNativeScopeCatalogue,
  type NativeScopeCatalogue, type NativeScopeRef, type NativeScopeSourcePrefix } from '../../domain/native-scope-availability'
import { nativeCheckpointScope, readNativeScopeCheckpoint, reduceMissingNativeScope, type NativeScopeCheckpoint } from '../../domain/native-scope-notification'
import type { NotificationService } from '../notification-service'
import { NativeReadOrder } from './native-read-order'
import { operatorMessageIds, preserveOperatorMessageMetadata } from '../../domain/team-message-notification'

interface ProjectionPort { flush(): Promise<void>; invalidateCheckpoint(key: string): void }
interface PowerPort { on(name: 'suspend' | 'resume', listener: () => void): unknown; removeListener(name: 'suspend' | 'resume', listener: () => void): unknown }
interface CatalogueFrame { signature: string; storageEpoch: number; workspaces: ReadonlySet<string>; runs: ReadonlySet<string>; at: number }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = (scope: NativeScopeRef) => JSON.stringify([scope.workspaceId, scope.runId])
const signature = (catalogue: NativeScopeCatalogue) => hash([[...catalogue.workspaceIds].sort(), catalogue.runs.map(identity).sort()])
const exists = (frame: CatalogueFrame, scope: NativeScopeRef) => frame.workspaces.has(scope.workspaceId) && frame.runs.has(identity(scope))

/** Original complete catalogue -> private historical checkpoints only. Switching/stopping observation is not disappearance. */
export function connectNativeScopeAvailabilityNotifications(
  team: { getReadOwnerId?(): string; subscribeReadObservation(listener: (value: TeamControlReadObservation) => void): () => void },
  owner: NotificationService,
  sources: Record<NativeScopeSourcePrefix, ProjectionPort>,
  options: { catalogueObserved?: (catalogue: NativeScopeCatalogue) => void; power?: PowerPort; now?: () => number } = {}
) {
  const order = new NativeReadOrder(team.getReadOwnerId?.()), now = options.now ?? Date.now
  let current: CatalogueFrame | undefined, pending: CatalogueFrame | undefined, processing: Promise<void> | undefined
  let completed: string | undefined, generation = 0, accepting = true, disposed = false, sleeping = false, closing: Promise<void> | undefined
  const check = (frame: CatalogueFrame, epoch: number) => !disposed && !sleeping && current === frame && generation === epoch && owner.sourceStorageEpoch() === frame.storageEpoch
  const invalidate = (key: string, prefix: NativeScopeSourcePrefix) => sources[prefix].invalidateCheckpoint(key)

  const legacyScope = async (checkpoint: NativeScopeCheckpoint, prefix: NativeScopeSourcePrefix, stillCurrent: () => boolean): Promise<NativeScopeRef | undefined> => {
    const scope = nativeCheckpointScope(checkpoint)
    if (scope) return scope
    if (checkpoint.kind === 'operator') {
      const ids = operatorMessageIds(checkpoint.state)
      for (let index = 0; index < ids.length && stillCurrent(); index += 100) {
        const rows = await owner.operatorMessageRecords(ids.slice(index, index + 100).map(id => `operator-message:${id}`))
        for (const row of rows) {
          const ref = { workspaceId: row.scope.workspaceId, runId: row.scope.runId }
          if (validNativeScope(ref) && `${prefix}${hash([ref.workspaceId, ref.runId])}` === checkpoint.state.key) return ref
        }
      }
      return undefined
    }
    if (checkpoint.kind !== 'group') return undefined
    // The old group checkpoint lacks a scope descriptor. Only its exact existing
    // semantic records can identify it. No title matching or active-scope fallback.
    const keys = Object.values(checkpoint.state.groups).map(fact => `group-topology:${fact.identity}`)
    if (checkpoint.state.rebases) keys.push(`group-rebase:${checkpoint.state.key.slice(-64)}:${checkpoint.state.rebases}`)
    for (const key of keys) {
      if (!stillCurrent()) return undefined
      const record = (await owner.page({ key, limit: 1 })).records[0]
      if (!record || !['group.topology', 'group.rebase'].includes(record.eventType ?? '')) continue
      const value = { workspaceId: record.scope.workspaceId, runId: record.scope.runId }
      if (validNativeScope(value) && `${prefix}${hash([value.workspaceId, value.runId])}` === checkpoint.state.key) return value
    }
    return undefined
  }

  const repair = async (key: string, prefix: NativeScopeSourcePrefix, descriptor: NativeScopeRef | undefined, frame: CatalogueFrame, epoch: number) => {
    let conflicts = 0
    while (check(frame, epoch)) {
      const stored = await owner.sourceState(key)
      if (!check(frame, epoch)) return
      const checkpoint = readNativeScopeCheckpoint(stored.data, key, prefix)
      if (!checkpoint) return
      const scope = nativeCheckpointScope(checkpoint) ?? descriptor ?? await legacyScope(checkpoint, prefix, () => check(frame, epoch))
      if (!check(frame, epoch)) return
      if (!scope) return // Legacy hydration-only/fully cleared scopes have no verifiable live record. Never guess; wait for their own original read.
      if (`${prefix}${hash([scope.workspaceId, scope.runId])}` !== key) throw Error('旧通知范围无法从原身份验证')
      if (exists(frame, scope) || checkpoint.state.scopeMissing?.summaryClosed && checkpoint.state.scopeMissing.rowsClosed) return
      const projection = reduceMissingNativeScope(checkpoint, scope, { episode: hash([key, stored.revision + 1, frame.at]), at: frame.at }, stored.revision + 1)
      if (checkpoint.kind === 'operator' && projection.drafts.length) {
        projection.drafts = preserveOperatorMessageMetadata(projection.drafts, await owner.operatorMessageRecords(projection.drafts.map(draft => draft.key)))
        if (!check(frame, epoch)) return
      }
      // A hydration-only group may never have emitted a notification. Metadata
      // repair must not manufacture it; archived/tombstoned markers still count.
      const drafts = []
      for (const draft of projection.drafts) {
        const marker = await owner.sourceMarker(draft.key)
        if (!check(frame, epoch)) return
        if (marker.sourceRevision > 0 && !marker.cleared) drafts.push(draft)
      }
      // Fence producer caches BEFORE sending the CAS, including an unknown ACK.
      // An old durable signature cannot swallow the next genuine original read.
      invalidate(key, prefix)
      const result = await owner.commitSource(key, stored.revision, projection.state, drafts)
      if (!check(frame, epoch)) return
      if (!result.applied) {
        if (++conflicts >= 3) throw Error('原范围私有核对冲突未收敛')
        continue
      }
      conflicts = 0
      if (projection.complete) return
    }
  }

  const scan = async (frame: CatalogueFrame, epoch: number) => {
    // Only already accepted private work is drained. This is never awaited by
    // the original business getter/observer and adds no original reads/requests.
    await Promise.all(Object.values(sources).map(source => source.flush()))
    if (!check(frame, epoch)) return
    let confirmed = true
    for (const prefix of NATIVE_SCOPE_SOURCE_PREFIXES) {
      if (!check(frame, epoch)) return
      let after: string | undefined
      try {
        do {
          const page = await owner.listNativeSources({ prefix, ...(after ? { after } : {}), limit: 100 })
          if (!check(frame, epoch)) return
          for (const row of page.rows) {
            if (!check(frame, epoch)) return
            try {
              if (row.scope && `${prefix}${hash([row.scope.workspaceId, row.scope.runId])}` !== row.key) throw Error('私有目录范围身份不一致')
              if (row.scope && exists(frame, row.scope)) continue
              await repair(row.key, prefix, row.scope, frame, epoch)
            } catch { confirmed = false; owner.reportHistoryGap() /* An unverified row cannot starve independent historical sources. */ }
          }
          if (page.nextKey && (page.nextKey <= (after ?? '') || page.nextKey !== page.rows.at(-1)?.key)) throw Error('私有原范围目录游标未推进')
          after = page.nextKey
        } while (after && check(frame, epoch))
      } catch { confirmed = false; owner.reportHistoryGap() }
    }
    if (confirmed && check(frame, epoch)) completed = frame.signature
  }
  const start = () => {
    if (processing || disposed) return
    processing = (async () => {
      while (pending && !disposed && !sleeping) {
        const frame = pending; pending = undefined
        try { await scan(frame, generation) } catch { owner.reportHistoryGap() /* Next genuine catalogue frame, not a retry/probe. */ }
      }
    })().finally(() => { processing = undefined; if (pending && !disposed && !sleeping) start() })
  }
  const stopRead = team.subscribeReadObservation(value => {
    if (!accepting || sleeping || order.accept(value.stamp) !== 'current') return
    try {
      if (!value.catalogue) throw Error('原完整范围目录尚未确认')
      validateNativeScopeCatalogue(value.catalogue)
      const native = { workspaceIds: value.snapshot.workspaces.map(workspace => workspace.id), runs: value.snapshot.runs.map(run => ({ workspaceId: run.workspaceId, runId: run.id })) }
      validateNativeScopeCatalogue(native)
      const catalogueSignature = signature(value.catalogue)
      if (catalogueSignature !== signature(native)) throw Error('原完整范围目录与同次快照不一致')
      options.catalogueObserved?.(value.catalogue)
      const storageEpoch = owner.sourceStorageEpoch(), id = `${storageEpoch}:${catalogueSignature}`
      if (current?.signature === id && (completed === id || processing)) return
      current = { signature: id, storageEpoch, at: now(), workspaces: new Set(value.catalogue.workspaceIds), runs: new Set(value.catalogue.runs.map(identity)) }
      ++generation; pending = current; start()
    } catch { ++generation; current = undefined; pending = undefined; completed = undefined; owner.reportHistoryGap() }
  })
  const suspend = () => { sleeping = true; ++generation; current = undefined; pending = undefined; completed = undefined }
  const resume = () => { sleeping = false; ++generation; current = undefined; pending = undefined; completed = undefined }
  options.power?.on('suspend', suspend); options.power?.on('resume', resume)
  const detach = () => { accepting = false; stopRead(); options.power?.removeListener('suspend', suspend); options.power?.removeListener('resume', resume) }
  const flush = async () => { while (processing) await processing }
  return {
    flush, suspend, resume,
    close: () => { if (!closing) { detach(); closing = flush().finally(() => { disposed = true; ++generation }) } return closing },
    dispose: () => { detach(); disposed = true; ++generation; pending = undefined }
  }
}
