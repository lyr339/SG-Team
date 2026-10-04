import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  CursorQuestionResponder,
  buildAnswerQuestionExpression,
  buildSkipQuestionExpression,
  parseQuestionActionResult
} from '../src/infrastructure/cursor/cursor-question-responder'

describe('cursor question responder', () => {
  it('builds the answer expression around Cursor\'s own currentSelections → submitChat fallback path', () => {
    const expression = buildAnswerQuestionExpression({
      composerId: 'composer-1',
      toolCallId: 'tool-1',
      selections: { direction: ['a'] },
      freeformTexts: {},
      note: '已选择：方案 A'
    })
    // 定位链：composer → ToolFormer → 气泡 → 待决策表；缺任一依赖返回结构化失败而不是半截操作。
    expect(expression).toContain('getHandleIfLoaded(COMPOSER_ID)')
    expect(expression).toContain('cds.getToolFormer(handle)')
    expect(expression).toContain('getBubbleIdByToolCallId(TOOL_CALL_ID)')
    expect(expression).toContain("code: 'question_not_pending'")
    expect(expression).toContain("code: 'unsupported_runtime'")
    // 写法与 Cursor 问卷 UI 点选一致：草稿进 additionalData，状态仍 pending；随后经桥提交触发 onBeforeSubmitChat。
    expect(expression).toContain("status: 'pending', currentSelections: SELECTIONS, freeformTexts: FREEFORM")
    expect(expression).toContain('bridge.submitByComposerId(COMPOSER_ID, NOTE, { ignoreQueuing: true })')
    // 回执只认气泡状态翻到 submitted。
    expect(expression).toContain("if (status === 'submitted') return { ok: true, status: 'submitted' }")
    expect(expression).toContain(JSON.stringify({ direction: ['a'] }))
    expect(expression).toContain(JSON.stringify('已选择：方案 A'))
  })

  it('builds the skip expression exactly like Cursor\'s Skip: cancelled additionalData + rejectToolCall', () => {
    const expression = buildSkipQuestionExpression({ composerId: 'composer-1', toolCallId: 'tool-1' })
    expect(expression).toContain("status: 'cancelled', skipReason: 'user'")
    expect(expression).toContain("toolFormer.rejectToolCall(TOOL_CALL_ID, { skipReason: 'user' })")
    expect(expression).not.toContain('submitByComposerId')
  })

  it('parses page results defensively: unknown shapes never become success', () => {
    expect(parseQuestionActionResult({ ok: true, status: 'submitted' })).toEqual({ ok: true, status: 'submitted' })
    expect(parseQuestionActionResult({ ok: true })).toMatchObject({ ok: false, code: 'unconfirmed' })
    expect(parseQuestionActionResult({ ok: false, code: 'question_not_pending', error: '已处理' }))
      .toEqual({ ok: false, code: 'question_not_pending', message: '已处理' })
    expect(parseQuestionActionResult({ ok: false, code: 'made_up' })).toEqual({ ok: false, code: 'unconfirmed', message: '未知错误' })
    expect(parseQuestionActionResult(undefined)).toMatchObject({ ok: false, code: 'unconfirmed' })
    expect(parseQuestionActionResult('yes')).toMatchObject({ ok: false, code: 'unconfirmed' })
  })

  it('reports cdp_unavailable when no workbench window resolves and submit_failed when evaluation throws', async () => {
    const missing = new CursorQuestionResponder({
      resolveWorkbenchSocket: async () => undefined,
      evaluate: async () => { throw new Error('should not evaluate') }
    })
    expect(await missing.skip('/workspace', { composerId: 'c', toolCallId: 't' })).toMatchObject({ ok: false, code: 'cdp_unavailable' })

    const throwing = new CursorQuestionResponder({
      resolveWorkbenchSocket: async () => 'ws://127.0.0.1:9333/devtools/page/1',
      evaluate: async () => { throw new Error('页面脚本异常：boom') }
    })
    expect(await throwing.answer('/workspace', {
      composerId: 'c', toolCallId: 't', selections: { q: ['a'] }, freeformTexts: {}, note: 'n'
    })).toEqual({ ok: false, code: 'submit_failed', message: '页面脚本异常：boom' })
  })

  it('passes the built expression to the resolved socket and returns the parsed page verdict', async () => {
    const calls: Array<{ socket: string; expression: string }> = []
    const responder = new CursorQuestionResponder({
      resolveWorkbenchSocket: async (workspacePath) => `ws://socket-for-${workspacePath}`,
      evaluate: async (socket, expression) => {
        calls.push({ socket, expression })
        return { ok: true, status: 'submitted' }
      },
      confirmTimeoutMs: 800
    })
    const result = await responder.answer('/workspace/alpha', {
      composerId: 'composer-1', toolCallId: 'tool-1', selections: { q: ['a'] }, freeformTexts: {}, note: '已选择：A'
    })
    expect(result).toEqual({ ok: true, status: 'submitted' })
    expect(calls[0]?.socket).toBe('ws://socket-for-/workspace/alpha')
    expect(calls[0]?.expression).toContain('const CONFIRM_MS = 800;')
  })
})

