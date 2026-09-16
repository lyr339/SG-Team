// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../src/domain/workspace-review'
import type { LiveProcessState } from '../src/shared/desktop-api'
import { requestReviewFocus } from '../src/renderer/src/inspector/review-focus-bus'
import { WorkspaceInspector } from '../src/renderer/src/WorkspaceInspector'

const session: AgentSession = {
  id: 'session-2', channelId: '2', generation: 1, displayName: '实现席', roleName: '实现席',
  status: 'running', currentTask: '右栏', queueDepth: 0, connectionPhase: 'processing',
  online: true, connected: true, waiting: false, workingFiles: [], healthEvidence: []
}

const historical: ConversationEntry = {
  id: 'reply-1', channelId: '2', role: 'assistant', text: '完成', timestamp: 1,
  status: 'complete', source: 'cursor', processBlocks: [{
    kind: 'tool', id: 'old-todos', toolName: 'todos', toolKind: 'todo', status: 'done',
    todos: [{ content: '历史任务', status: 'completed' }]
  }]
}

function liveTodos(content = '实时任务'): LiveProcessState {
  return {
    turn: 'turn-2', startedAt: 2, updatedAt: 3,
    blocks: [{
      kind: 'tool', id: 'live-todos', toolName: 'todos', toolKind: 'todo', status: 'running',
      todos: [{ content, status: 'in_progress' }]
    }]
  }
}

describe('WorkspaceInspector Cursor Todos', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('sg-team.inspector:active-tab', 'todos')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    localStorage.clear()
  })

  it('renders the live list in the dock and keeps the close action explicit', async () => {
    const onClose = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector
        session={session}
        entries={[historical]}
        liveProcess={liveTodos('实现真实 Review')}
        workspaceId="workspace-1"
        workspaceName="demo"
        onClose={onClose}
      />
    ))
    expect(container.textContent).toContain('Cursor Todos')
    expect(container.textContent).toContain('实现真实 Review')
    expect(container.textContent).toContain('0/1')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="收起右侧工作区"]')!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('falls back to the latest persisted Todo list after the live turn is archived', async () => {
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector
        session={session}
        entries={[historical]}
        workspaceId="workspace-1"
        onClose={() => {}}
      />
    ))
    expect(container.textContent).toContain('历史任务')
    expect(container.textContent).toContain('1/1')
    await act(async () => root.unmount())
  })

  it('does not carry an old Todo list into a newer live turn that has no Todo state', async () => {
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector
        session={session}
        entries={[historical]}
        liveProcess={{ turn: 'new-turn', startedAt: 3, updatedAt: 4, blocks: [] }}
        workspaceId="workspace-1"
        onClose={() => {}}
      />
    ))
    expect(container.textContent).not.toContain('历史任务')
    expect(container.textContent).toContain('暂无任务清单')
    await act(async () => root.unmount())
  })
})

describe('WorkspaceInspector × 本轮文件栏', () => {
  let container: HTMLDivElement
  const summary: WorkspaceReviewSummary = {
    state: 'ready', scope: 'uncommitted', workspaceName: 'demo', revision: 'rev-1', updatedAt: 1, additions: 4, deletions: 1, liveUpdates: true,
    files: [{ path: 'src/login.tsx', status: 'modified', staged: false, unstaged: true, additions: 4, deletions: 1 }]
  }
  const editedLogin: ConversationEntry = {
    id: 'u1', channelId: '2', role: 'user', source: 'desktop', text: '改登录', timestamp: 1, deliveredAt: 2, status: 'complete'
  }
  const editLive: LiveProcessState = {
    turn: 'turn-3', startedAt: 3, updatedAt: 4, generating: true,
    blocks: [{ kind: 'tool', id: 'edit-1', toolName: 'edit_file_v2', toolKind: 'edit', summary: 'src/login.tsx', hint: '+4 −1', status: 'done' }]
  }

  function installApi(): { getWorkspaceReview: ReturnType<typeof vi.fn>; fireChange: () => void } {
    let changeListener: (() => void) | undefined
    const api = {
      getWorkspaceReview: vi.fn(async () => summary),
      getWorkspaceReviewFile: vi.fn(async ({ path }: { path: string }) => ({ state: 'ready', path, truncated: false, hunks: [] })),
      onWorkspaceReviewChanged: vi.fn((listener: () => void) => { changeListener = listener; return () => { changeListener = undefined } }),
      fireChange: () => changeListener?.()
    }
    Object.defineProperty(window, 'sgDesktop', { configurable: true, value: api })
    return api
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    localStorage.clear()
  })

  it('mirrors the review summary to the caller and switches to the 变更 tab on a review-focus request', async () => {
    installApi()
    localStorage.setItem('sg-team.inspector:active-tab', 'plan')
    const onReviewSummary = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(
      <WorkspaceInspector session={session} entries={[editedLogin]} liveProcess={editLive} workspaceId="workspace-1" onReviewSummary={onReviewSummary} onClose={() => {}} />
    ))
    expect(onReviewSummary).toHaveBeenLastCalledWith(summary)
    expect(container.querySelector('.inspector-tab.is-active')!.textContent).toContain('计划')
    await act(async () => requestReviewFocus({ path: 'src/login.tsx' }))
    expect(container.querySelector('.inspector-tab.is-active')!.textContent).toContain('变更')
    await act(async () => root.unmount())
  })

  it('keeps the review summary polling while hidden as long as the turn has touched files (the bar is consuming it)', async () => {
    const api = installApi()
    const root = createRoot(container)
    // 收起 + 本轮有改动：推送仍触发重拉。
    await act(async () => root.render(
      <WorkspaceInspector session={session} entries={[editedLogin]} liveProcess={editLive} workspaceId="workspace-1" hidden onClose={() => {}} />
    ))
    const withFiles = api.getWorkspaceReview.mock.calls.length
    await act(async () => api.fireChange())
    expect(api.getWorkspaceReview.mock.calls.length).toBe(withFiles + 1)
    // 收起 + 本轮没有改动：推送只记标记。
    await act(async () => root.render(
      <WorkspaceInspector session={session} entries={[editedLogin]} liveProcess={{ ...editLive, blocks: [] }} workspaceId="workspace-1" hidden onClose={() => {}} />
    ))
    const withoutFiles = api.getWorkspaceReview.mock.calls.length
    await act(async () => api.fireChange())
    expect(api.getWorkspaceReview.mock.calls.length).toBe(withoutFiles)
    await act(async () => root.unmount())
  })
})
