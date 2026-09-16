import { randomUUID } from 'node:crypto'
import type { TeamControlRepository } from './team-control-repository'
import { isSessionPoolRun, type TeamControlSnapshot, type TeamMemberView, type TeamRuntimeChannelView } from '../domain/team-control'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { TeamContinuityService } from './team-continuity-service'
import type { TaskPoolService } from './task-pool-service'
import { TaskPoolError } from '../domain/task-pool'
import type {
  ManualTeamHandoffInput,
  ManualTeamHandoffResult,
  TeamHandoffCandidate,
  TeamHandoffOptions
} from '../domain/team-handoff'

export interface TeamHandoffSource {
  getSnapshot(): TeamControlSnapshot
}

export class TeamHandoffService {
  constructor(
    private readonly repository: TeamControlRepository,
    private readonly team: TeamHandoffSource,
    private readonly tasks: TaskPoolService,
    private readonly collaboration: TeamCollaborationRepository,
    private readonly continuity: TeamContinuityService,
    private readonly now: () => number = Date.now
  ) {}

  options(sourceSlotId: string): TeamHandoffOptions {
    const team = this.team.getSnapshot()
    const run = team.activeRun
    if (run?.status !== 'running') {
      throw new TaskPoolError('handoff_run_inactive', '只有运行中的团队可以手动交接')
    }
    // 会话池里「通道 = 席位」：角色交接会把席位绑定挪到另一条通道（rebindSlotFromMember /
    // rebindSlotToStandby），在池内等于把两条会话的身份互换。入组席位离线只表现为组 attention，
    // 处置手段是移出 / 加入协作组或会话上下文交接（SessionHandoffService），不是角色交接。
    if (isSessionPoolRun(run)) {
      throw new TaskPoolError('handoff_pool_run', '会话池内的席位与 Cursor 会话一一对应，不做角色交接；请移出 / 加入协作组，或使用会话上下文交接')
    }
    const source = team.members.find((member) => member.slot.id === sourceSlotId.trim())
    if (!source?.binding) throw new TaskPoolError('handoff_source_missing', '待交接角色没有有效运行绑定')
    if (source.slot.solo === true) throw new TaskPoolError('handoff_source_solo', '独立席位不参与团队交接')
    if (source.runtime?.online) throw new TaskPoolError('handoff_source_online', '当前 Agent 仍在线，无需交接')
    const originalLead = team.members.find((member) => member.role.templateKey === 'lead')
    const effectiveLeadSlotId = run.actingLeadSlotId ?? originalLead?.slot.id
    const sourceIsEffectiveLead = source.slot.id === effectiveLeadSlotId

    const pool = this.tasks.getSnapshot()
    const busySessions = new Set([
      ...Object.values(pool.attempts)
        .filter((attempt) => ['leased', 'running'].includes(attempt.status))
        .map((attempt) => attempt.agentSessionId),
      ...Object.values(pool.reviews)
        .filter((review) => review.status === 'leased' && review.reviewerSessionId)
        .map((review) => review.reviewerSessionId!)
    ])
    const failoverSessions = new Set(team.failovers
      .filter((record) => record.status === 'waiting_for_agent')
      .flatMap((record) => [record.fromAgentSessionId, record.toAgentSessionId].filter(Boolean) as string[]))

    const memberCandidates: TeamHandoffCandidate[] = team.members
      .filter((member) => member.slot.solo !== true)
      .filter((member) => member.slot.id !== source.slot.id && member.binding && member.runtime?.online)
      .map((member) => {
        const binding = member.binding!
        const mode = sourceIsEffectiveLead ? 'lead_authority' as const : 'role_rebind' as const
        // 「已确认」= 该会话签过到（acknowledged_at）；换席重建会清空它。
        const blockers = (sourceIsEffectiveLead ? [
          binding.acknowledgedAt === undefined ? 'Agent 尚未完成本轮确认' : '',
          failoverSessions.has(binding.agentSessionId) ? 'Agent 已处于另一场接替中' : ''
        ] : [
          !member.runtime?.waiting ? 'Agent 正在执行，尚未待命' : '',
          member.runtime?.queueDepth ? `通道队列还有 ${member.runtime.queueDepth} 条消息` : '',
          binding.acknowledgedAt === undefined ? 'Agent 尚未完成本轮确认' : '',
          busySessions.has(binding.agentSessionId) ? 'Agent 仍持有执行任务或验收' : '',
          failoverSessions.has(binding.agentSessionId) ? 'Agent 已处于另一场接替中' : '',
          member.role.templateKey === 'lead' ? '不能挪走当前唯一主控' : ''
        ]).filter(Boolean)
        return {
          agentSessionId: binding.agentSessionId,
          kind: 'member',
          mode,
          channelId: binding.channelId,
          slotId: member.slot.id,
          roleName: member.role.name,
          avatarId: member.slot.avatarId,
          eligible: blockers.length === 0,
          blocker: blockers[0],
          impact: sourceIsEffectiveLead
            ? `保留${member.role.name}职责与现有任务，同时接管唯一主控权限`
            : `${member.role.name}席将转为离线空缺`
        }
      })
    const standbyCandidates: TeamHandoffCandidate[] = team.standbyChannels
      .filter((channel) => channel.online && channel.agentSessionId)
      .map((channel) => {
        const blockers = [
          !channel.waiting ? '备用 Agent 尚未待命' : '',
          channel.queueDepth ? `通道队列还有 ${channel.queueDepth} 条消息` : '',
          failoverSessions.has(channel.agentSessionId!) ? 'Agent 已处于另一场接替中' : ''
        ].filter(Boolean)
        return {
          agentSessionId: channel.agentSessionId!,
          kind: 'standby',
          mode: 'role_rebind',
          channelId: channel.channelId,
          roleName: channel.displayName,
          eligible: blockers.length === 0,
          blocker: blockers[0],
          impact: '备用 Agent 将直接接管，不会产生新的职责空缺'
        }
      })
    return {
      runId: run.id,
      sourceSlotId: source.slot.id,
      sourceRoleName: source.role.name,
      sourceChannelId: source.binding.channelId,
      candidates: [...standbyCandidates, ...memberCandidates]
    }
  }

