// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../src/domain/workspace-review'
import { WorkspaceInspector } from '../src/renderer/src/WorkspaceInspector'
import { INSPECTOR_TAB_STORAGE_KEY } from '../src/renderer/src/inspector/InspectorShell'

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
    expect(container.textContent).toContain('Cursor Todos')
    // 当前项只在列表行标注（spinner + aria-current），小节头是安静的来源说明，不复读任务全文。
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
