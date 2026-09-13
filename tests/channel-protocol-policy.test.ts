import { describe, expect, it } from 'vitest'
import {
  buildDeliverySuffix,
  buildKeepaliveText,
  buildReplySyncRequiredMessage,
  buildSilentDeliverySuffix,
  buildStorageUnavailableMessage
} from '../src/domain/channel-delivery-policy'
import { buildChannelWaitInstruction } from '../src/domain/channel-wait-policy'
import { buildUnifiedServerInstructions } from '../src/mcp/team-tools'

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
