/** Consumer result only. No counts, model, error text or source JSON. */
export type UsageBindingFailureReason = 'record' | 'callback' | 'extract' | 'emit'
export type UsageBindingResult = { state: 'ready' | 'waiting' } | { state: 'failed'; reason: UsageBindingFailureReason }
export interface UsageBindingReceipt { complete(result: UsageBindingResult): void; unavailable(): void }
export interface UsageBindingObserver {
  begin(composerId: string): UsageBindingReceipt | undefined
  /** Document/transport changed, not proof that a former failure recovered. */
  reset(): void
  unattributed(): void
  unavailable(): void
}
