// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MembershipGuardDialog } from '../src/renderer/src/lobby/MembershipGuardDialog'
import { RuntimeAccountGuardDialog } from '../src/renderer/src/lobby/RuntimeAccountGuardDialog'
import { TransferMembershipDialog } from '../src/renderer/src/team/TransferMembershipDialog'
import { SessionHandoffDialog } from '../src/renderer/src/SessionHandoffDialog'
import type { AgentSession } from '../src/domain/agent-session'

const seat:AgentSession={id:'s1',channelId:'1',generation:1,displayName:'实现',roleName:'实现',status:'waiting',currentTask:'',queueDepth:0,connectionPhase:'waiting',online:true,connected:true,waiting:true,workingFiles:[],healthEvidence:[]}
const cases: Array<[string,(close:()=>void,busy:boolean)=>ReactElement]> = [
  ['membership', (onClose,busy)=><MembershipGuardDialog status={{state:'not_logged_in'}} message="请先登录" busy={busy} error="" onClose={onClose} onRefresh={()=>{}}/>],
  ['runtime', (onClose,busy)=><RuntimeAccountGuardDialog verify={{status:'cursor_unavailable'}} allowProceed={false} canSwitch={true} busy={busy} error="" onClose={onClose} onProceed={()=>{}} onSwitchAndRestart={()=>{}}/>],
  ['transfer', (onClose,busy)=><TransferMembershipDialog options={{runId:'r',groupId:'g',groupName:'组',sourceSlotId:'s',sourceRoleName:'实现',transfersLead:false,candidates:[]}} busy={busy} error="" onClose={onClose} onConfirm={async()=>undefined}/>],
  ['context', (onClose)=><SessionHandoffDialog session={seat} sessions={[seat]} loadContext={async()=>({channelId:'1',displayName:'实现',holdSupported:true,userMessageCount:0,assistantMessageCount:0})} deliver={async()=>{throw Error('not invoked')}} onClose={onClose}/>]
]
describe.each(cases)('%s dialog keyboard isolation', (_name,renderDialog) => {
  let host:HTMLDivElement,opener:HTMLButtonElement,root:Root
  beforeEach(()=>{;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');opener=document.createElement('button');document.body.append(opener,host);opener.focus();root=createRoot(host)})
  afterEach(async()=>{await act(async()=>root.unmount());host.remove();opener.remove()})
  it('enters the dialog, wraps Tab, consumes shell shortcuts and restores focus',async()=>{
    const close=vi.fn();await act(async()=>root.render(renderDialog(close,false)))
    const dialog=host.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
    const buttons=[...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];buttons.at(-1)!.focus()
    await act(async()=>buttons.at(-1)!.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})))
    expect(document.activeElement).toBe(buttons[0])
    const shell=vi.fn();window.addEventListener('keydown',shell)
    try {await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'2',ctrlKey:true,bubbles:true,cancelable:true})));expect(shell).not.toHaveBeenCalled()}
    finally{window.removeEventListener('keydown',shell)}
    await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
    expect(close).toHaveBeenCalledOnce()
    await act(async()=>root.render(null));expect(document.activeElement).toBe(opener)
  })
  if(_name!=='context') it('busy state still contains focus and does not dismiss on Escape',async()=>{
    const close=vi.fn();await act(async()=>root.render(renderDialog(close,true)))
    const dialog=host.querySelector<HTMLElement>('[role="dialog"]')!;expect(document.activeElement).toBe(dialog)
    await act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})))
    expect(document.activeElement).toBe(dialog)
    await act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
    expect(close).not.toHaveBeenCalled()
  })
})


describe('context handoff safe interaction edges',()=>{
  let host:HTMLDivElement,root:Root
  const context={channelId:'1',displayName:'实现',holdSupported:true,userMessageCount:0,assistantMessageCount:0,transcript:{path:'/tmp/context.jsonl',exists:true,resolution:'workspace' as const}}
  beforeEach(()=>{;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host)})
  afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks()})
  it('disables a selected target that disappeared instead of sending to a stale candidate',async()=>{
    const deliver=vi.fn(),loadContext=async()=>context
    const render=(sessions:AgentSession[])=>root.render(<SessionHandoffDialog session={seat} sessions={sessions} loadContext={loadContext} deliver={deliver} onClose={()=>{}}/>)
    await act(async()=>render([seat,{...seat,id:'s2',channelId:'2'}]))
    await act(async()=>host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click())
    await act(async()=>render([seat]))
    const submit=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='投递到 CH-2')!
    expect(submit.disabled).toBe(true);await act(async()=>submit.click());expect(deliver).not.toHaveBeenCalled()
    expect(host.textContent).toContain('所选会话已不在候选列表')
  })
  it('shows reveal failure instead of leaving a rejected promise unhandled',async()=>{
    await act(async()=>root.render(<SessionHandoffDialog session={seat} sessions={[seat]} loadContext={async()=>context} deliver={vi.fn()} revealPath={async()=>false} onClose={()=>{}}/>))
    const reveal=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes('中显示'))!
    await act(async()=>reveal.click());expect(host.textContent).toContain('无法定位文件')
  })
  it('ignores a late path-copy result after the dialog is unmounted',async()=>{
    let resolve!:()=>void
    const clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard')
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise<void>(done=>{resolve=done})}})
    try {
      await act(async()=>root.render(<SessionHandoffDialog session={seat} sessions={[seat]} loadContext={async()=>context} deliver={vi.fn()} onClose={()=>{}}/>))
      await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='复制路径')!.click())
      await act(async()=>root.render(null))
      const timer=vi.spyOn(globalThis,'setTimeout')
      await act(async()=>resolve());expect(timer).not.toHaveBeenCalled();timer.mockRestore()
    } finally {if(clipboard)Object.defineProperty(navigator,'clipboard',clipboard);else Reflect.deleteProperty(navigator,'clipboard')}
  })

})
