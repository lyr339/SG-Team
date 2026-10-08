import type { WireUsage } from "@shiguang/cursor-wire-runtime";

export const EXPERIMENT_MAX_SENDS = 3;
export type ExperimentState =
  | "ready"
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface ExperimentLedger {
  model: string;
  productId?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  chargedCents?: number;
  matched: true;
}
export interface ProtocolExperimentTurn {
  id: string;
  runId?: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  state: Exclude<ExperimentState, "ready">;
  text: string;
  thinking: string;
  usage?: WireUsage;
  error?: string;
  ledger?: ExperimentLedger;
  ledgerNote?: string;
  checkpointCount: number;
  kvGets: number;
  kvSets: number;
}
export interface ProtocolExperimentSession {
  id: string;
  backend: "wire";
  accountId: string;
  accountScope: string;
  accountLabel: string;
  createdAt: number;
  updatedAt: number;
  state: ExperimentState;
  modelId: "default";
  turns: number;
  attempts: ProtocolExperimentTurn[];
}
export interface ProtocolExperimentSnapshot {
  revision: number;
  busySessionId?: string;
  sessions: ProtocolExperimentSession[];
}
export interface ProtocolExperimentSend {
  sessionId: string;
  text: string;
}
