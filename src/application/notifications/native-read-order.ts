import type { NativeReadStamp } from '../../domain/native-read-observation'

/** The selected original service owns the stamp. Legacy/unverified snapshots never authorize a rebase. */
export class NativeReadOrder {
  private sequence = 0
  private readonly revisions = new Map<string, { revision: number; epoch: number; rebaseFrom?: number; rebaseTo?: number }>()
  constructor(private readonly owner: string | undefined) {}
  accept(stamp: NativeReadStamp | undefined): 'current' | 'legacy' | 'stale' {
    if (!this.owner) return 'legacy'
    if (!stamp || stamp.owner !== this.owner || !Number.isSafeInteger(stamp.sequence) || stamp.sequence < 1 || stamp.sequence <= this.sequence)
      return 'stale'
    this.sequence = stamp.sequence
    return 'current'
  }
  version(key: string, revision: number, current: boolean): { owner?: string; epoch: number; rebaseFrom?: number; rebaseTo?: number } {
    if (!current) return { epoch: 0 }
    if (!Number.isSafeInteger(revision) || revision < 0) throw Error('原读取修订号无效')
    const old = this.revisions.get(key)
    const value =
      old && revision < old.revision
        ? { revision, epoch: old.epoch + 1, rebaseFrom: old.revision, rebaseTo: revision }
        : { revision, epoch: old?.epoch ?? 0, rebaseFrom: old?.rebaseFrom, rebaseTo: old?.rebaseTo }
    this.revisions.set(key, value)
    if (this.revisions.size > 32) this.revisions.delete(this.revisions.keys().next().value!)
    return {
      owner: this.owner,
      epoch: value.epoch,
      ...(value.rebaseFrom !== undefined ? { rebaseFrom: value.rebaseFrom, rebaseTo: value.rebaseTo } : {})
    }
  }
}
