// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../src/domain/workspace-review'
import { WorkspaceInspector } from '../src/renderer/src/WorkspaceInspector'
import { INSPECTOR_TAB_STORAGE_KEY, InspectorShell, InspectorPanel } from '../src/renderer/src/inspector/InspectorShell'
import { MenuSelect } from '../src/renderer/src/lobby/MenuSelect'

const session: AgentSession = {
  id: 'session-2', channelId: '2', generation: 1, displayName: '实现席', roleName: '实现席',
  status: 'running', currentTask: '右栏', queueDepth: 0, connectionPhase: 'processing',
  online: true, connected: true, waiting: false, workingFiles: [], healthEvidence: []
}

const entries: ConversationEntry[] = [
  { id: 'u1', channelId: '2', role: 'user', text: '改一下登录页', timestamp: 1, deliveredAt: 2, status: 'complete', source: 'desktop' },
  {
    id: 'r1', channelId: '2', role: 'assistant', text: '改好了 ![截图](/tmp/login.png)', timestamp: 3, status: 'complete', source: 'cursor',
    processBlocks: [
      { kind: 'tool', id: 'edit-1', toolName: 'edit_file', toolKind: 'edit', status: 'done', summary: '/Users/me/demo/src/login.tsx' },
      { kind: 'command', id: 'cmd-1', command: 'npm test', output: 'ok', exitCode: 0, status: 'done' },
      { kind: 'tool', id: 'todo-1', toolName: 'todos', toolKind: 'todo', status: 'done', todos: [{ content: '写测试', status: 'in_progress' }] }
    ]
  }
]

function installDesktopApi(): void {
  Object.defineProperty(window, 'sgDesktop', {
    configurable: true,
    value: {
      getWorkspaceReview: vi.fn(async () => ({
        state: 'ready', scope: 'uncommitted', workspaceName: 'demo', revision: 'rev-1', updatedAt: 1, additions: 4, deletions: 1, liveUpdates: true,
        files: [{ path: 'src/login.tsx', status: 'modified', staged: false, unstaged: true, additions: 4, deletions: 1 }]
      })),
      getWorkspaceReviewFile: vi.fn(async ({ path }: { path: string }) => ({ state: 'ready', path, truncated: false, hunks: [] })),
      onWorkspaceReviewChanged: vi.fn(() => () => {})
    }
  })
}

