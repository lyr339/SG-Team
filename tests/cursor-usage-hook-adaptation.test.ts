import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { patchUsageSource } from '../scripts/patch-cursor-usage-hook'

function fixture(modern: boolean): string {
  return `class Local { end(d,f){const o=this.composerDataService,g=o;${modern
    ? '(f.inputTokens!==void 0||f.outputTokens!==void 0||f.cacheReadTokens!==void 0||f.cacheWriteTokens!==void 0)&&g.updateComposerDataSetStore(this.composerDataHandle,()=>{});'
    : '(d.inputTokens!==void 0||d.outputTokens!==void 0||d.cacheReadTokens!==void 0||d.cacheWriteTokens!==void 0)&&o.updateComposerDataSetStore(this.composerDataHandle,()=>{});'} } }
    async function cloud(e,t,V,ie){const D=async()=>{},E=()=>{},A=async(_,fn)=>fn(),_=()=>{};${modern
      ? 'if(ie.message.case==="turnEnded"){await A(ie.message.case,()=>{_();const fe=t.data.status==="generating";t.setData("status","completed")});}'
      : 'if(V.message.case==="turnEnded"){await D(),E(),e.setData("status","completed");}'} }
    globalThis.testLocal=Local;globalThis.testCloud=cloud;`
}

describe('optional native usage hook across audited releases', () => {
  it.each([false, true])('emits the exact four native counters without changing native operations (modern=%s)', async (modern) => {
    const emitted: string[] = []
    const sandbox: Record<string, any> = { __sgTeamUsage: (value: string) => emitted.push(value) }
    const patched = patchUsageSource(fixture(modern))
    expect(patchUsageSource(patched)).toBe(patched)
    runInNewContext(patched, sandbox)
    const counters = { inputTokens: 100n, outputTokens: 20n, cacheReadTokens: 30n, cacheWriteTokens: 40n }
    const handle = { data: { composerId: 'native', latestChatGenerationUUID: 'generation', status: 'generating' }, setData: (_: string, value: string) => { handle.data.status = value } }
    const local = new sandbox.testLocal()
    local.composerDataHandle = handle
    local.composerDataService = { updateComposerDataSetStore() {} }
    local.end(counters, counters)
    const event = { message: { case: 'turnEnded', value: counters } }
    await sandbox.testCloud(handle, handle, event, event)
    expect(emitted.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ c: 'native', g: 'generation', i: 100, o: 20, r: 30, w: 40 }),
      expect.objectContaining({ c: 'native', g: 'generation', i: 100, o: 20, r: 30, w: 40 })
    ])
    expect(handle.data.status).toBe('completed')
  })
  it('rejects ambiguous anchors before producing any patched source', () => {
    expect(() => patchUsageSource(fixture(true) + fixture(false))).toThrow(/anchors mismatch/)
    expect(() => patchUsageSource('plain bundle')).toThrow(/anchors mismatch/)
  })
})
