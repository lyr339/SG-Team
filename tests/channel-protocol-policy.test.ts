import { describe, expect, it } from 'vitest'
import {
  buildDeliverySuffix,
  buildKeepaliveText,
  buildMembershipNoticeSuffix,
  buildReplySyncRequiredMessage,
  buildSilentDeliverySuffix,
  buildStorageUnavailableMessage
} from '../src/domain/channel-delivery-policy'
import { buildChannelWaitInstruction } from '../src/domain/channel-wait-policy'
import {
  CHANNEL_KEEPALIVE_TIMEOUT_MAX_MS,
  CHANNEL_KEEPALIVE_TIMEOUT_MIN_MS,
  CHANNEL_KEEPALIVE_TIMEOUT_MS,
  MEMBERSHIP_NOTICE_PREFIX,
  resolveKeepaliveTimeoutMs,
  resolveOutboundKind
} from '../src/domain/channel-message'
import { buildMembershipNotice, buildTeamRoleBriefing, createConfiguredTeamBundle } from '../src/domain/team-control'
import { buildUnifiedServerInstructions } from '../src/mcp/team-tools'

describe('keepalive 窗口', () => {
  it('默认 5 分钟：远低于 Cursor cursor-mcp 扩展对每次工具调用的 1 小时超时，又把纯待命席位的气泡增长压到原来的 1/5', () => {
    expect(CHANNEL_KEEPALIVE_TIMEOUT_MS).toBe(300_000)
    expect(CHANNEL_KEEPALIVE_TIMEOUT_MS).toBeLessThan(36e5 / 10)
  })

  it('环境变量覆盖：合法毫秒整数按值生效，缺省 / 非数字 / 越界一律回落默认', () => {
    expect(resolveKeepaliveTimeoutMs(undefined)).toBe(CHANNEL_KEEPALIVE_TIMEOUT_MS)
    expect(resolveKeepaliveTimeoutMs('')).toBe(CHANNEL_KEEPALIVE_TIMEOUT_MS)
    expect(resolveKeepaliveTimeoutMs(' 60000 ')).toBe(60_000)
    expect(resolveKeepaliveTimeoutMs('600000')).toBe(600_000)
    expect(resolveKeepaliveTimeoutMs(String(CHANNEL_KEEPALIVE_TIMEOUT_MIN_MS))).toBe(CHANNEL_KEEPALIVE_TIMEOUT_MIN_MS)
    expect(resolveKeepaliveTimeoutMs(String(CHANNEL_KEEPALIVE_TIMEOUT_MAX_MS))).toBe(CHANNEL_KEEPALIVE_TIMEOUT_MAX_MS)
    expect(resolveKeepaliveTimeoutMs(String(CHANNEL_KEEPALIVE_TIMEOUT_MIN_MS - 1))).toBe(CHANNEL_KEEPALIVE_TIMEOUT_MS)
    expect(resolveKeepaliveTimeoutMs(String(CHANNEL_KEEPALIVE_TIMEOUT_MAX_MS + 1))).toBe(CHANNEL_KEEPALIVE_TIMEOUT_MS)
    expect(resolveKeepaliveTimeoutMs('60s')).toBe(CHANNEL_KEEPALIVE_TIMEOUT_MS)
    expect(resolveKeepaliveTimeoutMs('-60000')).toBe(CHANNEL_KEEPALIVE_TIMEOUT_MS)
    expect(resolveKeepaliveTimeoutMs('1e5')).toBe(CHANNEL_KEEPALIVE_TIMEOUT_MS)
  })
})