  manual(input: ManualTeamHandoffInput): ManualTeamHandoffResult {
    const options = this.options(input.sourceSlotId)
    const candidate = options.candidates.find((item) => (
      item.agentSessionId === input.replacementAgentSessionId.trim()
    ))
    if (!candidate) throw new TaskPoolError('handoff_candidate_missing', '候选 Agent 不属于当前团队')
    if (!candidate.eligible) throw new TaskPoolError('handoff_candidate_ineligible', candidate.blocker || '候选 Agent 当前不可交接')
    const team = this.team.getSnapshot()
    const source = team.members.find((member) => member.slot.id === options.sourceSlotId)!
    if (candidate.mode === 'lead_authority' && candidate.slotId) {
      return this.executeLeadAuthority(source, candidate.slotId, candidate.agentSessionId, candidate.channelId)
    }
    const replacement = candidate.kind === 'standby'
      ? team.standbyChannels.find((channel) => channel.agentSessionId === candidate.agentSessionId)!
      : team.runtimeChannels.find((channel) => channel.agentSessionId === candidate.agentSessionId)!
    const reason = candidate.kind === 'standby'
      ? `用户手动交接：${candidate.roleName} 接替 ${source.role.name}`
      : `用户手动交接：${candidate.roleName} · CH-${candidate.channelId} 迁移为 ${source.role.name}；${candidate.impact}`
    return this.execute(source, replacement, this.now(), reason, candidate.slotId)
  }

