import { createHash } from 'node:crypto'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import { isSessionPoolRun, type TeamControlSnapshot } from '../domain/team-control'
import {
  DEFAULT_UNANSWERED_TTL_MS,
  UNANSWERED_ALERT_DEBOUNCE_MS,
  findUnansweredDirectives,
  leadSilenceEvidence
} from '../domain/team-collab-sweeps'
import { groupScopedLead } from '../domain/team-orchestration'

export interface TeamCollaborationSweeperOptions {
  unansweredTtlMs?: number
  now?: () => number
}

/**
 * 协作域挂死清扫器：对照 task-pool 的租约清扫模式，补齐消息与主控心跳两类
 * 挂死形态。原则与 P0 未待命修复一致——只提醒、不越权改消息状态。
 *
 * 主控提醒只接受 TeamControlSnapshot 的正面终止证据；被动心跳静默、
 * online=false 与 ping no-pong 都只属于 suspected，不会诱导其他 Agent 接管。
 */
export class TeamCollaborationSweeper {
  private sweepTimer?: ReturnType<typeof setInterval>
  /** messageId → 上次提醒时间：同一条消息在防抖窗内只提醒一次。 */
  private readonly unansweredAlertedAt = new Map<string, number>()
  /** 作用域（run 或组）→ 主控终止周期键；已广播过的周期不重复，明确恢复后键变更自动复位。 */
  private readonly leadAlertedCycle = new Map<string, string>()

  constructor(
    private readonly collaboration: TeamCollaborationRepository,
    private readonly controlSnapshot: () => TeamControlSnapshot,
    private readonly options: TeamCollaborationSweeperOptions = {}
  ) {}

