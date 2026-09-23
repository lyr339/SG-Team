import { createHash } from 'node:crypto'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import { hasConfirmedRuntimeStop } from '../domain/channel-message'
import { isSessionPoolRun, type TeamControlSnapshot, type TeamGroupView, type TeamMemberView } from '../domain/team-control'
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
 * 协作域挂死清扫器：对照 task-pool 的租约清扫模式，补齐消息、主控心跳与成员离线三类
 * 挂死形态。原则与 P0 未待命修复一致——只提醒、不越权改消息状态。
 *
 * 主控提醒与成员 attention 都只接受 TeamControlSnapshot 的正面终止证据；被动心跳静默
 * 与 online=false 都只属于 suspected，不会诱导其他 Agent 接管。
 */
export class TeamCollaborationSweeper {
  private sweepTimer?: ReturnType<typeof setInterval>
  /** messageId → 上次提醒时间：同一条消息在防抖窗内只提醒一次。 */
  private readonly unansweredAlertedAt = new Map<string, number>()
  /** 作用域（run 或组）→ 主控终止周期键；已广播过的周期不重复，明确恢复后键变更自动复位。 */
  private readonly leadAlertedCycle = new Map<string, string>()
  /** 组内成员 slotId → 已通知 lead 的离线周期键；成员恢复后键变更自动复位，下次离线再提醒。 */
  private readonly memberAttentionCycle = new Map<string, string>()

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
    if (!run || run.status !== 'running') {
      this.leadAlertedCycle.clear()
      this.memberAttentionCycle.clear()
      return 0
    }
    const runId = run.id
    // 作用域：legacy 团队 run 只有一个 run 级作用域；会话池按活动协作组逐组清扫（任务书 §5.5）。
    const pool = isSessionPoolRun(run)
    const activeGroups = pool ? control.groups.filter((view) => view.group.status === 'active') : []
    const scopes: Array<string | undefined> = pool ? activeGroups.map((view) => view.group.id) : [undefined]
    for (const key of [...this.leadAlertedCycle.keys()]) {
      if (!scopes.some((scope) => (scope ?? 'run') === key)) this.leadAlertedCycle.delete(key)
    }
    return this.sweepUnanswered(control, runId, now)
      + scopes.reduce((sent, groupId) => sent + this.sweepLeadHeartbeat(control, runId, groupId, now), 0)
      + this.sweepMemberAttention(activeGroups, runId)
  }

  /**
   * 超龄未获回应的 directive/question：向原发送者回执超时提醒（幂等）。
   * 不再抄送有效主控「请介入协调」（阶段 2 · 2A）：催办与改派是编排器的事，lead 只收 done / failed / attention。
   */
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
      this.unansweredAlertedAt.set(item.id, now)
      // 发送者是 operator（控制台）时没有回执对象——operator→operator 自回环会被仓储拒绝，
      // 且控制台 UI 已有回执阶段展示。
      if (item.sender.type !== 'agent') continue
      const minutes = Math.round(item.ageMs / 60_000)
      const debounceBucket = Math.floor(now / UNANSWERED_ALERT_DEBOUNCE_MS)
      // 不用 replyToMessageId：仓储要求回复双方与原消息严格对应，而提醒是系统
      // 身份发出的独立通告；正文里引用原消息 id 保持可追溯。
      const senderKey = `sweeper:unanswered:${item.id}:${debounceBucket}`
      // 持久幂等：内存防抖在进程重启后失效，以快照 clientMessageId 查重兜底。
      if (existingClientIds.has(senderKey)) continue
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
    return sent
  }

  /**
   * 组内成员确认离线（Cursor 明确终止）→ 向该组有效 lead 发一条 attention notice（阶段 2 · 2A 三类 lead 通知之一）。
   * 与 `TeamGroupView.attention` 同口径（`hasConfirmedRuntimeStop`）；每个离线周期只提醒一次，成员恢复后自动复位。
   * lead 自己离线走 `sweepLeadHeartbeat`（提醒的是其他成员），这里跳过。
   */
  private sweepMemberAttention(groups: TeamGroupView[], runId: string): number {
    interface Candidate { view: TeamGroupView; member: TeamMemberView; leadSlotId: string; cycleKey: string }
    const offlineMembers = new Set<string>()
    const candidates: Candidate[] = []
    for (const view of groups) {
      const leadSlotId = view.effectiveLeadSlotId
      for (const member of view.members) {
        const runtime = member.runtime
        if (!runtime || runtime.online || !hasConfirmedRuntimeStop(runtime)) continue
        offlineMembers.add(member.slot.id)
        if (!leadSlotId || member.slot.id === leadSlotId) continue
        const cycleKey = `${runtime.connectionPhase ?? ''}:${runtime.lastSeenAt ?? 0}:${runtime.lastAgentActivityAt ?? 0}`
        if (this.memberAttentionCycle.get(member.slot.id) === cycleKey) continue
        candidates.push({ view, member, leadSlotId, cycleKey })
      }
    }
    // 成员恢复（不再离线）→ 忘掉它的周期键，下次再离线时重新提醒。
    for (const slotId of [...this.memberAttentionCycle.keys()]) {
      if (!offlineMembers.has(slotId)) this.memberAttentionCycle.delete(slotId)
    }
    if (!candidates.length) return 0
    // 持久幂等：进程重启后内存周期键失效，以快照 clientMessageId 查重兜底（与其余两类清扫一致）。
    const snapshot = this.collaboration.loadRun(runId)
    const existingClientIds = new Set(
      snapshot.messageOrder.map((id) => snapshot.messages[id]?.clientMessageId).filter(Boolean)
    )
    let sent = 0
    for (const { view, member, leadSlotId, cycleKey } of candidates) {
      this.memberAttentionCycle.set(member.slot.id, cycleKey)
      const cycleHash = createHash('sha1').update(`${member.slot.id}:${cycleKey}`).digest('hex').slice(0, 12)
      const alertKey = `sweeper:member-attention:${cycleHash}`
      if (existingClientIds.has(alertKey)) continue
      const runtime = member.runtime!
      const channelId = member.binding?.channelId ?? member.slot.channelId ?? '?'
      this.collaboration.createMessage({
        runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: leadSlotId },
        kind: 'notice',
        subject: `成员疑似离线：${member.role.name}`,
        content: `【成员离线提醒】协作组「${view.group.name}」的成员「${member.role.name} · CH-${channelId}」的 Cursor 会话已明确终止` +
          `（${runtime.healthEvidence[0] ?? runtime.connectionPhase ?? '无进一步证据'}）。` +
          '其持有的任务会在租约到期后回到队列并自动重派；是否移出该成员或交接其上下文由用户在拾光里决定，你只需在向用户汇报时提及。',
        clientMessageId: alertKey
      })
      existingClientIds.add(alertKey)
      sent += 1
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
      installedAt: member.binding?.installedAt,
      now
    })
    if (!evidence) {
      this.leadAlertedCycle.delete(scopeKey)
      return 0
    }
    // 周期键纳入心跳起点：主控活性恢复（lastSeenAt 刷新/online 翻正）后自动复位，可再次报警。
    const cycleKey = `${leadSlotId}:${member.runtime?.lastSeenAt ?? 0}:${member.runtime?.lastAgentActivityAt ?? 0}:${member.runtime?.connectionPhase ?? ''}:${member.runtime?.online ?? false}`
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
