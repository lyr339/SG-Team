import type { WireResult } from "./index";
export class WireStore {
  directory: string;
  metadata: {
    accountScope: string;
    conversationId: string;
    backend: string;
    createdAt: number;
    runs: WireResult[];
    checkpointId?: string;
  };
  constructor(
    directory: string,
    identity?: {
      accountScope?: string;
      conversationId?: string;
      backend?: string;
    },
  );
  setBlob(id: Uint8Array, data: Uint8Array): void;
  getBlob(id: Uint8Array): Buffer | undefined;
  checkpoint(): Buffer | null;
  saveCheckpoint(data: Uint8Array): void;
  recordRun(result: WireResult, checkpoint?: Uint8Array): void;
}