  private executeLeadAuthority(
    source: TeamMemberView,
    targetSlotId: string,
    targetAgentSessionId: string,
    targetChannelId: string
  ): ManualTeamHandoffResult {
    const binding = source.binding
    if (!binding) throw new TaskPoolError('handoff_binding_missing', '原主控运行绑定不存在')
    const at = this.now()
    this.repository.setActingLead({ runId: binding.runId, slotId: targetSlotId, at })
    const recoveredTaskIds = this.tasks.recoverAgentWork({
      fromAgentSessionId: binding.agentSessionId,
      toAgentSessionId: targetAgentSessionId,
      targetSlotId
    })
    const checkpoint = this.continuity.getSnapshot().checkpoints.at(-1)
    const collaboration = this.collaboration.loadRun(binding.runId)
    const pending = collaboration.messageOrder
      .map((id) => collaboration.messages[id])
      .filter((message) => message && (
        (message.recipient.type === 'agent' && message.recipient.slotId === source.slot.id && message.receipt.readAt === undefined)
        || (message.sender.type === 'agent' && message.sender.slotId === source.slot.id && message.receipt.respondedAt === undefined)
      ))
      .slice(-20)
    const message = this.collaboration.createMessage({
      runId: binding.runId,
      sender: { type: 'operator' },
      recipient: { type: 'agent', slotId: targetSlotId },
      kind: 'notice',
      subject: '用户手动交接主控权限',
      content: [
        `【拾光真实主控交接】CH-${targetChannelId} 已成为当前 TeamRun 的唯一有效主控；原主控权限已撤销。`,
        checkpoint ? `连续性检查点：${checkpoint.id}` : '',
        recoveredTaskIds.length ? `已迁移/重排任务：${recoveredTaskIds.join('、')}` : '原主控没有活动任务需要迁移。',
        pending.length ? `原主控待处理消息：\n${pending.map((item) => `- ${item!.id}｜${item!.content.slice(0, 500)}`).join('\n')}` : '原主控没有待处理消息。',
        '请调用 team_check_in 刷新权限并读取团队上下文，再调用 team_tasks({view:\'board\'}) 核对接管状态。'
      ].filter(Boolean).join('\n'),
      clientMessageId: `manual-lead-authority:${binding.runId}:${targetSlotId}:${at}`
    })
    return {
      mode: 'lead_authority',
      messageId: message.id,
      actingLeadSlotId: targetSlotId,
      recoveredTaskIds
    }
  }

  /** 角色交接只剩手动一种（standby 自动接替随一次性团队 run 退役，阶段 2 · 2B）。 */
  private execute(
    member: TeamMemberView,
    replacement: TeamRuntimeChannelView,
    detectedAt: number,
    reason: string,
    donorSlotId?: string
  ): ManualTeamHandoffResult {
    const binding = member.binding
    if (!binding || !replacement.agentSessionId) throw new TaskPoolError('handoff_binding_missing', '交接运行绑定不完整')
    const failoverId = `team-handoff:manual:${randomUUID()}`
    const bindingKey = randomUUID()
    try {
      const capsule = this.continuity.createTakeoverCapsule({
        slotId: member.slot.id,
        failoverId,
        previousAgentSessionId: binding.agentSessionId,
        replacementChannelId: replacement.channelId,
        bindingKey,
        mode: 'manual'
      })
      if (donorSlotId) {
        this.repository.rebindSlotFromMember({
          failoverId,
          runId: binding.runId,
          slotId: member.slot.id,
          donorSlotId,
          expectedAgentSessionId: binding.agentSessionId,
          replacementAgentSessionId: replacement.agentSessionId,
          reason,
          detectedAt,
          bindingKey,
          checkpointId: capsule.checkpointId
        })
      } else {
        this.repository.rebindSlotToStandby({
          failoverId,
          runId: binding.runId,
          slotId: member.slot.id,
          expectedAgentSessionId: binding.agentSessionId,
          replacementAgentSessionId: replacement.agentSessionId,
          reason,
          detectedAt,
          bindingKey,
          checkpointId: capsule.checkpointId
        })
      }
      const transferredTaskIds = this.tasks.transferAgentWork({
        fromAgentSessionId: binding.agentSessionId,
        toAgentSessionId: replacement.agentSessionId,
        slotId: member.slot.id
      })
      const message = this.collaboration.createMessage({
        runId: binding.runId,
        sender: { type: 'operator' },
        recipient: { type: 'agent', slotId: member.slot.id },
        kind: 'notice',
        subject: `手动交接：${member.role.name}`,
        content: capsule.content,
        clientMessageId: failoverId
      })
      this.repository.attachFailoverContext({
        failoverId,
        checkpointId: capsule.checkpointId,
        messageId: message.id,
        taskIds: [...new Set([...capsule.taskIds, ...transferredTaskIds])],
        at: this.now()
      })
      const failover = this.repository.listFailovers(binding.runId).find((record) => record.id === failoverId)!
      return { mode: 'role_rebind', failover, messageId: message.id, vacatedSlotId: donorSlotId }
    } catch (error) {
      try {
        const existing = this.repository.listFailovers(binding.runId).find((record) => record.id === failoverId)
        if (existing?.status === 'waiting_for_agent') {
          this.repository.updateFailoverStatus({
            failoverId,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
            at: this.now()
          })
        }
      } catch {
        // The original failure is the actionable error.
      }
      throw error
    }
  }
}
