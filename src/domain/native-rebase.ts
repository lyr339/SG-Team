import { validateNativeScopeMetadata, type NativeScopeMetadata } from './native-scope-availability'
export interface NativeVersionEvidence {
  currentRead?: boolean
  readOwner?: string
  readEpoch?: number
  rebaseFrom?: number
  rebaseTo?: number
  readSignature?: string
}
export interface NativeRebasePending {
  origin?: 'scope-returned'
  from: number
  to: number
  missing: string[]
}
export interface NativeRebaseState extends NativeScopeMetadata {
  readOwner?: string
  readEpoch?: number
  rebases?: number
  pendingRebase?: NativeRebasePending
  readSignature?: string
}
/** Pure metadata validation, not a reset permission policy or workflow state machine. */
export function validateNativeRebaseState(state: NativeRebaseState, maxMissing: number): void {
  validateNativeScopeMetadata(state)
  if (
    (state.readOwner !== undefined && (typeof state.readOwner !== 'string' || !state.readOwner || state.readOwner.length > 128)) ||
    [state.readEpoch, state.rebases].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
    (state.readSignature !== undefined && (typeof state.readSignature !== 'string' || !/^[a-f0-9]{64}$/.test(state.readSignature)))
  )
    throw Error('原读取代次或恢复计数无效')
  const pending = state.pendingRebase
  if (
    pending &&
    ((pending.origin !== undefined && pending.origin !== 'scope-returned') || !Number.isSafeInteger(pending.from) ||
      !Number.isSafeInteger(pending.to) ||
      pending.from < 0 ||
      pending.to < 0 ||
      pending.to > pending.from && pending.origin !== 'scope-returned' ||
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
  if (input.readSignature !== undefined && (typeof input.readSignature !== 'string' || !/^[a-f0-9]{64}$/.test(input.readSignature))) throw Error('原读取内容指纹无效')
  return Boolean(
    previous &&
      input.currentRead &&
      (input.revision < previous.revision ||
        (input.revision === previous.revision && previous.readSignature !== undefined && input.readSignature !== undefined && input.readSignature !== previous.readSignature) ||
        (input.rebaseFrom !== undefined && (input.readOwner !== previous.readOwner || input.readEpoch !== previous.readEpoch)))
  )
}
