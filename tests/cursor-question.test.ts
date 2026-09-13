import { describe, expect, it } from 'vitest'
import type { ProcessQuestion } from '../src/domain/conversation-entry'
import {
  CURSOR_QUESTION_FREEFORM_OPTION_ID,
  buildCursorQuestionAnswers,
  buildCursorQuestionNote,
  describeCursorQuestionAnswer,
  validateCursorQuestionDraft
} from '../src/domain/cursor-question'

/** 真实结构：2026-09-08 CH-2 设置页方案问卷（state.vscdb 落盘 params）。 */
const singleChoice: ProcessQuestion = {
  toolCallId: '3752a71b-a419-4cea-9f6b-ab13cf39de13',
  title: '设置页改造方向',
  status: 'pending',
  questions: [{
    id: 'direction',
    prompt: '账号与 Cursor 页改造方向选择：',
    allowMultiple: false,
    options: [
      { id: 'a', label: '方案 A：左侧导航标准设置页（推荐）' },
      { id: 'b', label: '方案 B：单页分区卡片轻改' },
      { id: 'c', label: '方案 C：顶部 Tabs' }
    ]
  }]
}

const multiQuestion: ProcessQuestion = {
  toolCallId: '1bfcbc37-5acc-4234-8d80-842e09278c7e',
  title: '河流动态效果方案确认',
  status: 'pending',
  questions: [
    { id: 'effect', prompt: '想要哪种"动"？', allowMultiple: true, options: [{ id: 'combo', label: '流动水面 + 流光' }, { id: 'surface', label: '只做流动水面' }] },
    { id: 'data', prompt: '数据这块怎么处理？', allowMultiple: false, options: [{ id: 'clip', label: '先裁剪到武汉段' }, { id: 'asis', label: '先不动数据' }] }
  ]
}

describe('cursor-question domain', () => {
  it('rejects drafts that leave a question unanswered, over-select a single-choice question, or pick unknown options', () => {
    expect(validateCursorQuestionDraft(singleChoice, { selections: {} })).toContain('还没有选择')
    expect(validateCursorQuestionDraft(singleChoice, { selections: { direction: ['a', 'b'] } })).toContain('只能选一项')
    expect(validateCursorQuestionDraft(singleChoice, { selections: { direction: ['zzz'] } })).toContain('未知选项')
    expect(validateCursorQuestionDraft(singleChoice, { selections: { direction: [CURSOR_QUESTION_FREEFORM_OPTION_ID] } })).toContain('没有填写内容')
    expect(validateCursorQuestionDraft(singleChoice, { selections: { direction: ['a'] } })).toBeUndefined()
    expect(validateCursorQuestionDraft(multiQuestion, { selections: { effect: ['combo', 'surface'] } })).toContain('数据这块怎么处理')
    expect(validateCursorQuestionDraft(multiQuestion, { selections: { effect: ['combo', 'surface'], data: ['clip'] } })).toBeUndefined()
  })

  it('folds the freeform sentinel into freeformText the way Cursor does and keeps option ids clean', () => {
    const answers = buildCursorQuestionAnswers(multiQuestion, {
      selections: { effect: ['combo'], data: [CURSOR_QUESTION_FREEFORM_OPTION_ID] },
      freeformTexts: { data: '用我手工画的中心线' }
    })
    expect(answers).toEqual([
      { questionId: 'effect', selectedOptionIds: ['combo'] },
      { questionId: 'data', selectedOptionIds: [], freeformText: '用我手工画的中心线' }
    ])
    expect(describeCursorQuestionAnswer(multiQuestion.questions[1]!, answers[1])).toBe('其他：用我手工画的中心线')
  })

  it('always produces a non-empty follow-up note: user note first, then per-question summaries', () => {
    const answers = buildCursorQuestionAnswers(singleChoice, { selections: { direction: ['a'] } })
    expect(buildCursorQuestionNote(singleChoice, answers)).toBe('已选择：方案 A：左侧导航标准设置页（推荐）')
    expect(buildCursorQuestionNote(singleChoice, answers, '  外观设置先不动  ')).toBe('外观设置先不动\n已选择：方案 A：左侧导航标准设置页（推荐）')
    const multi = buildCursorQuestionAnswers(multiQuestion, { selections: { effect: ['combo', 'surface'], data: ['clip'] } })
    expect(buildCursorQuestionNote(multiQuestion, multi).split('\n')).toEqual([
      '想要哪种"动"？ → 流动水面 + 流光；只做流动水面',
      '数据这块怎么处理？ → 先裁剪到武汉段'
    ])
  })
})
