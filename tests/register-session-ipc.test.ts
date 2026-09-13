import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopSessionBridge } from '../src/application/desktop-session-service'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import { registerSessionIpc } from '../src/main/register-session-ipc'
import { stripKnownSections } from '../src/main/snapshot-push'
import { IPC, type DesktopSnapshot } from '../src/shared/desktop-api'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name)
  }
}))
vi.mock('../src/main/ipc-security', () => ({ assertTrustedSender: vi.fn() }))

function entryOf(id: string, text: string): ConversationEntry {
  return { id, channelId: '1', role: 'assistant', text, timestamp: 1, status: 'complete', source: 'cursor' } as ConversationEntry
}

function snapshotOf(
  conversations: DesktopSnapshot['conversations'],
  conversationRevisions: Record<string, number> | undefined,
  updatedAt = 1
): DesktopSnapshot {
  return {
    connection: { state: 'connected', endpoint: '', attempt: 0, lastError: '' },
    sessions: [],
    conversations,
    ...(conversationRevisions ? { conversationRevisions } : {}),
    protocolIssues: [],
    updatedAt
  }
}

/** 渲染进程替身：记录推送、可模拟页面重载。 */
class FakeContents extends EventEmitter {
  readonly sent: DesktopSnapshot[] = []
  send(_channel: string, payload: DesktopSnapshot): void { this.sent.push(payload) }
  reload(): void { this.emit('did-start-loading') }
}

