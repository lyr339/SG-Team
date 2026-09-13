import { describe, expect, it } from 'vitest'
import { mergeDesktopSnapshot, snapshotGaps } from '../src/renderer/src/snapshot-sharing'
import type { DesktopSnapshot } from '../src/shared/desktop-api'
import type { AgentSession } from '../src/domain/agent-session'
import type { ConversationEntry } from '../src/domain/conversation-entry'

function sessionOf(id: string, task: string): AgentSession {
  return {
    id,
    channelId: id,
    displayName: `Agent ${id}`,
    roleName: '角色',
    status: 'waiting',
    currentTask: task,
    queueDepth: 0,
    connectionPhase: 'waiting',
    online: true,
    connected: true,
    waiting: true,
    telemetry: { state: 'bound', detail: '', source: 'cursor-local' }
  } as AgentSession
}

function entryOf(id: string, text: string): ConversationEntry {
  return { id, channelId: '1', role: 'assistant', text, timestamp: 1, status: 'complete', source: 'cursor' } as ConversationEntry
}

function snapshotOf(overrides: Partial<DesktopSnapshot>): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: '', attempt: 0, lastError: '' },
    sessions: [],
    conversations: {},
    protocolIssues: [],
    updatedAt: 1,
    ...overrides
  } as DesktopSnapshot
}

/** 模拟 webContents.send / invoke 回包：整份快照被结构化克隆，所有引用都是新的。 */
const overIpc = <T>(value: T): T => structuredClone(value)

