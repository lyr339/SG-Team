import { statSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorRestoredFiles } from '../scripts/fixtures/cursor-restored-files'

vi.mock('node:fs', async importOriginal => {
  const real=await importOriginal<typeof import('node:fs')>()
  return {...real,statSync:vi.fn(real.statSync),readFileSync:vi.fn(real.readFileSync)}
})
afterEach(async()=>{const real=await vi.importActual<typeof import('node:fs')>('node:fs');vi.mocked(statSync).mockImplementation(real.statSync);vi.mocked(readFileSync).mockClear()})
describe('transcript cache under a coarse filesystem clock',()=>{
  it('invalidates channel, reply and snapshot caches even when every stat field collides',async()=>{
    const f=cursorRestoredFiles('legacy'),real=await vi.importActual<typeof import('node:fs')>('node:fs')
    try{
      const stamp=real.statSync(f.transcript),first=f.read()
      expect(first.channelActivities?.['1']).toBeDefined()
      vi.mocked(statSync).mockImplementation(((...args:unknown[])=>args[0]===f.transcript?stamp:Reflect.apply(real.statSync,undefined,args)) as typeof statSync)
      f.rewriteTranscript('2','PRIVATE reply new');f.nextFrame()
      const next=f.read()
      expect(next.channelActivities?.['1']).toBeUndefined()
      expect(next.composers[0]?.lastAssistantResponse?.text).toBe('PRIVATE reply new')
      expect(f.read().composers).toBe(next.composers)
    }finally{f.close()}
  })
  it('shares one bounded validation across cache consumers and never rereads in the same frame',()=>{
    const f=cursorRestoredFiles('legacy')
    try{
      const first=f.read(),count=()=>vi.mocked(readFileSync).mock.calls.filter(args=>args[0]===f.transcript).length
      const initial=count();for(let i=0;i<100;i++)expect(f.read().composers).toBe(first.composers)
      expect(count()).toBe(initial)
      f.nextFrame();expect(f.read().composers).toBe(first.composers);expect(count()).toBe(initial+1)
    }finally{f.close()}
  })
})
