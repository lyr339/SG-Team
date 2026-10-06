import { notificationIsPending, notificationIsUnread, type NotificationPage, type NotificationQuery, type NotificationRecord, type NotificationPush } from '../../../domain/notification'

const clearable = (record: NotificationRecord) => record.attention !== 'activity' && !notificationIsUnread(record) && !notificationIsPending(record)
const sameBody = (a: NotificationRecord, b: NotificationRecord) => a.revision === b.revision && (a.storageEpoch ?? 0) === (b.storageEpoch ?? 0)
const receipt = (old: NotificationRecord, incoming: NotificationRecord): NotificationRecord => incoming.readRevision >= old.readRevision ? incoming : old
interface ReadStep { kind: 'receipt' | 'irrelevant' | 'unknown'; unread: number; clearable: number }

/** Bounded read-only UI reconciliation, not a workflow/store. Unknown revision gaps require explicit refresh, never guessed scoped counts. */
export class NotificationCenterProjection {
  private query: NotificationQuery = {}
  private readonly receipts = new Map<string, NotificationRecord>()
  private readonly steps = new Map<number, ReadStep>()
  private epoch = 0
  reset(query: NotificationQuery, storageEpoch = this.epoch): void {
    this.query = query; this.epoch = storageEpoch; this.receipts.clear(); this.steps.clear()
  }
  changeStorage(epoch: number | undefined): boolean {
    if (epoch === undefined || epoch === this.epoch) return false
    if (epoch < this.epoch) return false
    this.reset(this.query, epoch); return true
  }
  private scoped(record: NotificationRecord): boolean {
    return !this.query.workspaceId || !record.scope.workspaceId || record.scope.workspaceId === this.query.workspaceId
  }
  observe(event: NotificationPush, records: readonly NotificationRecord[], extra?: NotificationRecord): { read?: NotificationRecord; irrelevant?: boolean } {
    const change = event.change
    if (!change?.changed) return {}
    const incoming = change.record
    let step: ReadStep = { kind: 'unknown', unread: 0, clearable: 0 }, read: NotificationRecord | undefined
    if (incoming && !this.scoped(incoming)) step.kind = 'irrelevant'
    else if (incoming) {
      const saved = this.receipts.get(incoming.id), listed = records.find(record => record.id === incoming.id) ?? (extra?.id === incoming.id ? extra : undefined)
      const before = saved && listed && sameBody(saved, listed) ? receipt(listed, saved) : saved ?? listed
      if (before && sameBody(incoming, before) && incoming.archivedAt === before.archivedAt) {
        read = receipt(before, incoming); this.receipts.set(incoming.id, read)
        step = { kind: 'receipt', unread: Number(notificationIsUnread(read)) - Number(notificationIsUnread(before)),
          clearable: Number(clearable(read)) - Number(clearable(before)) }
      }
    }
    // A duplicated read response/push must not replace the first true delta with
    // zero merely because its already confirmed receipt is now in the cache.
    if (!this.steps.has(change.summary.revision)) this.steps.set(change.summary.revision, step)
    while (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value!)
    while (this.steps.size > 256) this.steps.delete(this.steps.keys().next().value!)
    return { ...(read ? { read } : {}), ...(step.kind === 'irrelevant' ? { irrelevant: true } : {}) }
  }
  merge(result: NotificationPage, previous: NotificationPage | undefined, more: boolean, latestRevision: number): { page: NotificationPage; dirty: boolean } {
    const append = more && !result.reset && previous && (previous.storageEpoch ?? 0) === (result.storageEpoch ?? 0)
    const rows = append ? [...previous.records, ...result.records.filter(record => !previous.records.some(old => old.id === record.id))] : result.records
    const records = rows.map(record => {
      const current = this.receipts.get(record.id)
      return current && sameBody(current, record) && current.archivedAt === record.archivedAt ? receipt(record, current) : record
    })
    let unread = 0, cleared = 0, proven = latestRevision - result.summary.revision <= 256
    for (let revision = result.summary.revision + 1; proven && revision <= latestRevision; revision++) {
      const step = this.steps.get(revision)
      if (!step || step.kind === 'unknown') { proven = false; break }
      unread += step.unread; cleared += step.clearable
    }
    return { page: { ...result, records, summary: { ...result.summary,
      ...(proven ? { unread: Math.max(0, result.summary.unread + unread), clearable: Math.max(0, result.summary.clearable + cleared) } : {}) } },
      dirty: latestRevision > result.summary.revision && !proven }
  }
  applyRead(page: NotificationPage, incoming: NotificationRecord): NotificationPage {
    const old = page.records.find(record => record.id === incoming.id)
    if (!old || !sameBody(old, incoming) || incoming.readRevision < old.readRevision) return page
    return { ...page, records: page.records.map(record => record.id === incoming.id ? incoming : record), summary: { ...page.summary,
      unread: Math.max(0, page.summary.unread + Number(notificationIsUnread(incoming)) - Number(notificationIsUnread(old))),
      clearable: Math.max(0, page.summary.clearable + Number(clearable(incoming)) - Number(clearable(old))) } }
  }
}
