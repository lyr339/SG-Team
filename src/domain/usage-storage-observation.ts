/** Metadata from the original load/save only; no file paths, ledger data, model IDs or retry grants. */
export type UsageStorageObservation =
  | { kind: 'load'; result: 'ready' | 'empty' }
  | { kind: 'load'; result: 'history-unconfirmed'; reason: 'read' | 'structure' | 'records'; backupAvailable?: boolean }
  | { kind: 'save'; result: 'confirmed' }
  | { kind: 'save'; result: 'unconfirmed'; reason: 'permission' | 'readonly' | 'capacity' | 'unclassified' }

export function usageStorageFailureReason(error: unknown): Extract<UsageStorageObservation, { result: 'unconfirmed' }>['reason'] {
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    return code === 'EACCES' || code === 'EPERM' ? 'permission' : code === 'EROFS' ? 'readonly' : code === 'ENOSPC' ? 'capacity' : 'unclassified'
  } catch { return 'unclassified' }
}
