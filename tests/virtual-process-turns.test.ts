import { describe, expect, it } from 'vitest'
import type { ConversationEntry, ProcessBlock } from '../src/domain/conversation-entry'
import type { LiveProcessState } from '../src/shared/desktop-api'
import { projectVirtualProcessTurns } from '../src/renderer/src/virtual-process-turns'

function user(id: string, timestamp: number, deliveredAt?: number): ConversationEntry {
  return { id, channelId: '1', role: 'user', text: id, timestamp, deliveredAt, status: 'complete', source: 'desktop' }
}

function assistant(id: string, timestamp: number, blocks?: ProcessBlock[]): ConversationEntry {
  return { id, channelId: '1', role: 'assistant', text: id, timestamp, status: 'complete', source: 'cursor', processBlocks: blocks }
}

function block(id: string, startedAt: number): ProcessBlock {
  return { kind: 'thinking', id, text: id, status: 'done', startedAt }
}

function process(blocks: ProcessBlock[]): LiveProcessState {
  return { turn: 'cursor-native-long-turn', blocks, startedAt: 900, updatedAt: 2_000 }
}

describe('projectVirtualProcessTurns', () => {
  it('keeps the current process before a newly queued message until check_messages takes it', () => {
    const turns = projectVirtualProcessTurns([user('queued', 1_000)], process([block('old-work', 1_100)]))
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ id: 'prelude', position: -0.5 })
    expect(turns[0]?.process?.blocks.map((item) => item.id)).toEqual(['old-work'])
  })

  it('splits one native Cursor turn at the authoritative delivery boundary', () => {
    const turns = projectVirtualProcessTurns(
      [user('message-1', 1_000, 1_200)],
      process([block('before-delivery', 1_100), block('after-delivery', 1_300)])
    )
    expect(turns.map((turn) => ({ id: turn.id, position: turn.position, blocks: turn.process?.blocks.map((item) => item.id) }))).toEqual([
      { id: 'prelude', position: -0.5, blocks: ['before-delivery'] },
      { id: 'message-1', position: 0.5, blocks: ['after-delivery'] }
    ])
  })

  it('places a delivered-message process between its user bubble and persisted reply', () => {
    const turns = projectVirtualProcessTurns(
      [user('message-1', 1_000, 1_020), assistant('reply-1', 1_500)],
      process([block('work-1', 1_100)])
    )
    expect(turns[0]).toMatchObject({ id: 'message-1', position: 0.5 })
  })

  it('keeps work for the active message ahead of a later queued message', () => {
    const turns = projectVirtualProcessTurns(
      [user('message-1', 1_000, 1_050), user('queued-2', 1_200)],
      process([block('still-message-1', 1_300)])
    )
    expect(turns[0]).toMatchObject({ id: 'message-1', position: 0.5 })
  })

  it('does not replay blocks already persisted on a reply', () => {
    const persisted = block('persisted', 1_100)
    const turns = projectVirtualProcessTurns(
      [user('message-1', 1_000, 1_020), assistant('reply-1', 1_500, [persisted])],
      process([persisted, block('new', 1_600)])
    )
    expect(turns.flatMap((turn) => turn.process?.blocks.map((item) => item.id) ?? [])).toEqual(['new'])
  })

  it('uses enqueue time as the boundary for immediate non-queue transports', () => {
    const turns = projectVirtualProcessTurns(
      [user('plugin-message', 1_000)], process([block('plugin-work', 1_100)]), undefined, true
    )
    expect(turns[0]).toMatchObject({ id: 'plugin-message', position: 0.5 })
  })

  it('seals the turn at its precisely linked reply and routes post-seal work into the continuation', () => {
    // 8.2-3：回复以 replyToEntryId 精确关联（outboundId 链路），封口之后的块不得进入
    // 已封口回合（周期闪动根因）。传输噪音已在 hook 按气泡整组过滤，能到达这里的封口后
    // 块是 Agent 答完继续干活的真实过程（会话交接后接续任务）：作为该锚点的续作独立呈现，
    // 而不是丢弃。
    const reply: ConversationEntry = {
      ...assistant('reply-1', 1_500), replyToEntryId: 'm1'
    }
    const turns = projectVirtualProcessTurns(
      [user('m1', 1_000, 1_020), reply],
      process([block('work', 1_100), block('follow-up-work', 1_600)])
    )
    expect(turns.map((turn) => ({
      id: turn.id,
      blocks: turn.process?.blocks.map((item) => item.id),
      continuation: turn.continuation?.process?.blocks.map((item) => item.id)
    }))).toEqual([{ id: 'm1', blocks: ['work'], continuation: ['follow-up-work'] }])
    expect(turns[0]?.continuation?.process?.turn).toBe('cursor-native-long-turn:virtual:m1:continuation')
    expect(turns[0]?.continuation?.process?.startedAt).toBe(1_600)
  })

  it('does not create a continuation when the reply has no precise link (legacy time window)', () => {
    // 旧数据无 replyToEntryId → 无关闭边界 → 沿用时间窗：回复后的块仍属回合本身。
    const turns = projectVirtualProcessTurns(
      [user('m1', 1_000, 1_020), assistant('reply-legacy', 1_500)],
      process([block('work', 1_100), block('after-reply', 1_600)])
    )
    expect(turns[0]?.continuation).toBeUndefined()
    expect(turns[0]?.process?.blocks.map((item) => item.id)).toEqual(['work', 'after-reply'])
  })

  it('routes the live response by the same close boundary: after the reply it belongs to the continuation', () => {
    const reply: ConversationEntry = { ...assistant('reply-1', 1_500), replyToEntryId: 'm1' }
    const entries = [user('m1', 1_000, 1_020), reply]
    const before = projectVirtualProcessTurns(
      entries, process([block('work', 1_100)]),
      { id: 'resp-1', channelId: '1', text: '正文', status: 'streaming', startedAt: 1_200, updatedAt: 1_300 }
    )
    expect(before[0]?.response?.id).toBe('resp-1')
    expect(before[0]?.continuation).toBeUndefined()

    const after = projectVirtualProcessTurns(
      entries, undefined,
      { id: 'resp-2', channelId: '1', text: '续作正文', status: 'streaming', startedAt: 1_700, updatedAt: 1_800 }
    )
    expect(after).toHaveLength(1)
    expect(after[0]?.response).toBeUndefined()
    expect(after[0]?.continuation?.response?.id).toBe('resp-2')
    expect(after[0]?.live).toBe(true)
  })

  it('marks the turn live while a continuation block is still running and skips persisted continuation blocks', () => {
    const persisted: ProcessBlock = block('persisted-follow-up', 1_600)
    const reply: ConversationEntry = {
      ...assistant('reply-1', 1_500), replyToEntryId: 'm1', continuationBlocks: [persisted]
    }
    const running: ProcessBlock = { kind: 'tool', id: 'shell-1', toolName: 'Shell', toolKind: 'command', summary: 'npm test', status: 'running', startedAt: 1_700 }
    const turns = projectVirtualProcessTurns(
      [user('m1', 1_000, 1_020), reply],
      process([persisted, running])
    )
    expect(turns[0]?.continuation?.process?.blocks.map((item) => item.id)).toEqual(['shell-1'])
    expect(turns[0]?.live).toBe(true)
  })

  it('keeps the legacy time-window fallback for replies without precise outbound links', () => {
    // 旧数据缺少 outboundId：无关闭边界，封口语义退化为时间窗（不回归旧库）。
    const turns = projectVirtualProcessTurns(
      [user('m1', 1_000, 1_020), assistant('reply-legacy', 1_500)],
      process([block('work', 1_100), block('after-reply', 1_600)])
    )
    expect(turns.map((turn) => ({ id: turn.id, blocks: turn.process?.blocks.map((item) => item.id) })))
      .toEqual([{ id: 'm1', blocks: ['work', 'after-reply'] }])
  })

  it('keeps work between two sealed turns on the earlier turn as its continuation, not on the later turn', () => {
    // 8.2-5：下一条消息 delivered 后创建新回合；两回合之间的块属于前一回合的续作，
    // 不进入后一回合，也不挪进已封口的前一回合正文过程。
    const firstReply: ConversationEntry = { ...assistant('reply-1', 1_500), replyToEntryId: 'm1' }
    const secondReply: ConversationEntry = { ...assistant('reply-2', 2_600), replyToEntryId: 'm2' }
    const turns = projectVirtualProcessTurns(
      [
        user('m1', 1_000, 1_020), firstReply,
        user('m2', 2_000, 2_100), secondReply
      ],
      process([
        block('work-1', 1_100),      // m1 回合内
        block('between', 1_800),     // m1 封口后、m2 投递前 → m1 的续作
        block('work-2', 2_200)       // m2 回合内
      ])
    )
    expect(turns.map((turn) => ({
      id: turn.id,
      blocks: turn.process?.blocks.map((item) => item.id),
      continuation: turn.continuation?.process?.blocks.map((item) => item.id)
    }))).toEqual([
      { id: 'm1', blocks: ['work-1'], continuation: ['between'] },
      { id: 'm2', blocks: ['work-2'], continuation: undefined }
    ])
  })

  it('keeps a sealed turn closed even while the next message is still queued', () => {
    // 8.2-4：下一消息仅入队未投递时不夺走上一轮；已封口回合不再吸收后续块——
    // 它们是该回合的续作（Agent 没回 check_messages 而继续干活，排队消息因此取不走）。
    const reply: ConversationEntry = { ...assistant('reply-1', 1_500), replyToEntryId: 'm1' }
    const turns = projectVirtualProcessTurns(
      [user('m1', 1_000, 1_020), reply, user('queued-2', 1_700)],
      process([block('work-1', 1_100), block('follow-up', 1_600)])
    )
    expect(turns.map((turn) => ({
      id: turn.id,
      blocks: turn.process?.blocks.map((item) => item.id),
      continuation: turn.continuation?.process?.blocks.map((item) => item.id)
    }))).toEqual([{ id: 'm1', blocks: ['work-1'], continuation: ['follow-up'] }])
  })

  it('anchors blocks by their stable first-observation time, not by rehydration time', () => {
    // 8.2-6：无原生 startedAt 的块使用 process.startedAt（首次观测时间）。
    // m2 在观测之后才投递，旧块不得挪入 m2 的新回合。
    const firstReply: ConversationEntry = { ...assistant('reply-1', 1_500), replyToEntryId: 'm1' }
    const observed: ProcessBlock = { kind: 'thinking', id: 'hydrated', text: '转录块', status: 'done' }
    const turns = projectVirtualProcessTurns(
      [user('m1', 1_000, 1_020), firstReply, user('m2', 2_000, 2_100)],
      { turn: 'rehydrated', blocks: [observed, block('fresh', 2_200)], startedAt: 1_100, updatedAt: 2_200 }
    )
    expect(turns.map((turn) => ({ id: turn.id, blocks: turn.process?.blocks.map((item) => item.id) }))).toEqual([
      { id: 'm1', blocks: ['hydrated'] },
      { id: 'm2', blocks: ['fresh'] }
    ])
  })
})
