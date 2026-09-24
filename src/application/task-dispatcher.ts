import type { TaskPoolSnapshot, TaskReview, TeamTask } from '../domain/task-pool'
import type { TeamControlSnapshot, TeamMemberView } from '../domain/team-control'
import { groupScopedLead, groupScopedMembers, selectTaskReviewMember } from '../domain/team-orchestration'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import { orchestratorMessageId, type OrchestrationSource } from './orchestration-source'

/** 终态通知正文里交付 / 失败摘要的长度上限：lead 只需要知道结论，全文在任务详情里。 */
const OUTCOME_SUMMARY_MAX_LENGTH = 1_200

function runnable(task: TeamTask, pool: TaskPoolSnapshot): boolean {
  return task.status === 'queued' && task.dependsOn.every((id) => pool.tasks[id]?.status === 'done')
}

function activeAgentSessions(pool: TaskPoolSnapshot): Set<string> {
  return new Set(pool.taskOrder.flatMap((id) => {
    const task = pool.tasks[id]
    return task && ['leased', 'running'].includes(task.status) && task.assigneeSessionId
      ? [task.assigneeSessionId]
      : []
  }))
}

export function executionMember(task: TeamTask, team: TeamControlSnapshot, pool: TaskPoolSnapshot): TeamMemberView | undefined {
  const busySessions = activeAgentSessions(pool)
  // 候选限定任务所属组（任务书 §5.5）：跨组不分派；legacy 团队 run 仍是全体非 solo 成员。
  const eligible = groupScopedMembers(team, task.groupId)
    .filter((member) => !task.targetSlotId || member.slot.id === task.targetSlotId)
    .filter((member) => task.requiredCapabilities.every((capability) => member.role.capabilities.includes(capability)))
    .filter((member) => !member.binding || !busySessions.has(member.binding.agentSessionId))
    .sort((left, right) => {
      const roleRank = (member: TeamMemberView): number => {
        if (['builder', 'backend', 'frontend', 'specialist'].includes(member.role.templateKey)) return 0
        if (member.role.templateKey === 'lead') return 1
        return 2
      }
      const runtimeRank = (member: TeamMemberView): number => member.runtime?.online && member.runtime.waiting ? 0 : 1
      return runtimeRank(left) - runtimeRank(right)
        || roleRank(left) - roleRank(right)
        || left.role.order - right.role.order
    })
  return eligible[0]
}

/**
 * 任务派单器：把可执行任务派给组内成员、把待验收任务派给组内质量角色，并在任务到达终态
 *（done / failed）时通知该组有效 lead——阶段 2 · 2A（决策 D1）之后 lead 只收这三类系统 notice
 *（第三类「成员 attention」由 TeamCollaborationSweeper 发）；分派、催办、派验收全部由桌面编排器完成。
 */
export class TaskDispatcher {
  private unsubscribers: Array<() => void> = []
  private reconciling = false
  /**
   * 已通知过的终态键 `taskId:status:attemptCount`。终态任务在池 run 的生命周期里只增不减，
   * 不能像派单那样每 tick 都去仓储查重；内存集合挡住重复查询，仓储的 clientMessageId 幂等挡住进程重启后的重复投递。
   */
  private readonly outcomeNotified = new Set<string>()

  constructor(
    private readonly tasks: OrchestrationSource<TaskPoolSnapshot>,
    private readonly team: OrchestrationSource<TeamControlSnapshot>,
    private readonly collaboration: TeamCollaborationRepository,
    private readonly onerror: (error: unknown) => void = () => undefined
  ) {}

  start(): void {
    if (this.unsubscribers.length) return
    this.unsubscribers = [
      this.tasks.subscribe(() => this.reconcile()),
      this.team.subscribe(() => this.reconcile())
    ]
    this.reconcile()
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
  }

  reconcile(): void {
    if (this.reconciling) return
    this.reconciling = true
    try {
      const team = this.team.getSnapshot()
      const run = team.activeRun
      if (!run || !['running', 'attention'].includes(run.status)) return
      const runId = run.id
      const pool = this.tasks.getSnapshot()
      if (pool.runId && pool.runId !== runId) return

      for (const taskId of pool.taskOrder) {
        const task = pool.tasks[taskId]
        if (!task || task.runId !== runId) continue
        try {
          if (runnable(task, pool)) this.dispatchExecution(task, team, pool)
          if (task.status === 'review' && task.currentReviewId) {
            const review = pool.reviews[task.currentReviewId]
            if (review?.status === 'queued') this.dispatchReview(task, review, team, pool)
          }
          if (task.status === 'done' || task.status === 'failed') this.notifyOutcome(task, team, pool)
        } catch (error) {
          this.onerror(error)
        }
      }
    } finally {
      this.reconciling = false
    }
  }

