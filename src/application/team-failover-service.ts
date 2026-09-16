import type { TeamControlRepository } from './team-control-repository'
import type { TeamControlSnapshot } from '../domain/team-control'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { TeamContinuityService } from './team-continuity-service'
import type { TaskPoolService } from './task-pool-service'
import { TeamHandoffService } from './team-handoff-service'
import type { ManualTeamHandoffInput, ManualTeamHandoffResult, TeamHandoffOptions } from '../domain/team-handoff'

/** 活动 run 结束后取消其未完成任务时写入的原因（池由用户结束 / 被新池替换 / 升级归档）。 */
export const RUN_CLOSED_TASK_REASON = '会话池已结束，未完成任务自动取消'

interface TeamSource {
  getSnapshot(): TeamControlSnapshot
  subscribe(listener: (snapshot: TeamControlSnapshot) => void): () => void
}

export interface TeamFailoverServiceOptions {
  now?: () => number
  onerror?: (error: unknown) => void
}

/**
 * 运行收尾与手动交接的主进程入口。
 *
 * 阶段 2 · 2B 起每个 `running` run 都是会话池（legacy 团队 run 由 v9 迁移归档为 completed），池的生命周期只由
 * 用户的 endActiveRun / createSessionPool 决定。因此这里不再有「全员离线 → completeRun」、standby 自动接替、
 * lead 自动转移与接替回执核对——它们都以一次性团队 run 与 launching 状态机为前提。入组成员离线只在其协作组上
 * 表现为 attention（`TeamGroupView.attention`、`TeamCollaborationSweeper.sweepMemberAttention`），由用户决定移出 / 交接。
 *
 * 剩下两件事：
 * 1. 活动 run 变为 completed 后，把它的未完成任务取消一次（含重启后补做）；
 * 2. 手动交接的门面（`TeamHandoffService`）——阶段 2 · 2C 改为组成员身份迁移。
 */
export class TeamFailoverService {
  private readonly onerror: (error: unknown) => void
  private readonly closedRuns = new Set<string>()
  private readonly handoffs: TeamHandoffService
  private unsubscribe?: () => void

  constructor(
    repository: TeamControlRepository,
    private readonly team: TeamSource,
    private readonly tasks: TaskPoolService,
    collaboration: TeamCollaborationRepository,
    continuity: TeamContinuityService,
    options: TeamFailoverServiceOptions = {}
  ) {
    this.onerror = options.onerror ?? (() => undefined)
    this.handoffs = new TeamHandoffService(
      repository,
      team,
      tasks,
      collaboration,
      continuity,
      options.now ?? Date.now
    )
  }

  manualHandoffOptions(slotId: string): TeamHandoffOptions {
    return this.handoffs.options(slotId)
  }

  manualHandoff(input: ManualTeamHandoffInput): ManualTeamHandoffResult {
    return this.handoffs.manual(input)
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