function harness() {
  handlers.clear()
  const contents = new FakeContents()
  const window = { isDestroyed: () => false, webContents: contents }
  const listeners = new Set<(snapshot: DesktopSnapshot) => void>()
  let current = snapshotOf({}, {})
  const bridge: DesktopSessionBridge = {
    getSnapshot: () => current,
    sendMessage: () => ({ commandId: 'c' }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
  }
  const dispose = registerSessionIpc(bridge, () => window as never)
  const publish = (snapshot: DesktopSnapshot): void => { current = snapshot; for (const listener of listeners) listener(snapshot) }
  const pull = (): DesktopSnapshot => handlers.get(IPC.getSnapshot)!({ sender: contents, senderFrame: null }) as DesktopSnapshot
  return { contents, publish, pull, dispose }
}

describe('stripKnownSections', () => {
  const entries = { '1': [entryOf('a', '一')], '2': [entryOf('b', '二')] }

  it('无版本号或接收方一无所知时原样返回同一对象', () => {
    const legacy = snapshotOf(entries, undefined)
    expect(stripKnownSections(legacy, { conversationRevisions: { '1': 1 } })).toBe(legacy)
    const fresh = snapshotOf(entries, { '1': 1, '2': 2 })
    expect(stripKnownSections(fresh, undefined)).toBe(fresh)
  })

  it('只剔除接收方已持有同版本的通道，版本表保持完整', () => {
    const snapshot = snapshotOf(entries, { '1': 1, '2': 2 })
    const stripped = stripKnownSections(snapshot, { conversationRevisions: { '1': 1, '2': 1 } })
    expect(Object.keys(stripped.conversations)).toEqual(['2'])
    expect(stripped.conversationRevisions).toEqual({ '1': 1, '2': 2 })
    expect(stripKnownSections(snapshot, { conversationRevisions: { '1': 1, '2': 2 } }).conversations).toEqual({})
    // 没有可剔除的段落时不新建对象
    expect(stripKnownSections(snapshot, { conversationRevisions: { '9': 3 } })).toBe(snapshot)
  })

  it('模型目录只在接收方已持有同版本时省略，版本号保留', () => {
    const models = [{ modelId: 'claude', displayName: 'Claude' }] as DesktopSnapshot['cursorModels']
    const snapshot = { ...snapshotOf(entries, { '1': 1 }), cursorModels: models, cursorModelsRevision: 7 }
    const kept = stripKnownSections(snapshot, { conversationRevisions: {}, cursorModelsRevision: 6 })
    expect(kept.cursorModels).toBe(models)
    const omitted = stripKnownSections(snapshot, { conversationRevisions: {}, cursorModelsRevision: 7 })
    expect(omitted.cursorModels).toBeUndefined()
    expect(omitted.cursorModelsRevision).toBe(7)
    expect(omitted.conversations).toEqual(snapshot.conversations)
  })
})

describe('registerSessionIpc 推送瘦身', () => {
  it('首次推送完整；未变通道随后省略；页面重载后重新完整', () => {
    const { contents, publish, dispose } = harness()
    try {
      const first = snapshotOf({ '1': [entryOf('a', '一')], '2': [entryOf('b', '二')] }, { '1': 1, '2': 2 }, 1)
      publish(first)
      expect(contents.sent[0]).toBe(first)

      // 只有通道 2 变了：通道 1 省略，版本表完整
      const second = snapshotOf({ '1': first.conversations['1']!, '2': [entryOf('b', '二'), entryOf('c', '三')] }, { '1': 1, '2': 3 }, 2)
      publish(second)
      expect(Object.keys(contents.sent[1]!.conversations)).toEqual(['2'])
      expect(contents.sent[1]!.conversationRevisions).toEqual({ '1': 1, '2': 3 })

      // 什么都没变（直播帧）：时间线整体省略
      publish({ ...second, updatedAt: 3 })
      expect(contents.sent[2]!.conversations).toEqual({})
      expect(contents.sent[2]!.conversationRevisions).toEqual({ '1': 1, '2': 3 })

      // 渲染层重载：本地状态归零，下一份必须完整
      contents.reload()
      publish({ ...second, updatedAt: 4 })
      expect(Object.keys(contents.sent[3]!.conversations).sort()).toEqual(['1', '2'])
    } finally {
      dispose()
    }
  })

  it('拉取永远完整，且把拉取回包记为已送达，随后的推送据此省略', () => {
    const { contents, publish, pull, dispose } = harness()
    try {
      const full = snapshotOf({ '1': [entryOf('a', '一')] }, { '1': 5 }, 1)
      publish(full)
      contents.reload()
      publish(full)
      const pulled = pull()
      expect(pulled).toBe(full)
      publish({ ...full, updatedAt: 2 })
      expect(contents.sent.at(-1)!.conversations).toEqual({})
      // 再拉一次仍然完整
      expect(Object.keys(pull().conversations)).toEqual(['1'])
    } finally {
      dispose()
    }
  })

  it('模型目录同样按版本省略：未变省略、变化后重发、拉取回包始终带目录', () => {
    const { contents, publish, pull, dispose } = harness()
    try {
      const models = [{ modelId: 'claude', displayName: 'Claude' }] as DesktopSnapshot['cursorModels']
      const first = { ...snapshotOf({ '1': [entryOf('a', '一')] }, { '1': 1 }, 1), cursorModels: models, cursorModelsRevision: 2 }
      publish(first)
      expect(contents.sent[0]!.cursorModels).toBe(models)
      publish({ ...first, updatedAt: 2 })
      expect(contents.sent[1]!.cursorModels).toBeUndefined()
      expect(contents.sent[1]!.cursorModelsRevision).toBe(2)
      expect(Object.keys(pull().cursorModels ?? {})).toHaveLength(1)
      const changed = [{ modelId: 'gpt', displayName: 'GPT' }] as DesktopSnapshot['cursorModels']
      publish({ ...first, cursorModels: changed, cursorModelsRevision: 3, updatedAt: 3 })
      expect(contents.sent[2]!.cursorModels).toBe(changed)
      expect(contents.sent[2]!.conversations).toEqual({})
    } finally {
      dispose()
    }
  })

  it('无版本号的快照（旧主进程 / 无内嵌通道）原样推送', () => {
    const { contents, publish, dispose } = harness()
    try {
      const legacy = snapshotOf({ '1': [entryOf('a', '一')] }, undefined, 1)
      publish(legacy)
      publish({ ...legacy, updatedAt: 2 })
      expect(contents.sent[1]!.conversations).toEqual(legacy.conversations)
    } finally {
      dispose()
    }
  })
})
