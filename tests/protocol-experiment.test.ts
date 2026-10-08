import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WireOptions, WireResult } from "@shiguang/cursor-wire-runtime";
import {
  ProtocolExperimentService,
  safeExperimentError,
} from "../src/application/protocol-experiment-service";
import { ProtocolExperimentCredentialResolver } from "../src/application/protocol-experiment-credential";
import { protocolIdentityRef } from "../src/infrastructure/cursor/cursor-protocol-quota";

const directories: string[] = [];
const services: ProtocolExperimentService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "sg-experiment-"));
  directories.push(path);
  return path;
};
const credential = {
  accountId: "local-saved-account",
  label: "研究账号",
  accessToken: "normal-session-secret",
  subject: "mock-user",
};
const resolveCredential = (): ReturnType<
  typeof vi.fn<() => Promise<typeof credential>>
> => vi.fn(async () => ({ ...credential }));
function result(options: WireOptions): WireResult {
  return {
    backend: "wire",
    runId: randomUUID(),
    conversationId: options.store.metadata.conversationId,
    startedAt: Date.now(),
    endedAt: Date.now(),
    httpStatus: 200,
    text: "OK",
    usage: {
      input_tokens: 1000,
      output_tokens: 3,
      cache_read_tokens: 500,
      cache_write_tokens: 0,
    },
    frames: 4,
    clientMessages: 2,
    checkpointCount: 1,
    priorTurns: options.store.metadata.runs.length,
    kvGets: 1,
    kvSets: 1,
    normalEnd: true,
  };
}
const runMock = () =>
  vi.fn(async (options: WireOptions) => {
    const value = result(options);
    options.beforeTransmit?.({
      runId: value.runId,
      conversationId: value.conversationId,
    });
    options.onEvent?.({ type: "text", text: "OK" });
    options.store.recordRun(value);
    return value;
  });
function make(
  overrides: Partial<
    ConstructorParameters<typeof ProtocolExperimentService>[1]
  > = {},
  path = directory(),
) {
  const run = runMock(),
    resolver = resolveCredential(),
    request = vi.fn(
      async () =>
        new Response(new Uint8Array(), {
          headers: { "content-type": "application/proto" },
        }),
    );
  const service = new ProtocolExperimentService(path, {
    resolveCredential: resolver,
    run,
    fetch: request,
    ...overrides,
  });
  services.push(service);
  return { service, run, resolver, request, path };
}
async function create(service: ProtocolExperimentService) {
  return (await service.create()).sessions.at(-1)!;
}

