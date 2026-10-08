import { createHash } from 'node:crypto'
import type { ProtocolQuota, ProtocolReceipt } from '../../domain/cursor-protocol'
import { decodeBillingProto, usageWindowRequest, type ProtoObject } from './cursor-protocol-billing-codec'
import { CursorTokenImporter, type ImportedCursorAccount } from './cursor-token-importer'

export function protocolIdentityRef(value: string): string { return createHash('sha256').update('sg-protocol-v1:' + value).digest('hex') }
const object = (value: unknown): ProtoObject => value && typeof value==='object' && !Array.isArray(value) ? value as ProtoObject : {}
const number = (value: unknown): number | undefined => typeof value==='number' && Number.isFinite(value) && value>=0 ? value : undefined
const string = (value: unknown): string | undefined => typeof value==='string' && value.length>0 && value.length<=160 ? value : undefined
export function billingReceipts(value: ProtoObject): ProtocolReceipt[] {
  const rows = Array.isArray(value.usage_events_display) ? value.usage_events_display : []
  return rows.flatMap(raw => {
    const row=object(raw),usage=object(row.token_usage),timestamp=number(row.timestamp),conversation=string(row.conversation_id),model=string(row.model)
    if(timestamp===undefined||!conversation||!model||row.is_token_based_call!==true||!Object.keys(usage).length)return []
    return [{timestamp,conversationRef:protocolIdentityRef(conversation),model,kind:`usage_kind_${number(row.kind)??0}`,
      productId:string(row.subscription_product_id),subscriptionName:string(row.custom_subscription_name),
      input:number(usage.input_tokens)??0,output:number(usage.output_tokens)??0,cacheRead:number(usage.cache_read_tokens)??0,cacheWrite:number(usage.cache_write_tokens)??0,
      chargedCents:number(row.charged_cents)}]
  })
}
const READS = {
  GetCurrentPeriodUsage:'aiserver.v1.GetCurrentPeriodUsageResponse',
  GetUsageLimitStatusAndActiveGrants:'aiserver.v1.GetUsageLimitStatusAndActiveGrantsResponse',
  GetPlanInfo:'aiserver.v1.GetPlanInfoResponse',
  GetFilteredUsageEvents:'aiserver.v1.GetFilteredUsageEventsResponse'
} as const
export async function boundedProtocolBody(response:Response):Promise<Buffer>{
  if(!response.body)return Buffer.alloc(0)
  const reader=response.body.getReader(),chunks:Buffer[]=[]
  let total=0
  try{
    while(true){const next=await reader.read();if(next.done)break;total+=next.value.byteLength
      if(total>2*1024*1024){await reader.cancel();throw new Error('额度响应超出读取上限。')}
      chunks.push(Buffer.from(next.value))
    }
  }finally{reader.releaseLock()}
  return Buffer.concat(chunks,total)
}
export class CursorProtocolQuotaReader {
  constructor(private readonly runtime: ()=>ImportedCursorAccount=()=>new CursorTokenImporter().import(),private readonly request:typeof fetch=fetch,private readonly now:()=>number=Date.now) {}
  async read(): Promise<ProtocolQuota> {
    let source:ImportedCursorAccount
    try { source=this.runtime() } catch { throw new Error('无法读取正式 Cursor 保存的登录态。请先在 Cursor 正常登录，再核对额度。') }
    if(!source.sub)throw new Error('Cursor 登录态缺少可核对的账号标识，未发起查询。')
    try {
      const claims=JSON.parse(Buffer.from(source.token.split('.')[1]!,'base64url').toString()) as {type?:unknown;sub?:unknown;exp?:unknown}
      if(claims.type!=='session'||claims.sub!==source.sub||typeof claims.exp!=='number'||!Number.isFinite(claims.exp)||claims.exp*1000<=this.now())throw new Error()
    }
    catch { throw new Error('正式 Cursor 登录态无效或已过期。此处不会换号、刷新凭据或重新登录。') }
    const checkedAt=this.now(),accountScope=protocolIdentityRef(source.sub)
    const results=await Promise.all(Object.entries(READS).map(async ([name,type])=>{
      const response=await this.request(`https://api2.cursor.sh/aiserver.v1.DashboardService/${name}`,{
        method:'POST',headers:{authorization:`Bearer ${source.token}`,'content-type':'application/proto','connect-protocol-version':'1'},
        body:new Uint8Array(name==='GetFilteredUsageEvents'?usageWindowRequest(checkedAt-86400000,checkedAt):Buffer.alloc(0)),redirect:'error',signal:AbortSignal.timeout(12000)
      })
      if(!response.ok)throw new Error(`Cursor 只读额度接口返回 HTTP ${response.status}；未改动登录态或收费设置。`)
      if(!(response.headers.get('content-type')||'').startsWith('application/proto'))throw new Error('Cursor 返回了未识别的额度响应，未作归属判断。')
      if(Number(response.headers.get('content-length'))>2*1024*1024)throw new Error('额度响应超出读取上限。')
      return [name,decodeBillingProto(await boundedProtocolBody(response),type)] as const
    }))
    if(protocolIdentityRef(this.runtime().sub??'')!==accountScope)throw new Error('Cursor 登录账号在查询期间已变化，本次读数未保存。请重新核对。')
    const map=Object.fromEntries(results),period=map.GetCurrentPeriodUsage!,plan=object(map.GetPlanInfo!.plan_info),usage=object(period.plan_usage),policy=object(map.GetUsageLimitStatusAndActiveGrants!.usage_limit_policy_status)
    return {checkedAt,accountScope,source:'formal-profile',planName:string(plan.plan_name)??'接口未返回计划名称',limitType:string(policy.limit_type),cycleEnd:number(period.billing_cycle_end),
      percentages:{auto:number(usage.auto_percent_used),api:number(usage.api_percent_used),total:number(usage.total_percent_used)},receipts:billingReceipts(map.GetFilteredUsageEvents!)}
  }
}
