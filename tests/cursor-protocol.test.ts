import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseProtocolCapture, protocolBucketLabel, receiptMatches, recordReceipt, type ProtocolQuota } from '../src/domain/cursor-protocol'
import { CursorProtocolStore } from '../src/infrastructure/cursor/cursor-protocol-store'
import { decodeBillingProto } from '../src/infrastructure/cursor/cursor-protocol-billing-codec'
import { CursorProtocolQuotaReader, billingReceipts, protocolIdentityRef } from '../src/infrastructure/cursor/cursor-protocol-quota'

const fixture = (name:string):Buffer => readFileSync(new URL(`./fixtures/cursor-protocol/${name}`,import.meta.url))
const observed = (): ReturnType<typeof parseProtocolCapture> => parseProtocolCapture(JSON.parse(fixture('observed-free.json').toString()))
const directories:string[]=[]
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})
function files(){const directory=mkdtempSync(join(tmpdir(),'sg-protocol-test-'));directories.push(directory);return {directory,store:new CursorProtocolStore(join(directory,'protocol.json')),input:join(directory,'capture.json')}}

describe('standalone protocol evidence',()=>{
  it('validates the actual Free error and two matched receipts without prompts or credentials',()=>{
    const capture=observed();expect(capture.records).toHaveLength(3);expect(capture.models).toHaveLength(43)
    expect(capture.records[0]!.usage).toBeUndefined();expect(protocolBucketLabel()).toBe('额度归属未确认')
    for(const row of capture.records.slice(1)){expect(receiptMatches(row,row.ledger!)).toBe(true);expect(protocolBucketLabel(row.ledger)).toBe('Free 额度订阅')}
    expect(capture.records[1]!.usage!.input).toBe(17374+512)
    expect(capture.records[2]!.usage!.input).toBe(355+17792)
    const json=JSON.stringify(capture);expect(json).not.toMatch(/eyJ\w+\.|outlook|authorization|cachedEmail|Reply only OK/)
  })
  it('does not infer a pool from success, Free plan, model name or limit_type',()=>{
    const row={...observed().records[1]!,ledger:undefined};expect(recordReceipt(row)).toBeUndefined()
    expect(protocolBucketLabel({ ...observed().records[1]!.ledger!, productId:'new-pro-pool',subscriptionName:'pro'})).toBe('订阅 new-pro-pool')
  })
  it('separates account identities and refuses ambiguous or unknown-basis matching',()=>{
    const row={...observed().records[1]!,ledger:undefined},bill=observed().records[1]!.ledger!
    const quota:ProtocolQuota={accountScope:row.accountScope,checkedAt:row.capturedAt,source:'formal-profile',planName:'Free',percentages:{},receipts:[bill]}
    expect(recordReceipt(row,quota)).toBe(bill)
    expect(recordReceipt(row,{...quota,accountScope:'b'.repeat(64)})).toBeUndefined()
    expect(recordReceipt(row,{...quota,receipts:[bill,bill]})).toBeUndefined()
    expect(receiptMatches({...row,inputBasis:'unknown'},bill)).toBe(false)
    expect(receiptMatches(row,{...bill,conversationRef:'b'.repeat(64)})).toBe(false)
  })
  it('requires complete success and rejects extra credential fields or unmatched ledger counts',()=>{
    const capture=observed();expect(()=>parseProtocolCapture({...capture,token:'secret'})).toThrow()
    expect(()=>parseProtocolCapture({...capture,records:[{...capture.records[1],frames:[]}]})).toThrow('结束帧')
    expect(()=>parseProtocolCapture({...capture,records:[{...capture.records[1],parameters:[{id:'api_key',value:'private'}]}]})).toThrow('凭据')
    expect(()=>parseProtocolCapture({...capture,records:[{...capture.records[1],ledger:{...capture.records[1]!.ledger,input:1}}]})).toThrow('不匹配')
  })
  it('persists only its own private file, cancels duplicates and never overwrites corrupted history',()=>{
    const {directory,store,input}=files();writeFileSync(input,JSON.stringify(observed()));expect(store.importFile(input).capture!.records).toHaveLength(3)
    expect(store.importFile(input).capture!.records).toHaveLength(3);expect(store.load().capture!.models).toHaveLength(43)
    if(process.platform!=='win32')expect(statSync(join(directory,'protocol.json')).mode&0o777).toBe(0o600)
    writeFileSync(join(directory,'protocol.json'),'{broken');expect(()=>store.importFile(input)).toThrow('原文件');expect(readFileSync(join(directory,'protocol.json'),'utf8')).toBe('{broken')
  })
  it('decodes actual quota protobuf and skips new unknown backend fields',()=>{
    const period=decodeBillingProto(fixture('GetCurrentPeriodUsage.bin'),'aiserver.v1.GetCurrentPeriodUsageResponse')
    expect(period.plan_usage).toMatchObject({auto_percent_used:4,api_percent_used:0,total_percent_used:2})
    const plan=decodeBillingProto(fixture('GetPlanInfo.bin'),'aiserver.v1.GetPlanInfoResponse');expect(plan.plan_info).toMatchObject({plan_name:'Free'})
    const result=decodeBillingProto(fixture('GetFilteredUsageEvents.bin'),'aiserver.v1.GetFilteredUsageEventsResponse')
    const bills=billingReceipts(result);expect(bills).toHaveLength(2);expect(bills[0]).toMatchObject({productId:'free',input:355,cacheRead:17792,output:16})
    expect(()=>decodeBillingProto(Buffer.from([10,4,1]),'aiserver.v1.GetPlanInfoResponse')).toThrow('截断')
  })
})

