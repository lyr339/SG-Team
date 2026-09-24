import { createHash } from 'node:crypto'
import type { PlanTaskInput } from '../domain/task-pool'
import { TaskPoolError } from '../domain/task-pool'
import type {
  AuthorizedTeamAgent,
  TeamAgentRuntimeIdentity,
  TeamMessage,
  TeamMessageKind
} from '../domain/team-collaboration'
import {
  sameTeamMessageActor,
  teamMessageReceiptStage,
  teamMessageRequiresResponse
} from '../domain/team-collaboration'
import type { TeamCollaborationRepository } from './team-collaboration-repository'
import type { AgentTaskView, TaskAgentService } from './task-agent-service'
import { orchestratorMessageId } from './orchestration-source'

const GENERATED_MESSAGE_ID_BUCKET_MS = 30_000

function generatedClientMessageId(prefix: string, parts: unknown[]): string {
  const bucket = Math.floor(Date.now() / GENERATED_MESSAGE_ID_BUCKET_MS)
  const hash = createHash('sha256')
    .update(JSON.stringify([bucket, ...parts]))
    .digest('hex')
    .slice(0, 24)
  return `${prefix}:${hash}:${bucket}`
}

export interface TeamInboxEntry {
  id: string
  threadId: string
  sender: TeamMessage['sender']
  kind: TeamMessageKind
  preview: string
  createdAt: number
  stage: ReturnType<typeof teamMessageReceiptStage>
}

export class TeamCollaborationAgentService {
  readonly identity: TeamAgentRuntimeIdentity

  constructor(
    private readonly repository: TeamCollaborationRepository,
    identity: TeamAgentRuntimeIdentity,
    private readonly tasks: TaskAgentService
  ) {
    const agentSessionId = identity.agentSessionId.trim()
    const runId = identity.runId.trim()
    const slotId = identity.slotId.trim()
    if (!/^[a-zA-Z0-9:_-]{3,200}$/.test(agentSessionId)) {
      throw new Error('agentSessionId 无效')
    }
    if (!/^[a-zA-Z0-9:_-]{3,200}$/.test(runId)) throw new Error('runId 无效')
    if (!/^[a-zA-Z0-9:_-]{3,240}$/.test(slotId)) throw new Error('slotId 无效')
    this.identity = {
      agentSessionId,
      runId,
      slotId,
      capabilities: [...new Set(identity.capabilities.map((item) => item.trim()).filter(Boolean))],
      groupId: identity.groupId?.trim() || undefined
    }
  }

  /**
   * Agent 视角的成员目录与消息快照都以「当前所在组」为作用域（由仓储实时解析，
   * 入组 / 出组即时生效）；legacy 团队 run 没有组 → 退回 run 级全员 / 全部消息。
   */
  private membersOf(agent: AuthorizedTeamAgent) {
    return this.repository.listRunMembers(agent.runId, agent.groupId)
  }

  private snapshotOf(agent: AuthorizedTeamAgent) {
    return this.repository.loadRun(agent.runId, agent.groupId)
  }

  getContext(): Record<string, unknown> {
    const agent = this.currentAgent()
    const members = this.membersOf(agent)
    const snapshot = this.snapshotOf(agent)
    const self = { type: 'agent' as const, slotId: agent.slotId }
    const unread = snapshot.messageOrder
      .map((id) => snapshot.messages[id])
      .filter((message): message is TeamMessage => Boolean(message))
      .filter((message) => sameTeamMessageActor(message.recipient, self) && message.receipt.readAt === undefined)
      .length
    const awaitingResponses = snapshot.messageOrder
      .map((id) => snapshot.messages[id])
      .filter((message): message is TeamMessage => Boolean(message))
      .filter((message) => sameTeamMessageActor(message.sender, self))
      .filter((message) => (
        message.recipient.type === 'agent'
        && teamMessageRequiresResponse(message.kind)
        && message.receipt.respondedAt === undefined
      ))
      .length
    return {
      self: agent,
      members,
      unreadMessages: unread,
      awaitingResponses,
      instructions: unread > 0
        ? `有 ${unread} 条未读团队消息，会随下一次 check_messages 送达。`
        : '当前没有未读团队消息。'
    }
  }

  isCoordinator(): boolean {
    const agent = this.currentAgent()
    return agent.isEffectiveLead === true
  }

