import { ipcMain, type BrowserWindow } from 'electron'
import type { CursorQuestionService } from '../application/cursor-question-service'
import { IPC, type CursorQuestionAnswerInput, type CursorQuestionSkipInput } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'
import { beginPageOperation, failPageOperation, finishPageOperation, notificationOperationId, type PageOperationObserver } from '../application/notifications/page-operation-notifications'
import type { NotificationScope, NotificationTarget } from '../domain/notification'

function questionRefOf(value: unknown): CursorQuestionSkipInput {
  if (!value || typeof value !== 'object') throw new Error('提问参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.channelId !== 'string' || typeof raw.toolCallId !== 'string') throw new Error('提问参数无效')
  return { channelId: raw.channelId, toolCallId: raw.toolCallId }
}

function answerInputOf(value: unknown): CursorQuestionAnswerInput {
  const ref = questionRefOf(value)
  const raw = value as Record<string, unknown>
  return {
    ...ref,
    selections: raw.selections && typeof raw.selections === 'object' && !Array.isArray(raw.selections)
      ? raw.selections as Record<string, string[]>
      : {},
    ...(raw.freeformTexts && typeof raw.freeformTexts === 'object' && !Array.isArray(raw.freeformTexts)
      ? { freeformTexts: raw.freeformTexts as Record<string, string> }
      : {}),
    ...(typeof raw.note === 'string' ? { note: raw.note } : {})
  }
}

/** 拾光会话页回答 / 跳过 Cursor 原生 ask_question；字段级校验与投递由 CursorQuestionService 负责。 */
export function registerCursorQuestionIpc(
  service: CursorQuestionService,
  getWindow: () => BrowserWindow | undefined,
  options: { operations?: PageOperationObserver; sourceTarget?: (channelId: string, toolCallId: string) => { scope: NotificationScope; target?: NotificationTarget } } = {}
): () => void {
  ipcMain.handle(IPC.answerCursorQuestion, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const answer = answerInputOf(input)
    let source: ReturnType<NonNullable<typeof options.sourceTarget>> | undefined
    try { source = options.sourceTarget?.(answer.channelId, answer.toolCallId) } catch {}
    const operation = beginPageOperation(options.operations, { kind: 'question-answer', id: notificationOperationId(input), ...source })
    try {
      const result = await service.answer(answer)
      if (result.ok) { finishPageOperation(operation, { state: 'success', facts: ['Cursor 原接口已确认这组答案提交，具体问卷状态以原会话为准。'] }); return result }
      const notification = finishPageOperation(operation, { state: result.code === 'unconfirmed' || result.code === 'submit_failed' ? 'unconfirmed' : 'failed',
        facts: ['原接口没有确认本次提交完成。请到原会话核对，不会自动再提交一次。'] })
      return notification ? { ...result, notification } : result
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  ipcMain.handle(IPC.skipCursorQuestion, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    const ref = questionRefOf(input)
    let source: ReturnType<NonNullable<typeof options.sourceTarget>> | undefined
    try { source = options.sourceTarget?.(ref.channelId, ref.toolCallId) } catch {}
    const operation = beginPageOperation(options.operations, { kind: 'question-skip', id: notificationOperationId(input), ...source })
    try {
      const result = await service.skip(ref)
      if (result.ok) { finishPageOperation(operation, { state: 'success', facts: ['Cursor 原接口已确认跳过这组问题；没有从裁剪或消失推测取消。'] }); return result }
      const notification = finishPageOperation(operation, { state: result.code === 'unconfirmed' || result.code === 'submit_failed' ? 'unconfirmed' : 'failed',
        facts: ['原接口没有确认跳过完成。请回原会话核对，不会自动再次跳过。'] })
      return notification ? { ...result, notification } : result
    } catch (error) { failPageOperation(operation, error); throw error }
  })
  return () => {
    ipcMain.removeHandler(IPC.answerCursorQuestion)
    ipcMain.removeHandler(IPC.skipCursorQuestion)
  }
}
