// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { SessionWorkspace } from '../src/renderer/src/SessionWorkspace'

const session: AgentSession = {id:'history-seat',channelId:'5',generation:1,displayName:'历史验收',roleName:'独立席',status:'waiting',currentTask:'',queueDepth:0,
  connectionPhase:'waiting',online:true,connected:true,waiting:true,workingFiles:[],healthEvidence:[]}
const user: ConversationEntry = {id:'u1',channelId:'5',role:'user',source:'desktop',status:'complete',timestamp:1000,deliveredAt:1050,text:'请继续'}
const reply = (partial: Partial<ConversationEntry>): ConversationEntry => ({id:'a1',channelId:'5',role:'assistant',source:'cursor',status:'complete',timestamp:2000,replyToEntryId:'u1',text:'最终回答',...partial})
type Props = Parameters<typeof SessionWorkspace>[0]
describe('archived workspace content remains complete after deliberate lazy expansion', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    ;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT = true
    host=document.createElement('div');document.body.append(host);root=createRoot(host)
  })
  afterEach(async () => {await act(async () => root.unmount());host.remove()})
  const render = async (overrides: Partial<Props>) => act(async () => root.render(<SessionWorkspace session={session} entries={[user]}
    onSend={async()=>{}} onBack={()=>{}} draft="" onDraftChange={()=>{}} attachments={[]} onAttachmentsChange={()=>{}} {...overrides}/>))
  const expand = async () => act(async () => host.querySelector<HTMLButtonElement>('.cursor-native-process__summary')!.click())

  it('retains both read and command details without mounting them before the user opens history', async () => {
    await render({entries:[user,reply({processBlocks:[
      {kind:'tool',id:'read',toolName:'Read',toolKind:'read',summary:'src/App.tsx',status:'done'},
      {kind:'command',id:'command',command:'npm test',output:'ok',exitCode:0,status:'done'}
    ]})]})
    expect(host.textContent).not.toContain('src/App.tsx')
    await expand()
    expect(host.textContent).toContain('src/App.tsx');expect(host.textContent).toContain('npm test')
    expect(host.querySelectorAll('.cursor-native-process')).toHaveLength(1)
  })
  it('keeps legitimate interim messages but never duplicates the final reply inside the opened flow', async () => {
    await render({entries:[user,reply({processBlocks:[
      {kind:'message',id:'interim',text:'我先读取目标文件。',status:'done'},
      {kind:'message',id:'duplicate',text:'最终回答',status:'done'}
    ]})]})
    await expand()
    expect(host.textContent).toContain('我先读取目标文件。')
    expect(host.textContent!.match(/最终回答/g)).toHaveLength(1)
  })
  it('keeps completed continuation details after the reply, without resurrecting a live marker', async () => {
    await render({entries:[user,reply({text:'已接手。',continuationBlocks:[{kind:'tool',id:'edit',toolName:'edit_file',toolKind:'edit',summary:'src/a.ts',status:'done',startedAt:2500}]})]})
    await expand()
    expect(host.textContent).toContain('src/a.ts')
    expect(host.innerHTML.indexOf('已接手。')).toBeLessThan(host.innerHTML.indexOf('src/a.ts'))
    expect(host.querySelector('.chat-row--continuation .is-live')).toBeNull()
  })
  it('a final native response keeps the associated long-running thought step available on expansion', async () => {
    await render({entries:[],liveProcess:{turn:'cursor:long',startedAt:1000,updatedAt:5000,blocks:[{kind:'thinking',id:'thought-long',text:'长任务完整过程',status:'done'}]},
      liveAgentResponse:{id:'answer-long',channelId:'5',text:'长任务最终回答',status:'complete',startedAt:180000,updatedAt:180100}})
    expect(host.textContent).toContain('长任务最终回答')
    await expand()
    expect(host.querySelector('[data-step-id="block:thought-long"]')).not.toBeNull()
    expect(host.textContent).toContain('Thought')
  })
})
