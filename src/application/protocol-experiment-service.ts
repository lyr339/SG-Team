import { existsSync, readFileSync, mkdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  runWire,
  minimalContext,
  type WireResult,
  type WireEvent,
} from "@shiguang/cursor-wire-runtime";
import { WireStore } from "@shiguang/cursor-wire-runtime/store";
import {
  EXPERIMENT_MAX_SENDS,
  type ProtocolExperimentTurn,
  type ProtocolExperimentSession,
  type ProtocolExperimentSnapshot,
} from "../domain/protocol-experiment";
import { writeStoreFileSync } from "../infrastructure/fs/store-file";
import {
  decodeBillingProto,
  usageWindowRequest,
} from "../infrastructure/cursor/cursor-protocol-billing-codec";
import {
  billingReceipts,
  protocolIdentityRef,
  boundedProtocolBody,
} from "../infrastructure/cursor/cursor-protocol-quota";

export interface ExperimentCredential {
  accountId: string;
  label: string;
  accessToken: string;
  subject: string;
}
export interface ExperimentServicePorts {
  resolveCredential(accountId?: string): Promise<ExperimentCredential>;
  run?: typeof runWire;
  fetch?: typeof fetch;
  now?: () => number;
}
const nonnegative = z.number().finite().nonnegative();
const states = z.enum([
  "ready",
  "preparing",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const usageSchema = z
  .object(
    Object.fromEntries(
      [
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "reasoning_tokens",
        "ended_at_ms",
      ].map((key) => [key, nonnegative.optional()]),
    ),
  )
  .strict();
const ledgerSchema = z
  .object({
    model: z.string().max(160),
    productId: z.string().max(160).optional(),
    input: nonnegative,
    output: nonnegative,
    cacheRead: nonnegative,
    cacheWrite: nonnegative,
    chargedCents: nonnegative.optional(),
    matched: z.literal(true),
  })
  .strict();
const turnSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid().optional(),
    prompt: z.string().min(1).max(256),
    startedAt: nonnegative,
    endedAt: nonnegative.optional(),
    state: states.exclude(["ready"]),
    text: z.string().max(64000),
    thinking: z.string().max(16000),
    usage: usageSchema.optional(),
    error: z.string().max(500).optional(),
    ledger: ledgerSchema.optional(),
    ledgerNote: z.string().max(500).optional(),
    checkpointCount: nonnegative.int(),
    kvGets: nonnegative.int(),
    kvSets: nonnegative.int(),
  })
  .strict();
