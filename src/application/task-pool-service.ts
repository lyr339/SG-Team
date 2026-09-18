import { randomUUID } from 'node:crypto'
import { transactTaskPool, type TaskPoolRepository } from './task-pool-transaction'
import { sameTaskGroup, type PlanTaskInput, type TaskPoolAggregate, type TaskPoolSnapshot, type TaskPoolState, type TeamTask } from '../domain/task-pool'
import type { TeamRunStatus } from '../domain/team-control'

export interface ActiveTaskScope {
  workspaceId?: string
  runId?: string
  scopeRevision: number
}

export interface ActiveRunProvider {
  getActiveRunId(): string | undefined
  getActiveRunStatus?(): TeamRunStatus | undefined
  getActiveTaskScope?(): ActiveTaskScope
}

export interface CreateTaskInput {
  title: string
  description?: string
  acceptance?: string
  priority?: number
  maxAttempts?: number
  dependsOnTaskIds?: string[]
  requiredCapabilities?: string[]
  /** 目标协作组（会话池）：操作员为某个组创建任务；legacy 团队 run 留空。 */
  groupId?: string
}

type TaskPoolListener = (snapshot: TaskPoolSnapshot) => void

export class TaskPoolService {
  private listeners = new Set<TaskPoolListener>()
  private sweepTimer?: ReturnType<typeof setInterval>
  private watchTimer?: ReturnType<typeof setInterval>
  private lastEmittedRevision: number

  constructor(
    private readonly repository: TaskPoolRepository,
    private readonly runProvider: ActiveRunProvider,
    /**
     * 租约持有者是否仍在岗（阶段 2 · 2F，决策 D3=a）：清扫器据此续租而不是回收。
     * 不注入 = 按到期即回收（旧行为）；主进程在 `main/index.ts` 注入席位 presence 判定。
     */
    private readonly holderOnline?: (agentSessionId: string) => boolean
  ) {
    this.lastEmittedRevision = repository.load().revision
  }

  /** 全部写事务走这里：清扫与其余写入路径共用同一套在岗判定（阶段 2 · 2F）。 */
  private transact<Result>(operation: (pool: TaskPoolAggregate) => Result): Result {
    return transactTaskPool(this.repository, operation, { dependencies: { holderOnline: this.holderOnline } })
  }

  getSnapshot(): TaskPoolSnapshot {
    return this.snapshotForActiveRun(this.repository.load(), this.activeScope())
  }

  subscribe(listener: TaskPoolListener): () => void {
    this.listeners.add(listener)
    const snapshot = this.getSnapshot()
    this.lastEmittedRevision = snapshot.revision
    listener(snapshot)
    return () => this.listeners.delete(listener)
  }

  createTask(input: CreateTaskInput): TeamTask {
    const title = input.title.trim()
    if (!title) throw new Error('任务标题不能为空')
    if (title.length > 160) throw new Error('任务标题不能超过 160 个字符')
    const description = input.description?.trim() ?? ''
    const acceptance = input.acceptance?.trim() ?? ''
    if (description.length > 8_000) throw new Error('任务描述不能超过 8000 个字符')
    if (acceptance.length > 4_000) throw new Error('验收标准不能超过 4000 个字符')

    const runId = this.requireMutableRunId()
    const groupId = input.groupId?.trim() || undefined
    const rawState = this.repository.load()
    const dependencyKeys = [...new Set(input.dependsOnTaskIds ?? [])].map((taskId) => {
      const task = rawState.tasks[taskId]
      if (!task || task.runId !== runId) throw new Error('前置任务不属于当前 TeamRun')
      if (!sameTaskGroup(task.groupId, groupId)) throw new Error('前置任务不属于同一协作组')
      return task.key
    })
    const requiredCapabilities = [...new Set((input.requiredCapabilities ?? [])
      .map((value) => value.trim())
      .filter(Boolean))]
    if (requiredCapabilities.length > 32 || requiredCapabilities.some((value) => value.length > 80)) {
      throw new Error('任务能力配置超出限制')
    }

    const plan: PlanTaskInput = {
      key: `manual-${randomUUID()}`,
      title,
      description,
      acceptance,
      priority: input.priority,
      maxAttempts: input.maxAttempts,
      dependsOn: dependencyKeys,
      requiredCapabilities
    }
    const [task] = this.transact((pool) => pool.plan(runId, [plan], groupId))
    this.emit()
    return task!
  }

