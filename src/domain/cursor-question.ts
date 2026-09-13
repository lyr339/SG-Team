import type { ProcessQuestion, ProcessQuestionAnswer } from './conversation-entry'

/**
 * Cursor 原生 ask_question 的回答语义（拾光侧作答 → Cursor 待决策）。
 *
 * Cursor 的问卷 UI 用一个哨兵选项 id 表示「其他（自由填写）」：选中它时答案的
 * selectedOptionIds 不含该 id，改以 freeformText 携带正文。拾光把用户在卡片里的
 * 勾选与填写折算成同一形态，再交给 Cursor 的 currentSelections 回退路径。
 */
export const CURSOR_QUESTION_FREEFORM_OPTION_ID = '__freeform_other__'

/** 卡片草稿：每题选中的选项 id（可含自由填写哨兵）与自由填写正文。 */
export interface CursorQuestionDraft {
  selections: Record<string, string[]>
  freeformTexts?: Record<string, string>
}

/** 校验草稿是否可提交；返回首个问题的文案，通过返回 undefined。 */
export function validateCursorQuestionDraft(question: ProcessQuestion, draft: CursorQuestionDraft): string | undefined {
  if (!question.questions.length) return '这道提问没有可回答的题目'
  for (const item of question.questions) {
    const selected = (draft.selections[item.id] ?? []).filter(Boolean)
    if (!selected.length) return `「${item.prompt}」还没有选择`
    if (!item.allowMultiple && selected.length > 1) return `「${item.prompt}」只能选一项`
    const known = new Set([...item.options.map((option) => option.id), CURSOR_QUESTION_FREEFORM_OPTION_ID])
    const unknown = selected.find((id) => !known.has(id))
    if (unknown) return `「${item.prompt}」包含未知选项 ${unknown}`
    if (selected.includes(CURSOR_QUESTION_FREEFORM_OPTION_ID) && !draft.freeformTexts?.[item.id]?.trim()) {
      return `「${item.prompt}」选择了其他，但没有填写内容`
    }
  }
  return undefined
}

/** 草稿折算为最终答案（与 Cursor 自身 buildAskQuestionResultFromDraft 同口径）。 */
export function buildCursorQuestionAnswers(question: ProcessQuestion, draft: CursorQuestionDraft): ProcessQuestionAnswer[] {
  return question.questions.map((item) => {
    const selected = (draft.selections[item.id] ?? []).filter(Boolean)
    const freeform = selected.includes(CURSOR_QUESTION_FREEFORM_OPTION_ID)
      ? draft.freeformTexts?.[item.id]?.trim() || '其他'
      : undefined
    return {
      questionId: item.id,
      selectedOptionIds: selected.filter((id) => id !== CURSOR_QUESTION_FREEFORM_OPTION_ID),
      ...(freeform ? { freeformText: freeform } : {})
    }
  })
}

/** 单题答案的可读文本：选项标签 + 自由填写正文。 */
export function describeCursorQuestionAnswer(
  item: ProcessQuestion['questions'][number],
  answer: ProcessQuestionAnswer | undefined
): string {
  if (!answer) return ''
  const labels = answer.selectedOptionIds.map((id) => item.options.find((option) => option.id === id)?.label ?? id)
  if (answer.freeformText) labels.push(`其他：${answer.freeformText}`)
  return labels.join('；')
}

/**
 * 随答案送入 Cursor 的跟进消息。Cursor 的回退路径要求消息非空（空文本会落入常规
 * 提交管线），因此没有用户附言时自动生成选择摘要——同时让 Cursor 转录留下决策记录。
 */
export function buildCursorQuestionNote(
  question: ProcessQuestion,
  answers: ProcessQuestionAnswer[],
  userNote?: string
): string {
  const lines = question.questions.map((item) => {
    const answer = answers.find((candidate) => candidate.questionId === item.id)
    const described = describeCursorQuestionAnswer(item, answer)
    return question.questions.length > 1 ? `${item.prompt} → ${described}` : `已选择：${described}`
  })
  const note = userNote?.trim()
  return [...(note ? [note] : []), ...lines].join('\n').trim()
}
