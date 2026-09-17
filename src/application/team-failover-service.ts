import type { TeamControlSnapshot } from '../domain/team-control'
import type { TaskPoolService } from './task-pool-service'

/** 活动 run 结束后取消其未完成任务时写入的原因（池由用户结束 / 被新池替换 / 升级归档）。 */
export const RUN_CLOSED_TASK_REASON = '会话池已结束，未完成任务自动取消'

interface TeamSource {
  getSnapshot(): TeamControlSnapshot
  subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void
}

export interface TeamFailoverServiceOptions {
  onerror?: (error: unknown) => void
}

/**
 * 运行收尾的主进程兜底。
 *
 * 阶段 2 · 2B 起每个 `running` run 都是会话池（legacy 团队 run 由 v9 迁移归档为 completed），池的生命周期只由
 * 用户的 endActiveRun / createSessionPool 决定。因此这里不再有「全员离线 → completeRun」、standby 自动接替、
 * lead 自动转移与接替回执核对——它们都以一次性团队 run 与 launching 状态机为前提。入组成员离线只在其协作组上
 * 表现为 attention（`TeamGroupView.attention`、`TeamCollaborationSweeper.sweepMemberAttention`），由用户决定
 * 移出 / 成员身份迁移（`TeamGroupService.transferMembership`，阶段 2 · 2C）。
 *
 * 剩下一件事：活动 run 变为 completed 后，把它的未完成任务取消一次（含重启后补做）。
 */
export class TeamFailoverService {
  private readonly onerror: (error: unknown) => void
  private readonly closedRuns = new Set<string>()
  private unsubscribe?: () => void

  constructor(
    private readonly team: TeamSource,
    private readonly tasks: TaskPoolService,
    options: TeamFailoverServiceOptions = {}
  ) {
    this.onerror = options.onerror ?? (() => undefined)
  }

  /** 订阅团队快照（订阅即回放当前快照，所以启动时残留的已结束 run 会被立刻收尾）。 */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.team.subscribe((snapshot) => this.reconcile(snapshot))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.closedRuns.clear()
  }

  reconcile(snapshot: TeamControlSnapshot = this.team.getSnapshot()): void {
    try {
      const run = snapshot.activeRun
      if (run?.status !== 'completed' || this.closedRuns.has(run.id)) return
      this.tasks.closeRun(run.id, RUN_CLOSED_TASK_REASON)
      this.closedRuns.add(run.id)
    } catch (error) {
      this.onerror(error)
    }
  }
}
