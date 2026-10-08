import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { FrameDecoder, encodeEnvelope } from "./wire-framing.mjs";
import { createWireTypes } from "./wire-types.mjs";

export class WireRunError extends Error {
  constructor(message, code = "client_error", details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function minimalContext(directory) {
  return {
    env: {
      osVersion: os.platform() + " " + os.release(),
      workspacePaths: [],
      processWorkingDirectory: directory,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sandboxEnabled: false,
      sandboxSupported: false,
      secretRedactionEnabled: true,
    },
    rules: [],
    tools: [],
    agentSkills: [],
    mcpInstructions: [],
    webSearchEnabled: false,
    webFetchEnabled: false,
    readLintsEnabled: false,
    searchConversationsEnabled: false,
  };
}
export function buildRun(
  types,
  store,
  text,
  { modelId = "default", parameters = [], context = null } = {},
) {
  if (typeof text !== "string" || !text.trim() || text.length > 256)
    throw Error("Experimental prompt must be 1–256 characters");
  const prior = store.checkpoint(),
    state = prior ? types.State.fromBinary(prior) : new types.State();
  const runId = randomUUID(),
    userId = randomUUID();
  const action = {
    action: {
      case: "userMessageAction",
      value: { userMessage: { text, messageId: userId, mode: 2 } },
    },
  };
  if (context) action.action.value.requestContext = context;
  const data = {
    conversationState: state,
    action,
    requestedModel: { modelId: modelId, parameters },
    conversationId: store.metadata.conversationId,
    runId: runId,
    mcpTools: {},
    suggestNextPrompt: false,
    clientSupportsInlineImages: false,
    canCreateCloudSubagents: false,
    clientSupportsSendToUser: false,
    clientSupportsRoutedModelUpdate: true,
  };
  return {
    runId,
    userId,
    message: new types.Client({ message: { case: "runRequest", value: data } }),
    priorTurns: state.turns?.length ?? 0,
  };
}
export async function runWire({
  baseUrl = "https://api2.cursor.sh",
  headers = {},
  types = createWireTypes(),
  store,
  text,
  model,
  context = null,
  onEvent = () => {},
  signal,
  timeoutMs = 90000,
  heartbeatMs = 5000,
  beforeTransmit = () => {},
}) {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw Error("Only HTTPS or loopback mock is allowed");
  const run = buildRun(types, store, text, { ...model, context }),
    start = Date.now();
  const session = http2.connect(url.origin, { minVersion: "TLSv1.2" });
  let lastCheckpoint,
    totalBytes = 0,
    decodedBytes = 0,
    thinkingBytes = 0,
    stream,
    timer,
    heartbeat,
    stopped = false,
    protocolEnd = false,
    turnEnded = false,
    checkpointCount = 0,
    textOutput = "",
    usage = null,
    frames = 0,
    sends = 0,
    kvGets = 0,
    kvSets = 0,
    chain = Promise.resolve(),
    terminalError = null;
  const finalize = () => {
    clearTimeout(timer);
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", abort);
    if (stream && !stream.destroyed) stream.close();
    session.close();
    setTimeout(() => session.destroy(), 250).unref();
  };
  let rejectCurrent;
  const abort = () => {
    terminalError = new WireRunError("Experimental run cancelled", "cancelled");
    rejectCurrent?.(terminalError);
    stream?.close(http2.constants.NGHTTP2_CANCEL);
  };
  session.on("error", (error) => rejectCurrent?.(error));
  signal?.addEventListener("abort", abort, { once: true });
  const emit = (event) => onEvent(event);
  try {
    await new Promise((resolve, reject) => {
      rejectCurrent = reject;
      session.once("connect", resolve);
      timer = setTimeout(
        () =>
          reject(
            new WireRunError("HTTP2 connection timeout", "deadline_exceeded"),
          ),
        Math.min(timeoutMs, 15000),
      );
      if (signal?.aborted) abort();
    });
    clearTimeout(timer);
    if (signal?.aborted)
      throw new WireRunError("Experimental run cancelled", "cancelled");
    beforeTransmit({
      runId: run.runId,
      conversationId: store.metadata.conversationId,
    });
    stream = session.request({
      ...headers,
      ":method": "POST",
      ":path": "/agent.v1.AgentService/Run",
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      "connect-accept-encoding": "gzip",
    });
    const send = async (message) => {
      if (stopped || stream.destroyed || stream.writableEnded)
        throw Error("Request stream not writable");
      const packet = encodeEnvelope(message.toBinary());
      sends++;
      if (!stream.write(packet))
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            stream.off("drain", drain);
            stream.off("error", error);
            stream.off("close", close);
          };
          const drain = () => {
            cleanup();
            resolve();
          };
          const error = (value) => {
            cleanup();
            reject(value);
          };
          const close = () =>
            error(
              new WireRunError(
                "Request closed before acknowledgement",
                "incomplete",
              ),
            );
          stream.once("drain", drain);
          stream.once("error", error);
          stream.once("close", close);
        });
    };
    const result = await new Promise((resolve, reject) => {
      let decoder,
        status,
        finished = false,
        finishing = false;
      const fail = (error) => {
        if (finished) return;
        finished = true;
        stopped = true;
        reject(error);
        stream.close(http2.constants.NGHTTP2_CANCEL);
      };
      rejectCurrent = fail;
      const finish = async () => {
        if (finished || finishing) return;
        finishing = true;
        try {
          await chain;
          if (finished) return;
          if (terminalError) throw terminalError;
          decoder?.finish();
          if (!protocolEnd)
            throw new WireRunError("Missing protocol end", "incomplete");
          if (!turnEnded)
            throw new WireRunError(
              "Missing turn-ended confirmation",
              "incomplete",
            );
          if (stream.rstCode)
            throw new WireRunError("HTTP2 stream reset", "incomplete");
          if (!lastCheckpoint)
            throw new WireRunError("Missing durable checkpoint", "incomplete");
          finished = true;
          stopped = true;
          resolve({
            backend: "wire",
            runId: run.runId,
            conversationId: store.metadata.conversationId,
            startedAt: start,
            endedAt: Date.now(),
            httpStatus: status,
            text: textOutput,
            usage,
            frames,
            clientMessages: sends,
            checkpointCount,
            priorTurns: run.priorTurns,
            kvGets,
            kvSets,
            normalEnd: true,
          });
        } catch (error) {
          fail(error);
        }
      };
      async function handle(frame) {
        if (stopped) return;
        decodedBytes += frame.payload.length;
        if (decodedBytes > 32 * 1024 * 1024)
          throw new WireRunError(
            "Decoded response limit reached",
            "resource_limit",
          );
        if (++frames > 8000)
          throw new WireRunError(
            "Response frame limit reached",
            "resource_limit",
          );
        if (frame.end) {
          const data = JSON.parse(frame.payload.toString("utf8"));
          protocolEnd = true;
          clearInterval(heartbeat);
          if (data.error)
            throw new WireRunError(
              data.error.message || data.error.code,
              data.error.code,
              data.error.details,
            );
          emit({ type: "protocol-end", ok: !data.error });
          stream.end();
          return;
        }
        const message = types.Server.fromBinary(frame.payload),
          kind = message.message.case,
          value = message.message.value;
        if (kind === "kvServerMessage") {
          const operation = value.message.case,
            args = value.message.value;
          if (operation === "setBlobArgs") {
            store.setBlob(args.blobId, args.blobData);
            kvSets++;
            await send(
              new types.Client({
                message: {
                  case: "kvClientMessage",
                  value: {
                    id: value.id,
                    message: { case: "setBlobResult", value: {} },
                  },
                },
              }),
            );
          } else if (operation === "getBlobArgs") {
            const blob = store.getBlob(args.blobId);
            kvGets++;
            await send(
              new types.Client({
                message: {
                  case: "kvClientMessage",
                  value: {
                    id: value.id,
                    message: {
                      case: "getBlobResult",
                      value: blob ? { blobData: blob } : {},
                    },
                  },
                },
              }),
            );
          } else
            throw new WireRunError("Unsupported KV operation", "unsupported");
          emit({ type: "kv", operation });
        } else if (kind === "conversationCheckpointUpdate") {
          lastCheckpoint = value.toBinary();
          checkpointCount++;
          emit({ type: "checkpoint", count: checkpointCount });
        } else if (
          kind === "execServerMessage" &&
          value.message.case === "requestContextArgs"
        ) {
          const safeContext = context ?? minimalContext(store.directory);
          await send(
            new types.Client({
              message: {
                case: "execClientMessage",
                value: {
                  id: value.id,
                  execId: value.execId,
                  message: {
                    case: "requestContextResult",
                    value: {
                      result: {
                        case: "success",
                        value: {
                          requestContext: safeContext,
                          servedFromDiskCache: false,
                        },
                      },
                    },
                  },
                },
              },
            }),
          );
          emit({
            type: "context-request",
            operation: "requestContextArgs",
            executedCommands: 0,
          });
        } else if (
          kind === "interactionQuery" &&
          value.query.case === "setupVmEnvironmentArgs"
        ) {
          const args = value.query.value;
          if (
            args.installCommand ||
            args.startCommand ||
            args.dockerfileContents
          )
            throw new WireRunError(
              "VM setup with commands is not supported by this isolated Ask backend",
              "unsupported",
              { kind, operation: value.query.case },
            );
          await send(
            new types.Client({
              message: {
                case: "interactionResponse",
                value: {
                  id: value.id,
                  result: {
                    case: "setupVmEnvironmentResult",
                    value: { result: { case: "success", value: {} } },
                  },
                },
              },
            }),
          );
          emit({
            type: "environment-ready",
            operation: "setupVmEnvironmentArgs",
            executedCommands: 0,
          });
        } else if (kind === "interactionUpdate") {
          const update = value.message.case,
            data = value.message.value;
          if (update === "textDelta") {
            textOutput += data.text;
            if (Buffer.byteLength(textOutput) > 64000)
              throw new WireRunError(
                "Experimental answer size limit reached",
                "resource_limit",
              );
            emit({ type: "text", text: data.text });
          } else if (update === "thinkingDelta") {
            thinkingBytes += Buffer.byteLength(data.text);
            if (thinkingBytes > 16000)
              throw new WireRunError(
                "Experimental reasoning size limit reached",
                "resource_limit",
              );
            emit({ type: "thinking", text: data.text });
          } else if (update === "turnEnded") {
            if (turnEnded)
              throw new WireRunError(
                "Duplicate turn confirmation",
                "protocol_error",
              );
            turnEnded = true;
            usage = Object.fromEntries(
              [
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "reasoning_tokens",
                "ended_at_ms",
              ]
                .filter(
                  (k) =>
                    data[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] !==
                    undefined,
                )
                .map((k) => [
                  k,
                  Number(
                    data[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())],
                  ),
                ]),
            );
            if (
              Object.values(usage).some(
                (value) => !Number.isSafeInteger(value) || value < 0,
              )
            )
              throw new WireRunError("Invalid token usage", "protocol_error");
            emit({ type: "usage", usage });
          } else emit({ type: "interaction", kind: update });
        } else if (
          [
            "execServerMessage",
            "execServerControlMessage",
            "interactionQuery",
          ].includes(kind)
        )
          throw new WireRunError(
            "Experimental Ask backend will not execute tools or answer privileged interactions",
            "unsupported",
            { kind, operation: value.message?.case ?? value.query?.case },
          );
        else emit({ type: "server-message", kind: kind ?? "unknown" });
      }
      stream.on("response", (response) => {
        status = response[":status"];
        if (status !== 200) {
          fail(new WireRunError("Run returned HTTP " + status, "http_error"));
          return;
        }
        if (
          !String(response["content-type"] || "").startsWith(
            "application/connect+proto",
          )
        ) {
          fail(
            new WireRunError(
              "Unsupported response content type",
              "protocol_error",
            ),
          );
          return;
        }
        decoder = new FrameDecoder({
          compression: response["connect-content-encoding"] || "identity",
        });
        try {
          emit({ type: "connected", status });
        } catch (error) {
          fail(error);
        }
      });
      stream.on("data", (chunk) => {
        if (stopped) return;
        try {
          totalBytes += chunk.length;
          if (totalBytes > 16 * 1024 * 1024)
            throw new WireRunError(
              "Response size limit reached",
              "resource_limit",
            );
          stream.pause();
          if (!decoder) throw Error("Response data before headers");
          for (const frame of decoder.push(chunk)) {
            chain = chain.then(() => handle(frame));
            chain.catch((error) => {
              terminalError = error;
              fail(error);
              stream.close(http2.constants.NGHTTP2_CANCEL);
            });
          }
          chain.then(() => {
            if (!stopped) stream.resume();
          }, fail);
        } catch (error) {
          fail(error);
        }
      });
      stream.on("end", () => void finish());
      stream.on("close", () => {
        if (!finished) void finish();
      });
      stream.on("error", fail);
      timer = setTimeout(() => {
        terminalError = new WireRunError(
          "Experimental run timed out; no automatic retry",
          "deadline_exceeded",
        );
        stream.close(http2.constants.NGHTTP2_CANCEL);
        fail(terminalError);
      }, timeoutMs);
      if (signal?.aborted) abort();
      heartbeat = setInterval(() => {
        if (!protocolEnd)
          void send(
            new types.Client({
              message: { case: "clientHeartbeat", value: {} },
            }),
          ).catch((error) => {
            terminalError = error;
            fail(error);
          });
      }, heartbeatMs);
      heartbeat.unref();
      try {
        emit({
          type: "run-start",
          runId: run.runId,
          priorTurns: run.priorTurns,
        });
      } catch (error) {
        fail(error);
      }
      if (!stopped) void send(run.message).catch(fail);
    });
    store.recordRun(result, lastCheckpoint);
    return result;
  } finally {
    stopped = true;
    rejectCurrent = undefined;
    finalize();
  }
}
