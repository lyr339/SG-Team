import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/shared/desktop-api'

const electronMock = vi.hoisted(() => ({ on: vi.fn(), exposeInMainWorld: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: {}, ipcRenderer: { on: electronMock.on }, contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld } }))
import { syncWindowFullscreen } from '../src/main/register-window-chrome-ipc'

describe('native fullscreen chrome', () => {
  it('syncs initial/reloaded documents and both transitions, ignores maximize, and cleans up', () => {
    let fullscreen = false
    let destroyed = false
    const send = vi.fn()
    const webContents = Object.assign(new EventEmitter(), { send, isDestroyed: () => false })
    const window = Object.assign(new EventEmitter(), { isFullScreen: () => fullscreen, isDestroyed: () => destroyed })
    Object.defineProperty(window, 'webContents', {
      get: () => {
        if (destroyed) throw new TypeError('Object has been destroyed')
        return webContents
      }
    })
    syncWindowFullscreen(window as unknown as BrowserWindow)
    webContents.emit('dom-ready')
    expect(send).toHaveBeenLastCalledWith(IPC.windowFullscreenChanged, false)
    window.emit('maximize')
    expect(send).toHaveBeenCalledTimes(1)
    fullscreen = true
    window.emit('enter-full-screen')
    expect(send).toHaveBeenLastCalledWith(IPC.windowFullscreenChanged, true)
    webContents.emit('dom-ready')
    expect(send).toHaveBeenNthCalledWith(3, IPC.windowFullscreenChanged, true)
    fullscreen = false
    window.emit('leave-full-screen')
    expect(send).toHaveBeenLastCalledWith(IPC.windowFullscreenChanged, false)
    // Electron 的 closed 语义是原生对象已经销毁；清理过程不得再读取
    // BrowserWindow.webContents，否则正式包退出时会弹主进程异常框。
    destroyed = true
    expect(() => window.emit('closed')).not.toThrow()
    expect(window.listenerCount('enter-full-screen')).toBe(0)
    expect(window.listenerCount('leave-full-screen')).toBe(0)
    expect(webContents.listenerCount('dom-ready')).toBe(0)
  })
  it('preload applies fullscreen updates without exposing another renderer API', async () => {
    const dataset: Record<string, string> = {}
    vi.stubGlobal('document', { documentElement: { dataset } })
    try {
      await import('../src/preload/index')
      const handler = electronMock.on.mock.calls.find(([name]) => name === IPC.windowFullscreenChanged)![1]
      expect(dataset.nativeFullscreen).toBe('false')
      handler({}, true)
      expect(dataset.nativeFullscreen).toBe('true')
      handler({}, false)
      expect(dataset.nativeFullscreen).toBe('false')
    } finally {
      vi.unstubAllGlobals()
    }
  })

})
