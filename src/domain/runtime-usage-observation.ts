/** In-process attribution only. No additional CDP call, raw error, model, counts or credentials. */
export type RuntimeUsageReadResult = { state: 'ready' | 'waiting' } | { state: 'failed'; reason: 'read' | 'record' }
export interface RuntimeUsageReadReceipt { complete(result: RuntimeUsageReadResult): void; unavailable(): void }
export interface RuntimeUsageReadObserver {
  begin(input: { workspacePath?: string; composerIds: readonly string[] }): RuntimeUsageReadReceipt | undefined
  unavailable(): void
}
