// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolSnapshot } from '../src/domain/cursor-protocol'
import { SettingsProtocol } from '../src/renderer/src/settings/SettingsProtocol'

const capture = (version:string):ProtocolSnapshot => ({capture:{format:'shiguang.cursor-protocol.v1',capturedAt:1000,cursorVersion:version,records:[],models:[]}})
describe('protocol evidence page operation lifetime (mock API only)',()=>{
  let root:Root,host:HTMLDivElement,original:Window['sgDesktop']
  beforeEach(()=>{;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;original=window.sgDesktop;host=document.createElement('div');document.body.append(host);root=createRoot(host)})
  afterEach(async()=>{await act(async()=>root.unmount());host.remove();window.sgDesktop=original})
  const render=async(active:boolean)=>act(async()=>root.render(<SettingsProtocol active={active} onAccounts={()=>{}}/>))
  const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(el=>el.textContent===text)!
  it('returning to a pending import retains its busy state and does not start a competing snapshot read',async()=>{
    let finish!:(value:ProtocolSnapshot)=>void
    const get=vi.fn(async()=>capture('old')),importCapture=vi.fn(()=>new Promise<ProtocolSnapshot>(done=>{finish=done}))
    window.sgDesktop={getCursorProtocolSnapshot:get,importCursorProtocolCapture:importCapture} as unknown as Window['sgDesktop']
    await render(true);await act(async()=>host.querySelector<HTMLButtonElement>('[role="tab"]:nth-child(2)')!.click())
    await act(async()=>button('导入采集记录').click())
    await render(false);await render(true)
    expect(get).toHaveBeenCalledTimes(1)
    expect(button('正在导入…').disabled).toBe(true)
    await act(async()=>finish(capture('new')))
    expect(host.querySelector('.protocol-footnote')!.textContent).toContain('Cursor new')
    expect(button('导入采集记录').disabled).toBe(false)
  })
  it('prevents duplicate imports before React commits the disabled button',async()=>{
    let finish!:(value:ProtocolSnapshot)=>void
    const importCapture=vi.fn(()=>new Promise<ProtocolSnapshot>(done=>{finish=done}))
    window.sgDesktop={getCursorProtocolSnapshot:async()=>capture('old'),importCursorProtocolCapture:importCapture} as unknown as Window['sgDesktop']
    await render(true);await act(async()=>host.querySelector<HTMLButtonElement>('[role="tab"]:nth-child(2)')!.click())
    await act(async()=>{const start=button('导入采集记录');start.click();start.click()})
    expect(importCapture).toHaveBeenCalledTimes(1)
    await act(async()=>finish(capture('new')))
  })
})
