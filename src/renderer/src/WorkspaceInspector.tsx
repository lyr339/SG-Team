import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentSession } from '../../domain/agent-session'
import type { ConversationEntry } from '../../domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../../domain/workspace-review'
import type { LiveProcessState } from '../../shared/desktop-api'
import { ActivityPanel } from './inspector/ActivityPanel'
import { projectActivity } from './inspector/activity-view'
import { ArtifactsPanel } from './inspector/ArtifactsPanel'
import { projectArtifacts } from './inspector/artifacts-view'
import { ActivityIcon, ArtifactIcon, DiffIcon, PlanIcon } from './inspector/InspectorIcons'
import { InspectorPanel, InspectorShell, readStoredInspectorTab, type InspectorTabId, type InspectorTabSpec } from './inspector/InspectorShell'
import { currentCursorTodos, PlanPanel } from './inspector/PlanPanel'
import { ReviewPanel } from './inspector/ReviewPanel'
import { subscribeReviewFocus } from './inspector/review-focus-bus'
import { turnMutatedPaths } from './inspector/review-scope'
import { turnReviewEditsByPath } from './inspector/turn-review-view'
import { todoTone } from './TodoIndicator'
import type { TurnFilesView } from './turn-files-view'

export type { CursorTodoItem } from './inspector/PlanPanel'

interface WorkspaceInspectorProps {
  session: AgentSession
  entries: ConversationEntry[]
  liveProcess?: LiveProcessState
  workspaceId?: string
  workspaceName?: string
  /** 工作区绝对路径：用于把过程块里的绝对路径归一为仓库相对路径。 */
  workspacePath?: string
  /**
   * 本轮文件栏的视图（App 已算好的 `buildTurnFilesView`）：变更面板的「本轮」范围直接
   * 复用它做文件列表与计数，栏、名册与右栏三处永远一致；这里只补每个文件的逐次编辑差异。
   */
  turnFiles?: TurnFilesView
  /** 把引用文本追加到该会话的输入框（「反馈给 Agent」）。 */
  onQuoteToComposer?: (text: string) => void
  /** 右栏已收起但仍挂载：面板保留状态，暂停轮询等后台工作，重新展开时补拉一次。 */
  hidden?: boolean
  /** 工作区变更摘要的镜像（输入区上方的本轮文件栏用它取增删行数，不重复拉取）。 */
  onReviewSummary?: (summary: WorkspaceReviewSummary | undefined) => void
  onClose: () => void
}

/**
 * 会话右侧工作区（Codex 式右栏）：变更 / 计划 / 活动 / 产物 四个面板共用一个壳。
 * 变更是工作区级（切会话不换），其余三个随会话切换；所有数据都是快照的纯投影，
 * 面板不推进任何工作流状态，Git 动作由用户显式发起并经主进程校验。
 * 徽章统一表示「该面板顶层列出的条目数」，实时活动另以状态点表示。
 */
export function WorkspaceInspector({
  session,
  entries,
  liveProcess,
  workspaceId,
  workspaceName,
  workspacePath,
  turnFiles,
  onQuoteToComposer,
  hidden = false,
  onReviewSummary,
  onClose
}: WorkspaceInspectorProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<InspectorTabId>(readStoredInspectorTab)
  const [reviewSummary, setReviewSummary] = useState<WorkspaceReviewSummary>()
  const workspaceKey = workspaceId || workspaceName || session.id
  const todos = useMemo(() => currentCursorTodos(entries, liveProcess), [entries, liveProcess])
  const activity = useMemo(() => projectActivity(entries, liveProcess, workspacePath), [entries, liveProcess, workspacePath])
  const artifacts = useMemo(() => projectArtifacts(entries, reviewSummary, workspacePath), [entries, reviewSummary, workspacePath])
  const turnPaths = useMemo(() => turnMutatedPaths(entries, liveProcess, workspacePath), [entries, liveProcess, workspacePath])
  // 「本轮」的逐次编辑差异：范围（本轮 / 保住的上一轮）跟着文件栏视图走，两处永远说同一批文件。
  const turnScope = turnFiles?.scope ?? 'turn'
  const turnEdits = useMemo(
    () => turnReviewEditsByPath(turnScope, entries, liveProcess, workspacePath),
    [entries, liveProcess, turnScope, workspacePath]
  )
  const onSummary = useCallback((summary: WorkspaceReviewSummary | undefined) => {
    setReviewSummary(summary)
    onReviewSummary?.(summary)
  }, [onReviewSummary])
  // 中栏文件栏的「审查」：切到变更标签（开右栏由 DesktopShell 处理，切范围与定位由 ReviewPanel 处理）。
  useEffect(() => subscribeReviewFocus(() => setActiveTab('review')), [])
  // 右栏收起时暂停变更摘要的轮询——除非本轮有改动过的文件：那时输入区上方的文件栏正在
  // 消费这份摘要的增删行数，它有可见的消费者，不能停在旧数字上。
  const reviewPaused = hidden && turnPaths.length === 0

  const liveActivity = Boolean(liveProcess?.generating || liveProcess?.blocks.some((block) => block.status === 'running'))
  const runningTodos = todos.items.some((todo) => todoTone(todo.status) === 'in_progress')
  const activityItems = activity.totals.files + activity.totals.commands + activity.totals.sources + activity.totals.tools
  const tabs: InspectorTabSpec[] = [
    { id: 'review', label: '变更', icon: <DiffIcon />, badge: reviewSummary?.state === 'ready' ? reviewSummary.files.length : turnFiles?.files.length || undefined, title: '审查改动：本轮看 Agent 编辑流，未提交 / 分支看 Git' },
    { id: 'plan', label: '计划', icon: <PlanIcon />, badge: todos.items.length || undefined, live: runningTodos, title: 'Cursor 原生任务清单' },
    { id: 'activity', label: '活动', icon: <ActivityIcon />, badge: activityItems || undefined, live: liveActivity, title: '本会话的文件、命令、来源与工具调用' },
    { id: 'artifacts', label: '产物', icon: <ArtifactIcon />, badge: artifacts.images.length + artifacts.files.length || undefined, title: '截图、图片与新增文件' }
  ]

  return (
    <InspectorShell tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} onClose={onClose}>
      <InspectorPanel tab="review">
        <ReviewPanel workspaceKey={workspaceKey} turnPaths={turnPaths} turnFiles={turnFiles} turnEdits={turnEdits} paused={reviewPaused} onQuote={onQuoteToComposer} onSummary={onSummary} />
      </InspectorPanel>
      <InspectorPanel tab="plan">
        <PlanPanel todos={todos} onOpenTab={setActiveTab} />
      </InspectorPanel>
      <InspectorPanel tab="activity">
        <ActivityPanel view={activity} onOpenTab={setActiveTab} />
      </InspectorPanel>
      <InspectorPanel tab="artifacts">
        <ArtifactsPanel view={artifacts} onOpenTab={setActiveTab} />
      </InspectorPanel>
    </InspectorShell>
  )
}