  /**
   * 操作员为某个协作组一次规划 1–30 条任务（阶段 2 · 2A，决策 D2）：与 `team_task plan` 走同一条聚合路径
   *（key 唯一、依赖同组、targetSlotId 快照），差别只在没有 Agent 身份——组归属与成员校验由 TeamGroupService 完成。
   */
  planTasks(groupId: string, inputs: PlanTaskInput[]): TeamTask[] {
    const normalizedGroupId = groupId.trim()
    if (!normalizedGroupId) throw new Error('groupId 不能为空')
    if (!inputs.length || inputs.length > 30) throw new Error('一次必须规划 1 到 30 条任务')
    const runId = this.requireMutableRunId()
    const tasks = this.transact((pool) => pool.plan(runId, inputs, normalizedGroupId))
    this.emit()
    return tasks
  }

  cancelTask(taskId: string, reason = '用户取消'): TeamTask {
    const normalizedTaskId = taskId.trim()
    if (!normalizedTaskId) throw new Error('taskId 不能为空')
    this.assertTaskInActiveRun(normalizedTaskId)
    const task = this.transact((pool) => pool.cancel(normalizedTaskId, reason))
    this.emit()
    return task
  }

  approveTask(taskId: string, reviewer = '用户'): TeamTask {
    const normalizedTaskId = taskId.trim()
    this.assertTaskInActiveRun(normalizedTaskId)
    const task = this.transact((pool) => pool.approve(normalizedTaskId, reviewer))
    this.emit()
    return task
  }

  rejectTask(taskId: string, reason: string, reviewer = '用户'): TeamTask {
    const normalizedTaskId = taskId.trim()
    this.assertTaskInActiveRun(normalizedTaskId)
    const task = this.transact((pool) => pool.reject(normalizedTaskId, reviewer, reason))
    this.emit()
    return task
  }

  closeRun(runId: string, reason = '本轮团队已经结束'): TeamTask[] {
    const normalizedRunId = runId.trim()
    if (!normalizedRunId) throw new Error('runId 不能为空')
    return this.cancelOpenTasks((task) => task.runId === normalizedRunId, reason)
  }

  /** 解散协作组：取消该组全部未完成任务（任务书 §7 规则 5）；消息与记忆由各自仓储保留只读。 */
  closeGroup(runId: string, groupId: string, reason = 'group_dissolved'): TeamTask[] {
    const normalizedRunId = runId.trim()
    const normalizedGroupId = groupId.trim()
    if (!normalizedRunId) throw new Error('runId 不能为空')
    if (!normalizedGroupId) throw new Error('groupId 不能为空')
    return this.cancelOpenTasks(
      (task) => task.runId === normalizedRunId && task.groupId === normalizedGroupId,
      reason
    )
  }

  /** 成员出组：释放其持有的任务租约与验收、清空定向给该席位的任务（任务书 §7 规则 1、3），返回受影响的任务 id。 */
  releaseAgentWork(input: { agentSessionId: string; slotId?: string; reason: string }): string[] {
    const released = this.transact((pool) => pool.releaseAgentWork(input))
    if (released.length) this.emit()
    return released
  }

  private cancelOpenTasks(matches: (task: TeamTask) => boolean, reason: string): TeamTask[] {
    const terminal = new Set(['done', 'failed', 'cancelled'])
    const state = this.repository.load()
    const taskIds = state.taskOrder.filter((taskId) => {
      const task = state.tasks[taskId]
      return task !== undefined && matches(task) && !terminal.has(task.status)
    })
    if (!taskIds.length) return []
    const cancelled = this.transact((pool) => taskIds.flatMap((taskId) => {
      const task = pool.snapshot().tasks[taskId]
      return task && !terminal.has(task.status) ? [pool.cancel(taskId, reason)] : []
    }))
    if (cancelled.length) this.emit()
    return cancelled
  }

