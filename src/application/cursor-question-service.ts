import type { ProcessQuestion, ProcessQuestionAnswer } from '../domain/conversation-entry'
import {
  buildCursorQuestionAnswers,
  buildCursorQuestionNote,
  validateCursorQuestionDraft,
  type CursorQuestionDraft
} from '../domain/cursor-question'
import type { TeamControlSnapshot } from '../domain/team-control'
import type {
  CursorQuestionActionResult,
  CursorQuestionAnswerInput,
  CursorQuestionSkipInput
} from '../shared/desktop-api'
import type { CursorQuestionAnswerCommand, CursorQuestionSkipCommand } from '../infrastructure/cursor/cursor-question-responder'

export interface CursorQuestionOutcome {
  toolCallId: string
  status: 'submitted' | 'cancelled'
  answers?: ProcessQuestionAnswer[]
  note?: string
  skipReason?: string
}

export interface CursorQuestionServicePorts {
  team: { getSnapshot(): TeamControlSnapshot }
  sessions: {
    /** 通道内该 toolCallId 对应的提问（直播 / 归档 / 已封口回复三处任一）。 */
    findQuestion(channelId: string, toolCallId: string): ProcessQuestion | undefined
    applyQuestionOutcome(channelId: string, outcome: CursorQuestionOutcome): boolean
  }
  responder: {
    answer(workspacePath: string | undefined, command: CursorQuestionAnswerCommand): Promise<CursorQuestionActionResult>
    skip(workspacePath: string | undefined, command: CursorQuestionSkipCommand): Promise<CursorQuestionActionResult>
  }
}

const MAX_NOTE_CHARS = 4_000

function sanitizeSelections(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (!key || !Array.isArray(raw)) continue
    const ids = raw.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim().slice(0, 200)] : []).slice(0, 30)
    out[key.slice(0, 200)] = [...new Set(ids)]
  }
  return out
}

function sanitizeTexts(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (!key || typeof raw !== 'string' || !raw.trim()) continue
    out[key.slice(0, 200)] = raw.trim().slice(0, 2_000)
  }
  return out
}

/**
 * 在拾光里回答 / 跳过 Cursor 原生 ask_question 的编排：
 * 校验草稿 → 定位席位绑定的 Composer → CDP 写入 Cursor 待决策 → 成功后把结果就地写回过程块。
 * 校验与文案生成放在主进程：渲染层只提交草稿，跟进消息的非空保证不依赖前端。
 */
export class CursorQuestionService {
  constructor(private readonly ports: CursorQuestionServicePorts) {}

  async answer(input: CursorQuestionAnswerInput): Promise<CursorQuestionActionResult> {
    const located = this.locate(input)
    if (!located.ok) return located
    const { channelId, toolCallId, question } = located
    const draft: CursorQuestionDraft = {
      selections: sanitizeSelections(input.selections),
      freeformTexts: sanitizeTexts(input.freeformTexts)
    }
    const problem = validateCursorQuestionDraft(question, draft)
    if (problem) return { ok: false, code: 'invalid_input', message: problem }
    const userNote = typeof input.note === 'string' ? input.note.trim().slice(0, MAX_NOTE_CHARS) : ''
    const answers = buildCursorQuestionAnswers(question, draft)
    const target = this.resolveComposer(channelId)
    if (!target) return { ok: false, code: 'composer_unbound', message: `CH-${channelId} 尚未绑定 Cursor 会话，无法投递答案` }
    const result = await this.ports.responder.answer(target.workspacePath, {
      composerId: target.composerId,
      toolCallId,
      selections: draft.selections,
      freeformTexts: draft.freeformTexts ?? {},
      note: buildCursorQuestionNote(question, answers, userNote)
    })
    if (result.ok && result.status !== 'submitted') return { ok: false, code: 'unconfirmed', message: 'Cursor 回执与提交操作不一致' }
    if (result.ok) {
      this.ports.sessions.applyQuestionOutcome(channelId, {
        toolCallId, status: 'submitted', answers, ...(userNote ? { note: userNote } : {})
      })
    }
    return result
  }

  async skip(input: CursorQuestionSkipInput): Promise<CursorQuestionActionResult> {
    const located = this.locate(input)
    if (!located.ok) return located
    const { channelId, toolCallId } = located
    const target = this.resolveComposer(channelId)
    if (!target) return { ok: false, code: 'composer_unbound', message: `CH-${channelId} 尚未绑定 Cursor 会话，无法跳过提问` }
    const result = await this.ports.responder.skip(target.workspacePath, { composerId: target.composerId, toolCallId })
    if (result.ok && result.status !== 'cancelled') return { ok: false, code: 'unconfirmed', message: 'Cursor 回执与跳过操作不一致' }
    if (result.ok) {
      this.ports.sessions.applyQuestionOutcome(channelId, { toolCallId, status: 'cancelled', skipReason: 'user' })
    }
    return result
  }

  private locate(input: { channelId: string; toolCallId: string }):
    | { ok: true; channelId: string; toolCallId: string; question: ProcessQuestion }
    | Extract<CursorQuestionActionResult, { ok: false }> {
    const channelId = String(input.channelId ?? '').trim()
    const toolCallId = String(input.toolCallId ?? '').trim()
    if (!/^\d+$/.test(channelId) || !toolCallId || toolCallId.length > 200) {
      return { ok: false, code: 'invalid_input', message: '提问参数无效' }
    }
    const question = this.ports.sessions.findQuestion(channelId, toolCallId)
    if (!question) return { ok: false, code: 'question_not_pending', message: '拾光尚未观察到这条提问，请稍后重试或在 Cursor 中回答' }
    if (question.status !== 'pending') {
      return { ok: false, code: 'question_not_pending', message: question.status === 'submitted' ? '这条提问已经回答过了' : '这条提问已被跳过' }
    }
    return { ok: true, channelId, toolCallId, question }
  }

  private resolveComposer(channelId: string): { composerId: string; workspacePath?: string } | undefined {
    const team = this.ports.team.getSnapshot()
    const runId = team.activeRun?.id
    const binding = team.bindings.find((candidate) => (
      candidate.channelId === channelId && (!runId || candidate.runId === runId)
    ))
    const composerId = binding?.composerId?.trim()
    if (!composerId) return undefined
    const workspacePath = team.workspaces.find((workspace) => workspace.id === team.activeWorkspaceId)?.path
    return { composerId, workspacePath }
  }
}
