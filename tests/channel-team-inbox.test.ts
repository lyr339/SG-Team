import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelMessageService } from '../src/application/channel-message-service'
import { createChannelTeamInbox, type ChannelTeamInbox } from '../src/application/channel-team-inbox'
import { ORPHANED_RECEIPT_DETAIL, teamMessageReceiptStage } from '../src/domain/team-collaboration'
import { createConfiguredTeamBundle } from '../src/domain/team-control'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { SqliteTeamCollaborationRepository } from '../src/infrastructure/team-collaboration/sqlite-team-collaboration-repository'
import { SqliteTeamControlRepository } from '../src/infrastructure/team-control/sqlite-team-control-repository'

/**
 * 团队消息随 check_messages 内联投递（阶段 4 · 4C）：收件查询、投递即已读、适配器与长轮询的衔接。
 * A 组：CH-1 lead · CH-2 builder · CH-3 reviewer；B 组：CH-4 lead；CH-5 独立席位。
 */
function poolFixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sg-team-inbox-')), 'team.sqlite3')
  const control = new SqliteTeamControlRepository(path)
  const collaboration = new SqliteTeamCollaborationRepository(path)
  const channels = new SqliteChannelMessageRepository(path)
  const bundle = createConfiguredTeamBundle({
    workspaceId: 'pool', workspaceName: 'pool', workspacePath: '/workspace/pool', now: 100,
    mode: 'independent', runKey: 'run-pool',
    members: ['1', '2', '3', '4', '5'].map((channelId) => ({ channelId, roleTemplateKey: 'solo', avatarId: 'researcher', skills: [], solo: true }))
  })
  control.upsertWorkspaceTeam(bundle)
  control.recordInstallation({
    workspaceId: 'pool', runId: bundle.run.id, generation: 'gen',
    agents: bundle.slots.map((slot) => ({
      agentSessionId: `pool:ch-${slot.channelId}:gen`, workspaceId: 'pool',
      channelId: slot.channelId!, generation: 'gen', runId: bundle.run.id, capabilities: []
    }))
  })
  const slotIdOf = (channelId: string) => bundle.slots.find((slot) => slot.channelId === channelId)!.id
  const groupA = control.createGroup({
    runId: bundle.run.id, name: 'A 组', goal: 'A 目标', leadSlotId: slotIdOf('1'),
    members: [
      { slotId: slotIdOf('1'), roleTemplateKey: 'lead' },
      { slotId: slotIdOf('2'), roleTemplateKey: 'builder' },
      { slotId: slotIdOf('3'), roleTemplateKey: 'reviewer' }
    ]
  }).group
  const groupB = control.createGroup({
    runId: bundle.run.id, name: 'B 组', leadSlotId: slotIdOf('4'),
    members: [{ slotId: slotIdOf('4'), roleTemplateKey: 'lead' }]
  }).group
  const inbox = createChannelTeamInbox({ ownershipFor: (channelId) => control.resolveChannelSessionOwner(channelId), collaboration })
  let sequence = 0
  const send = (from: string | 'operator', to: string, kind: 'directive' | 'question' | 'status' | 'notice', content: string, subject?: string) =>
    collaboration.createMessage({
      runId: bundle.run.id,
      sender: from === 'operator' ? { type: 'operator' } : { type: 'agent', slotId: slotIdOf(from) },
      recipient: { type: 'agent', slotId: slotIdOf(to) },
      kind,
      content,
      subject,
      clientMessageId: `inbox-test-${(sequence += 1).toString().padStart(4, '0')}`
    })
  const unreadOf = (channelId: string, groupId = groupA.id) => collaboration.listUnreadForRecipient({
    runId: bundle.run.id, slotId: slotIdOf(channelId), groupId, limit: 10
  })
  return {
    control, collaboration, channels, runId: bundle.run.id, groupA, groupB, slotIdOf, inbox, send, unreadOf,
    close: () => { channels.close(); collaboration.close(); control.close() }
  }
}

