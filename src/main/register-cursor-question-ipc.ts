import { ipcMain, type BrowserWindow } from 'electron'
import type { CursorQuestionService } from '../application/cursor-question-service'
import { IPC, type CursorQuestionAnswerInput, type CursorQuestionSkipInput } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

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
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.answerCursorQuestion, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.answer(answerInputOf(input))
  })
  ipcMain.handle(IPC.skipCursorQuestion, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.skip(questionRefOf(input))
  })
  return () => {
    ipcMain.removeHandler(IPC.answerCursorQuestion)
    ipcMain.removeHandler(IPC.skipCursorQuestion)
  }
}
