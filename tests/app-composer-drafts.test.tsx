import type { AccountAutomationSettings } from '../src/domain/account-automation'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { MessageAttachment } from '../src/domain/conversation-entry'
import { emptyTaskPoolSnapshot } from '../src/domain/task-pool'
import { emptyTeamControlSnapshot } from '../src/domain/team-control'
import { emptyTeamCollaborationSnapshot } from '../src/domain/team-collaboration'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import { App } from '../src/renderer/src/App'

function makeSession(channelId: string, displayName: string): AgentSession {
  return {
    id: `session-${channelId}`,
    channelId,
    generation: 1,
    displayName,
    roleName: '实现席',
    status: 'waiting',
    currentTask: '',
    queueDepth: 0,
    connectionPhase: 'keepalive',
    online: true,
    connected: true,
    waiting: true,
    workingFiles: [],
    healthEvidence: []
  }
}

const snapshot: DesktopSnapshot = {
  connection: { state: 'connected', endpoint: 'shiguang://test', attempt: 0, lastError: '' },
  sessions: [
    makeSession('2', '后端实现 · CH-2'),
    makeSession('5', '专项实现 · CH-5')
  ],
  conversations: { '2': [], '5': [] },
  protocolIssues: [],
  updatedAt: 1
}

interface SendMessageCall {
  channelId: string
  text: string
  attachments?: MessageAttachment[]
}

const sendMessage = vi.fn<(input: SendMessageCall) => Promise<void>>(async () => {})

function stubScrollApis(): void {
  // jsdom 未实现元素滚动 API；会话时间线的贴底滚动在测试中置为空操作
  if (!window.Element.prototype.scrollTo) {
    window.Element.prototype.scrollTo = () => {}
  }
}

function stubMatchMedia(): void {
  // jsdom 未实现 matchMedia；App 的 Windows 标题栏主题同步 effect 只需恒亮色桩
  if (!window.matchMedia) {
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia
  }
}

function installDesktopMock(desktopSnapshot: DesktopSnapshot = snapshot): void {
  const base: Record<string, unknown> = {
    onSnapshot: () => () => {},
    onTaskPoolSnapshot: () => () => {},
    onTeamControlSnapshot: () => () => {},
    onTeamCollaborationSnapshot: () => () => {},
    onProcessingProgress: () => () => {},
    onAgentLaunchProgress: () => () => {},
    onCdpAutoHealEvent: () => () => {},
    onAccountAutomationProgress: () => () => {},
    getSnapshot: async () => desktopSnapshot,
    getTaskPoolSnapshot: async () => emptyTaskPoolSnapshot(),
    getTeamControlSnapshot: async () => emptyTeamControlSnapshot(),
    getTeamCollaborationSnapshot: async () => emptyTeamCollaborationSnapshot(),
    listCursorAccounts: async () => [],
    getProcessingProviderStatuses: async () => [
      { providerId: 'aozai', label: '奥仔', unit: 'points', saved: false },
      { providerId: 'henxin', label: '痕心', unit: 'uses', saved: false }
    ],
    getAgentLaunchPlan: async () => undefined,
    getAccountAutomationSettings: async () => ({ enabled: false, delaySec: 30, postProcessDelaySec: 30, processingProvider: 'aozai' }),
    getAccountAutomationRun: async () => ({ phase: 'idle' }),
    getCursorCdpSettings: async () => ({ autoHealEnabled: false }),
    getCursorUpdatePreferences: async () => ({}),
    detectCursorWorkspace: async () => ({ state: 'none', source: 'test', confidence: 0, candidates: [], detail: '' }),
    refreshProcessingBalance: async (providerId: 'aozai' | 'henxin') => ({ providerId, label: providerId === 'henxin' ? '痕心' : '奥仔', unit: providerId === 'henxin' ? 'uses' : 'points', saved: false }),
    installTaskMcp: async () => ({ workspacePath: '/workspace/demo', workspaceId: 'demo', runId: 'run-1', serverNames: ['SG Team'] }),
    sendMessage
  }
  const api = new Proxy(base, {
    get: (target, prop) => {
      if (prop in target) return target[prop as keyof typeof target]
      if (String(prop).startsWith('on')) return () => () => {}
      return async () => undefined
    }
  })
  ;(window as unknown as { sgDesktop: unknown }).sgDesktop = api
}

let container: HTMLDivElement
let root: Root