  startSweeper(intervalMs = 30_000): void {
    this.stopSweeper()
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep()
      } catch (error) {
        process.stderr.write(`[team-collab] sweep failed: ${String(error)}\n`)
      }
    }, Math.max(1_000, intervalMs))
    this.sweepTimer.unref?.()
  }

  stopSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  /** 执行一轮全部子清扫，返回本轮发出的提醒条数（便于测试与审计）。 */
  sweep(): number {
    const now = this.options.now?.() ?? Date.now()
    const control = this.controlSnapshot()
    const run = control.activeRun
    if (!run || !['launching', 'running', 'attention'].includes(run.status)) {
      this.leadAlertedCycle.clear()
      return 0
    }
    const runId = run.id
    // 作用域：legacy 团队 run 只有一个 run 级作用域；会话池按活动协作组逐组清扫（任务书 §5.5）。
    const scopes: Array<string | undefined> = isSessionPoolRun(run)
      ? control.groups.filter((view) => view.group.status === 'active').map((view) => view.group.id)
      : [undefined]
    for (const key of [...this.leadAlertedCycle.keys()]) {
      if (!scopes.some((scope) => (scope ?? 'run') === key)) this.leadAlertedCycle.delete(key)
    }
    return this.sweepUnanswered(control, runId, now)
      + scopes.reduce((sent, groupId) => sent + this.sweepLeadHeartbeat(control, runId, groupId, now), 0)
  }

  /** 超龄未获回应的 directive/question：向原发送者回执超时提醒，并通知该消息所属组的有效主控（幂等）。 */
  private sweepUnanswered(control: TeamControlSnapshot, runId: string, now: number): number {
    const snapshot = this.collaboration.loadRun(runId)
    const existingClientIds = new Set(
      snapshot.messageOrder.map((id) => snapshot.messages[id]?.clientMessageId).filter(Boolean)
    )
    const ttlMs = this.options.unansweredTtlMs ?? DEFAULT_UNANSWERED_TTL_MS
    const stale = findUnansweredDirectives(snapshot, now, ttlMs)
    let sent = 0
    for (const item of stale) {
      const lastAlerted = this.unansweredAlertedAt.get(item.id)
      if (lastAlerted !== undefined && now - lastAlerted < UNANSWERED_ALERT_DEBOUNCE_MS) continue
      const leadSlotId = groupScopedLead(control, snapshot.messages[item.id]?.groupId)?.slot.id
      const minutes = Math.round(item.ageMs / 60_000)
      const debounceBucket = Math.floor(now / UNANSWERED_ALERT_DEBOUNCE_MS)
      // 不用 replyToMessageId：仓储要求回复双方与原消息严格对应，而提醒是系统
      // 身份发出的独立通告；正文里引用原消息 id 保持可追溯。
      // 发送者是 operator（控制台）时跳过回执——operator→operator 自回环会被仓储拒绝，
      // 且控制台 UI 已有回执阶段展示；此类消息只通知主控。
      if (item.sender.type === 'agent') {
        const senderKey = `sweeper:unanswered:${item.id}:${debounceBucket}`
        // 持久幂等：内存防抖在进程重启后失效，以快照 clientMessageId 查重兜底。
        if (!existingClientIds.has(senderKey)) {
          this.collaboration.createMessage({
            runId,
            sender: { type: 'operator' },
            recipient: item.sender,
            kind: 'notice',
            content: `【清扫提醒】你发出的${item.kind === 'directive' ? '指令' : '问题'}（${item.id}）已 ${minutes} 分钟未获回应：` +
              `「${item.contentPreview}」。若接收方已掉线，请转交代理主控或改派；若已无需处理，请回执说明。`,
            clientMessageId: senderKey,
            threadId: item.threadId
          })
          existingClientIds.add(senderKey)
          sent += 1
        }
      }
      // 同步通知有效主控（发送者本人即主控时不重复）；只提醒，不改动原消息状态。
      if (leadSlotId && !(item.sender.type === 'agent' && item.sender.slotId === leadSlotId)) {
        const leadKey = `sweeper:unanswered:${item.id}:lead:${debounceBucket}`
        if (!existingClientIds.has(leadKey)) {
          this.collaboration.createMessage({
            runId,
            sender: { type: 'operator' },
            recipient: { type: 'agent', slotId: leadSlotId },
            kind: 'notice',
            content: `【清扫提醒】成员发出的${item.kind === 'directive' ? '指令' : '问题'}（${item.id}）已 ${minutes} 分钟未获回应：` +
              `「${item.contentPreview}」。请主控介入协调（催促/改派/确认接收方活性）；本提醒不改动原消息状态。`,
            clientMessageId: leadKey,
            threadId: item.threadId
          })
          existingClientIds.add(leadKey)
          sent += 1
        }
      }
      this.unansweredAlertedAt.set(item.id, now)
    }
    return sent
  }

  /**
   * 有效主控失联：幂等广播一次「可 team_run claim_lead 接管」的提醒，恢复后自动复位。
   * 会话池内按组：主控 = 组的有效 lead，接收者 = 该组其他成员；legacy 团队 run 为 run 级。
   */
  private sweepLeadHeartbeat(snapshot: TeamControlSnapshot, runId: string, groupId: string | undefined, now: number): number {
    const scopeKey = groupId ?? 'run'
    const member = groupScopedLead(snapshot, groupId)
    if (!member) {
      this.leadAlertedCycle.delete(scopeKey)
      return 0
    }
    const leadSlotId = member.slot.id
    const channelId = member.binding?.channelId ?? member.slot.channelId
    const liveness = channelId ? this.collaboration.getLiveness(channelId, runId) : undefined
    const evidence = leadSilenceEvidence({
      runtime: member.runtime
        ? {
            online: member.runtime.online,
            status: member.runtime.status,
            connectionPhase: member.runtime.connectionPhase,
            runtimeEvidence: member.runtime.runtimeEvidence,
            lastSeenAt: member.runtime.lastSeenAt,
            lastAgentActivityAt: member.runtime.lastAgentActivityAt
          }
        : undefined,
      liveness,
      installedAt: member.binding?.installedAt,
      now
    })
    if (!evidence) {
      this.leadAlertedCycle.delete(scopeKey)
      return 0
    }
    // 周期键纳入心跳起点：主控活性恢复（lastSeenAt 刷新/online 翻正）后自动复位，可再次报警。
    const cycleKey = `${leadSlotId}:${member.runtime?.lastSeenAt ?? 0}:${member.runtime?.lastAgentActivityAt ?? 0}:${member.runtime?.connectionPhase ?? ''}:${member.runtime?.online ?? false}:${liveness?.liveness ?? 'unknown'}`
    if (this.leadAlertedCycle.get(scopeKey) === cycleKey) return 0
    const members = this.collaboration.listRunMembers(runId, groupId)
      .filter((member) => member.channelId && member.slotId !== leadSlotId)
    if (!members.length) return 0
    // clientMessageId 上限 200：cycleKey 含长 slotId，压成短哈希保证持久幂等键合法。
    const cycleHash = createHash('sha1').update(cycleKey).digest('hex').slice(0, 12)
    const collabSnapshot = this.collaboration.loadRun(runId)
    const existingClientIds = new Set(
      collabSnapshot.messageOrder.map((id) => collabSnapshot.messages[id]?.clientMessageId).filter(Boolean)
    )
    let sent = 0
    for (const member of members) {
      const alertKey = `sweeper:lead-silent:${cycleHash}:${member.roleKey}`
      if (existingClientIds.has(alertKey)) continue
      this.collaboration.createMessage({
        runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: member.slotId },
        kind: 'notice',
        content: `【主控失联提醒】有效主控心跳异常：${evidence}。` +
          '若确认其已掉线，任何已绑定成员可调用 team_run({action:\'claim_lead\'}) 自荐接管临时主控；' +
          '原主控恢复后可经 team_run 的 transfer_lead / clear_acting_lead 复位。',
        clientMessageId: alertKey
      })
      existingClientIds.add(alertKey)
      sent += 1
    }
    this.leadAlertedCycle.set(scopeKey, cycleKey)
    return sent
  }
}