describe('read-only quota lookup',()=>{
  const now=Date.UTC(2026,9,7,14)
  const token='eyJ0ZXN0.'+Buffer.from(JSON.stringify({sub:'research-user',type:'session',exp:Math.floor(now/1000)+3600})).toString('base64url')+'.signature'
  const runtime=()=>({token,sub:'research-user'})
  function request(){return vi.fn(async (url:string|URL|Request)=>{const name=String(url).split('/').at(-1)!;return new Response(new Uint8Array(fixture(name+'.bin')),{headers:{'content-type':'application/proto'}})})}
  it('rejects mismatched subjects, unknown types and missing expiry before any quota request',async()=>{
    for(const claims of [{sub:'other-user',type:'session',exp:Math.floor(now/1000)+3600},{sub:'research-user',type:'unknown',exp:Math.floor(now/1000)+3600},{sub:'research-user',type:'session'}]){
      const value='eyJ0ZXN0.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature',fetch=request()
      await expect(new CursorProtocolQuotaReader(()=>({token:value,sub:'research-user'}),fetch as unknown as typeof globalThis.fetch,()=>now).read()).rejects.toThrow('登录态无效')
      expect(fetch).not.toHaveBeenCalled()
    }
  })
  it('uses exactly four read-only endpoints, returns no tokens, and does not log in or invoke Run',async()=>{
    const fetch=request(),quota=await new CursorProtocolQuotaReader(runtime,fetch as unknown as typeof globalThis.fetch,()=>now).read()
    expect(quota.planName).toBe('Free');expect(quota.accountScope).toBe(protocolIdentityRef('research-user'));expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls.map(call=>String(call[0]).split('/').at(-1))).toEqual(['GetCurrentPeriodUsage','GetUsageLimitStatusAndActiveGrants','GetPlanInfo','GetFilteredUsageEvents'])
    expect(JSON.stringify(quota)).not.toContain(token)
  })
  it('does not refresh, exchange or query a web/expired token',async()=>{
    const fetch=request(),web='header.'+Buffer.from(JSON.stringify({type:'web'})).toString('base64url')+'.signature'
    await expect(new CursorProtocolQuotaReader(()=>({token:web,sub:'web-user'}),fetch as unknown as typeof globalThis.fetch,()=>now).read()).rejects.toThrow('不会换号')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('discards results when the formal login changes during the read',async()=>{
    let calls=0;const fetch=request()
    await expect(new CursorProtocolQuotaReader(()=>({token,sub:++calls===1?'research-user':'other-user'}),fetch as unknown as typeof globalThis.fetch,()=>now).read()).rejects.toThrow('已变化')
  })
  it('does not convert authentication/HTTP failure into zero quota',async()=>{
    const fetch=vi.fn(async()=>new Response('denied',{status:401}))
    await expect(new CursorProtocolQuotaReader(runtime,fetch as unknown as typeof globalThis.fetch,()=>now).read()).rejects.toThrow('HTTP 401')
  })
})