// 执行实际注入表达式，不只检查生成的字符串。
describe('question expression execution', () => {
  function runtime(blocking = true, modern = false, persistFailure = false) {
    let extra: Record<string, unknown> = { status: 'pending' }
    let pending: Record<string, unknown> = { bubble: { toolCallId: 'tool', blocking } }
    const calls: string[] = []
    const data = { fullConversationHeadersOnly: [] as Array<{ type: number; bubbleId: string }>, conversationMap: {} as Record<string, { text: string }> }
    const tf = {
      getBubbleIdByToolCallId: () => 'bubble', getBubbleData: () => ({ additionalData: extra,
        params: { questions: [{ id: 'q', allowMultiple: false, options: [{ id: 'a', label: 'A' }] }] } }),
      setBubbleData: (_: string, value: { additionalData: Record<string, unknown> }) => { calls.push('draft'); extra = value.additionalData },
      pendingDecisions: () => ({ pendingDecisions: pending }),
      rejectToolCall: () => { calls.push('reject'); pending = {} },
      acceptToolCall: () => { calls.push('accept'); extra.status = 'submitted'; pending = {} }
    }
    const window = {
      vscode: { context: { configuration: () => ({ product: { version: modern ? '3.21.12' : '3.6.31' } }) } },
      __sgComposerService: {
        createComposer: () => ({}),
        composerDataService: { getHandleIfLoaded: () => ({}), getToolFormer: () => tf,
          getComposerDataIfLoaded: () => data,
          manuallyPersistComposerOrThrow: async (id: string) => {
            expect(id).toBe('composer'); calls.push('persist')
            if (persistFailure) throw new Error('disk failure')
          } },
        composerChatService: {
          submitChatMaybeAbortCurrent: (_id: string, note: string) => {
            calls.push('submit'); extra.status = 'submitted'; pending = {}
            data.fullConversationHeadersOnly.push({ type: 1, bubbleId: 'followup' }); data.conversationMap.followup = { text: note }
            return Promise.resolve()
          }
        }
      }
    }
    return { window, calls, extra: () => extra }
  }
  const command = { composerId: 'composer', toolCallId: 'tool', selections: { q: ['a'] }, freeformTexts: {}, note: '已选择 A' }
  it('writes the draft before native submit and requires the resulting status', async () => {
    const r = runtime()
    const result = await runInNewContext(buildAnswerQuestionExpression(command), { window: r.window, setTimeout })
    expect(result).toEqual({ ok: true, status: 'submitted' })
    expect(r.calls).toEqual(['draft', 'submit'])
    expect(r.extra().currentSelections).toEqual({ q: ['a'] })
  })
  it('does not write when a pending decision is not blocking', async () => {
    const r = runtime(false)
    expect(await runInNewContext(buildAnswerQuestionExpression(command), { window: r.window, setTimeout })).toMatchObject({ ok: false, code: 'question_not_pending' })
    expect(r.calls).toEqual([])
  })
  it('rejects through Cursor and verifies removal from the pending table', async () => {
    const r = runtime()
    expect(await runInNewContext(buildSkipQuestionExpression(command), { window: r.window, setTimeout })).toEqual({ ok: true, status: 'cancelled' })
    expect(r.calls).toEqual(['draft', 'reject'])
  })
  it('3.21.12 uses native acceptance without submitting a follow-up that would cancel the question', async () => {
    const r = runtime(true, true)
    expect(await runInNewContext(buildAnswerQuestionExpression(command), { window: r.window, setTimeout })).toEqual({ ok: true, status: 'submitted' })
    expect(r.calls).toEqual(['draft', 'persist', 'accept', 'persist'])
    expect(r.calls).not.toContain('submit')
  })
  it('3.21.12 preserves explicit comments only AFTER accepting and saving the answers', async () => {
    const r = runtime(true, true)
    expect(await runInNewContext(buildAnswerQuestionExpression({ ...command, followupNote: 'User comment' }), { window: r.window, setTimeout })).toEqual({ ok: true, status: 'submitted' })
    expect(r.calls).toEqual(['draft', 'persist', 'accept', 'persist', 'submit'])
  })
  it('3.21.12 rejects incomplete/unknown selections before changing native state', async () => {
    const drafts: Array<Record<string, string[]>> = [{}, { q: ['unknown'] }, { q: ['a', 'a'] }, { q: ['__freeform_other__'] }]
    for (const selections of drafts) {
      const r = runtime(true, true)
      expect(await runInNewContext(buildAnswerQuestionExpression({ ...command, selections }), { window: r.window, setTimeout }))
        .toMatchObject({ ok: false, code: 'submit_failed' })
      expect(r.calls).toEqual([])
    }
  })
  it('3.21.12 does not release a pending decision when saving its draft failed', async () => {
    const r = runtime(true, true, true)
    expect(await runInNewContext(buildAnswerQuestionExpression(command), { window: r.window, setTimeout }))
      .toMatchObject({ ok: false, code: 'submit_failed' })
    expect(r.calls).toEqual(['draft', 'persist'])
    expect(r.extra().status).toBe('pending')
  })
  it('3.21.12 persists skip before rejecting, and restores pending state if persistence failed', async () => {
    const r = runtime(true, true)
    expect(await runInNewContext(buildSkipQuestionExpression(command), { window: r.window, setTimeout })).toEqual({ ok: true, status: 'cancelled' })
    expect(r.calls).toEqual(['draft', 'persist', 'reject'])
    const failed = runtime(true, true, true)
    expect(await runInNewContext(buildSkipQuestionExpression(command), { window: failed.window, setTimeout }))
      .toMatchObject({ ok: false, code: 'submit_failed' })
    expect(failed.calls).toEqual(['draft', 'persist', 'draft'])
    expect(failed.extra().status).toBe('pending')
  })
})