describe('团队消息收件查询与投递即已读', () => {
  it('lists only unread messages addressed to the seat inside its current group, in insertion order, with the thread subject', () => {
    const data = poolFixture()
    try {
      const first = data.send('1', '2', 'directive', '先实现接口', '接口层')
      const second = data.send('operator', '2', 'notice', '拾光提醒')
      data.send('1', '3', 'directive', '准备验收')
      const read = data.send('1', '2', 'question', '已经读过的问题')
      data.collaboration.markRead(read.id, { type: 'agent', slotId: data.slotIdOf('2') })

      const unread = data.unreadOf('2')
      expect(unread.map((message) => message.id)).toEqual([first.id, second.id])
      expect(unread[0]).toMatchObject({ kind: 'directive', subject: '接口层', content: '先实现接口', groupId: data.groupA.id })
      // 别的组查询不到 A 组消息。
      expect(data.unreadOf('2', data.groupB.id)).toEqual([])
    } finally {
      data.close()
    }
  })

  it('marks a delivered batch notified + read in one transaction, idempotently, and only for the real recipient', () => {
    const data = poolFixture()
    try {
      const message = data.send('1', '2', 'directive', '先实现接口')
      expect(data.collaboration.markDelivered([message.id], { type: 'agent', slotId: data.slotIdOf('3') })).toEqual([])
      expect(data.collaboration.markDelivered([message.id], { type: 'agent', slotId: data.slotIdOf('2') }, 5_000)).toEqual([message.id])
      expect(data.collaboration.markDelivered([message.id], { type: 'agent', slotId: data.slotIdOf('2') })).toEqual([])

      const snapshot = data.collaboration.loadRun(data.runId)
      expect(snapshot.messages[message.id]!.receipt).toMatchObject({ notificationState: 'notified', notifiedAt: 5_000, readAt: 5_000 })
      expect(teamMessageReceiptStage(snapshot.messages[message.id]!.receipt)).toBe('read')
      expect(snapshot.events.filter((event) => event.type === 'message.read' && event.messageId === message.id))
        .toMatchObject([{ detail: 'delivered_by_check_messages', actor: { type: 'agent', slotId: data.slotIdOf('2') } }])
      expect(data.unreadOf('2')).toEqual([])
    } finally {
      data.close()
    }
  })

  it('never delivers orphaned receipts, even after the seat rejoins the same group', () => {
    const data = poolFixture()
    try {
      const directive = data.send('1', '2', 'directive', '出组前的指令')
      data.control.removeGroupMember({ groupId: data.groupA.id, slotId: data.slotIdOf('2') })
      data.collaboration.orphanPendingReceipts({ runId: data.runId, slotId: data.slotIdOf('2'), groupId: data.groupA.id })
      data.control.addGroupMembers({ groupId: data.groupA.id, members: [{ slotId: data.slotIdOf('2'), roleTemplateKey: 'builder' }] })
      expect(data.collaboration.loadRun(data.runId).messages[directive.id]!.receipt.notificationDetail).toContain(ORPHANED_RECEIPT_DETAIL)
      expect(data.unreadOf('2')).toEqual([])
    } finally {
      data.close()
    }
  })

  it('adapts rows into an inbox batch with sender labels and the respond rule; solo seats and ended pools get nothing', () => {
    const data = poolFixture()
    try {
      data.send('operator', '2', 'directive', '【系统任务调度】任务 ID：task-1', '新任务')
      data.send('1', '2', 'question', '字段命名定了吗？', '接口约定')
      data.send('3', '2', 'status', '验收环境已就绪')
      const batch = data.inbox.unread('2', 10)!
      expect(batch).toMatchObject({ runId: data.runId, slotId: data.slotIdOf('2') })
      expect(batch.messages.map((message) => [message.kind, message.senderLabel, message.needsResponse])).toEqual([
        ['directive', '拾光系统', false],
        ['question', expect.stringMatching(/ · CH-1$/), true],
        ['status', expect.stringMatching(/ · CH-3$/), false]
      ])
      expect(data.inbox.unread('5', 10)).toBeUndefined()
      expect(data.inbox.unread('99', 10)).toBeUndefined()
      data.inbox.markDelivered(batch, Date.now())
      expect(data.inbox.unread('2', 10)).toBeUndefined()

      data.send('1', '3', 'directive', '收尾前的最后一条')
      data.control.completeRun(data.runId, Date.now())
      expect(data.inbox.unread('3', 10)).toBeUndefined()
    } finally {
      data.close()
    }
  })
})