const storeSchema = z
  .object({
    version: z.literal(1),
    sessions: z
      .array(
        z
          .object({
            id: z.uuid(),
            backend: z.literal("wire"),
            accountId: z.string().min(1).max(160),
            accountScope: z.string().regex(/^[a-f0-9]{64}$/),
            accountLabel: z.string().min(1).max(80),
            createdAt: nonnegative,
            updatedAt: nonnegative,
            state: states,
            modelId: z.literal("default"),
            turns: nonnegative.int().max(EXPERIMENT_MAX_SENDS),
            attempts: z.array(turnSchema).max(EXPERIMENT_MAX_SENDS),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export function safeExperimentError(error: unknown, token?: string): string {
  const value = error as { message?: string; code?: string; details?: unknown };
  const details = Array.isArray(value?.details)
    ? value.details[0]?.debug?.details
    : undefined;
  let message = String(
    details?.detail ?? details?.title ?? value?.message ?? "隔离实验未完成。",
  );
  if (token) message = message.split(token).join("[凭据已隐藏]");
  return message
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[凭据已隐藏]")
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已隐藏]")
    .slice(0, 500);
}
/** Independent Ask-only storage. Never binds TeamRun, MCP or an IDE Composer. */
export class ProtocolExperimentService {
  private sessions: ProtocolExperimentSession[] = [];
  private listeners = new Set<(snapshot: ProtocolExperimentSnapshot) => void>();
  private active?: { id: string; controller: AbortController };
  private creating?: Promise<ProtocolExperimentSnapshot>;
  private revision = 0;
  private disposed = false;
  private loadError?: Error;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private streamPersistAt = 0;
  private persistenceError?: Error;
  private readonly file: string;

  constructor(
    private readonly directory: string,
    private readonly ports: ExperimentServicePorts,
  ) {
    this.file = join(directory, "experiments.json");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory())
        throw new Error("Invalid experiment directory");
      if (existsSync(this.file)) {
        const stat = lstatSync(this.file);
        if (!stat.isFile() || stat.size > 6 * 1024 * 1024)
          throw new Error("Invalid experiment file");
        const stored = storeSchema.parse(
          JSON.parse(readFileSync(this.file, "utf8")),
        );
        this.sessions = stored.sessions as ProtocolExperimentSession[];
        if (
          new Set(this.sessions.map((row) => row.id)).size !==
          this.sessions.length
        )
          throw new Error("Duplicate experiment identity");
        // A crash cannot authorize a retry. Preserve partial output and completed
        // wire checkpoints, but expose the unfinished UI turn as interrupted.
        for (const row of this.sessions) {
          if (row.state === "running" || row.state === "preparing") {
            row.state = "interrupted";
            const turn = row.attempts.at(-1);
            if (turn) {
              turn.state = "interrupted";
              turn.error =
                "上次运行被中断；没有自动重发，已发出的请求可能计入用量。";
              // The wire commit may have completed just before the UI-store
              // write. Recover only the exact committed run, never send again.
              const path = join(this.directory, "sessions", row.id);
              if (turn.runId && existsSync(join(path, "session.json"))) {
                try {
                  const store = new WireStore(path, {
                    accountScope: row.accountScope,
                    conversationId: row.id,
                  });
                  const run = store.metadata.runs.find(
                    (candidate) =>
                      candidate.runId === turn.runId &&
                      candidate.normalEnd === true,
                  );
                  if (run && store.checkpoint()) {
                    const restored = turnSchema.parse({
                      ...turn,
                      state: "completed",
                      text: run.text,
                      usage: run.usage ?? undefined,
                      endedAt: run.endedAt,
                      checkpointCount: run.checkpointCount,
                      kvGets: run.kvGets,
                      kvSets: run.kvSets,
                      error: undefined,
                      ledgerNote: "已从成功提交恢复结果；账本归属尚未核对。",
                    }) as ProtocolExperimentTurn;
                    Object.assign(turn, restored);
                    row.state = "completed";
                    row.turns = store.metadata.runs.length;
                  }
                } catch {
                  /* Inconsistent state stays interrupted; no network or overwrite. */
                }
              }
            }
          }
        }
      }
    } catch {
      this.loadError = new Error(
        "隔离实验记录无法读取，原文件保留；其他功能不受影响。",
      );
    }
  }
  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }
  private assertUsable(): void {
    if (this.loadError) throw this.loadError;
    if (this.disposed) throw new Error("实验后端已关闭。");
    if (this.persistenceError) throw this.persistenceError;
  }
  snapshot(): ProtocolExperimentSnapshot {
    this.assertUsable();
    return structuredClone({
      revision: this.revision,
      busySessionId: this.active?.id,
      sessions: this.sessions,
    });
  }
  subscribe(
    listener: (snapshot: ProtocolExperimentSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(): void {
    if (this.disposed) return;
    this.revision++;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* Detached renderer must not interrupt a model run. */
      }
    }
  }
  private persist(): void {
    writeStoreFileSync(
      this.file,
      JSON.stringify({ version: 1, sessions: this.sessions }),
      { mode: 0o600 },
    );
    this.streamPersistAt = this.now();
  }
  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.persist();
    this.publish();
  }
  private schedule(): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      try {
        if (this.now() - this.streamPersistAt >= 500) this.persist();
        this.publish();
      } catch {
        this.persistenceError = new Error(
          "实验结果保存失败；已停止本次运行，未自动重发。",
        );
        this.active?.controller.abort();
      }
    }, 80);
  }
  create(): Promise<ProtocolExperimentSnapshot> {
    this.assertUsable();
    if (this.creating) return this.creating;
    this.creating = this.createSession()
      .catch((error) => {
        throw new Error(safeExperimentError(error));
      })
      .finally(() => {
        this.creating = undefined;
      });
    return this.creating;
  }
  private async createSession(): Promise<ProtocolExperimentSnapshot> {
    if (this.sessions.length >= 20)
      throw new Error("最多保存 20 个实验会话；本次未删除旧数据。");
    const credential = await this.ports.resolveCredential();
    this.assertUsable();
    const time = this.now();
    this.sessions.push({
      id: randomUUID(),
      backend: "wire",
      accountId: credential.accountId,
      accountScope: protocolIdentityRef(credential.subject),
      accountLabel: credential.label,
      createdAt: time,
      updatedAt: time,
      state: "ready",
      modelId: "default",
      turns: 0,
      attempts: [],
    });
    this.flush();
    return this.snapshot();
  }
  async send(id: string, text: string): Promise<ProtocolExperimentSnapshot> {
    this.assertUsable();
    const row = this.sessions.find((candidate) => candidate.id === id);
    if (!row) throw new Error("隔离实验会话不存在。");
    if (this.active)
      throw new Error("已有实验正在运行或核对账本；不会重复发起。");
    if (typeof text !== "string" || !text.trim() || text.length > 256)
      throw new Error("实验提示词限制为 1–256 个字符。");
    if (row.attempts.length >= EXPERIMENT_MAX_SENDS)
      throw new Error("该会话已达到 3 次发送上限，未发出请求。");
    const controller = new AbortController();
    this.active = { id, controller };
    const turn: ProtocolExperimentTurn = {
      id: randomUUID(),
      prompt: text,
      startedAt: this.now(),
      state: "preparing",
      text: "",
      thinking: "",
      checkpointCount: 0,
      kvGets: 0,
      kvSets: 0,
    };
    row.attempts.push(turn);
    row.state = "preparing";
    row.updatedAt = this.now();
    let token: string | undefined;
    let result: WireResult | undefined;
    try {
      this.flush();
      const credential = await this.ports.resolveCredential(row.accountId);
      token = credential.accessToken;
      if (
        protocolIdentityRef(credential.subject) !== row.accountScope ||
        credential.accountId !== row.accountId
      )
        throw new Error(
          "会话绑定的账号身份已变化，未发出请求。请新建实验会话。",
        );
      if (controller.signal.aborted || this.disposed)
        throw new Error("实验已取消。");
      const store = new WireStore(join(this.directory, "sessions", row.id), {
        accountScope: row.accountScope,
        conversationId: row.id,
      });
      turn.state = "running";
      row.state = "running";
      this.flush();
      const event = (value: WireEvent): void => {
        if (controller.signal.aborted || this.disposed) return;
        if (value.type === "text")
          turn.text = (turn.text + (value.text ?? "")).slice(0, 64000);
        if (value.type === "thinking")
          turn.thinking = (turn.thinking + (value.text ?? "")).slice(0, 16000);
        if (value.type === "usage") turn.usage = value.usage;
        if (value.type === "checkpoint")
          turn.checkpointCount = Number(value.count);
        if (value.type === "kv") {
          if (value.operation === "getBlobArgs") turn.kvGets++;
          if (value.operation === "setBlobArgs") turn.kvSets++;
        }
        row.updatedAt = this.now();
        this.schedule();
      };
      result = await (this.ports.run ?? runWire)({
        store,
        text,
        context: minimalContext(store.directory),
        model: { modelId: "default", parameters: [] },
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": "shiguang-protocol-experiment/0.1",
          "x-cursor-client-type": "sdk",
          "x-cursor-client-version": "sdk-1.0.36",
          "x-cursor-streaming": "true",
          "x-request-id": randomUUID(),
        },
        beforeTransmit: (identities) => {
          turn.runId = identities.runId;
          this.flush();
        },
        onEvent: event,
      });
      turn.state = "completed";
      row.state = "completed";
      row.turns = store.metadata.runs.length;
      turn.text = result.text;
      turn.usage = result.usage ?? undefined;
      turn.checkpointCount = result.checkpointCount;
      turn.kvGets = result.kvGets;
      turn.kvSets = result.kvSets;
      turn.endedAt = result.endedAt;
      turn.ledgerNote = "结果已保存，正在只读核对账本…";
      row.updatedAt = this.now();
      this.flush();
      // A metadata failure never turns a successful generation into a failure,
      // and never retries the generation or changes the account/billing settings.
      try {
        turn.ledger = await this.ledger(token, result, controller.signal);
        turn.ledgerNote = turn.ledger
          ? undefined
          : "尚无唯一匹配的账本记录；不补零，不重发。";
      } catch {
        turn.ledgerNote = "账本核对暂不可用；已保存的结果不受影响。";
      }
      row.updatedAt = this.now();
      this.flush();
    } catch (error) {
      if (!result) {
        turn.state = controller.signal.aborted ? "cancelled" : "failed";
        row.state = turn.state;
        turn.endedAt = this.now();
        turn.error =
          this.persistenceError?.message ?? safeExperimentError(error, token);
        row.updatedAt = this.now();
      }
      try {
        this.flush();
      } catch {
        /* Preserve the previous on-disk record, never overwrite with an empty store. */
      }
      throw new Error(
        this.persistenceError?.message ?? safeExperimentError(error, token),
      );
    } finally {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.active = undefined;
      if (!this.disposed && !this.persistenceError) this.publish();
    }
    return this.snapshot();
  }
  cancel(id: string): ProtocolExperimentSnapshot {
    this.assertUsable();
    if (this.active?.id === id) this.active.controller.abort();
    return this.snapshot();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.controller.abort();
    clearTimeout(this.flushTimer);
    this.listeners.clear();
    try {
      if (!this.loadError && !this.persistenceError) this.persist();
    } catch {
      /* Interrupted state is reconciled at next startup. */
    }
  }
  private async ledger(
    token: string,
    run: WireResult,
    signal: AbortSignal,
  ): Promise<ProtocolExperimentTurn["ledger"]> {
    const response = await (this.ports.fetch ?? fetch)(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/proto",
          "connect-protocol-version": "1",
        },
        body: new Uint8Array(
          usageWindowRequest(run.startedAt - 60000, this.now()),
        ),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      },
    );
    if (
      !response.ok ||
      !(response.headers.get("content-type") ?? "").startsWith(
        "application/proto",
      )
    )
      return undefined;
    const candidates = billingReceipts(
      decodeBillingProto(
        await boundedProtocolBody(response),
        "aiserver.v1.GetFilteredUsageEventsResponse",
      ),
    ).filter(
      (receipt) =>
        receipt.conversationRef === protocolIdentityRef(run.conversationId) &&
        receipt.timestamp >= run.startedAt - 1500 &&
        receipt.timestamp <= run.endedAt + 5000 &&
        receipt.input + receipt.cacheRead + receipt.cacheWrite ===
          run.usage?.input_tokens &&
        receipt.output === run.usage?.output_tokens,
    );
    if (candidates.length !== 1) return undefined;
    const match = candidates[0]!;
    return {
      model: match.model,
      productId: match.productId,
      input: match.input,
      output: match.output,
      cacheRead: match.cacheRead,
      cacheWrite: match.cacheWrite,
      chargedCents: match.chargedCents,
      matched: true,
    };
  }
}
