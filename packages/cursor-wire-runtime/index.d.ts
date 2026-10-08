import type { WireStore } from "./store";
import type { WireTypes } from "./types";
export interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  ended_at_ms?: number;
}
export interface WireResult {
  backend: "wire";
  runId: string;
  conversationId: string;
  startedAt: number;
  endedAt: number;
  httpStatus: number;
  text: string;
  usage: WireUsage | null;
  frames: number;
  clientMessages: number;
  checkpointCount: number;
  priorTurns: number;
  kvGets: number;
  kvSets: number;
  normalEnd: true;
}
export interface WireEvent {
  type: string;
  text?: string;
  usage?: WireUsage;
  [key: string]: unknown;
}
export interface WireOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  types?: WireTypes;
  store: WireStore;
  text: string;
  model?: {
    modelId?: string;
    parameters?: Array<{ id: string; value: string }>;
  };
  context?: unknown;
  onEvent?: (event: WireEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  heartbeatMs?: number;
  beforeTransmit?: (identities: {
    runId: string;
    conversationId: string;
  }) => void;
}
export class WireRunError extends Error {
  code: string;
  details?: unknown;
  constructor(message: string, code?: string, details?: unknown);
}
export function runWire(options: WireOptions): Promise<WireResult>;
export function minimalContext(directory: string): unknown;