describe('WorkspaceInspector shell', () => {
  it('does not collapse the whole inspector when Escape first closes an inner portal menu', async () => {
    const root=createRoot(container), onClose=vi.fn()
    await act(async()=>root.render(<InspectorShell tabs={[{id:'team',label:'协同',icon:null}]} activeTab="team" onTabChange={()=>{}} onClose={onClose}>
      <InspectorPanel tab="team"><MenuSelect value="a" ariaLabel="测试成员" options={[{value:'a',label:'成员 A'}]} onChange={()=>{}}/></InspectorPanel>
    </InspectorShell>))
    const trigger=container.querySelector<HTMLButtonElement>('.menu-select__button')!
    await act(async()=>trigger.click())
    await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.querySelector('.menu-select__menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    expect(onClose).toHaveBeenCalledOnce()
    await act(async()=>root.unmount())
  })
  it('consumes an explicit same-scope team focus once without stealing later tab choices', async () => {
    const root = createRoot(container)
    const view = {scopeKey:'run:group',runId:'run',mutable:true,tasks:[],messages:[],pendingReplies:0,planningLabel:''}
    const context = {view,onOpenSession:vi.fn(),onManageGroup:vi.fn(),onPlanTask:vi.fn(async()=>{})}
    const render = async (focus={key:1,scopeKey:'run:group'}) => {
      await act(async()=>root.render(<WorkspaceInspector session={session} entries={entries} onClose={()=>{}} groupContext={context} groupFocus={focus} />))
    }
    await render()
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('协同')
    await act(async()=>[...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button=>button.textContent?.startsWith('计划'))!.click())
    await render()
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('计划1')
    await render({key:2,scopeKey:'other-run:other-group'})
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('计划1')
    await render({key:3,scopeKey:'run:group'})
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('协同')
    await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{altKey:true,code:'Digit5'})))
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('协同')
    await act(async()=>root.unmount())
  })
  let container: HTMLDivElement

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    installDesktopApi()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    localStorage.clear()
  })

  it('renders four tabs with live counts, roves focus with arrow keys and persists the selection', async () => {
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector session={session} entries={entries} workspaceId="ws" workspacePath="/Users/me/demo" onClose={() => {}} />
    ))
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs.map((tab) => tab.textContent)).toEqual(['变更1', '计划1', '活动2', '产物1'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    // 运行状态留在清单内容中；标签只保留计数，不叠加装饰点。
    expect(container.querySelector('.inspector-tab__dot')).toBeNull()

    await act(async () => {
      tabs[0]!.focus()
      tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(document.activeElement?.textContent).toBe('计划1')
    expect(localStorage.getItem(INSPECTOR_TAB_STORAGE_KEY)).toBe('plan')
    expect(container.textContent).toContain('任务 1进行中 · 0待处理')
    // 当前项在列表行由缺口环和 aria-current 标注，小节头仅显示状态计数。
    expect(container.textContent).toContain('写测试')
    expect(container.querySelector('.inspector-plan__list li.is-in_progress')!.getAttribute('aria-current')).toBe('step')

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(localStorage.getItem(INSPECTOR_TAB_STORAGE_KEY)).toBe('artifacts')
    expect(container.textContent).toContain('截图')
    expect(container.querySelector('.artifact-card')).toBeTruthy()

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(localStorage.getItem(INSPECTOR_TAB_STORAGE_KEY)).toBe('activity')
    expect(container.textContent).toContain('改动文件')
    expect(container.textContent).toContain('npm test')
    await act(async () => root.unmount())
  })

  it('maps the legacy "todos" preference to the plan tab and closes on Escape', async () => {
    localStorage.setItem(INSPECTOR_TAB_STORAGE_KEY, 'todos')
    const onClose = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector session={session} entries={entries} workspaceId="ws" onClose={onClose} />
    ))
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('计划1')
    await act(async () => {
      container.querySelector<HTMLElement>('.workspace-inspector')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('keeps the review panel mounted while another tab is active so pushes keep flowing', async () => {
    localStorage.setItem(INSPECTOR_TAB_STORAGE_KEY, 'activity')
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector session={session} entries={entries} workspaceId="ws" onClose={() => {}} />
    ))
    const api = window.sgDesktop as unknown as { getWorkspaceReview: ReturnType<typeof vi.fn>; onWorkspaceReviewChanged: ReturnType<typeof vi.fn> }
    expect(api.getWorkspaceReview).toHaveBeenCalled()
    expect(api.onWorkspaceReviewChanged).toHaveBeenCalledTimes(1)
    const hidden = container.querySelector('.inspector-panel.is-hidden')
    expect(hidden?.getAttribute('hidden')).not.toBeNull()
    expect(hidden?.textContent).toContain('src/login.tsx')
    await act(async () => root.unmount())
  })

  it('removes the previous review and artifacts when the directory changes under the same workspace id', async () => {
    localStorage.setItem(INSPECTOR_TAB_STORAGE_KEY, 'artifacts')
    localStorage.setItem('sg-team.inspector:review-scope:v2', 'uncommitted')
    const api = window.sgDesktop as unknown as { getWorkspaceReview: ReturnType<typeof vi.fn> }
    const summary = (name: string): WorkspaceReviewSummary => ({
      state: 'ready', scope: 'uncommitted', workspaceName: name, revision: name, updatedAt: 1,
      additions: 1, deletions: 0, liveUpdates: true,
      files: [{ path: `docs/${name}.md`, status: 'added', staged: false, unstaged: true, additions: 1, deletions: 0 }]
    })
    let deliverNext: ((value: WorkspaceReviewSummary) => void) | undefined
    api.getWorkspaceReview.mockResolvedValueOnce(summary('old'))
      .mockImplementationOnce(() => new Promise<WorkspaceReviewSummary>((resolve) => { deliverNext = resolve }))
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector session={session} entries={entries} workspaceId="shared" workspacePath="/repo/old" onClose={() => {}} />
    ))
    const oldRow = container.querySelector('.review-file[data-path="docs/old.md"]')
    expect(oldRow).not.toBeNull()
    expect(container.textContent).toContain('docs/old.md')

    await act(async () => root.render(
      <WorkspaceInspector session={session} entries={entries} workspaceId="shared" workspacePath="/repo/new" onClose={() => {}} />
    ))
    expect(container.contains(oldRow)).toBe(false)
    expect(container.textContent).not.toContain('docs/old.md')
    expect(container.querySelector('.review-file[data-path="docs/new.md"]')).toBeNull()

    await act(async () => deliverNext?.(summary('new')))
    expect(container.textContent).toContain('docs/new.md')
    await act(async () => root.unmount())
  })
})
