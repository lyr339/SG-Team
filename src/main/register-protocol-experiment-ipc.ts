import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import { IPC } from "../shared/desktop-api";
import type { ProtocolExperimentService } from "../application/protocol-experiment-service";

export function registerProtocolExperimentIpc(
  service: ProtocolExperimentService,
  getWindow: () => BrowserWindow | undefined,
): () => void {
  const authorize = (event: Electron.IpcMainInvokeEvent): void => {
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("协议实验只能从拾光主窗口发起。");
  };
  const sendInput = z
    .object({ sessionId: z.uuid(), text: z.string().trim().min(1).max(256) })
    .strict();
  ipcMain.handle(IPC.protocolExperimentGet, (event) => {
    authorize(event);
    return service.snapshot();
  });
  ipcMain.handle(IPC.protocolExperimentCreate, (event) => {
    authorize(event);
    return service.create();
  });
  ipcMain.handle(IPC.protocolExperimentSend, (event, input: unknown) => {
    authorize(event);
    const value = sendInput.parse(input);
    return service.send(value.sessionId, value.text);
  });
  ipcMain.handle(IPC.protocolExperimentCancel, (event, input: unknown) => {
    authorize(event);
    return service.cancel(z.uuid().parse(input));
  });
  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(IPC.protocolExperimentSnapshot, snapshot);
  });
  return () => {
    unsubscribe();
    service.dispose();
    for (const channel of [
      IPC.protocolExperimentGet,
      IPC.protocolExperimentCreate,
      IPC.protocolExperimentSend,
      IPC.protocolExperimentCancel,
    ])
      ipcMain.removeHandler(channel);
  };
}