describe("isolated protocol experiment service", () => {
  it("does not generate on mount/create; explicitly sends Auto only with no MCP, files, or SDK dependency", async () => {
    const { service, run, request, path } = make();
    expect(service.snapshot().sessions).toEqual([]);
    const row = await create(service);
    expect(run).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await service.send(row.id, "仅回复 OK");
    const options = run.mock.calls[0]![0];
    expect(options.model).toEqual({ modelId: "default", parameters: [] });
    expect(options.headers).toMatchObject({
      "x-cursor-client-type": "sdk",
      "x-cursor-client-version": "sdk-1.0.36",
    });
    expect(options.context).toMatchObject({
      tools: [],
      rules: [],
      mcpInstructions: [],
      env: { workspacePaths: [] },
    });
    expect(service.snapshot().sessions[0]).toMatchObject({
      turns: 1,
      state: "completed",
      attempts: [{ text: "OK", checkpointCount: 1 }],
    });
    expect(readFileSync(join(path, "experiments.json"), "utf8")).not.toContain(
      credential.accessToken,
    );
    expect(request.mock.calls).toHaveLength(1);
  });
  it("binds identity at creation and never silently uses the newly selected account", async () => {
    const resolver = vi.fn(async (id?: string) => ({
      ...credential,
      accountId: id ?? "selected-A",
    }));
    const { service, run } = make({ resolveCredential: resolver });
    const row = await create(service);
    await service.send(row.id, "OK");
    expect(resolver.mock.calls.map((call) => call[0])).toEqual([
      undefined,
      "selected-A",
    ]);
    resolver.mockResolvedValue({
      ...credential,
      accountId: "selected-A",
      subject: "wrong-user",
    });
    await expect(service.send(row.id, "OK")).rejects.toThrow("身份已变化");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("blocks duplicate/global concurrent sends before a credential or model call", async () => {
    let release!: (value: WireResult) => void;
    let captured!: WireOptions;
    const run = vi.fn((options: WireOptions) => {
      captured = options;
      return new Promise<WireResult>((resolve) => {
        release = resolve;
      });
    });
    const { service } = make({ run });
    const a = await create(service),
      b = await create(service);
    const pending = service.send(a.id, "OK");
    await Promise.resolve();
    await expect(service.send(a.id, "OK")).rejects.toThrow("不会重复");
    await expect(service.send(b.id, "OK")).rejects.toThrow("不会重复");
    release(result(captured));
    await pending;
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("cancels during authentication without transmitting or automatically retrying", async () => {
    let resolve!: (value: typeof credential) => void;
    const { service, run, resolver } = make();
    const row = await create(service);
    resolver.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = service.send(row.id, "OK");
    service.cancel(row.id);
    resolve(credential);
    await expect(pending).rejects.toThrow("取消");
    expect(run).not.toHaveBeenCalled();
    expect(service.snapshot().sessions[0]?.state).toBe("cancelled");
  });
  it("counts failed attempts, caps manual sends, rejects long/empty input, and never retries generation", async () => {
    const run = vi.fn(async () => {
      throw new Error("quota exhausted");
    });
    const { service } = make({ run });
    const row = await create(service);
    await expect(service.send(row.id, " ".repeat(2))).rejects.toThrow("1–256");
    await expect(service.send(row.id, "a".repeat(257))).rejects.toThrow(
      "1–256",
    );
    for (let i = 0; i < 3; i++)
      await expect(service.send(row.id, "OK")).rejects.toThrow("quota");
    await expect(service.send(row.id, "OK")).rejects.toThrow("3 次");
    expect(run).toHaveBeenCalledTimes(3);
    expect(service.snapshot().sessions[0]?.attempts).toHaveLength(3);
  });
  it("keeps completed output when metadata lookup fails and returns unknown, not zero", async () => {
    const { service, run } = make({
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const row = await create(service);
    await service.send(row.id, "OK");
    const turn = service.snapshot().sessions[0]!.attempts[0]!;
    expect(turn.state).toBe("completed");
    expect(turn.ledger).toBeUndefined();
    expect(turn.ledgerNote).toContain("不受影响");
    expect(run).toHaveBeenCalledOnce();
  });
  it("refuses to overwrite a corrupted or traversal-shaped store, without crashing other app services", async () => {
    const path = directory();
    writeFileSync(join(path, "experiments.json"), "{broken");
    const { service, run } = make({}, path);
    expect(() => service.snapshot()).toThrow("原文件");
    expect(() => service.create()).toThrow("原文件");
    expect(run).not.toHaveBeenCalled();
    expect(readFileSync(join(path, "experiments.json"), "utf8")).toBe(
      "{broken",
    );
  });
  it("restores interrupted sessions without a network request, preserves partial output, and keeps independent history", async () => {
    const { service, path } = make();
    const row = await create(service);
    const stored = JSON.parse(
      readFileSync(join(path, "experiments.json"), "utf8"),
    );
    stored.sessions[0].state = "running";
    stored.sessions[0].attempts = [
      {
        id: randomUUID(),
        prompt: "OK",
        startedAt: Date.now(),
        state: "running",
        text: "partial",
        thinking: "",
        checkpointCount: 0,
        kvGets: 0,
        kvSets: 0,
      },
    ];
    writeFileSync(join(path, "experiments.json"), JSON.stringify(stored));
    const reopened = make({}, path);
    const restored = reopened.service.snapshot().sessions[0]!;
    expect(restored.id).toBe(row.id);
    expect(restored.state).toBe("interrupted");
    expect(restored.attempts[0]?.text).toBe("partial");
    expect(reopened.run).not.toHaveBeenCalled();
  });
  it("redacts structured backend secrets and never leaks token/email into failure snapshots", async () => {
    const message = `Bearer ${credential.accessToken} eyJhead.payload.signature user@example.com`;
    const { service } = make({
      run: vi.fn(async () => {
        throw { details: [{ debug: { details: { detail: message } } }] };
      }),
    });
    const row = await create(service);
    await expect(service.send(row.id, "OK")).rejects.not.toThrow(
      credential.accessToken,
    );
    expect(JSON.stringify(service.snapshot())).not.toMatch(
      /normal-session-secret|eyJhead|user@example/,
    );
    expect(
      safeExperimentError(new Error(message), credential.accessToken),
    ).toContain("隐藏");
  });
  it("throttles streaming pushes and never runs per-token persistence", async () => {
    const { service } = make({
      run: vi.fn(async (options) => {
        for (let n = 0; n < 100; n++)
          options.onEvent?.({ type: "text", text: "x" });
        const value = result(options);
        options.store.recordRun(value);
        return value;
      }),
    });
    const listener = vi.fn();
    service.subscribe(listener);
    const row = await create(service);
    await service.send(row.id, "OK");
    expect(listener.mock.calls.length).toBeLessThan(12);
  });
});
const jwt = (type: string, sub = "owner", exp = Date.now() / 1000 + 3600) =>
  "header." +
  Buffer.from(JSON.stringify({ type, sub, exp })).toString("base64url") +
  ".signature";
describe("normal credential resolver", () => {
  it("caches only in memory, invalidates changed vault tokens, and does not write or switch the vault", async () => {
    let token = jwt("web");
    const session = jwt("session");
    const exchanger = {
      resolve: vi.fn(async () => ({
        accessToken: session,
        refreshToken: session,
        sourceType: "web",
        runtimeType: "session",
        exchanged: true,
      })),
    };
    const vault = {
      list: vi.fn(() => [
        {
          id: "A",
          label: "user@example.com",
          active: true,
          maskedToken: "",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      credential: vi.fn(() => token),
    };
    const resolver = new ProtocolExperimentCredentialResolver(
      vault,
      exchanger,
      "/isolated/nonexistent.vscdb",
    );
    const first = await resolver.resolve();
    await resolver.resolve("A");
    expect(first.label).toBe("us…@example.com");
    expect(exchanger.resolve).toHaveBeenCalledOnce();
    token = jwt("web", "owner", Date.now() / 1000 + 5000);
    await resolver.resolve("A");
    expect(exchanger.resolve).toHaveBeenCalledTimes(2);
    resolver.clear();
    await resolver.resolve("A");
    expect(exchanger.resolve).toHaveBeenCalledTimes(3);
    expect(protocolIdentityRef(first.subject)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("refuses expired, removed or wrong-subject sessions without a model request", async () => {
    const vault = {
      list: () => [
        {
          id: "A",
          label: "one",
          active: true,
          maskedToken: "",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      credential: () => jwt("web"),
    };
    const exchanger = {
      resolve: vi.fn(async () => ({
        accessToken: jwt("session", "other"),
        refreshToken: "",
        sourceType: "web",
        runtimeType: "session",
        exchanged: true,
      })),
    };
    const resolver = new ProtocolExperimentCredentialResolver(
      vault,
      exchanger,
      "/isolated/nonexistent.vscdb",
    );
    await expect(resolver.resolve("missing")).rejects.toThrow("不能自动换号");
    await expect(resolver.resolve()).rejects.toThrow("不一致");
    vault.credential = () => jwt("web", "owner", Date.now() / 1000 - 1);
    await expect(resolver.resolve()).rejects.toThrow("过期");
    expect(exchanger.resolve).toHaveBeenCalledOnce();
  });
});

function vint(value: number): Buffer {
  let n = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(n & 127n);
    n >>= 7n;
    if (n) byte |= 128;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}
const intField = (no: number, value: number) =>
  Buffer.concat([vint(no * 8), vint(value)]);
const byteField = (no: number, value: string | Buffer) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([vint(no * 8 + 2), vint(bytes.length), bytes]);
};
function receiptBytes(id: string, time: number, output = 3): Buffer {
  const tokens = Buffer.concat([
    intField(1, 500),
    intField(2, output),
    intField(4, 500),
  ]);
  const event = Buffer.concat([
    intField(1, time),
    byteField(2, "default"),
    intField(3, 7),
    intField(8, 1),
    byteField(9, tokens),
    byteField(23, id),
    byteField(24, "free"),
  ]);
  return byteField(3, event);
}
it("accepts only an unambiguous ledger receipt matching conversation, time and token conservation", async () => {
  let bytes: Buffer = Buffer.alloc(0);
  const request = vi.fn(
    async () =>
      new Response(new Uint8Array(bytes), {
        headers: { "content-type": "application/proto" },
      }),
  );
  const { service } = make({ fetch: request });
  const row = await create(service);
  bytes = receiptBytes(row.id, Date.now());
  await service.send(row.id, "OK");
  expect(service.snapshot().sessions[0]!.attempts[0]!.ledger).toMatchObject({
    matched: true,
    productId: "free",
    input: 500,
    cacheRead: 500,
    output: 3,
  });
  const receipt = receiptBytes(row.id, Date.now());
  bytes = Buffer.concat([receipt, receipt]);
  await service.send(row.id, "OK");
  expect(service.snapshot().sessions[0]!.attempts[1]!.ledger).toBeUndefined();
  bytes = receiptBytes(randomUUID(), Date.now());
  await service.send(row.id, "OK");
  expect(service.snapshot().sessions[0]!.attempts[2]!.ledger).toBeUndefined();
});
it("does not buffer an unbounded billing body or misreport it as zero", async () => {
  const request = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/proto" } },
      ),
  );
  const { service } = make({ fetch: request });
  const row = await create(service);
  await service.send(row.id, "OK");
  expect(service.snapshot().sessions[0]!.attempts[0]!).toMatchObject({
    state: "completed",
    ledgerNote: expect.stringContaining("不受影响"),
  });
});

it("recovers the exact durably committed run after a UI-store crash, without generating or guessing", async () => {
  const { service, path } = make();
  const row = await create(service);
  const { WireStore } = await import("@shiguang/cursor-wire-runtime/store");
  const store = new WireStore(join(path, "sessions", row.id), {
    accountScope: row.accountScope,
    conversationId: row.id,
  });
  const run = result({ store, text: "OK" });
  store.recordRun(run, Buffer.alloc(0));
  const stored = JSON.parse(
    readFileSync(join(path, "experiments.json"), "utf8"),
  );
  stored.sessions[0].state = "running";
  stored.sessions[0].attempts = [
    {
      id: randomUUID(),
      runId: run.runId,
      prompt: "OK",
      startedAt: run.startedAt,
      state: "running",
      text: "partial",
      thinking: "",
      checkpointCount: 0,
      kvGets: 0,
      kvSets: 0,
    },
  ];
  writeFileSync(join(path, "experiments.json"), JSON.stringify(stored));
  const reopened = make({}, path);
  const recovered = reopened.service.snapshot().sessions[0]!;
  expect(recovered.state).toBe("completed");
  expect(recovered.attempts[0]!.text).toBe("OK");
  expect(recovered.attempts[0]!.ledger).toBeUndefined();
  expect(reopened.run).not.toHaveBeenCalled();
  stored.sessions[0].attempts[0].runId = randomUUID();
  writeFileSync(join(path, "experiments.json"), JSON.stringify(stored));
  const unmatched = make({}, path);
  expect(unmatched.service.snapshot().sessions[0]!.state).toBe("interrupted");
  expect(unmatched.run).not.toHaveBeenCalled();
});