describe('check_messages 与团队消息批次', () => {
  const quick = { keepaliveTimeoutMs: 1_000, pollIntervalMs: 50 }

  it('delivers the team batch only when the outbox is empty, without opening the reply gate', async () => {
    const data = poolFixture()
    try {
      const service = new ChannelMessageService(data.channels, data.inbox)
      data.send('1', '2', 'directive', '先实现接口')
      data.channels.enqueueOutbound('2', '用户：顺便看看日志', 1_000)

      const user = await service.checkMessages({ channelId: '2', ...quick })
      expect(user).toMatchObject({ type: 'delivered', message: { text: '用户：顺便看看日志' } })
      service.recordReply({ channelId: '2', content: '日志没有异常。' })

      const team = await service.checkMessages({ channelId: '2', ...quick })
      expect(team.type).toBe('team')
      if (team.type === 'team') expect(team.batch.messages.map((message) => message.content)).toEqual(['先实现接口'])
      expect(data.channels.getPresence('2')).toMatchObject({ connectionPhase: 'processing' })
      expect(data.channels.getPresence('2')?.pendingReplySyncSince).toBeUndefined()
      // 没有守门：不必 record_reply 就能继续轮询，已读的消息不会再来。
      expect((await service.checkMessages({ channelId: '2', ...quick })).type).toBe('keepalive')
    } finally {
      data.close()
    }
  })

  it('retires envelope rows written by the pre-phase-4 dispatcher and delivers the message itself instead', async () => {
    const data = poolFixture()
    try {
      const message = data.send('1', '2', 'directive', '信封指向的指令')
      data.channels.enqueueOutbound('2', `【拾光内部协作通知】\n消息 ID：${message.id}`, 1_000, undefined, true)
      const service = new ChannelMessageService(data.channels, data.inbox)
      const result = await service.checkMessages({ channelId: '2', ...quick })
      expect(result.type).toBe('team')
      if (result.type === 'team') expect(result.batch.messages.map((entry) => entry.id)).toEqual([message.id])
      expect(data.channels.listPendingOutbound('2')).toEqual([])
      expect(data.channels.listOutboundSince(0)[0]).toMatchObject({ kind: 'internal', retiredAt: expect.any(Number), deliveredAt: undefined })
    } finally {
      data.close()
    }
  })

  it('keeps the batch unread when the receipt write fails and delivers it on the next poll round', async () => {
    const data = poolFixture()
    try {
      data.send('1', '2', 'directive', '先实现接口')
      let failures = 1
      const flaky: ChannelTeamInbox = {
        unread: (channelId, limit) => data.inbox.unread(channelId, limit),
        markDelivered: (batch, at) => {
          if (failures > 0) {
            failures -= 1
            throw Object.assign(new Error('database is locked'), { errcode: 5 })
          }
          data.inbox.markDelivered(batch, at)
        }
      }
      const result = await new ChannelMessageService(data.channels, flaky).checkMessages({ channelId: '2', ...quick })
      expect(result.type).toBe('team')
      expect(failures).toBe(0)
      expect(data.unreadOf('2')).toEqual([])
    } finally {
      data.close()
    }
  })
})
