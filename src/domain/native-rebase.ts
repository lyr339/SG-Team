export interface NativeVersionEvidence {
  currentRead?: boolean
  readOwner?: string
  readEpoch?: number
  rebaseFrom?: number
  rebaseTo?: number
}
export interface NativeRebasePending {
  from: number
  to: number
  missing: string[]
}
export interface NativeRebaseState {
  readOwner?: string
  readEpoch?: number
  rebases?: number
  pendingRebase?: NativeRebasePending
}
/** Pure metadata validation, not a reset permission policy or workflow state machine. */
export function validateNativeRebaseState(state: NativeRebaseState, maxMissing: number): void {
  if (
    (state.readOwner !== undefined && (typeof state.readOwner !== 'string' || !state.readOwner || state.readOwner.length > 128)) ||
    [state.readEpoch, state.rebases].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
  )
    throw Error('原读取代次或恢复计数无效')
  const pending = state.pendingRebase
  if (
    pending &&
    (!Number.isSafeInteger(pending.from) ||
      !Number.isSafeInteger(pending.to) ||
      pending.from < 0 ||
      pending.to < 0 ||
      pending.to > pending.from ||
      !Array.isArray(pending.missing) ||
      pending.missing.length > maxMissing ||
      new Set(pending.missing).size !== pending.missing.length ||
      pending.missing.some((value) => typeof value !== 'string' || !value || value.length > 300))
  )
    throw Error('原读取恢复进度无效')
}
export function nativeRevisionRegressed(
  previous: (NativeRebaseState & { revision: number }) | undefined,
  input: NativeVersionEvidence & { revision: number }
): boolean {
  return Boolean(
    previous &&
      input.currentRead &&
      (input.revision < previous.revision ||
        (input.rebaseFrom !== undefined && (input.readOwner !== previous.readOwner || input.readEpoch !== previous.readEpoch)))
  )
}
