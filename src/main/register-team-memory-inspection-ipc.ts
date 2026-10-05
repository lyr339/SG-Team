import { ipcMain, type BrowserWindow } from 'electron'
import type { TeamMemoryService } from '../application/team-memory-service'
import type { TeamControlSnapshot } from '../domain/team-control'
import type {
  TeamMemoryInspectionRequest,
  TeamMemoryInspection,
  TeamMemoryReviewRequest,
  TeamMemoryReviewResult
} from '../domain/team-memory-inspection'
import type { MemoryOperatorReviewProof } from '../domain/memory-operator-review'
import { IPC } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'
import {
  beginPageOperation,
  failPageOperation,
  finishPageOperation,
  notificationOperationId,
  type PageOperationObserver
} from '../application/notifications/page-operation-notifications'
function requestOf(value: unknown): TeamMemoryInspectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('记忆查看参数无效')
  const raw = value as Record<string, unknown>
  for (const key of ['workspaceId', 'runId', 'memoryId'])
    if (typeof raw[key] !== 'string' || !(raw[key] as string).trim() || (raw[key] as string).length > 300)
      throw Error('记忆查看身份无效')
  if (
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 1 ||
    (raw.groupId !== undefined &&
      (typeof raw.groupId !== 'string' || !raw.groupId || raw.groupId.length > 300))
  )
    throw Error('记忆查看范围无效')
  return {
    workspaceId: raw.workspaceId as string,
    runId: raw.runId as string,
    memoryId: raw.memoryId as string,
    version: raw.version as number,
    ...(raw.groupId ? { groupId: raw.groupId as string } : {})
  }
}
function reviewOf(value: unknown): TeamMemoryReviewRequest {
  const ref = requestOf(value),
    raw = value as Record<string, unknown>
  if ((raw.decision !== 'accept' && raw.decision !== 'reject') || raw.confirmed !== true)
    throw Error('原记忆审核需要明确确认')
  if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > 4000))
    throw Error('审核附言最多 4000 字')
  return {
    ...ref,
    decision: raw.decision as 'accept' | 'reject',
    confirmed: true,
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
    ...(notificationOperationId(value) ? { notificationId: notificationOperationId(value) } : {})
  }
}
/** Viewing stays read-only. Reviewing is a separate original-service command with an explicit current-scope confirmation, never a saved notification action. */
export function registerTeamMemoryInspectionIpc(
  memory: Pick<TeamMemoryService, 'getSnapshot'> & Partial<Pick<TeamMemoryService, 'review'>>,
  getTeam: () => TeamControlSnapshot,
  getWindow: () => BrowserWindow | undefined,
  options: {
    operatorReviewProof?: (request: TeamMemoryInspectionRequest) => MemoryOperatorReviewProof | undefined
    operations?: PageOperationObserver
  } = {}
): () => void {
  const currentScope = (request: TeamMemoryInspectionRequest, write = false): TeamControlSnapshot => {
    const team = getTeam()
    if (
      team.activeWorkspaceId !== request.workspaceId ||
      team.activeRun?.id !== request.runId ||
      team.activeRun.workspaceId !== request.workspaceId ||
      (request.groupId &&
        !team.groups.some((view) => view.group.id === request.groupId && view.group.runId === request.runId))
    )
      throw Error('记忆原运行范围已变化，原通知仍可查看')
    if (
      write &&
      (team.activeRun.status !== 'running' ||
        (request.groupId &&
          !team.groups.some((view) => view.group.id === request.groupId && view.group.status === 'active')))
    )
      throw Error('原运行或协作组已结束，只能查看原记忆')
    return team
  }
  const inspect = (request: TeamMemoryInspectionRequest): TeamMemoryInspection => {
    const team = currentScope(request),
      snapshot = memory.getSnapshot(),
      item = snapshot.items[request.memoryId]
    if (
      snapshot.workspaceId !== request.workspaceId ||
      snapshot.runId !== request.runId ||
      !item ||
      item.workspaceId !== request.workspaceId ||
      item.runId !== request.runId ||
      item.version !== request.version ||
      item.groupId !== request.groupId
    )
      throw Error('这项原记忆已不在当前查看范围')
    let operatorReview: MemoryOperatorReviewProof | undefined
    try {
      if (item.status === 'proposed') operatorReview = options.operatorReviewProof?.(request)
    } catch {}
    return {
      item,
      ...(item.supersedesId && snapshot.items[item.supersedesId]
        ? { predecessor: snapshot.items[item.supersedesId] }
        : {}),
      revision: snapshot.revision,
      observedAt: Date.now(),
      ...(operatorReview ? { operatorReview } : {}),
      canReview: Boolean(
        memory.review &&
          item.status === 'proposed' &&
          team.activeRun?.status === 'running' &&
          (!request.groupId ||
            team.groups.some((view) => view.group.id === request.groupId && view.group.status === 'active'))
      )
    }
  }
  ipcMain.handle(IPC.teamMemoryInspect, (event, input) => {
    assertTrustedSender(event, getWindow)
    return inspect(requestOf(input))
  })
  ipcMain.handle(IPC.teamMemoryReview, (event, input): TeamMemoryReviewResult => {
    assertTrustedSender(event, getWindow)
    const request = reviewOf(input)
    currentScope(request, true)
    if (!memory.review) throw Error('原记忆审核入口未装配')
    inspect(request) // Exact object/version, not a channel or a historical target.
    const operation = beginPageOperation(options.operations, {
      kind: request.decision === 'accept' ? 'memory-accept' : 'memory-reject',
      id: request.notificationId,
      scope: {
        workspaceId: request.workspaceId,
        runId: request.runId,
        ...(request.groupId ? { groupId: request.groupId } : {}),
        memoryId: request.memoryId,
        memoryVersion: String(request.version)
      },
      target: {
        kind: 'memory',
        workspaceId: request.workspaceId,
        runId: request.runId,
        ...(request.groupId ? { groupId: request.groupId } : {}),
        memoryId: request.memoryId,
        version: request.version
      },
      origin: { module: 'run' }
    })
    try {
      const item = memory.review(request.memoryId, request.decision, request.note, request.version, {
        workspaceId: request.workspaceId,
        runId: request.runId,
        ...(request.groupId ? { groupId: request.groupId } : {})
      })
      const expected = request.decision === 'accept' ? 'accepted' : 'rejected'
      let inspection: TeamMemoryInspection,
        inspectionPending = false
      try {
        inspection = inspect(request)
      } catch {
        inspectionPending = true
        inspection = {
          item,
          canReview: false,
          observedAt: Date.now(),
          revision: 0
        }
      }
      const notification = finishPageOperation(operation, {
        state: item.status !== expected ? 'unconfirmed' : inspectionPending ? 'partial' : 'success',
        facts: [
          item.status === expected ? '原审核服务已返回确认结论。' : '原服务没有返回预期确认结论。',
          ...(inspectionPending ? ['审核结论已知，但原记录刷新待核对；不重做审核。'] : []),
          '原附言、正文、凭据和引用没有复制到通知。'
        ]
      })
      return {
        inspection,
        ...(item.status === expected ? { conclusion: expected } : {}),
        ...(inspectionPending ? { inspectionPending: true } : {}),
        ...(notification ? { notification } : {})
      }
    } catch (error) {
      failPageOperation(operation, error)
      throw error
    }
  })
  return () => {
    ipcMain.removeHandler(IPC.teamMemoryInspect)
    ipcMain.removeHandler(IPC.teamMemoryReview)
  }
}
