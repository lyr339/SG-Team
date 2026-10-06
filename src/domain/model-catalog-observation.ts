/** Original local preference read only. No remote model request, model name, raw JSON, path or credential. */
export type ModelCatalogObservation =
  | { state: 'ready' | 'waiting' | 'fallback'; at: number }
  | { state: 'failed'; reason: 'read' | 'record' | 'size'; at: number }
export interface ModelCatalogObserver {
  observe(fact: ModelCatalogObservation): void
  unavailable(): void
}
