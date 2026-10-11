import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ACCOUNT_AUTOMATION_SETTINGS, normalizeAccountAutomationSettings } from '../src/domain/account-automation'
import { AutomationSettingsWriter } from '../src/renderer/src/settings/automation-settings-writer'

const initial=()=>normalizeAccountAutomationSettings(DEFAULT_ACCOUNT_AUTOMATION_SETTINGS)
function fixture() {
  let persisted=initial()
  const read=vi.fn(async()=>persisted),write=vi.fn(async(value:typeof persisted)=>{persisted=normalizeAccountAutomationSettings(value);return persisted})
  return {store:new AutomationSettingsWriter(initial(),read,write),read,write,persisted:()=>persisted}
}

describe('automation settings field-intent persistence',()=>{
  it('rebases simultaneous different fields and nested billing fields instead of overwriting their siblings',async()=>{
    const {store,persisted}=fixture();await store.load();const base=store.snapshot()
    const a=store.save(base,{...base,delaySec:1,checkoutProfile:{...base.checkoutProfile!,name:'Alice'}})
    const b=store.save(base,{...base,roxyApiPort:51000,checkoutProfile:{...base.checkoutProfile!,province:'广东省'}})
    expect(store.snapshot().checkoutProfile?.name).toBe('Alice');expect(store.snapshot().checkoutProfile?.province).toBe('广东省')
    await Promise.all([a,b]);expect(persisted()).toMatchObject({delaySec:1,roxyApiPort:51000,checkoutProfile:{name:'Alice',province:'广东省'}})
  })
  it('hydrates before writing and does not persist default placeholders over a slow initial read',async()=>{
    let release!:(value:ReturnType<typeof initial>)=>void
    const write=vi.fn(async(value:ReturnType<typeof initial>)=>value)
    const store=new AutomationSettingsWriter(initial(),()=>new Promise(done=>{release=done}),write)
    const loading=store.load(),base=store.snapshot(),saving=store.save(base,{...base,delaySec:2})
    expect(write).not.toHaveBeenCalled()
    release({...initial(),roxyApiPort:55000,checkoutProfile:{...initial().checkoutProfile!,city:'广州'}})
    await loading;await saving
    expect(write).toHaveBeenCalledWith(expect.objectContaining({delaySec:2,roxyApiPort:55000,checkoutProfile:expect.objectContaining({city:'广州'})}))
  })
  it('a failed edit rolls back only itself, preserves newer edits and does not poison later saves',async()=>{
    const {store,write,persisted}=fixture();await store.load();const base=store.snapshot()
    write.mockRejectedValueOnce(new Error('disk full'))
    const first=store.save(base,{...base,delaySec:2}),second=store.save(base,{...base,roxyApiPort:51000})
    await expect(first).rejects.toThrow('disk full');await second
    expect(store.snapshot().delaySec).toBe(base.delaySec);expect(store.snapshot().roxyApiPort).toBe(51000)
    await store.save(store.snapshot(),{...store.snapshot(),delaySec:3});expect(persisted().delaySec).toBe(3)
  })
  it('an older receipt cannot roll newer typing back while it waits for persistence',async()=>{
    const {store,write}=fixture();await store.load();let release!:(value:ReturnType<typeof initial>)=>void
    write.mockImplementationOnce(()=>new Promise(done=>{release=done}))
    const base=store.snapshot(),first=store.save(base,{...base,checkoutProfile:{...base.checkoutProfile!,name:'A'}})
    const next=store.snapshot(),second=store.save(next,{...next,checkoutProfile:{...next.checkoutProfile!,name:'Alice'}})
    expect(store.snapshot().checkoutProfile?.name).toBe('Alice')
    await Promise.resolve();await Promise.resolve();await Promise.resolve()
    release({...base,checkoutProfile:{...base.checkoutProfile!,name:'A'}})
    await first;expect(store.snapshot().checkoutProfile?.name).toBe('Alice');await second
  })
  it('a failed initial read restores the initial view and never writes unknown settings',async()=>{
    const write=vi.fn(),store=new AutomationSettingsWriter(initial(),async()=>{throw Error('unreadable')},write)
    await expect(store.save(store.snapshot(),{...store.snapshot(),enabled:true})).rejects.toThrow('unreadable')
    expect(store.snapshot().enabled).toBe(false);expect(write).not.toHaveBeenCalled()
  })
  it('supports explicit sparse-field removal and suppresses no-op writes',async()=>{
    const {store,write}=fixture();await store.load()
    await store.save(store.snapshot(),{...store.snapshot(),seamlessHandoverAccountId:'account-2'})
    await store.save(store.snapshot(),{...store.snapshot(),seamlessHandoverAccountId:undefined})
    expect(store.snapshot().seamlessHandoverAccountId).toBeUndefined()
    const calls=write.mock.calls.length;await store.save(store.snapshot(),{...store.snapshot()});expect(write).toHaveBeenCalledTimes(calls)
  })
  it('flush waits for outstanding writes, rejects a failed write and adds no reads when already loaded',async()=>{
    const {store,read,write}=fixture();await store.load();let fail!:(reason:Error)=>void
    write.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject}))
    const saving=store.save(store.snapshot(),{...store.snapshot(),enabled:true}),flushed=store.flush()
    await Promise.resolve();await Promise.resolve();await Promise.resolve();fail(new Error('write failed'))
    await expect(saving).rejects.toThrow();await expect(flushed).rejects.toThrow()
    expect((await store.flush()).enabled).toBe(false);expect(read).toHaveBeenCalledTimes(1)
  })
})