  listInbox(unreadOnly = false, limit = 30): TeamInboxEntry[] {
    const agent = this.currentAgent()
    const self = { type: 'agent' as const, slotId: agent.slotId }
    const snapshot = this.snapshotOf(agent)
    return snapshot.messageOrder
      .map((id) => snapshot.messages[id])
      .filter((message): message is TeamMessage => Boolean(message))
      .filter((message) => sameTeamMessageActor(message.recipient, self))
      .filter((message) => !unreadOnly || message.receipt.readAt === undefined)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.min(100, Math.max(1, Math.floor(limit))))
      .map((message) => ({
        id: message.id,
        threadId: message.threadId,
        sender: message.sender,
        kind: message.kind,
        preview: message.content.replace(/\s+/g, ' ').slice(0, 180),
        createdAt: message.createdAt,
        stage: teamMessageReceiptStage(message.receipt)
      }))
  }

  readMessage(messageId: string): TeamMessage {
    const agent = this.currentAgent()
    return this.repository.markRead(
      messageId,
      { type: 'agent', slotId: agent.slotId }
    )
  }

  sendMessage(input: {
    recipientSlotId: string
    kind: Exclude<TeamMessageKind, 'response'>
    content: string
    subject?: string
    clientMessageId?: string
  }): TeamMessage {
    const agent = this.currentAgent()
    if (input.kind === 'directive' && !agent.isEffectiveLead) {
      throw new TaskPoolError('lead_only_directive', '只有主控协调可以发送任务指令')
    }
    const recipientSlotId = input.recipientSlotId.trim()
    if (!this.membersOf(agent).some((member) => member.slotId === recipientSlotId)) {
      throw new TaskPoolError('recipient_not_found', '目标 AgentSlot 不属于当前团队 / 协作组')
    }
    return this.repository.createMessage({
      runId: agent.runId,
      sender: { type: 'agent', slotId: agent.slotId },
      recipient: { type: 'agent', slotId: recipientSlotId },
      kind: input.kind,
      content: input.content,
      subject: input.subject,
      clientMessageId: input.clientMessageId?.trim() || generatedClientMessageId('agent-message', [
        agent.runId,
        agent.slotId,
        recipientSlotId,
        input.kind,
        input.subject ?? '',
        input.content
      ])
    })
  }

  broadcast(input: {
    kind: 'question' | 'notice'
    content: string
    subject?: string
    clientMessageId?: string
  }): TeamMessage[] {
    const agent = this.currentAgent()
    if (!agent.isEffectiveLead) {
      throw new TaskPoolError('lead_only_broadcast', '只有主控协调可以向全体成员广播')
    }
    const recipients = this.membersOf(agent)
      .filter((member) => member.slotId !== agent.slotId)
    const baseId = input.clientMessageId?.trim() || generatedClientMessageId('agent-broadcast', [
      agent.runId,
      agent.slotId,
      input.kind,
      input.subject ?? '',
      input.content
    ])
    return recipients.map((recipient) => this.repository.createMessage({
      runId: agent.runId,
      sender: { type: 'agent', slotId: agent.slotId },
      recipient: { type: 'agent', slotId: recipient.slotId },
      kind: input.kind,
      subject: input.subject,
      content: input.content,
      clientMessageId: orchestratorMessageId('broadcast', baseId, recipient.slotId)
    }))
  }

  collectResponses(messageIds?: string[]): Array<{
    messageId: string
    recipientSlotId: string
    stage: ReturnType<typeof teamMessageReceiptStage>
    response?: string
  }> {
    const agent = this.currentAgent()
    if (!agent.isEffectiveLead) {
      throw new TaskPoolError('lead_only_collect', '只有主控协调可以集中收集团队回应')
    }
    const requestedIds = (messageIds ?? []).map((id) => id.trim()).filter(Boolean)
    const requested = new Set(requestedIds)
    const requestedOrder = new Map(requestedIds.map((id, index) => [id, index]))
    const snapshot = this.snapshotOf(agent)
    const self = { type: 'agent' as const, slotId: agent.slotId }
    return snapshot.messageOrder
      .map((id) => snapshot.messages[id])
      .filter((message): message is TeamMessage => Boolean(message))
      .filter((message) => sameTeamMessageActor(message.sender, self) && message.recipient.type === 'agent')
      .filter((message) => message.kind === 'question' || message.kind === 'notice')
      .filter((message) => requested.size === 0 || requested.has(message.id))
      .sort((left, right) => requested.size
        ? (requestedOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
          - (requestedOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        : left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((message) => ({
        messageId: message.id,
        recipientSlotId: message.recipient.type === 'agent' ? message.recipient.slotId : '',
        stage: teamMessageReceiptStage(message.receipt),
        response: message.receipt.responseMessageId
          ? snapshot.messages[message.receipt.responseMessageId]?.content
          : undefined
      }))
  }

  reportTaskStatus(input: {
    taskId: string
    subject: string
    content: string
    eventKey: string
  }): TeamMessage | undefined {
    const agent = this.currentAgent()
    if (agent.isEffectiveLead) return undefined
    const lead = this.membersOf(agent)
      .find((member) => member.isEffectiveLead)
    if (!lead) return undefined
    return this.repository.createMessage({
      runId: agent.runId,
      sender: { type: 'agent', slotId: agent.slotId },
      recipient: { type: 'agent', slotId: lead.slotId },
      kind: 'status',
      subject: input.subject,
      content: input.content,
      clientMessageId: orchestratorMessageId('task-status', input.taskId, input.eventKey)
    })
  }

  respondMessage(input: {
    messageId: string
    content: string
    clientMessageId?: string
  }): TeamMessage {
    const agent = this.currentAgent()
    const snapshot = this.snapshotOf(agent)
    const original = snapshot.messages[input.messageId.trim()]
    const self = { type: 'agent' as const, slotId: agent.slotId }
    if (!original || !sameTeamMessageActor(original.recipient, self)) {
      throw new TaskPoolError('message_recipient_mismatch', '只能回应发给当前 AgentSlot 的消息')
    }
    this.repository.acknowledge(original.id, self)
    return this.repository.createMessage({
      runId: agent.runId,
      sender: self,
      recipient: original.sender,
      kind: 'response',
      content: input.content,
      clientMessageId: input.clientMessageId?.trim() || generatedClientMessageId('agent-response', [
        agent.runId,
        agent.slotId,
        original.id,
        input.content
      ]),
      threadId: original.threadId,
      replyToMessageId: original.id
    })
  }

  listTaskBoard(): AgentTaskView[] {
    this.currentAgent()
    return this.tasks.listBoard()
  }

  planTasks(inputs: PlanTaskInput[]): ReturnType<TaskAgentService['plan']> {
    const agent = this.currentAgent()
    const members = this.membersOf(agent)
    const memberBySlot = new Map(members.map((member) => [member.slotId, member]))
    for (const input of inputs) {
      const required = [...new Set((input.requiredCapabilities ?? []).map((item) => item.trim()).filter(Boolean))]
      if (input.targetSlotId) {
        const target = memberBySlot.get(input.targetSlotId.trim())
        if (!target) {
          throw new TaskPoolError('target_slot_not_found', `指定 AgentSlot 不属于当前团队 / 协作组：${input.targetSlotId}`)
        }
        const available = new Set(target.capabilities)
        const missing = required.filter((capability) => !available.has(capability))
        if (missing.length) {
          throw new TaskPoolError(
            'target_capability_mismatch',
            `${target.roleName} 不具备能力 ${missing.join('、')}；请从 team_check_in 返回的 context.members capabilities 中选择，或省略 requiredCapabilities`
          )
        }
      } else if (required.length && !members.some((member) => (
        required.every((capability) => member.capabilities.includes(capability))
      ))) {
        throw new TaskPoolError(
          'team_capability_unavailable',
          `当前团队没有成员同时具备能力：${required.join('、')}`
        )
      }
    }
    return this.tasks.plan(inputs)
  }

  createLeadTakeoverContext(input: {
    previousLeadSlotId?: string
    evidence: string[]
    recoveredTaskIds: string[]
  }): TeamMessage {
    const agent = this.currentAgent()
    if (!agent.isEffectiveLead) {
      throw new TaskPoolError('lead_only_takeover_context', '只有当前有效主控可以生成接管上下文')
    }
    const snapshot = this.snapshotOf(agent)
    const previousLeadSlotId = input.previousLeadSlotId?.trim()
    const pending = previousLeadSlotId
      ? snapshot.messageOrder
        .map((id) => snapshot.messages[id])
        .filter((message): message is TeamMessage => Boolean(message))
        .filter((message) => (
          (message.recipient.type === 'agent'
            && message.recipient.slotId === previousLeadSlotId
            && message.receipt.readAt === undefined)
          || (message.sender.type === 'agent'
            && message.sender.slotId === previousLeadSlotId
            && message.recipient.type === 'agent'
            && teamMessageRequiresResponse(message.kind)
            && message.receipt.respondedAt === undefined)
        ))
        .slice(-20)
      : []
    const board = this.tasks.listBoard()
    const activeTasks = board
      .filter(({ task }) => ['queued', 'leased', 'running', 'review'].includes(task.status))
      .slice(0, 30)
    return this.repository.createMessage({
      runId: agent.runId,
      sender: { type: 'operator' },
      recipient: { type: 'agent', slotId: agent.slotId },
      kind: 'notice',
      subject: '主控接管上下文',
      content: [
        '【主控接管上下文】你已成为唯一有效主控。',
        input.evidence.length ? `失联证据：${input.evidence.join('；')}` : '',
        input.recoveredTaskIds.length ? `已迁移/重排任务：${input.recoveredTaskIds.join('、')}` : '原主控没有活动任务需要迁移。',
        '',
        '当前活动任务：',
        activeTasks.length
          ? activeTasks.map(({ task }) => `- ${task.id}｜${task.title}｜${task.status}｜${task.progress}%`).join('\n')
          : '- 无',
        '',
        '原主控相关待处理消息：',
        pending.length
          ? pending.map((message) => `- ${message.id}｜${message.kind}｜${message.content.slice(0, 500)}`).join('\n')
          : '- 无',
        '',
        '用 team_tasks({view:\'board\'}) 核对任务；需要重新领取的任务按正常 team_task claim 流程处理。'
      ].filter((line, index, values) => line !== '' || values[index - 1] !== '').join('\n'),
      clientMessageId: generatedClientMessageId('lead-takeover-context', [
        agent.runId,
        agent.slotId,
        previousLeadSlotId ?? '',
        input.recoveredTaskIds
      ])
    })
  }

  private currentAgent(): AuthorizedTeamAgent {
    return this.repository.resolveAuthorizedAgent(this.identity)
  }
}