describe('channel protocol policy text', () => {
  it('does not instruct agents to record a reply when they only keep polling', () => {
    const instruction = buildChannelWaitInstruction({
      channelId: '1',
      communicationServerName: 'SG Team'
    })

    expect(instruction).toContain('工具返回后的静默待命动作')
    expect(instruction).toContain('直接调用 SG Team.check_messages')
    expect(instruction).toContain('不要向用户输出可见文字')
    expect(instruction).not.toContain('先用 SG Team.record_reply')
    // 反循环误报对抗：待命指令必须点名 IDE 提醒是误报，并提示携带最新 tick。
    expect(instruction).toContain('tick')
    expect(instruction).toContain('误报')
  })

  it('keeps first and later delivery suffixes compact while preserving reply sync and silent keepalive', () => {
    const first = buildDeliverySuffix({
      channelId: '1'
    })
    const later = buildDeliverySuffix({ channelId: '1' })

    for (const text of [first, later]) {
      expect(text).toContain('【真实用户消息处理完后进入 check_messages 待命】')
      expect(text).toContain('可见回复后 record_reply 同步完整正文，再 check_messages')
      expect(text).toContain('没有可见回复不 record_reply')
      // keepalive 强禁令：直接再调、不输出可见回复、不以文字代替调用、IDE 提醒是误报。
      expect(text).toContain('keepalive 直接再调')
      expect(text).toContain('不输出可见回复')
      expect(text).toContain('不以文字代替调用')
      expect(text).toContain('误报')
      expect(text.length).toBeLessThan(320)
    }
    // 协议不再因首投重复展开；工作区和通道身份已由启动消息/MCP 参数承载。
    expect(first).toBe(later)
  })

  it('hands the next poll tick to the agent in every delivery suffix', () => {
    const suffix = buildDeliverySuffix({ channelId: '3', tick: 6 })
    expect(suffix).toContain("再 check_messages（带 tick:'6'）")

    const silent = buildSilentDeliverySuffix({ channelId: '3', tick: 6 })
    expect(silent).toContain("check_messages（带 tick:'6'） 静默待命")

    // 无 tick（异常路径兜底）时保持旧形态，不出现占位符。
    expect(buildDeliverySuffix({ channelId: '3' })).not.toContain('tick:')
    expect(buildSilentDeliverySuffix({ channelId: '3' })).not.toContain('tick:')
  })

  it('keepalive returns the exact next call with a fresh tick and names the IDE loop false positive', () => {
    const text = buildKeepaliveText({ channelId: '3', session: 'seat-token-0001', round: 9, tick: 42 })

    expect(text).toContain('<sg_team_keepalive n="9"/>')
    expect(text).toContain("check_messages({channel_id:'3', session:'seat-token-0001', tick:'42'})")
    expect(text).toContain('误报')
    expect(text).not.toContain('【真实用户消息处理完后进入 check_messages 待命】')
    // 精简约束：keepalive 单行极简——空闲期每分钟一条，上下文积累成本必须逼近零。
    expect(text.trim().split('\n')).toHaveLength(1)
    expect(text.length).toBeLessThan(180)

    // 无会话令牌的 legacy 调用：提示里不回显 session。
    const legacy = buildKeepaliveText({ channelId: '3', round: 1, tick: 7 })
    expect(legacy).toContain("check_messages({channel_id:'3', tick:'7'})")
    expect(legacy).not.toContain('session:')
  })

  it('keeps unified MCP server instructions silent on keepalive and read duplicates', () => {
    const instructions = buildUnifiedServerInstructions()

    expect(instructions).toContain('每次真实用户可见回复后必须 record_reply')
    expect(instructions).toContain('团队内部通知只用 team_message 回执处理')
    // 工具面收敛后的对象划分说明：模型据此在 7 个团队工具里选对象，再选 action/view。
    expect(instructions).toContain('team_tasks 看任务（view）')
    expect(instructions).toContain('team_run 运行与主控（action）')
    expect(instructions).toContain('keepalive、无未读或已读重复时必须静默续等')
    expect(instructions).toContain('也不要 record_reply')
    expect(instructions).toContain('内部通知不会触发该守门')
    // 反循环根治：instructions 必须建立 tick 契约并点名 IDE 重复调用提醒是误报。
    expect(instructions).toContain('携带上一次返回中提示的 tick')
    expect(instructions).toContain('误报')
    expect(instructions).toContain('不要停止轮询')
  })

  it('tells agents that a desktop restart is not a stop, and how to ride out transport / storage blips', () => {
    const instructions = buildUnifiedServerInstructions()
    const rule = instructions.split('\n').find((line) => line.startsWith('瞬断续接：'))!

    expect(rule).toContain('拾光桌面端退出或重启不会中断本会话')
    expect(rule).toContain('MCP 进程由 Cursor 托管')
    expect(rule).toContain('transport closed')
    expect(rule).toContain('storage_unavailable')
    expect(rule).toContain('这不是围栏终止')
    expect(rule).toContain('原样重试同一调用')
    expect(rule).toContain('record_reply 先补同步，再 check_messages 续等')
    expect(rule).toContain('连续 3 次仍失败')
    // 围栏终止与额度/授权错误的「不要重试」规则保持原样，瞬断规则不覆盖它们。
    expect(instructions).toContain('收到「会话围栏」终止指令即停止轮询并结束，不要重试')
    expect(instructions).toContain('usage limit / quota / billing / authorization / isRetryable:false')

    expect(buildStorageUnavailableMessage({ detail: 'database is locked', retryable: true, failures: 1 }))
      .toContain('这不是会话围栏终止')
    expect(buildStorageUnavailableMessage({ detail: 'disk I/O error', retryable: false, failures: 3 }))
      .toContain('请停止自动重试')
  })

  it('keeps silent internal notifications out of the user-visible reply protocol', () => {
    const instruction = buildSilentDeliverySuffix({ channelId: '2' })

    expect(instruction).toContain('内部协作通知协议')
    expect(instruction).toContain('不是用户可见对话')
    expect(instruction).toContain("team_message({action:'read', messageId})")
    expect(instruction).toContain("team_message({action:'respond', messageId, content})")
    expect(instruction).toContain('不要调用 record_reply')
    expect(instruction).not.toContain('持续对话协议')
  })

  it('keeps reply-sync recovery limited to the explicit need-sync error path', () => {
    const message = buildReplySyncRequiredMessage(false)

    expect(message).toContain('上一轮用户消息已经处理')
    expect(message).toContain('请立即调用 record_reply')
    expect(message).toContain('不要重新回答用户')
  })
})