  sweepExpiredLeases(): string[] {
    const reclaimed = this.transact((pool) => pool.reclaimExpired())
    this.pollExternalChanges()
    return reclaimed
  }

  transferAgentWork(input: {
    fromAgentSessionId: string
    toAgentSessionId: string
    slotId: string
    ttlMs?: number
  }): string[] {
    const transferred = this.transact((pool) => pool.transferAgentWork(input))
    this.emit()
    return transferred
  }

  recoverAgentWork(input: {
    fromAgentSessionId: string
    toAgentSessionId: string
    targetSlotId: string
    ttlMs?: number
  }): string[] {
    const recovered = this.transact((pool) => pool.recoverAgentWork(input))
    if (recovered.length) this.emit()
    return recovered
  }

  pollExternalChanges(): boolean {
    const revision = this.repository.load().revision
    if (revision === this.lastEmittedRevision) return false
    this.emit()
    return true
  }

  notifyRunChanged(): void {
    this.emit()
  }

  startSweeper(intervalMs = 5_000): void {
    this.stopSweeper()
    this.sweepTimer = setInterval(() => {
      try {
        this.sweepExpiredLeases()
      } catch (error) {
        process.stderr.write(`[task-pool] lease sweep failed: ${String(error)}\n`)
      }
    }, Math.max(1_000, intervalMs))
    this.sweepTimer.unref?.()
  }

  startWatcher(intervalMs = 1_000): void {
    this.stopWatcher()
    this.watchTimer = setInterval(() => {
      try {
        this.pollExternalChanges()
      } catch (error) {
        process.stderr.write(`[task-pool] revision watch failed: ${String(error)}\n`)
      }
    }, Math.max(250, intervalMs))
    this.watchTimer.unref?.()
  }

  stopSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  stopWatcher(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = undefined
  }

  private emit(snapshot = this.getSnapshot()): void {
    this.lastEmittedRevision = snapshot.revision
    for (const listener of this.listeners) listener(snapshot)
  }

  private requireActiveRunId(): string {
    const runId = this.runProvider.getActiveRunId()?.trim()
    if (!runId) throw new Error('请先在「运行」页创建会话池')
    return runId
  }

  private requireMutableRunId(): string {
    const runId = this.requireActiveRunId()
    if (this.runProvider.getActiveRunStatus?.() === 'completed') throw new Error('会话池已结束，请先创建新的批次')
    return runId
  }

  private assertTaskInActiveRun(taskId: string): void {
    const runId = this.requireMutableRunId()
    const task = this.repository.load().tasks[taskId]
    if (!task || task.runId !== runId) throw new Error('任务不属于当前 TeamRun')
  }

  private activeScope(): ActiveTaskScope {
    return this.runProvider.getActiveTaskScope?.() ?? {
      runId: this.runProvider.getActiveRunId(),
      scopeRevision: 0
    }
  }

  private snapshotForActiveRun(state: TaskPoolState, scope: ActiveTaskScope): TaskPoolSnapshot {
    const { runId } = scope
    const taskOrder = runId
      ? state.taskOrder.filter((taskId) => state.tasks[taskId]?.runId === runId)
      : []
    const taskIds = new Set(taskOrder)
    const tasks = Object.fromEntries(taskOrder.map((taskId) => [taskId, state.tasks[taskId]!]))
    const attempts = Object.fromEntries(
      Object.entries(state.attempts).filter(([, attempt]) => taskIds.has(attempt.taskId))
    )
    const events = state.events.filter((event) => taskIds.has(event.taskId))
    const reviews = Object.fromEntries(
      Object.entries(state.reviews).filter(([, review]) => taskIds.has(review.taskId))
    )
    const reviewOrder = state.reviewOrder.filter((reviewId) => Boolean(reviews[reviewId]))
    return structuredClone({
      ...state,
      workspaceId: scope.workspaceId,
      runId,
      scopeRevision: scope.scopeRevision,
      tasks,
      taskOrder,
      attempts,
      reviews,
      reviewOrder,
      events
    })
  }
}