describe('mergeDesktopSnapshot', () => {
  it('内容未变的会话复用旧引用，变化的才换新', () => {
    const previous = snapshotOf({ sessions: [sessionOf('1', '旧任务'), sessionOf('2', '不变')] })
    const incoming = snapshotOf({ sessions: [sessionOf('1', '新任务'), sessionOf('2', '不变')], updatedAt: 2 })
    const merged = mergeDesktopSnapshot(previous, incoming)
    expect(merged.sessions[0]).not.toBe(previous.sessions[0])
    expect(merged.sessions[1]).toBe(previous.sessions[1])
  })

  it('没有版本号时（预览 / 旧主进程）：同引用的通道数组保留，不同引用整体替换', () => {
    const shared = [entryOf('e1', '你好')]
    const previous = snapshotOf({ conversations: { '1': shared, '2': [entryOf('e2', '旧')] } })
    const incoming = snapshotOf({ conversations: { '1': shared, '2': [entryOf('e2', '新')] }, updatedAt: 2 })
    const merged = mergeDesktopSnapshot(previous, incoming)
    expect(merged.conversations['1']).toBe(shared)
    expect(merged.conversations['2']).toBe(incoming.conversations['2'])
    // 跨 IPC 且无版本号：无法判定未变，按来包为准
    const cloned = overIpc(snapshotOf({ conversations: { '1': [entryOf('e1', '你好')] }, updatedAt: 3 }))
    expect(mergeDesktopSnapshot(previous, cloned).conversations['1']).toBe(cloned.conversations['1'])
  })

  it('跨 IPC 克隆后，版本相同的通道复用本地数组，版本前进的换新', () => {
    const previous = snapshotOf({
      conversations: { '1': [entryOf('e1', '你好')], '2': [entryOf('e2', '旧')] },
      conversationRevisions: { '1': 7, '2': 8 }
    })
    const incoming = overIpc(snapshotOf({
      conversations: { '1': [entryOf('e1', '你好')], '2': [entryOf('e2', '旧'), entryOf('e3', '新回复')] },
      conversationRevisions: { '1': 7, '2': 9 },
      updatedAt: 2
    }))
    const merged = mergeDesktopSnapshot(previous, incoming)
    expect(merged.conversations['1']).toBe(previous.conversations['1'])
    expect(merged.conversations['2']).toBe(incoming.conversations['2'])
    expect(merged.conversationRevisions).toEqual({ '1': 7, '2': 9 })
  })

  it('瘦身推送：版本表完整、数组被省略的通道沿用本地数组；版本表里没有的通道即移除', () => {
    const previous = snapshotOf({
      conversations: { '1': [entryOf('e1', '你好')], '2': [entryOf('e2', '旧')], '3': [entryOf('e3', '将被移除')] },
      conversationRevisions: { '1': 7, '2': 8, '3': 9 }
    })
    const push = overIpc(snapshotOf({
      conversations: { '2': [entryOf('e2', '旧'), entryOf('e4', '新')] },
      conversationRevisions: { '1': 7, '2': 10 },
      updatedAt: 2
    }))
    const merged = mergeDesktopSnapshot(previous, push)
    expect(merged.conversations['1']).toBe(previous.conversations['1'])
    expect(merged.conversations['2']).toBe(push.conversations['2'])
    expect(merged.conversations['3']).toBeUndefined()
    expect(merged.conversationRevisions).toEqual({ '1': 7, '2': 10 })
    expect(snapshotGaps(merged)).toEqual([])
  })

  it('迟到的完整拉取回包：只补本地缺失或更旧的通道，不回退、不删通道、不覆盖直播态', () => {
    const live = { id: 'b1', channelId: '2', text: '正在生成', status: 'streaming' as const, startedAt: 10, updatedAt: 20 }
    // 本地：推送先到，通道 2 因瘦身而缺数组（主进程以为拉取回包已送达）
    const previous = snapshotOf({
      sessions: [sessionOf('1', '新任务')],
      conversations: { '1': [entryOf('e1', '你好')] },
      conversationRevisions: { '1': 7, '2': 8, '9': 12 },
      liveAgentResponses: { '2': live },
      updatedAt: 5
    })
    expect(snapshotGaps(previous)).toEqual(['conversation:2@8', 'conversation:9@12'])
    const latePull = overIpc(snapshotOf({
      sessions: [sessionOf('1', '旧任务')],
      conversations: { '1': [entryOf('e1', '更旧的你好')], '2': [entryOf('e2', '通道二历史')] },
      conversationRevisions: { '1': 6, '2': 8 },
      updatedAt: 3
    }))
    const merged = mergeDesktopSnapshot(previous, latePull)
    expect(merged.sessions).toBe(previous.sessions)
    expect(merged.liveAgentResponses?.['2']).toBe(live)
    expect(merged.updatedAt).toBe(5)
    expect(merged.conversations['1']).toBe(previous.conversations['1'])
    expect(merged.conversations['2']).toBe(latePull.conversations['2'])
    expect(merged.conversations['9']).toBeUndefined()
    expect(merged.conversationRevisions).toEqual({ '1': 7, '2': 8, '9': 12 })
    expect(snapshotGaps(merged)).toEqual(['conversation:9@12'])
  })

  it('迟到但没带来任何新通道数组的包：原状态对象原样保留（不触发重渲）', () => {
    const previous = snapshotOf({
      conversations: { '1': [entryOf('e1', '你好')] },
      conversationRevisions: { '1': 7 },
      updatedAt: 5
    })
    const staleSame = overIpc(snapshotOf({ conversations: { '1': [entryOf('e1', '你好')] }, conversationRevisions: { '1': 7 }, updatedAt: 4 }))
    expect(mergeDesktopSnapshot(previous, staleSame)).toBe(previous)
    const staleOlder = overIpc(snapshotOf({ conversations: { '1': [entryOf('e1', '更旧')] }, conversationRevisions: { '1': 6 }, updatedAt: 4 }))
    expect(mergeDesktopSnapshot(previous, staleOlder)).toBe(previous)
  })

  it('模型目录按版本合并：省略时沿用本地，版本前进换新，缺口可识别', () => {
    const models = [{ modelId: 'claude', displayName: 'Claude' }] as DesktopSnapshot['cursorModels']
    const previous = snapshotOf({ cursorModels: models, cursorModelsRevision: 3, conversationRevisions: {}, updatedAt: 1 })
    // 瘦身推送：目录省略、版本相同 → 沿用本地引用
    const omitted = overIpc(snapshotOf({ cursorModelsRevision: 3, conversationRevisions: {}, updatedAt: 2 }))
    expect(mergeDesktopSnapshot(previous, omitted).cursorModels).toBe(models)
    // 版本前进且带目录 → 换新
    const advanced = overIpc(snapshotOf({ cursorModels: [{ modelId: 'gpt', displayName: 'GPT' }] as DesktopSnapshot['cursorModels'], cursorModelsRevision: 4, conversationRevisions: {}, updatedAt: 3 }))
    expect(mergeDesktopSnapshot(previous, advanced).cursorModels?.[0]?.modelId).toBe('gpt')
    // 版本前进却省略（竞态窗口）→ 记版本留空，缺口可识别
    const gap = mergeDesktopSnapshot(previous, overIpc(snapshotOf({ cursorModelsRevision: 5, conversationRevisions: {}, updatedAt: 4 })))
    expect(gap.cursorModels).toBeUndefined()
    expect(snapshotGaps(gap)).toEqual(['cursorModels@5'])
    // 迟到的完整包补上目录，不动其余状态
    const late = overIpc(snapshotOf({ cursorModels: [{ modelId: 'late', displayName: 'Late' }] as DesktopSnapshot['cursorModels'], cursorModelsRevision: 5, conversationRevisions: {}, updatedAt: 1 }))
    const repaired = mergeDesktopSnapshot(gap, late)
    expect(repaired.cursorModels?.[0]?.modelId).toBe('late')
    expect(repaired.updatedAt).toBe(4)
  })

  it('迟到且没有版本号的旧快照整体丢弃', () => {
    const previous = snapshotOf({ sessions: [sessionOf('1', '新')], conversations: { '1': [entryOf('e1', '新')] }, updatedAt: 5 })
    const stale = snapshotOf({ sessions: [sessionOf('1', '旧')], conversations: { '1': [entryOf('e1', '旧')] }, updatedAt: 4 })
    expect(mergeDesktopSnapshot(previous, stale)).toBe(previous)
  })

  it('实时回答状态按通道保持结构共享', () => {
    const live = {
      id: 'bubble-1', channelId: '1', text: '正在生成', status: 'streaming' as const,
      startedAt: 10, updatedAt: 20
    }
    const previous = snapshotOf({ liveAgentResponses: { '1': live } })
    const incoming = snapshotOf({ liveAgentResponses: { '1': live }, updatedAt: 2 })
    expect(mergeDesktopSnapshot(previous, incoming).liveAgentResponses?.['1']).toBe(live)
  })

  it('初始快照（updatedAt=0）与同一对象直接放行', () => {
    const initial = snapshotOf({ updatedAt: 0 })
    const incoming = snapshotOf({ sessions: [sessionOf('1', '任务')], updatedAt: 1 })
    expect(mergeDesktopSnapshot(initial, incoming)).toBe(incoming)
    expect(mergeDesktopSnapshot(incoming, incoming)).toBe(incoming)
  })
})
