import { useMemo, useState } from 'react'
import type { ProcessQuestion } from '../../domain/conversation-entry'
import {
  CURSOR_QUESTION_FREEFORM_OPTION_ID,
  describeCursorQuestionAnswer,
  validateCursorQuestionDraft,
  type CursorQuestionDraft
} from '../../domain/cursor-question'
import type { CursorQuestionActionResult } from '../../shared/desktop-api'

/** 会话页对 ask_question 的两个动作；由 App 绑定到当前通道的 desktop API。 */
export interface QuestionActions {
  answer(toolCallId: string, draft: CursorQuestionDraft & { note?: string }): Promise<CursorQuestionActionResult>
  skip(toolCallId: string): Promise<CursorQuestionActionResult>
}

interface QuestionCardProps {
  question: ProcessQuestion
  actions?: QuestionActions
  /** 卡片所在过程已封口 / 会话离线等不可作答的场景。 */
  readOnly?: boolean
}

const FAILURE_HINT: Record<string, string> = {
  cdp_unavailable: 'Cursor 调试连接不可用，请在 Cursor 中回答',
  composer_not_loaded: 'Cursor 尚未加载该会话，请在 Cursor 中回答',
  unsupported_runtime: '当前 Cursor 版本不支持在拾光中作答，请在 Cursor 中回答',
  question_not_pending: '这条提问已在 Cursor 中处理过了',
  composer_unbound: '该席位尚未绑定 Cursor 会话'
}

function toggleSelection(current: string[], optionId: string, allowMultiple: boolean): string[] {
  if (allowMultiple) return current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId]
  // 单选遵循原生 radio 语义：再次点击已选项保持选择，不制造“整题未回答”的空态。
  return [optionId]
}

/**
 * Cursor 原生 ask_question 的拾光卡片：等待回答时可直接点选 / 填写 / 附言并提交或跳过；
 * 已回答 / 已跳过时展示最终答案。状态与 Cursor 面板双向一致（同一份气泡数据）。
 */
export function QuestionCard({ question, actions, readOnly = false }: QuestionCardProps): React.JSX.Element {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [freeformTexts, setFreeformTexts] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'answer' | 'skip' | null>(null)
  const [error, setError] = useState('')
  const draft = useMemo<CursorQuestionDraft>(() => ({ selections, freeformTexts }), [selections, freeformTexts])
  const problem = useMemo(() => validateCursorQuestionDraft(question, draft), [question, draft])
  const interactive = question.status === 'pending' && !readOnly && Boolean(actions)

  const run = async (kind: 'answer' | 'skip'): Promise<void> => {
    if (!actions || busy) return
    setBusy(kind)
    setError('')
    try {
      const result = kind === 'answer'
        ? await actions.answer(question.toolCallId, { ...draft, note: note.trim() || undefined })
        : await actions.skip(question.toolCallId)
      if (!result.ok) setError(FAILURE_HINT[result.code] ?? result.message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  // 标题由过程卡头部承担（action = 提问标题），卡片内不重复。
  if (question.status !== 'pending') {
    const cancelled = question.status === 'cancelled'
    return (
      <div className={`cursor-question is-${question.status}`} data-tool-call-id={question.toolCallId}>
        {cancelled ? (
          <p className="cursor-question__resolution">
            {question.skipReason === 'timeout' ? '提问已超时，未收到回答' : '已跳过这组提问'}
          </p>
        ) : (
          <ul className="cursor-question__answers">
            {question.questions.map((item) => {
              const answer = question.answers?.find((candidate) => candidate.questionId === item.id)
              const description = describeCursorQuestionAnswer(item, answer)
              const awaitingHydration = !description && question.answers === undefined
              return (
                <li key={item.id}>
                  <span className="cursor-question__prompt">{item.prompt}</span>
                  <span className={`cursor-question__answer${awaitingHydration ? ' is-pending' : ''}`}>
                    {description || (awaitingHydration ? '答案同步中…' : '未选择')}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {question.note ? <p className="cursor-question__note">附言：{question.note}</p> : null}
      </div>
    )
  }

  return (
    <div className="cursor-question is-pending" data-tool-call-id={question.toolCallId} role="group" aria-label={question.title || 'Agent 提问'}>
      {question.questions.map((item, index) => {
        const chosen = selections[item.id] ?? []
        const freeformChosen = chosen.includes(CURSOR_QUESTION_FREEFORM_OPTION_ID)
        return (
          <fieldset key={item.id} className="cursor-question__item" disabled={!interactive || busy !== null}>
            <legend>
              {question.questions.length > 1 ? <i>{index + 1}</i> : null}
              <span>{item.prompt}</span>
              {item.allowMultiple ? <em>可多选</em> : null}
            </legend>
            <div className="cursor-question__options" role={item.allowMultiple ? 'group' : 'radiogroup'}>
              {item.options.map((option) => {
                const active = chosen.includes(option.id)
                return (
                  <button
                    key={option.id}
                    type="button"
                    role={item.allowMultiple ? 'checkbox' : 'radio'}
                    aria-checked={active}
                    className={`cursor-question__option ${active ? 'is-active' : ''}`}
                    onClick={() => setSelections((current) => ({
                      ...current,
                      [item.id]: toggleSelection(current[item.id] ?? [], option.id, item.allowMultiple)
                    }))}
                  >
                    <i aria-hidden="true" />
                    <span>{option.label}</span>
                  </button>
                )
              })}
              <button
                type="button"
                role={item.allowMultiple ? 'checkbox' : 'radio'}
                aria-checked={freeformChosen}
                className={`cursor-question__option is-freeform ${freeformChosen ? 'is-active' : ''}`}
                onClick={() => setSelections((current) => ({
                  ...current,
                  [item.id]: toggleSelection(current[item.id] ?? [], CURSOR_QUESTION_FREEFORM_OPTION_ID, item.allowMultiple)
                }))}
              >
                <i aria-hidden="true" />
                <span>其他</span>
              </button>
            </div>
            {freeformChosen ? (
              <input
                className="cursor-question__freeform"
                value={freeformTexts[item.id] ?? ''}
                maxLength={2_000}
                placeholder="填写你的答案"
                aria-label={`${item.prompt}：其他`}
                onChange={(event) => setFreeformTexts((current) => ({ ...current, [item.id]: event.target.value }))}
              />
            ) : null}
          </fieldset>
        )
      })}
      {interactive ? (
        <div className="cursor-question__submit">
          <textarea
            className="cursor-question__note-input"
            value={note}
            rows={1}
            maxLength={4_000}
            placeholder="附言（可选）：会和答案一起发给 Agent"
            aria-label="附言"
            disabled={busy !== null}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="cursor-question__actions">
            <button type="button" className="cursor-question__skip" disabled={busy !== null} onClick={() => void run('skip')}>
              {busy === 'skip' ? '跳过中…' : '跳过'}
            </button>
            <button
              type="button"
              className="cursor-question__confirm"
              disabled={busy !== null || Boolean(problem)}
              title={problem ?? '提交答案'}
              onClick={() => void run('answer')}
            >
              {busy === 'answer' ? '提交中…' : '提交回答'}
            </button>
          </div>
          {error ? <p className="cursor-question__error" role="alert">{error}</p> : null}
        </div>
      ) : (
        <p className="cursor-question__resolution">{readOnly || !actions ? '请在 Cursor 中回答这组提问' : ''}</p>
      )}
    </div>
  )
}