function composerTextarea(): HTMLTextAreaElement {
  const element = container.querySelector('textarea[aria-label^="给 "]')
  if (!element) throw new Error('composer textarea not rendered')
  return element as HTMLTextAreaElement
}

function sessionCard(channelId: string): HTMLButtonElement {
  const card = Array.from(container.querySelectorAll<HTMLButtonElement>('button.session-row'))
    .find((element) => element.textContent?.includes(`CH-${channelId}`))
  if (!card) throw new Error(`session card CH-${channelId} not rendered`)
  return card
}

async function renderApp(hash: string): Promise<void> {
  window.location.hash = hash
  root = createRoot(container)
  await act(async () => {
    root.render(<App />)
  })
  // 初始 effect 链（快照/团队/账号等 Promise）全部落进 React 状态
  await act(async () => {})
  await act(async () => {})
}

async function typeDraft(value: string): Promise<void> {
  const textarea = composerTextarea()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(textarea, value)
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function selectChannel(channelId: string): Promise<void> {
  const card = sessionCard(channelId)
  await act(async () => {
    card.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

async function attachFile(name: string, type = 'text/plain'): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('attachment input not rendered')
  const file = new window.File(['hello attachment'], name, { type })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  // FileReader 以宏任务完成读取，等待附件落进状态
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {})
}

function clickButtonWithText(text: string): void {
  const button = Array.from(container.querySelectorAll('button'))
    .find((element) => element.textContent?.trim() === text)
  if (!button) throw new Error(`button "${text}" not rendered`)
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('App 输入框草稿与附件按通道隔离', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    sendMessage.mockClear()
    stubScrollApis()
    stubMatchMedia()
    installDesktopMock()
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    window.location.hash = ''
    localStorage.clear()
  })

  it('无深链接时会话是首页，并在运行页往返后保留当前会话', async () => {
    await renderApp('')
    expect(composerTextarea().getAttribute('aria-label')).toContain('CH-2')
    expect(container.querySelector('.topbar-nav')?.textContent?.replace(/\s/g, '')).toBe('会话运行')
    expect(container.querySelector<HTMLButtonElement>('.brand')?.getAttribute('aria-label')).toBe('返回拾光会话')

    await selectChannel('5')
    await act(async () => clickButtonWithText('运行'))
    expect(container.querySelector('.run-page')).toBeTruthy()
    await act(async () => clickButtonWithText('会话'))
    expect(composerTextarea().getAttribute('aria-label')).toContain('CH-5')
    expect(localStorage.getItem('shiguang.lastSessionChannel.v1')).toBe('5')
  })

  it('账号与 Cursor 从右上角入口进入，不占主导航；再点一次回到会话', async () => {
    await renderApp('')
    const accountButton = container.querySelector<HTMLButtonElement>('.account-button')!
    expect(accountButton.getAttribute('aria-label')).toBe('账号与 Cursor')
    await act(async () => accountButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(container.querySelector('.settings-page[aria-label="账号与 Cursor 配置"]')).toBeTruthy()
    expect(container.querySelector('.account-button')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => container.querySelector<HTMLButtonElement>('.account-button')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(composerTextarea().getAttribute('aria-label')).toContain('CH-2')
  })

  it('首次没有会话时留在会话首页：只有「批量创建独立会话」一个入口（团队 run 已退役，协作组在名册里建），直达独立批次配置', async () => {
    installDesktopMock({ ...snapshot, sessions: [], conversations: {} })
    await renderApp('')
    expect(container.textContent).toContain('还没有发现 Cursor 会话')
    expect(container.textContent).not.toContain('组建协作团队')
    expect(container.querySelectorAll('.fresh-empty__actions button')).toHaveLength(1)
    await act(async () => clickButtonWithText('批量创建独立会话'))
    expect(container.querySelector('.run-page')).toBeTruthy()
    expect(container.querySelector('section[aria-label="独立批次配置"]')).toBeTruthy()
  })

  it('draft 按 channelId 保存：切换通道互不干扰，切回后恢复', async () => {
    await renderApp('#sessions:2')
    expect(composerTextarea().value).toBe('')
    expect(composerTextarea().getAttribute('aria-label')).toContain('CH-2')

    await typeDraft('给 CH-2 的草稿')
    await selectChannel('5')
    expect(composerTextarea().getAttribute('aria-label')).toContain('CH-5')
    expect(composerTextarea().value).toBe('')

    await typeDraft('CH-5 的另一份草稿')
    await selectChannel('2')
    expect(composerTextarea().value).toBe('给 CH-2 的草稿')

    await selectChannel('5')
    expect(composerTextarea().value).toBe('CH-5 的另一份草稿')
  })

  it('附件按 channelId 保存：切换通道后各自恢复', async () => {
    await renderApp('#sessions:2')
    await attachFile('ch2-notes.md')
    expect(container.textContent).toContain('ch2-notes.md')

    await selectChannel('5')
    expect(container.textContent).not.toContain('ch2-notes.md')

    await attachFile('ch5-shot.png', 'image/png')
    expect(container.textContent).toContain('ch5-shot.png')

    await selectChannel('2')
    expect(container.textContent).toContain('ch2-notes.md')
    expect(container.textContent).not.toContain('ch5-shot.png')

    await selectChannel('5')
    expect(container.textContent).toContain('ch5-shot.png')
    expect(container.textContent).not.toContain('ch2-notes.md')
  })

  it('发送成功后清空该通道草稿并把文本发给对应 channelId', async () => {
    await renderApp('#sessions:2')
    await typeDraft('请处理这个任务')
    await act(async () => {
      clickButtonWithText('发送')
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith({
      channelId: '2',
      text: '请处理这个任务',
      attachments: undefined
    })
    expect(composerTextarea().value).toBe('')

    await selectChannel('5')
    expect(composerTextarea().value).toBe('')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('theme and mode changes preserve the actual workspace, composer, draft and attachments without sending', async () => {
    await renderApp('#sessions:2')
    await typeDraft('Theme changes must not send or replace this draft.')
    await attachFile('theme-preserved.md')
    const textarea = composerTextarea(), workspace = container.querySelector('.workspace-main')
    expect(workspace).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="外观设置"]')!.click())
    for (const id of ['dai-blue', 'luoshen-violet', 'ink-jade', 'sg-orange']) {
      const choice = container.querySelector<HTMLButtonElement>(`[data-accent-choice="${id}"]`)!
      choice.focus()
      await act(async () => choice.click())
      expect(document.documentElement.dataset.accent).toBe(id)
      expect(document.activeElement).toBe(choice)
      expect(composerTextarea()).toBe(textarea)
      expect(composerTextarea().value).toBe('Theme changes must not send or replace this draft.')
      expect(container.querySelector('.workspace-main')).toBe(workspace)
      expect(container.textContent).toContain('theme-preserved.md')
    }
    await act(async () => clickButtonWithText('深色'))
    expect(document.documentElement.dataset.colorMode).toBe('dark')
    expect(composerTextarea()).toBe(textarea)
    expect(composerTextarea().value).toBe('Theme changes must not send or replace this draft.')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('shiguang.appearance.v1')!)).toMatchObject({ accent: 'sg-orange', colorMode: 'dark' })
  })
  it('reselecting the current or pending appearance does not trigger another snapshot', async () => {
    await renderApp('#sessions:2')
    await typeDraft('Keep this draft during repeated theme clicks.')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="外观设置"]')!.click())
    const descriptor = Object.getOwnPropertyDescriptor(document, 'startViewTransition')
    let commit!: () => void
    const start = vi.fn((update: () => void) => {
      commit = update
      return {ready:Promise.resolve(),finished:new Promise<void>(() => {}),skipTransition:vi.fn()}
    })
    Object.defineProperty(document, 'startViewTransition', {configurable:true,value:start})
    try {
      const orange = container.querySelector<HTMLButtonElement>('[data-accent-choice="sg-orange"]')!
      const blue = container.querySelector<HTMLButtonElement>('[data-accent-choice="dai-blue"]')!
      await act(async () => orange.click()); expect(start).not.toHaveBeenCalled()
      await act(async () => {blue.click();blue.click()})
      expect(start).toHaveBeenCalledOnce()
      await act(async () => commit())
      await act(async () => blue.click()); expect(start).toHaveBeenCalledOnce()
      expect(document.documentElement.dataset.accent).toBe('dai-blue')
      expect(composerTextarea().value).toBe('Keep this draft during repeated theme clicks.')
    } finally {
      if (descriptor) Object.defineProperty(document, 'startViewTransition', descriptor)
      else Reflect.deleteProperty(document, 'startViewTransition')
    }
  })
  it('persists concurrent automation form edits without overwriting sibling fields or flashing old input',async()=>{
    const pending:Array<{value:AccountAutomationSettings;resolve:(value:AccountAutomationSettings)=>void}>=[]
    window.sgDesktop.saveAccountAutomationSettings=vi.fn((value:AccountAutomationSettings)=>new Promise<AccountAutomationSettings>(resolve=>pending.push({value,resolve})))
    await renderApp('#account:automation')
    const fields=[...container.querySelectorAll<HTMLInputElement>('.settings-checkout-form input')]
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!
    await act(async()=>{setter.call(fields[0],'Alice');fields[0]!.dispatchEvent(new Event('input',{bubbles:true}))})
    await act(async()=>{setter.call(fields[1],'广东省');fields[1]!.dispatchEvent(new Event('input',{bubbles:true}))})
    expect(pending).toHaveLength(1)
    expect(fields[0]!.value).toBe('Alice');expect(fields[1]!.value).toBe('广东省')
    await act(async()=>pending[0]!.resolve(pending[0]!.value));expect(pending).toHaveLength(2)
    expect(fields[0]!.value).toBe('Alice');expect(fields[1]!.value).toBe('广东省')
    expect(pending[1]!.value.checkoutProfile).toMatchObject({name:'Alice',province:'广东省'})
    await act(async()=>pending[1]!.resolve(pending[1]!.value))
    expect(fields[0]!.value).toBe('Alice');expect(fields[1]!.value).toBe('广东省')
  })

  it('shows a local settings error and preserves an independent successful edit after one save fails',async()=>{
    let fail!:(error:Error)=>void
    window.sgDesktop.saveAccountAutomationSettings=vi.fn<(value:AccountAutomationSettings)=>Promise<AccountAutomationSettings>>()
      .mockImplementationOnce(()=>new Promise((_done,reject)=>{fail=reject})).mockImplementation(async value=>value)
    await renderApp('#account:automation')
    const fields=[...container.querySelectorAll<HTMLInputElement>('.settings-checkout-form input')]
    const oldName=fields[0]!.value,setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!
    await act(async()=>{setter.call(fields[0],'Alice');fields[0]!.dispatchEvent(new Event('input',{bubbles:true}))})
    await act(async()=>{setter.call(fields[1],'广东省');fields[1]!.dispatchEvent(new Event('input',{bubbles:true}))})
    await act(async()=>fail(new Error('disk failure')))
    expect(fields[0]!.value).toBe(oldName);expect(fields[1]!.value).toBe('广东省')
    expect(container.querySelector('.settings-content [role="alert"]')?.textContent).toContain('部分设置未保存')
  })

  it.each([true,false])('a dependent browser refresh waits for real settings persistence (success=%s)',async(success)=>{
    let resolve!:(value:AccountAutomationSettings)=>void,reject!:(reason:Error)=>void,saved!:AccountAutomationSettings
    window.sgDesktop.saveAccountAutomationSettings=vi.fn((value:AccountAutomationSettings)=>{saved=value;return new Promise<AccountAutomationSettings>((done,fail)=>{resolve=done;reject=fail})})
    const refresh=vi.fn(async()=>({ok:true,profiles:[]}));window.sgDesktop.listAccountAutomationBitProfiles=refresh
    await renderApp('#account:automation')
    const field=container.querySelector<HTMLInputElement>('.settings-checkout-form input')!,setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!
    await act(async()=>{setter.call(field,'Alice');field.dispatchEvent(new Event('input',{bubbles:true}))})
    await act(async()=>clickButtonWithText('导入来源'))
    const calls=refresh.mock.calls.length
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="刷新指纹浏览器窗口"]')!.click())
    expect(refresh).toHaveBeenCalledTimes(calls)
    await act(async()=>{if(success)resolve(saved);else reject(new Error('save failed'))})
    expect(refresh).toHaveBeenCalledTimes(calls+(success?1:0))
  })

  it('a successful local-read retry clears only the initial settings read warning',async()=>{
    const settings:AccountAutomationSettings={enabled:false,delaySec:30,postProcessDelaySec:30,processingProvider:'aozai'}
    const read=vi.fn<()=>Promise<AccountAutomationSettings>>().mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(settings)
    window.sgDesktop.getAccountAutomationSettings=read
    window.sgDesktop.listAccountAutomationBitProfiles=vi.fn(async()=>({ok:true,profiles:[]}))
    await renderApp('#account:import')
    expect(container.querySelector('.settings-content [role="alert"]')?.textContent).toContain('设置暂未读取')
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="刷新指纹浏览器窗口"]')!.click())
    expect(read).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.settings-content [role="alert"]')).toBeNull()
  })

})