  /**
   * 任务终态 → 组内有效 lead 一条 notice：done 附交付摘要，failed（重试已用尽）附失败原因与下一步选项。
   * cancelled 不通知（那是用户 / 成员关系变化的结果，用户自己知道）。无 lead 组没有接收者，静默。
   */
  private notifyOutcome(task: TeamTask, team: TeamControlSnapshot, pool: TaskPoolSnapshot): void {
    const key = `${task.id}:${task.status}:${task.attemptCount}`
    if (this.outcomeNotified.has(key)) return
    const lead = groupScopedLead(team, task.groupId)
    if (!lead) return
    const attempt = task.currentAttemptId ? pool.attempts[task.currentAttemptId] : undefined
    const summary = (value: string | undefined): string => (value ?? '').trim().slice(0, OUTCOME_SUMMARY_MAX_LENGTH)
    const done = task.status === 'done'
    this.collaboration.createMessage({
      runId: task.runId,
      sender: { type: 'operator' },
      recipient: { type: 'agent', slotId: lead.slot.id },
      kind: 'notice',
      subject: done ? `任务完成：${task.title}` : `任务失败：${task.title}`,
      content: [
        done ? '【任务完成】' : '【任务失败】',
        `任务 ID：${task.id}`,
        `标题：${task.title}`,
        done
          ? `已通过独立验收（第 ${task.attemptCount} 次执行）。`
          : `第 ${task.attemptCount} 次执行失败，已用尽 ${task.maxAttempts} 次重试，不会再自动重派。`,
        done
          ? summary(task.result ?? attempt?.output) ? `交付摘要：${summary(task.result ?? attempt?.output)}` : ''
          : `失败原因：${summary(task.failureReason ?? attempt?.error) || '未提供'}`,
        done
          ? '依赖它的任务已可分派，系统会自动派单；只在这改变了对用户的结论时，才用 record_reply 向用户同步一句。'
          : '请决定下一步：需要换一种拆法时用 team_task({action:\'plan\', tasks:[...]}) 重新规划；无法自行推进时向用户说明一次。'
      ].filter(Boolean).join('\n'),
      clientMessageId: orchestratorMessageId('task-outcome', task.id, task.status, task.attemptCount)
    })
    this.outcomeNotified.add(key)
  }

  private dispatchExecution(task: TeamTask, team: TeamControlSnapshot, pool: TaskPoolSnapshot): void {
    const member = executionMember(task, team, pool)
    if (!member) return
    const retry = task.attemptCount > 0
    this.collaboration.createMessage({
      runId: task.runId,
      sender: { type: 'operator' },
      recipient: { type: 'agent', slotId: member.slot.id },
      kind: 'directive',
      subject: retry ? `任务重新分配：${task.title}` : `新任务：${task.title}`,
      content: [
        '【系统任务调度】',
        `任务 ID：${task.id}`,
        `标题：${task.title}`,
        task.description ? `目标与边界：${task.description}` : '',
        task.acceptance ? `验收标准：${task.acceptance}` : '',
        retry && task.failureReason ? `上次未通过原因：${task.failureReason}` : '',
        `直接调用 team_task({ action: "claim", taskId: "${task.id}" }) 原子领取（需要依赖、当前 Attempt 等完整详情时再 team_tasks({ taskId: "${task.id}" })）。`,
        '领取后开始执行；领取、进度、提交会随 team_task 动作自动上报，不需要另发团队消息。'
      ].filter(Boolean).join('\n'),
      clientMessageId: orchestratorMessageId('task', task.id, task.attemptCount)
    })
  }

  private dispatchReview(
    task: TeamTask,
    review: TaskReview,
    team: TeamControlSnapshot,
    pool: TaskPoolSnapshot
  ): void {
    const member = selectTaskReviewMember(review, team, pool)
    if (!member) return
    const attempt = pool.attempts[review.attemptId]
    this.collaboration.createMessage({
      runId: task.runId,
      sender: { type: 'operator' },
      recipient: { type: 'agent', slotId: member.slot.id },
      kind: 'directive',
      subject: `独立验收：${task.title}`,
      content: [
        '【系统独立验收调度】',
        `任务 ID：${task.id}`,
        `验收记录：${review.id}`,
        `验收标准：${task.acceptance || '按任务目标与交付证据独立验证'}`,
        attempt?.output ? `实现方交付摘要：${attempt.output.slice(0, 4_000)}` : '',
        '请调用 team_review({action:\'claim\'}) 领取，独立复现并检查失败路径；随后用 team_review({action:\'submit\', decision, evidence, reason}) 提交证据与通过/打回结论。',
        '禁止复述实现方结论，禁止让实现者自审。'
      ].filter(Boolean).join('\n'),
      clientMessageId: orchestratorMessageId('review', review.id, review.leaseCount)
    })
  }
}
