import type { SessionHandoffContext, SessionHandoffResult, SessionHandoffTarget } from '../domain/session-handoff'
import type { TeamControlSnapshot } from '../domain/team-control'
import type {
  ContextHandoffOutcome,
  MembershipTransferInput,
  MembershipTransferOutcome,
  MembershipTransferResult
} from '../domain/team-handoff'

export interface MembershipTransferWithContextPorts {
  groups: { transferMembership(input: { groupId: string; fromSlotId: string; toSlotId: string }): MembershipTransferResult }
  team: { getSnapshot(): TeamControlSnapshot }
  handoff: {
    context(channelId: string): SessionHandoffContext
    deliverFrom(source: SessionHandoffContext, target: SessionHandoffTarget, note?: string): SessionHandoffResult
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 用户的成员身份迁移 + 可选的上下文交接，一次调用内按固定顺序完成：
 *
 * 1. 迁移前解析原席位的上下文（转录位置、会话记录口径）——成员身份迁移不改写绑定，
 *    但迁移失败时不能留下任何投递副作用；解析阶段的异常也只影响上下文，不拦迁移；
 * 2. 执行迁移（失败原样抛出，不投递任何消息）；
 * 3. 迁移成功后把预解析的上下文作为普通用户消息排进目标席位的通道队列。投递失败不回滚
 *    迁移，以 contextHandoff.ok=false 报告给用户。
 *
 * 不带 includeContext 时与直接调用 groups.transferMembership 完全等价。
 */
export function transferMembershipWithContext(
  ports: MembershipTransferWithContextPorts,
  input: MembershipTransferInput
): MembershipTransferOutcome {
  const migration = { groupId: input.groupId, fromSlotId: input.fromSlotId, toSlotId: input.toSlotId }
  if (!input.includeContext) return { transfer: ports.groups.transferMembership(migration) }

  const team = ports.team.getSnapshot()
  const memberOf = (slotId: string) => team.members.find((member) => member.slot.id === slotId.trim())
  const sourceChannelId = memberOf(input.fromSlotId)?.binding?.channelId
  // 来源上下文在迁移前解析。找不到 Composer 时 transcript 只是缺省，由投递阶段报告
  // 「找不到上下文文档」；解析阶段的任何异常同样只影响上下文，不能反过来拦住身份迁移。
  let source: SessionHandoffContext | undefined
  let resolveError: string | undefined
  try {
    source = sourceChannelId ? ports.handoff.context(sourceChannelId) : undefined
  } catch (error) {
    resolveError = describe(error)
  }

  const transfer = ports.groups.transferMembership(migration)

  const targetChannelId = transfer.toChannelId ?? memberOf(input.toSlotId)?.binding?.channelId
  let contextHandoff: ContextHandoffOutcome
  if (!source || !targetChannelId) {
    contextHandoff = { ok: false, error: resolveError ?? '迁移前没有定位到原席位或目标席位的通道，上下文文档未投递' }
  } else {
    try {
      contextHandoff = { ok: true, result: ports.handoff.deliverFrom(source, { kind: 'channel', channelId: targetChannelId }) }
    } catch (error) {
      contextHandoff = { ok: false, error: describe(error) }
    }
  }
  return { transfer, contextHandoff }
}
