// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProtocolExperiments } from "../src/renderer/src/settings/ProtocolExperiments";
import type { ProtocolExperimentSnapshot } from "../src/domain/protocol-experiment";
import type { SgDesktopApi } from "../src/shared/desktop-api";
let root: Root, container: HTMLDivElement;
let snapshot: ProtocolExperimentSnapshot;
let listener: (value: ProtocolExperimentSnapshot) => void;
let api: Partial<SgDesktopApi>;
const id = "5debe596-c8d2-4e09-b382-d8d07f279a6f";
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  snapshot = {
    revision: 1,
    sessions: [
      {
        id,
        backend: "wire",
        accountId: "local-A",
        accountScope: "a".repeat(64),
        accountLabel: "研究账号",
        createdAt: 1,
        updatedAt: 1,
        state: "ready",
        modelId: "default",
        turns: 0,
        attempts: [],
      },
    ],
  };
  api = {
    getProtocolExperiments: vi.fn(async () => structuredClone(snapshot)),
    createProtocolExperiment: vi.fn(async () => structuredClone(snapshot)),
    sendProtocolExperiment: vi.fn(async () => structuredClone(snapshot)),
    cancelProtocolExperiment: vi.fn(async () => structuredClone(snapshot)),
    onProtocolExperiments: vi.fn((next) => {
      listener = next;
      return vi.fn();
    }),
  };
  window.sgDesktop = api as SgDesktopApi;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "sgDesktop");
});
const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (row) => row.textContent === text,
  )!;
it("does not issue model/auth requests on load or navigation; native entry is explicit", async () => {
  const native = vi.fn(),
    accounts = vi.fn();
  await act(async () =>
    root.render(
      <ProtocolExperiments active onAccounts={accounts} onNative={native} />,
    ),
  );
  expect(api.sendProtocolExperiment).not.toHaveBeenCalled();
  expect(api.createProtocolExperiment).not.toHaveBeenCalled();
  await act(async () => button("查看账号").click());
  expect(accounts).toHaveBeenCalledOnce();
  const nativeButton = [
    ...container.querySelectorAll<HTMLButtonElement>("button.wire-mode"),
  ][0]!;
  await act(async () => nativeButton.click());
  expect(native).toHaveBeenCalledOnce();
  expect(api.sendProtocolExperiment).not.toHaveBeenCalled();
});
it("allows cancellation while a send promise is pending, does not duplicate a send, and does not fabricate usage", async () => {
  let finish!: (value: ProtocolExperimentSnapshot) => void;
  api.sendProtocolExperiment = vi.fn(
    () =>
      new Promise<ProtocolExperimentSnapshot>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(<ProtocolExperiments active onAccounts={() => {}} />),
  );
  await act(async () => {
    const input = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "OK");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  snapshot = {
    ...snapshot,
    revision: 2,
    busySessionId: id,
    sessions: [
      {
        ...snapshot.sessions[0]!,
        state: "running",
        attempts: [
          {
            id,
            prompt: "OK",
            startedAt: 1,
            state: "running",
            text: "",
            thinking: "",
            checkpointCount: 0,
            kvGets: 0,
            kvSets: 0,
          },
        ],
      },
    ],
  };
  await act(async () => listener(snapshot));
  expect(button("停止").disabled).toBe(false);
  await act(async () => button("停止").click());
  expect(api.cancelProtocolExperiment).toHaveBeenCalledExactlyOnceWith(id);
  expect(api.sendProtocolExperiment).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("—");
  await act(async () => finish(snapshot));
});