describe('membership notice protocol (会话池 · 协作组)', () => {
  it('uses a dedicated suffix without any messageId / team_message read guidance, and hands over the next tick', () => {
    const suffix = buildMembershipNoticeSuffix({ channelId: '3', tick: 1010 })
    expect(suffix).toContain('【成员关系通知协议】')
    expect(suffix).toContain("check_messages（带 tick:'1010'）")
    expect(suffix).toContain('没有 messageId')
    expect(suffix).toContain('不是注入')
    expect(suffix).not.toContain("team_message({action:'read'")
    expect(suffix).toContain('不要调用 record_reply')
    // 与内部协作后缀是两种不同的协议文本。
    expect(buildSilentDeliverySuffix({ channelId: '3', tick: 1010 })).toContain("team_message({action:'read'")
  })

  it('builds the four notice templates with the marker prefix so relay / delivery classify them as membership', () => {
    const group = { name: '验收组', goal: '把接口重构收尾' }
    const joined = buildMembershipNotice({ kind: 'joined', channelId: '3', group, roleName: '专项实现 1', leadLabel: '主控协调 · CH-1' })
    expect(joined.startsWith(MEMBERSHIP_NOTICE_PREFIX)).toBe(true)
    expect(joined).toContain('已加入协作组「验收组」')
    expect(joined).toContain('组目标：把接口重构收尾')
    expect(joined).toContain("team_check_in({channel_id:'3'})")
    expect(joined).toContain('lead：主控协调 · CH-1')
    const left = buildMembershipNotice({ kind: 'left', channelId: '3', group })
    expect(left).toContain('已被移出协作组')
    expect(left).toContain('不要再调用任何 team_* 工具')
    const dissolved = buildMembershipNotice({ kind: 'dissolved', channelId: '3', group })
    expect(dissolved).toContain('已解散')
    const promoted = buildMembershipNotice({ kind: 'lead_changed', channelId: '3', group, leadLabel: '专项实现 1 · CH-3', becameLead: true })
    expect(promoted).toContain('已成为本组唯一有效主控')
    const demoted = buildMembershipNotice({ kind: 'lead_changed', channelId: '1', group, leadLabel: '专项实现 1 · CH-3', becameLead: false })
    expect(demoted).toContain('不再持有主控权限')
    for (const text of [joined, left, dissolved, promoted, demoted]) {
      expect(resolveOutboundKind(text)).toBe('membership')
      expect(text).not.toContain('messageId')
    }
    // 入组 / lead 变更通知不要求任何可见回复；出组 / 解散只是说明之后的通信方式。
    for (const text of [joined, promoted, demoted]) expect(text).not.toContain('record_reply')
    // 无 lead 组：模板写明 lead 为「无」。
    expect(buildMembershipNotice({ kind: 'joined', channelId: '2', group, roleName: '架构实现' })).toContain('lead：无')
  })

  it('classifies outbound kinds: explicit wins, then title prefix, then silent flag', () => {
    expect(resolveOutboundKind('用户消息')).toBe('user')
    expect(resolveOutboundKind('用户消息', undefined, true)).toBe('internal')
    expect(resolveOutboundKind('【拾光内部协作通知】x')).toBe('internal')
    expect(resolveOutboundKind(`${MEMBERSHIP_NOTICE_PREFIX}x`)).toBe('membership')
    expect(resolveOutboundKind(`${MEMBERSHIP_NOTICE_PREFIX}x`, 'user')).toBe('user')
  })

  it('announces membership notices in the unified instructions and scopes the team_* ban to ungrouped seats', () => {
    const text = buildUnifiedServerInstructions()
    expect(text).toContain('成员关系：所有会话都以独立席位创建')
    expect(text).toContain(MEMBERSHIP_NOTICE_PREFIX)
    expect(text).toContain('未入组时只用 check_messages / record_reply')
    expect(text).toContain('not_in_group')
    expect(text).not.toContain('独立席只用 check_messages / record_reply，不调用 team_*')
  })

  it('briefs a grouped seat with the group goal, lead and membership caveat; the run goal never appears', () => {
    const bundle = createConfiguredTeamBundle({
      workspaceId: 'w', workspaceName: 'w', workspacePath: '/w', now: 1,
      members: [
        { channelId: '1', roleTemplateKey: 'lead', avatarId: 'lead', skills: [] },
        { channelId: '2', roleTemplateKey: 'builder', avatarId: 'architect', skills: [] }
      ]
    })
    bundle.run.goal = '团队目标 X'
    const builderSlot = bundle.slots[1]!
    const builderRole = bundle.roles.find((role) => role.id === builderSlot.roleId)!
    const binding = {
      id: 'b', workspaceId: 'w', runId: bundle.run.id, slotId: builderSlot.id, channelId: '2', agentSessionId: 'w:ch-2:g',
      generation: 'g', composerBindingKey: 'k', launchDetail: '', acknowledgedAt: 1, lastCheckInNote: '',
      installedAt: 1, updatedAt: 1
    }
    const grouped = buildTeamRoleBriefing({
      run: bundle.run, role: builderRole, slot: builderSlot, binding, effectiveLead: false,
      group: { name: '验收组', goal: '组目标 Y', leadLabel: '主控协调 · CH-1', memberCount: 2 }
    })
    expect(grouped).toContain('协作组「验收组」的「架构实现」Agent')
    expect(grouped).toContain('组目标：组目标 Y')
    expect(grouped).not.toContain('团队目标：团队目标 X')
    expect(grouped).toContain(`会投递${MEMBERSHIP_NOTICE_PREFIX}`)
    // 无 lead 组：不给主控工作流，说明任务由用户直接指派。
    const leaderless = buildTeamRoleBriefing({
      run: bundle.run, role: builderRole, slot: builderSlot, binding, effectiveLead: false,
      group: { name: '验收组', goal: '', leadLabel: undefined, memberCount: 1 }
    })
    expect(leaderless).toContain('lead：无')
    expect(leaderless).toContain('本组没有 lead')
    // 简报只对组成员存在（阶段 2 · 2B）：目标一律来自组，run 只提供 id 作为稳定坐标。
    expect(leaderless).not.toContain('团队目标')
    expect(leaderless).toContain(`TeamRun：${bundle.run.id}`)
  })
})
