import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/desktop-api'
import { CursorProtocolStore } from '../infrastructure/cursor/cursor-protocol-store'
import { CursorProtocolQuotaReader } from '../infrastructure/cursor/cursor-protocol-quota'
import type { ProtocolSnapshot } from '../domain/cursor-protocol'

export function registerCursorProtocolIpc(store: CursorProtocolStore,getWindow:()=>BrowserWindow|undefined,reader=new CursorProtocolQuotaReader()):()=>void {
  let inFlight:Promise<ProtocolSnapshot>|undefined
  const authorized=(event:Electron.IpcMainInvokeEvent):BrowserWindow=>{
    const window=getWindow(); if(!window||window.isDestroyed()||window.webContents!==event.sender||event.senderFrame!==window.webContents.mainFrame)throw new Error('协议诊断只能从拾光设置页发起。');return window
  }
  ipcMain.handle(IPC.cursorProtocolGet,event=>{authorized(event);return store.load()})
  ipcMain.handle(IPC.cursorProtocolImport,async event=>{
    const window=authorized(event)
    const result=await dialog.showOpenDialog(window,{title:'导入脱敏协议记录',properties:['openFile'],filters:[{name:'拾光协议 v1 JSON',extensions:['json']}]})
    return result.canceled||!result.filePaths[0]?undefined:store.importFile(result.filePaths[0])
  })
  ipcMain.handle(IPC.cursorProtocolQuota,event=>{
    authorized(event)
    if(!inFlight)inFlight=reader.read().then(quota=>store.saveQuota(quota)).finally(()=>{inFlight=undefined})
    return inFlight
  })
  return ()=>{for(const channel of [IPC.cursorProtocolGet,IPC.cursorProtocolImport,IPC.cursorProtocolQuota])ipcMain.removeHandler(channel)}
}
