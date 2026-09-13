import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelMessageRelay } from '../src/application/channel-message-relay'
import { ChannelMessageService } from '../src/application/channel-message-service'
import {
  DesktopSessionService,
  type DesktopSessionTeamSource,
  type DesktopSessionTransport
} from '../src/application/desktop-session-service'
import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import { SqliteChannelMessageRepository } from '../src/infrastructure/channel-messages/sqlite-channel-message-repository'
import { deliveryStateOf, stripKnownSections } from '../src/main/snapshot-push'
import { mergeDesktopSnapshot, snapshotGaps } from '../src/renderer/src/snapshot-sharing'
import type { DesktopSnapshot } from '../src/shared/desktop-api'

/**
 * 主进程侧每通道时间线版本号 → IPC 推送瘦身 → 渲染层按版本合并。
 * 端到端断言：relay 未变 → 版本不变 → 瘦身推送不带时间线、渲染层复用旧数组；
 * relay 变了（新消息 / 投递 / 回复）→ 版本前进 → 只有该通道随推送下发并换新；无关通道不受影响。
 */
function teamSnapshot(): TeamControlSnapshot {
  const run = {
    id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: 'goal', templateId: 'default',
    status: 'running' as const, createdAt: 1, updatedAt: 1
  }
  return {
    ...emptyTeamControlSnapshot(),
    activeWorkspaceId: 'workspace-a',
    workspaces: [{ id: 'workspace-a', name: 'alpha', path: '/workspace/alpha', createdAt: 1, updatedAt: 1 }],
    runs: [run],
    activeRun: run,
    bindings: []
  }
}

class Bridge implements DesktopSessionTransport {
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  constructor(private readonly relay: ChannelMessageRelay) {
    relay.subscribe(() => { for (const listener of this.listeners) listener(this.getSnapshot()) })
  }
  getSnapshot(): DesktopSnapshot {
    return this.relay.applyTo({
      connection: { state: 'connected', endpoint: 'shiguang://local-channel-runtime', attempt: 0, lastError: '' },
      sessions: [],
      conversations: {},
      protocolIssues: [],
      updatedAt: 100
    })
  }
  sendMessage() { return { commandId: 'command-1' } }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

class Team implements DesktopSessionTeamSource {
  private readonly snapshot = teamSnapshot()
  getSnapshot(): TeamControlSnapshot { return structuredClone(this.snapshot) }
  subscribe(): () => void { return () => {} }
  recordComposerBinding(): boolean { return false }
}

describe('conversation revisions across IPC', () => {
  it('unchanged channels keep their revision and are reused after a structured clone; changed channels advance', () => {
    const repository = new SqliteChannelMessageRepository(
      join(mkdtempSync(join(tmpdir(), 'sg-conversation-revisions-')), 'channel.sqlite3')
    )
    const relay = new ChannelMessageRelay(repository)
    const service = new DesktopSessionService(new Bridge(relay), new Team(), {
      readWorkspace: () => ({ availability: 'unavailable', detail: '', composers: [], bindingCandidates: [], updatedAt: 1 })
    }, relay)
    try {
      repository.markChannelEmbedded('1', 'workspace-a', '/workspace/alpha')
      repository.markChannelEmbedded('2', 'workspace-a', '/workspace/alpha')
      relay.resetScope('run-a', 1)
      relay.sendMessage({ channelId: '1', text: '通道一的第一条' })
      relay.sendMessage({ channelId: '2', text: '通道二的第一条' })

      // 渲染层视角：首次拉取完整，快照是 IPC 克隆出来的，引用身份全丢
      let rendered = structuredClone(service.getSnapshot())
      let known = deliveryStateOf(rendered)
      const firstRevisions = rendered.conversationRevisions
      expect(firstRevisions?.['1']).toBeTypeOf('number')
      expect(firstRevisions?.['2']).toBeTypeOf('number')
      expect(firstRevisions?.['1']).not.toBe(firstRevisions?.['2'])

      // 什么都没变（直播帧）：版本号不变，推送整体省略时间线，渲染层沿用旧数组、无缺口
      const idleFull = service.getSnapshot()
      const idlePush = structuredClone(stripKnownSections({ ...idleFull, updatedAt: idleFull.updatedAt + 1 }, known))
      expect(idlePush.conversations).toEqual({})
      expect(idlePush.conversationRevisions).toEqual(firstRevisions)
      const sharedIdle = mergeDesktopSnapshot(rendered, idlePush)
      expect(sharedIdle.conversations['1']).toBe(rendered.conversations['1'])
      expect(sharedIdle.conversations['2']).toBe(rendered.conversations['2'])
      expect(snapshotGaps(sharedIdle)).toEqual([])
      rendered = sharedIdle
      known = deliveryStateOf(idleFull)

      // 通道二多了一条回复：只有通道二换版本、换数组；通道一继续复用
      const channelService = new ChannelMessageService(repository)
      const [pending] = repository.listPendingOutbound('2')
      repository.markOutboundDelivered([pending!.id], Date.now(), { channelId: '2', patch: {
        waiting: false, connectionPhase: 'processing', pendingReplySyncSince: Date.now(), pendingOutboundId: pending!.id
      } })
      channelService.recordReply({ channelId: '2', content: '通道二的回复' })
      relay.pollReplies()
      const afterReplyFull = service.getSnapshot()
      expect(afterReplyFull.conversationRevisions?.['1']).toBe(firstRevisions?.['1'])
      expect(afterReplyFull.conversationRevisions?.['2']).not.toBe(firstRevisions?.['2'])
      // 推送只带变化的通道二
      const afterReplyPush = structuredClone(stripKnownSections(afterReplyFull, known))
      expect(Object.keys(afterReplyPush.conversations)).toEqual(['2'])
      const sharedAfterReply = mergeDesktopSnapshot(rendered, afterReplyPush)
      expect(sharedAfterReply.conversations['1']).toBe(rendered.conversations['1'])
      expect(sharedAfterReply.conversations['2']).toBe(afterReplyPush.conversations['2'])
      expect(sharedAfterReply.conversations['2']?.some((entry) => entry.text === '通道二的回复')).toBe(true)
      expect(snapshotGaps(sharedAfterReply)).toEqual([])
    } finally {
      service.dispose()
      relay.stop()
      repository.close()
    }
  })
})
