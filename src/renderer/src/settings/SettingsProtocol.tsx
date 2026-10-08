import { useEffect, useState } from 'react'
import { protocolBucketLabel, recordReceipt, type ProtocolModel, type ProtocolRecord, type ProtocolSnapshot } from '../../../domain/cursor-protocol'
import { SettingsSection } from './SettingsSection'
import './protocol.css'
import { ProtocolExperiments } from './ProtocolExperiments'

const EMPTY: ProtocolSnapshot = {}
const integer = (value?: number): string => value === undefined ? '—' : new Intl.NumberFormat('zh-CN').format(value)
const clock = (value: number): string => new Date(value).toLocaleString('zh-CN', { month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit' })
const status = (row: ProtocolRecord): string => row.outcome === 'success' ? '已完成' : row.outcome === 'rejected' ? '服务端拒绝' : '流未完整'
function modelLabel(row:ProtocolRecord,snapshot:ProtocolSnapshot):string {
  const model=snapshot.capture?.models.find(model=>model.id===row.model),effort=row.parameters.find(p=>p.id==='effort')?.value
  const option=model?.parameters.find(p=>p.id==='effort')?.options.find(p=>p.value===effort)
  return [model?.name??row.model,effort?option?.id??effort[0]!.toUpperCase()+effort.slice(1):''].filter(Boolean).join(' · ')
}

export function SettingsProtocol({ active, onAccounts, onNative }: { active: boolean; onAccounts: ()=>void; onNative?: ()=>void }): React.JSX.Element {
  const [snapshot,setSnapshot]=useState<ProtocolSnapshot>(EMPTY)
  const [selected,setSelected]=useState('')
  const [tab,setTab]=useState<'experiments'|'records'|'models'|'quota'>('experiments')
  const [busy,setBusy]=useState<'load'|'import'|'quota'|null>(null)
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[search,setSearch]=useState('')
  const rows=snapshot.capture?.records??[]
  const row=rows.find(row=>row.id===selected)??rows.at(-1)
  useEffect(()=>{
    if(!active||!window.sgDesktop?.getCursorProtocolSnapshot)return
    let alive=true;setBusy('load')
    window.sgDesktop.getCursorProtocolSnapshot().then(value=>{if(alive){setSnapshot(value);setError('')}}).catch(()=>{if(alive)setError('无法读取本机协议记录，原文件未覆盖。')}).finally(()=>{if(alive)setBusy(null)})
    return()=>{alive=false}
  },[active])
  async function run(action:'import'|'quota'):Promise<void>{
    const api=window.sgDesktop,method=action==='import'?api?.importCursorProtocolCapture:api?.checkCursorProtocolQuota
    if(!method){setError('当前运行版本尚未接入协议诊断接口。');return}
    setBusy(action);setError('');setNotice('')
    try{const value=await method();if(value){setSnapshot(value);setNotice(action==='import'?'脱敏记录已保存到本机。':'额度接口已读取；未发送模型请求，未改动登录态或收费设置。')}}
    catch(e){setError(e instanceof Error?e.message:'操作未完成，原记录保留。')}
    finally{setBusy(null)}
  }
  return <div className="protocol-page">
    {tab!=='experiments'?<><div className="protocol-tools">
      <p>只读诊断 <span>与 MCP、会话编排和估算账本分离</span></p>
      <div><button type="button" className="protocol-button" disabled={!!busy} onClick={()=>void run('import')}>{busy==='import'?'正在导入…':'导入采集记录'}</button>
        <button type="button" className="protocol-button protocol-button--primary" disabled={!!busy} onClick={()=>void run('quota')}><span className={busy==='quota'?'protocol-refresh is-loading':'protocol-refresh'} aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" focusable="false"><path d="M19.5 7.5A8 8 0 1 0 20 15M19.5 3.5v4.5H15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg></span>{busy==='quota'?'正在核对…':'核对 Cursor 额度'}</button></div>
    </div>
    <p className="protocol-source">核对读取<strong>正式 Cursor 配置中保存的登录态</strong>，不是拾光待切换账号或隔离实验账号。不会切号、重启、发起对话或打开按量收费。<button type="button" onClick={onAccounts}>查看账号</button></p></>:null}
    {error?<p className="protocol-feedback is-error" role="alert">{error}</p>:null}
    {notice?<p className="protocol-feedback" role="status">{notice}</p>:null}
    <div className="protocol-tabs" role="tablist" aria-label="协议诊断视图">{(['experiments','records','models','quota'] as const).map(value=><button type="button" key={value} role="tab" aria-selected={tab===value} onClick={()=>setTab(value)}>{value==='experiments'?'协议实验':value==='records'?'会话记录':value==='models'?'模型参数':'额度依据'}<span>{value==='records'?rows.length:value==='models'?snapshot.capture?.models.length??0:''}</span></button>)}</div>
    <div role="tabpanel" aria-label={tab==='experiments'?'协议实验':tab==='records'?'会话记录':tab==='models'?'模型参数':'额度依据'}>
      {tab==='experiments'?<ProtocolExperiments active={active && tab==='experiments'} onAccounts={onAccounts} onNative={onNative}/>:tab==='records'? rows.length&&row ? <div className="protocol-records"><nav aria-label="已导入的协议会话">{[...rows].reverse().map(item=><button type="button" key={item.id} className={row.id===item.id?'is-selected':''} aria-pressed={row.id===item.id} onClick={()=>setSelected(item.id)}><strong>{modelLabel(item,snapshot)}</strong><span className={item.outcome==='rejected'?'is-error':''}>{status(item)}</span><time dateTime={new Date(item.capturedAt).toISOString()}>{clock(item.capturedAt)}</time></button>)}</nav><ProtocolRecordDetail row={row} snapshot={snapshot}/></div>
        :<div className="protocol-empty"><strong>把请求与记账证据放在同一个地方</strong><p>导入本机抓取的脱敏协议 v1 JSON，即可查看模型选择、完整流状态、服务端 token 回报和账本归属。当前页面不会自动抓取或发送模型请求。</p><button type="button" className="protocol-button" disabled={!!busy} onClick={()=>void run('import')}>导入首份采集记录</button></div>
        :tab==='models'?<ProtocolModels models={snapshot.capture?.models??[]} rows={rows} search={search} onSearch={setSearch}/>
        :<ProtocolQuotaEvidence snapshot={snapshot}/>}
    </div>
    {tab!=='experiments'?<p className="protocol-footnote">来源：{snapshot.capture?`导入采集 · Cursor ${snapshot.capture.cursorVersion} · ${clock(snapshot.capture.capturedAt)}`:'尚未导入采集'}。导入记录不是当前账号的实时用量；原始认证头、提示词、答案和机器标识不会进入此页。</p>:null}
  </div>
}
function ProtocolRecordDetail({ row,snapshot }: {row:ProtocolRecord;snapshot:ProtocolSnapshot}):React.JSX.Element{
  const bill=recordReceipt(row,snapshot.quota)
  const liveBill=!!bill&&snapshot.quota?.accountScope===row.accountScope&&snapshot.quota.receipts.includes(bill)
  const usage=row.usage
  return <article className="protocol-detail">
    <header><div><h2>{modelLabel(row,snapshot)}</h2><p>{row.mode.replace('AGENT_MODE_','').replace('ASK','Ask')} · Cursor {row.cursorVersion} · {status(row)}</p></div><span>导入证据</span></header>
    <div className="protocol-chain" aria-label="请求到记账的证据链"><div><small>请求</small><strong>HTTP/2</strong></div><div><small>选择</small><strong>{row.parameters.find(p=>p.id==='effort')?.value??'参数已记录'}</strong></div><div><small>用量</small><strong>{usage?'服务端回报':'未返回'}</strong></div><div><small>账本</small><strong>{bill?protocolBucketLabel(bill):'未关联'}</strong></div></div>
    <dl className="protocol-definitions"><div><dt>真实入口</dt><dd><code>{row.endpoint}</code></dd></div><div><dt>模型参数</dt><dd>{row.parameters.map(p=><code key={p.id}>{p.id}={p.value}</code>)}</dd></div><div><dt>流状态</dt><dd>{row.requestFrames} 个请求帧 / {row.responseFrames} 个响应帧{row.errorCode?` · ${row.errorCode}`:''}</dd></div></dl>
    {row.outcome==='rejected'?<p className="protocol-record-note">结束帧返回 {row.errorCode??'错误'}{row.limitType?`，限制类型 ${row.limitType}`:''}。HTTP 200 不代表生成成功；没有 usage 或账本证据时，不填写零消耗。</p>:null}
    <div className="protocol-token-table"><div className="protocol-token-table__head"><span>Token 口径</span><span>流回报</span><span>账本回报</span></div>
      {[['Input',usage?.input,bill?.input],['Output',usage?.output,bill?.output],['Cache Read',usage?.cacheRead,bill?.cacheRead],['Cache Write',usage?.cacheWrite,bill?.cacheWrite],['Reasoning',usage?.reasoning,undefined]].map(([label,a,b])=><div key={String(label)}><span>{label}</span><strong>{integer(a as number|undefined)}</strong><strong>{integer(b as number|undefined)}</strong></div>)}
    </div>
    <p className="protocol-record-note">{row.inputBasis==='total-including-cache'?'这份采集的流 Input 含缓存，账本 Input 是未缓存部分。':'这份采集尚未确认 Input 的缓存口径，未进行自动账本匹配。'}本栏按身份、对话标识、时间与 token 数匹配；不把 token delta、KV 写入或上下文占用当作收费。</p>
    {bill?<div className="protocol-ledger"><div><span>额度归属</span><strong>{protocolBucketLabel(bill)}</strong></div><div><span>记账值</span><strong>{bill.chargedCents===undefined?'—':`${bill.chargedCents.toFixed(4)} ¢`}</strong></div><p>服务端额度记账值，不等于银行卡扣款。Free 同样可以返回计费核算金额。</p><details><summary>查看归属字段</summary><dl className="protocol-definitions"><div><dt>subscription_product_id</dt><dd><code>{bill.productId??'未返回'}</code></dd></div><div><dt>custom_subscription_name</dt><dd><code>{bill.subscriptionName??'未返回'}</code></dd></div><div><dt>来源</dt><dd>{liveBill?'本次只读账本查询匹配':'导入采集附带账本匹配'}</dd></div></dl></details></div>:<p className="protocol-record-note">还没有这次对话的账本匹配。不能只凭 Free / Pro、模型名字或成功回复来确认它被哪个额度桶记账。</p>}
    {snapshot.quota&&snapshot.quota.accountScope!==row.accountScope?<p className="protocol-record-note">本次额度核对与这条采集的登录态不同，未将读数套用到此记录。</p>:null}
    <details className="protocol-frames"><summary>响应帧 · {row.frames.length} 项 <span>保留顺序与结束标记</span></summary><ol>{row.frames.map(frame=><li key={frame.index}><span>{frame.index+1}</span><code>{frame.kind==='end'?'EndStream':frame.fields.join(' · ')||'未知消息'}</code><small>0x{frame.flags.toString(16).padStart(2,'0')} · {frame.bytes} B</small></li>)}</ol></details>
  </article>
}
function ProtocolModels({models,rows,search,onSearch}:{models:ProtocolModel[];rows:ProtocolRecord[];search:string;onSearch:(value:string)=>void}):React.JSX.Element{
  const filtered=models.filter(model=>(model.id+' '+model.name).toLowerCase().includes(search.toLowerCase()))
  return <SettingsSection title="服务端模型目录" description="目录和参数定义不是账号使用权限；有采集样本的模型会单独标记。">
    <label className="protocol-search"><span>查找模型</span><input value={search} onChange={e=>onSearch(e.target.value)} placeholder="模型名称或 wire ID" type="search"/></label>
    {!models.length?<p className="protocol-record-note">导入包含模型目录的采集记录后显示。当前不会自动枚举模型或消耗额度试用。</p>:!filtered.length?<p className="protocol-record-note">没有匹配的模型。试试 wire ID 或简短名称。</p>:<div className="protocol-model-list">{filtered.map(model=><details key={model.id}><summary><span><strong>{model.name}</strong><code>{model.id}</code></span><span>{rows.some(row=>row.model===model.id&&row.outcome==='success')?'有成功采集':'仅目录观测'}</span></summary><div className="protocol-model-body"><p>上下文目录值 {model.contextLimit===null?'未返回':integer(model.contextLimit)} · Thinking {model.supportsThinking?'有声明':'未声明'} · Max {model.supportsMax?'有声明':'未声明'}。这些声明不代表当前账号获准使用。</p>{model.parameters.length?model.parameters.map(parameter=><div key={parameter.id}><strong>{parameter.name}</strong><code>{parameter.id}</code><span>{parameter.options.map(option=>option.value).join(' / ')||'目录未返回选项'}</span></div>):<p>此族未返回参数定义。</p>}</div></details>)}</div>}
  </SettingsSection>
}
function ProtocolQuotaEvidence({snapshot}:{snapshot:ProtocolSnapshot}):React.JSX.Element{
  const quota=snapshot.quota
  return <div className="protocol-quota-view"><SettingsSection title="正式 Cursor 的只读结果" description="只在点击核对时访问官方读取接口；不会新建会话或改动收费设置。">
    {quota?<><dl className="protocol-definitions"><div><dt>服务端计划</dt><dd>{quota.planName}</dd></div><div><dt>读取时间</dt><dd>{clock(quota.checkedAt)}</dd></div><div><dt>限制类型</dt><dd><code>{quota.limitType??'接口未返回'}</code></dd></div><div><dt>周期结束</dt><dd>{quota.cycleEnd?clock(quota.cycleEnd):'接口未返回'}</dd></div><div><dt>近期账本</dt><dd>{quota.receipts.length} 条带 token 的记录 · 最近 24 小时，最多 20 条</dd></div></dl><details className="protocol-raw-quota"><summary>查看接口原始进度口径</summary><p>旧字段名不能直接等同于新版额度池。不同分母的百分比不相加。</p><dl className="protocol-definitions">{Object.entries(quota.percentages).map(([key,value])=><div key={key}><dt>{key}_percent_used</dt><dd>{value===undefined?'未返回':`${value}%`}</dd></div>)}</dl></details></>:<p className="protocol-record-note">尚未核对。页面不会自动读取登录凭据或请求账单。</p>}
  </SettingsSection><SettingsSection title="Free 与 Pro 如何归属" description="证据强弱分开，不把账号档位当作每次扣费的最终答案。"><div className="protocol-policy"><div><strong>Free · 看账本，不猜桶</strong><p>账本明确返回 <code>subscription_product_id=free</code> 与 <code>custom_subscription_name=free</code>，并与这次对话匹配，才能确认 Free 归属。没有匹配证据的记录，不套用这个结论。</p></div><div><strong>Pro · 官方规则，尚未逐模型实测</strong><p>当前官方说明区分 Cursor Models 与 Other Models 两个额度池。实际落入哪一池仍要看该登录态的计划、模型路由与账本；不能用旧 <code>auto_bucket_models</code> 名单或模型显示名猜。</p><a href="https://cursor.com/docs/models-and-pricing" target="_blank" rel="noreferrer">查看 Cursor 官方说明 ↗</a></div><div><strong>MCP 不负责选额度桶</strong><p>工具定义、历史上下文和工具循环会影响模型输入与调用量，但不会替代 Cursor 服务端的账号鉴权、额度策略与记账。本栏不调用拾光 MCP 或自动化流程。</p></div></div></SettingsSection></div>
}
