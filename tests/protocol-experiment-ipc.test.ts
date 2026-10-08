import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { ProtocolExperimentService } from "../src/application/protocol-experiment-service";
import { registerProtocolExperimentIpc } from "../src/main/register-protocol-experiment-ipc";
import { IPC } from "../src/shared/desktop-api";
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (key: string, value: (...args: unknown[]) => unknown) =>
      handlers.set(key, value),
    removeHandler: (key: string) => handlers.delete(key),
  },
}));
describe("protocol experiment IPC boundary", () => {
  it("accepts only main-frame requests, validates inputs, pushes snapshots, and disposes its own service", () => {
    handlers.clear();
    const frame = {},
      webContents = {
        mainFrame: frame,
        isDestroyed: () => false,
        send: vi.fn(),
      },
      window = { isDestroyed: () => false, webContents };
    let push!: (value: unknown) => void;
    const unsubscribe = vi.fn(),
      service = {
        snapshot: vi.fn(() => ({ sessions: [], revision: 0 })),
        create: vi.fn(),
        send: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
        subscribe: vi.fn((listener) => {
          push = listener;
          return unsubscribe;
        }),
      };
    const dispose = registerProtocolExperimentIpc(
      service as unknown as ProtocolExperimentService,
      () => window as unknown as BrowserWindow,
    );
    const invoke = (
      channel: string,
      input?: unknown,
      event = { sender: webContents, senderFrame: frame },
    ) => handlers.get(channel)!(event, input);
    expect(invoke(IPC.protocolExperimentGet)).toEqual({
      sessions: [],
      revision: 0,
    });
    expect(() =>
      invoke(IPC.protocolExperimentCreate, undefined, {
        sender: webContents,
        senderFrame: {},
      }),
    ).toThrow("主窗口");
    expect(() =>
      invoke(IPC.protocolExperimentSend, {
        sessionId: "../escape",
        text: "OK",
      }),
    ).toThrow();
    expect(() =>
      invoke(IPC.protocolExperimentSend, {
        sessionId: "a".repeat(36),
        text: "a".repeat(257),
      }),
    ).toThrow();
    const id = "5debe596-c8d2-4e09-b382-d8d07f279a6f";
    invoke(IPC.protocolExperimentSend, { sessionId: id, text: " OK " });
    expect(service.send).toHaveBeenCalledExactlyOnceWith(id, "OK");
    expect(() =>
      invoke(IPC.protocolExperimentSend, {
        sessionId: id,
        text: "OK",
        modelId: "privileged",
      }),
    ).toThrow();
    push({ sessions: [], revision: 1 });
    expect(webContents.send).toHaveBeenCalledWith(
      IPC.protocolExperimentSnapshot,
      { sessions: [], revision: 1 },
    );
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(handlers.size).toBe(0);
  });
});
