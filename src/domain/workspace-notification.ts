import type { NotificationDraft } from './notification'
import type { CursorWorkspaceDetection } from './cursor-workspace'
export interface WorkspaceNotificationInput {
  key: string
  detected?: { id: string; name: string }
  cause: CursorWorkspaceDetection['cause']
  persistent: boolean
  observedAt: number
}
export interface WorkspaceNotificationState {
  version: 1
  key: string
  transition: number
  last?: { id: string; name: string }
  issue?: { id: number; cause: CursorWorkspaceDetection['cause']; active: boolean }
}
const reasons: Record<NonNullable<CursorWorkspaceDetection['cause']>, string> = {
  'no-window': '原探测未发现 Cursor IDE 窗口。',
  'multiple-windows': '原探测发现多个 IDE 窗口，尚不能选择唯一工作区。',
  'no-folder': '原探测确认 Cursor 没有打开本地工作区。',
  remote: '原探测发现远程工作区，当前只识别本机文件夹。',
  'multi-root': '原探测发现多根工作区，当前只识别本机文件夹。',
  unconfirmed: '原探测未能确认工作区身份。',
  'connection-unavailable': '原探测的调试连接尚不可用。'
}
export function readWorkspaceNotificationState(value: unknown, key: string): WorkspaceNotificationState | undefined {
  if (value === undefined) return undefined
  const state = value as WorkspaceNotificationState
  if (
    !state ||
    state.version !== 1 ||
    state.key !== key ||
    !Number.isSafeInteger(state.transition) ||
    state.transition < 0 ||
    (state.last &&
      (typeof state.last.id !== 'string' ||
        !state.last.id ||
        state.last.id.length > 300 ||
        typeof state.last.name !== 'string' ||
        state.last.name.length > 80)) ||
    (state.issue &&
      (!Number.isSafeInteger(state.issue.id) ||
        state.issue.id < 1 ||
        typeof state.issue.active !== 'boolean' ||
        (state.issue.cause !== undefined && !Object.hasOwn(reasons, state.issue.cause))))
  )
    throw Error('工作区通知检查点无效，原数据保留')
  return state
}
export function reduceWorkspaceNotifications(
  previous: WorkspaceNotificationState | undefined,
  input: WorkspaceNotificationInput,
  baseline: boolean,
  revision: number
): { state: WorkspaceNotificationState; drafts: NotificationDraft[] } {
  const state: WorkspaceNotificationState = structuredClone(previous ?? { version: 1, key: input.key, transition: 0 }),
    drafts: NotificationDraft[] = []
  const base = {
    category: 'maintenance' as const,
    source: 'Cursor 工作区',
    scope: {},
    target: { kind: 'run' as const },
    origin: { module: 'run' as const },
    occurredAt: input.observedAt,
    timeBasis: 'observed' as const,
    sourceRevision: revision
  }
  if (input.detected) {
    if (state.last?.id !== input.detected.id) {
      ++state.transition
      drafts.push({
        ...base,
        key: `workspace-observation:${state.transition}`,
        eventType: 'workspace.observed',
        eventId: `workspace-observation:${state.transition}`,
        subjectState: 'detected',
        title: state.last ? '识别到的 Cursor 工作区已变化' : 'Cursor 当前工作区已识别',
        detail: `当前识别为「${input.detected.name}」。这是 IDE 工作区身份，不表示旧会话已结束；拾光运行范围没有被通知切换。`,
        tone: 'info',
        attention: 'activity',
        state: 'resolved',
        announce: false
      })
    }
    if (state.issue?.active) {
      const issue = state.issue
      issue.active = false
      drafts.push({
        ...base,
        key: `workspace-issue:${issue.id}`,
        eventType: 'workspace.confirmation',
        eventId: `workspace-issue:${issue.id}:confirmed`,
        subjectState: 'confirmed',
        title: 'Cursor 工作区已重新确认',
        detail: `当前已确认「${input.detected.name}」。原问题为：${reasons[issue.cause ?? 'unconfirmed']}\n这不是会话恢复或批量创建成功的证明。`,
        tone: 'info',
        attention: 'notice',
        state: 'resolved',
        announce: false,
        renewAttention: false,
        respectCleared: true
      })
    }
    state.last = input.detected
  } else if (input.persistent && state.last) {
    const issue = state.issue?.active ? state.issue : { id: (state.issue?.id ?? 0) + 1, cause: input.cause, active: true }
    issue.cause = input.cause
    state.issue = issue
    drafts.push({
      ...base,
      key: `workspace-issue:${issue.id}`,
      eventType: 'workspace.confirmation',
      eventId: `workspace-issue:${issue.id}:unconfirmed`,
      subjectState: 'unconfirmed',
      title: '当前 Cursor 工作区尚未确认',
      detail: `${reasons[input.cause ?? 'unconfirmed']}\n上次识别为「${state.last.name}」，不会继续宣称它就是当前工作区；原运行和会话状态仍由原功能确认。`,
      tone: 'warning',
      attention: 'notice',
      state: 'active',
      announce: false,
      renewAttention: false,
      respectCleared: Boolean(previous?.issue?.active)
    })
  }
  return { state, drafts }
}
