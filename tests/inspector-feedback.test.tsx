// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useTransientFeedback } from '../src/renderer/src/inspector/InspectorState'

it('ignores a late file-action callback after the owning panel unmounts',async()=>{
  ;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
  let flash!:(message:string)=>void
  function Panel(){const [text,show]=useTransientFeedback();flash=show;return <span>{text}</span>}
  await act(async()=>root.render(<Panel/>));await act(async()=>root.unmount())
  const timer=vi.spyOn(window,'setTimeout')
  try {await act(async()=>flash('已复制'));expect(timer).not.toHaveBeenCalled()}finally{timer.mockRestore();host.remove()}
})

it('replaces old expiry timers and immediately clears an empty acknowledgement',async()=>{
  ;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
  vi.useFakeTimers();const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
  let flash!:(message:string)=>void
  function Panel(){const [text,show]=useTransientFeedback();flash=show;return <span>{text}</span>}
  try{
    await act(async()=>root.render(<Panel/>));await act(async()=>flash('第一条'))
    await act(async()=>vi.advanceTimersByTime(800));await act(async()=>flash('第二条'))
    await act(async()=>vi.advanceTimersByTime(800));expect(host.textContent).toBe('第二条')
    await act(async()=>flash(''));expect(host.textContent).toBe('');expect(vi.getTimerCount()).toBe(0)
  }finally{await act(async()=>root.unmount());host.remove();vi.useRealTimers()}
})
