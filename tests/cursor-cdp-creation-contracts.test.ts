import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CursorCdpSessionCreator } from '../src/infrastructure/cursor/cursor-cdp-session-creator'

type Submission = 'completed' | 'long-running' | 'rejected' | 'not-rendered'
interface Composer {
  composerId: string
  status: string
  fullConversationHeadersOnly: Array<{ bubbleId: string; type: number }>
  conversationMap: Record<string, { text: string; errorDetails?: { message: string } }>
  modelConfig?: Record<string, unknown>
}

/** Run the real creation expression; model, persistence and submit behavior are isolated native-contract doubles. */
function fixture(submission: Submission) {
  const handles = new Map<string, { data: Composer }>()
  const persisted: string[] = []
  let sequence = 0
  const ds = {
    allComposersData: { allComposers: [] as Array<{ composerId: string }> },
    getComposerDataIfLoaded: (id: string) => handles.get(id)?.data,
    getHandleIfLoaded: (id: string) => handles.get(id),
    manuallyPersistComposer: async (id: string) => {
      expect(typeof id).toBe('string')
      if (handles.has(id)) persisted.push(id)
    }
  }
  const service = {
    composerDataService: ds,
    createComposer: async () => {
      const composerId = `composer-${++sequence}`
      handles.set(composerId, { data: { composerId, status: 'none', fullConversationHeadersOnly: [], conversationMap: {} } })
      ds.allComposersData.allComposers.push({ composerId })
      return { composerId }
    },
    modelConfigService: {
      setModelConfigForComposer(handle: { data: Composer }, config: Record<string, unknown>, surface: string, options: unknown) {
        expect(surface).toBe('composer'); expect(options).toEqual({ updateGlobalConfig: false })
        handle.data.modelConfig = structuredClone(config)
      },
      getEffectiveModelConfigForComposer: (handle: { data: Composer }) => handle.data.modelConfig
    },
    composerChatService: {
      submitChatMaybeAbortCurrent: async (id: string, text: string) => {
        const data = handles.get(id)!.data
        if (submission === 'not-rendered') return
        data.fullConversationHeadersOnly.push({ bubbleId: 'human', type: 1 })
        data.conversationMap.human = { text }
        if (submission === 'rejected') {
          data.fullConversationHeadersOnly.push({ bubbleId: 'error', type: 2 })
          data.conversationMap.error = { text: '', errorDetails: { message: 'Git Required' } }
          return // Cursor 3.21.12's native refusal path resolves normally, without throwing.
        }
        if (submission === 'long-running') { data.status = 'generating'; return new Promise(() => {}) }
        data.status = 'completed'
      }
    }
  }
  const creator = new CursorCdpSessionCreator({
    fetchTargets: async () => [{ id: 'fixture', type: 'page', title: 'fixture', url: 'file:///workbench.html', webSocketDebuggerUrl: 'ws://fixture' }],
    ensureComposerService: async () => true,
    evaluate: async (_url, expression) => runInNewContext(expression, { window: { __sgComposerService: service }, Date, setTimeout })
  })
  return { creator, persisted, handles }
}

describe('Cursor creation receipts and per-composer persistence', () => {
  it('does not turn a native normal-return refusal into a successful launch', async () => {
    const { creator } = fixture('rejected')
    const result = await creator.createAgentSession({ channelId: '1', name: 'audit', prompt: 'start' })
    expect(result).toMatchObject({ ok: false, composerId: 'composer-1', message: expect.stringContaining('Git Required') })
  })
  it('does not accept a resolved submit promise when no human message was rendered', async () => {
    const { creator } = fixture('not-rendered')
    expect(await creator.createAgentSession({ channelId: '1', name: 'audit', prompt: 'start' }))
      .toMatchObject({ ok: false, message: expect.stringContaining('没有核验到开场提示词') })
  })
  it('returns promptly for long-lived Agent runs without waiting for run completion', async () => {
    const { creator } = fixture('long-running')
    expect(await creator.createAgentSession({ channelId: '1', name: 'audit', prompt: 'start' }))
      .toMatchObject({ ok: true, composerId: 'composer-1', message: expect.stringContaining('异步受理') })
  })
  it('persists two independent model selections by composerId before submitting', async () => {
    const { creator, persisted, handles } = fixture('completed')
    const results = await Promise.all(['model-one', 'model-two'].map((modelId, index) => creator.createAgentSession({
      channelId: String(index + 1), name: modelId, prompt: `start ${modelId}`,
      modelSelection: { modelId, displayName: modelId, parameters: [], maxMode: false }
    })))
    expect(results.every((result) => result.ok)).toBe(true)
    expect(new Set(results.map((result) => result.composerId)).size).toBe(2)
    expect(persisted).toEqual(['composer-1', 'composer-2'])
    expect(handles.get('composer-1')!.data.modelConfig?.modelName).toBe('model-one')
    expect(handles.get('composer-2')!.data.modelConfig?.modelName).toBe('model-two')
  })
})
