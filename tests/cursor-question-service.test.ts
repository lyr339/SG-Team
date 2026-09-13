import { describe, expect, it } from 'vitest'
import { CursorQuestionService, type CursorQuestionOutcome } from '../src/application/cursor-question-service'
import type { ProcessQuestion } from '../src/domain/conversation-entry'
import { emptyTeamControlSnapshot, type TeamControlSnapshot } from '../src/domain/team-control'
import type { CursorQuestionActionResult } from '../src/shared/desktop-api'
import type { CursorQuestionAnswerCommand, CursorQuestionSkipCommand } from '../src/infrastructure/cursor/cursor-question-responder'

const question: ProcessQuestion = {
  toolCallId: 'tool-1',
  title: '设置页改造方向',
  status: 'pending',
  questions: [{
    id: 'direction', prompt: '改造方向：', allowMultiple: false,
    options: [{ id: 'a', label: '方案 A' }, { id: 'b', label: '方案 B' }]
  }]
}

function team(composerId?: string): TeamControlSnapshot {
  const snapshot = emptyTeamControlSnapshot()
  snapshot.activeWorkspaceId = 'workspace-a'
  snapshot.workspaces = [{ id: 'workspace-a', name: 'alpha', path: '/workspace/alpha', createdAt: 1, updatedAt: 1 }]
  snapshot.runs = [{ id: 'run-a', workspaceId: 'workspace-a', name: 'run', goal: '', templateId: 'default', status: 'running', createdAt: 1, updatedAt: 1 }]
  snapshot.activeRun = snapshot.runs[0]
  snapshot.bindings = [{
    id: 'binding-1', workspaceId: 'workspace-a', runId: 'run-a', slotId: 'slot-1', channelId: '2',
    agentSessionId: 'agent-2', generation: 'gen', composerBindingKey: 'gen', installedAt: 1,
    launchStatus: 'delivered', launchDetail: '', lastCheckInNote: '', composerId
  }]
  return snapshot
}

function harness(input: { composerId?: string; question?: ProcessQuestion; verdict?: CursorQuestionActionResult } = {}) {
  const answers: Array<{ workspacePath?: string; command: CursorQuestionAnswerCommand }> = []
  const skips: Array<{ workspacePath?: string; command: CursorQuestionSkipCommand }> = []
  const outcomes: Array<{ channelId: string; outcome: CursorQuestionOutcome }> = []
  const verdict = input.verdict ?? { ok: true, status: 'submitted' }
  const service = new CursorQuestionService({
    team: { getSnapshot: () => team(input.composerId) },
    sessions: {
      findQuestion: (channelId, toolCallId) => channelId === '2' && toolCallId === 'tool-1' ? input.question ?? question : undefined,
      applyQuestionOutcome: (channelId, outcome) => { outcomes.push({ channelId, outcome }); return true }
    },
    responder: {
      answer: async (workspacePath, command) => { answers.push({ workspacePath, command }); return verdict },
      skip: async (workspacePath, command) => { skips.push({ workspacePath, command }); return { ok: true, status: 'cancelled' } }
    }
  })
  return { service, answers, skips, outcomes }
}

describe('CursorQuestionService', () => {
  it('validates the draft before touching Cursor and never reaches the responder on bad input', async () => {
    const { service, answers } = harness({ composerId: 'composer-2' })
    expect(await service.answer({ channelId: 'x', toolCallId: 'tool-1', selections: {} })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.answer({ channelId: '2', toolCallId: 'tool-1', selections: {} })).toMatchObject({ ok: false, code: 'invalid_input', message: expect.stringContaining('还没有选择') })
    expect(await service.answer({ channelId: '2', toolCallId: 'missing', selections: { direction: ['a'] } })).toMatchObject({ ok: false, code: 'question_not_pending' })
    expect(answers).toHaveLength(0)
  })

  it('refuses to answer a question that Cursor already resolved', async () => {
    const { service, answers } = harness({ composerId: 'composer-2', question: { ...question, status: 'submitted' } })
    expect(await service.answer({ channelId: '2', toolCallId: 'tool-1', selections: { direction: ['a'] } }))
      .toMatchObject({ ok: false, code: 'question_not_pending', message: '这条提问已经回答过了' })
    expect(answers).toHaveLength(0)
  })

  it('needs a bound Composer to deliver into', async () => {
    const { service } = harness()
    expect(await service.answer({ channelId: '2', toolCallId: 'tool-1', selections: { direction: ['a'] } }))
      .toMatchObject({ ok: false, code: 'composer_unbound' })
  })

  it('delivers the sanitized draft with a generated note and patches the block on success', async () => {
    const { service, answers, outcomes } = harness({ composerId: 'composer-2' })
    const result = await service.answer({
      channelId: '2', toolCallId: 'tool-1',
      selections: { direction: [' a ', 'a'] },
      note: '  先做 A，外观后续再说  '
    })
    expect(result).toEqual({ ok: true, status: 'submitted' })
    expect(answers).toEqual([{
      workspacePath: '/workspace/alpha',
      command: {
        composerId: 'composer-2', toolCallId: 'tool-1',
        selections: { direction: ['a'] }, freeformTexts: {},
        note: '先做 A，外观后续再说\n已选择：方案 A'
      }
    }])
    expect(outcomes).toEqual([{
      channelId: '2',
      outcome: { toolCallId: 'tool-1', status: 'submitted', answers: [{ questionId: 'direction', selectedOptionIds: ['a'] }], note: '先做 A，外观后续再说' }
    }])
  })

  it('does not patch the block when Cursor did not confirm', async () => {
    const { service, outcomes } = harness({ composerId: 'composer-2', verdict: { ok: false, code: 'unconfirmed', message: '超时' } })
    expect(await service.answer({ channelId: '2', toolCallId: 'tool-1', selections: { direction: ['b'] } }))
      .toEqual({ ok: false, code: 'unconfirmed', message: '超时' })
    expect(outcomes).toHaveLength(0)
  })

  it('skips through the responder and records the cancelled outcome', async () => {
    const { service, skips, outcomes } = harness({ composerId: 'composer-2' })
    expect(await service.skip({ channelId: '2', toolCallId: 'tool-1' })).toEqual({ ok: true, status: 'cancelled' })
    expect(skips).toEqual([{ workspacePath: '/workspace/alpha', command: { composerId: 'composer-2', toolCallId: 'tool-1' } }])
    expect(outcomes).toEqual([{ channelId: '2', outcome: { toolCallId: 'tool-1', status: 'cancelled', skipReason: 'user' } }])
  })
})
