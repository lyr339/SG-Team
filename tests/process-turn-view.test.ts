import { describe, expect, it } from 'vitest'
import { buildProcessTurnView, suggestedActionsFromText } from '../src/renderer/src/process-turn-view'

describe('ProcessTurnViewModel', () => {

  it('preserves Cursor native thinking/tool order and exposes native details', () => {
    const model = buildProcessTurnView({
      id: 'native-turn',
      blocks: [
        { kind: 'thinking', id: 'z-thinking', text: '先分析', status: 'done', durationMs: 2_000 },
        { kind: 'message', id: 'assistant-progress', text: '准备读取目标文件。', status: 'done' },
        { kind: 'tool', id: 'a-read', toolName: 'read_file_v2', toolKind: 'read', summary: '/a.ts', output: 'file body', status: 'done' },
        { kind: 'thinking', id: 'm-thinking', text: '再判断', status: 'running' },
        { kind: 'tool', id: 'b-browser', toolName: 'browser_navigate', toolKind: 'browser', summary: 'http://localhost', status: 'running' },
        { kind: 'tool', id: 'todos', toolName: 'todos', toolKind: 'todo', summary: '待办清单 0/1', todos: [{ content: '验收', status: 'in_progress' }], status: 'running' }
      ]
    })
    expect(model.steps.map((step) => step.kind)).toEqual(['thinking', 'message', 'read', 'thinking', 'browser', 'todo'])
    expect(model.steps[0]?.durationMs).toBe(2_000)
    expect(model.steps[1]?.body).toBe('准备读取目标文件。')
    expect(model.steps[2]?.details).toContainEqual({ label: '输出', value: 'file body', kind: 'code' })
    expect(model.steps[5]?.todos).toEqual([{ content: '验收', status: 'in_progress' }])
  })

  it('projects image-generation blocks: verb by state, file name as the object, thumbnail source, no JSON output detail', () => {
    const model = buildProcessTurnView({
      id: 'image-turn',
      blocks: [
        {
          kind: 'tool', id: 'img-done', toolName: 'generate_image', toolKind: 'image', toolCase: 'generateImageToolCall',
          summary: 'board-v1.png', status: 'done',
          input: { description: 'design board', filePath: 'board-v1.png' },
          image: { path: '/tmp/assets/board-v1.png' }
        },
        { kind: 'tool', id: 'img-running', toolName: 'generate_image', toolKind: 'image', toolCase: 'generateImageToolCall', summary: 'board-v2.png', status: 'running' },
        // hook v35 之前落库的旧块：other 类、无 summary、路径埋在 output 的 JSON 文本里。
        {
          kind: 'tool', id: 'img-legacy', toolName: 'generate_image', toolKind: 'other', toolCase: 'generateImageToolCall', status: 'done',
          output: '{\n  "filePath": "/tmp/assets/board-v0.png",\n  "imageData": "[binary/image payload omitted]"\n}'
        }
      ]
    })
    expect(model.steps.map((step) => [step.kind, step.action, step.target])).toEqual([
      ['image', '已生成图片', 'board-v1.png'],
      ['image', '生成图片中', 'board-v2.png'],
      ['image', '已生成图片', 'board-v0.png']
    ])
    expect(model.steps[0]?.image).toEqual({ path: '/tmp/assets/board-v1.png' })
    expect(model.steps[0]?.details.map((detail) => detail.label)).toEqual(['输入'])
    expect(model.steps[1]?.image).toBeUndefined()
    // 旧块：路径救出后 output 文本不再作为「输出」明细重复出现。
    expect(model.steps[2]?.image).toEqual({ path: '/tmp/assets/board-v0.png' })
    expect(model.steps[2]?.details).toEqual([])
  })

  it('marks CDP sampling boundaries as estimated timing', () => {
    const model = buildProcessTurnView({
      id: 'cursor-live',
      blocks: [{
        kind: 'tool', id: 'cursor:read', toolName: 'read_file', toolKind: 'read',
        summary: 'package.json', status: 'done', startedAt: 1_000, completedAt: 1_120,
        timingEstimated: true
      }]
    })
    expect(model.timingEstimated).toBe(true)
    expect(model.elapsedMs).toBe(120)
  })

  it('extracts up to four contextual next actions from a real answer', () => {
    expect(suggestedActionsFromText(`结论已经确认。\n\n接下来可以：\n1. 补齐回归测试\n2. 提交本轮改动\n3. 观察实时日志\n4. 更新实现文档\n5. 多余项`)).toEqual([
      '补齐回归测试', '提交本轮改动', '观察实时日志', '更新实现文档'
    ])
  })

  it('does not fabricate suggestions from plain numbered content lists (RC-11, §8.5-8)', () => {
    // 图片内容说明被误判为建议操作的事故形态：无明确建议标题的编号列表
    // 只是正文描述，不得生成任何建议按钮。
    const imageDescription = [
      '图中包含以下内容：',
      '',
      '1. **顶部文字**',
      '2. **中间多组工具调用块**：交替出现 `mcp--` 调用与结果',
      '3. 底部工具栏显示 capability:30'
    ].join('\n')
    expect(suggestedActionsFromText(imageDescription)).toEqual([])
  })

  it('normalizes suggestion candidates to plain text before rendering (RC-11, §8.5-9)', () => {
    const text = [
      '实现完成。',
      '',
      '**接下来可以**：',
      '1. 运行 `npm test` 验证',
      '2. 查看 **实现文档**',
      '3. [发布说明](https://example.com) 存档'
    ].join('\n')
    expect(suggestedActionsFromText(text)).toEqual([
      '运行 npm test 验证',
      '查看 实现文档',
      '发布说明 存档'
    ])
  })

  it('treats bold lines as emphasis, not unordered list items', () => {
    const text = '下一步建议：\n**最重要的操作**：先跑测试'
    expect(suggestedActionsFromText(text)).toEqual([])
  })
})

describe('ProcessTurnViewModel · tool presentation (Cursor 同口径)', () => {
  it('uses the model-given description as the headline and demotes verb + target below it', () => {
    const model = buildProcessTurnView({
      id: 'turn',
      blocks: [{
        kind: 'tool', id: 'cursor:shell', toolName: 'run_terminal_command_v2', toolKind: 'command',
        title: '查看新消息提交时对待答问卷的处理逻辑', summary: 'cd /tmp && python3 - <<EOF', hint: 'cd, python3', status: 'done', output: 'ok'
      }]
    })
    const step = model.steps[0]!
    expect(step.action).toBe('查看新消息提交时对待答问卷的处理逻辑')
    expect(step.verb).toBe('已运行')
    expect(step.target).toBeUndefined()
    expect(step.hint).toBe('cd, python3')
    expect(step.stateText).toBe('完成')
    // 命令不再占头部，但在明细第一行可见。
    expect(step.details[0]).toEqual({ label: '命令', value: 'cd /tmp && python3 - <<EOF', kind: 'code' })
  })

  it('turns the verb with status when there is no description', () => {
    const statuses = ['running', 'done', 'failed'] as const
    const actions = statuses.map((status) => buildProcessTurnView({
      id: 'turn',
      blocks: [{ kind: 'tool', id: `read-${status}`, toolName: 'read_file_v2', toolKind: 'read', summary: '/a.ts', hint: 'L1-120', status }]
    }).steps[0]!)
    expect(actions.map((step) => step.action)).toEqual(['读取中', '已读取', '读取失败'])
    expect(actions.map((step) => step.stateText)).toEqual(['进行中', '完成', '失败'])
    expect(actions[1]).toMatchObject({ target: '/a.ts', hint: 'L1-120', verb: undefined })
  })

  it('refines the verb by native toolCase (ls / glob / fetch / await) and falls back to the kind table', () => {
    const steps = buildProcessTurnView({
      id: 'turn',
      blocks: [
        { kind: 'tool', id: 'ls', toolName: 'list_dir', toolKind: 'read', toolCase: 'lsToolCall', summary: '/src', status: 'done' },
        { kind: 'tool', id: 'glob', toolName: 'glob_file_search', toolKind: 'search', toolCase: 'globToolCall', summary: '**/*.ts', status: 'running' },
        { kind: 'tool', id: 'fetch', toolName: 'web_fetch', toolKind: 'browser', toolCase: 'fetchToolCall', summary: 'https://example.com', status: 'done' },
        { kind: 'tool', id: 'await', toolName: 'awaitToolCall', toolKind: 'command', toolCase: 'awaitToolCall', summary: '837682', hint: '12s', status: 'done' },
        { kind: 'tool', id: 'legacy', toolName: 'read_file_v2', toolKind: 'read', summary: '/a.ts', status: 'done' }
      ]
    }).steps
    expect(steps.map((step) => step.action)).toEqual(['已列出', '搜索文件中', '已抓取', '后台命令已结束', '已读取'])
    // await 属 command 类但不是可执行命令行：不生成 shell 卡数据。
    expect(steps[3]).toMatchObject({ kind: 'command', target: '837682', hint: '12s' })
    expect(steps[3]?.shell).toBeUndefined()
  })

  it('normalizes the shell description like Cursor (drop leading “run”, capitalize) and exposes shell card data', () => {
    const step = buildProcessTurnView({
      id: 'turn',
      blocks: [{
        kind: 'tool', id: 'sh', toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall',
        title: 'run the relay regression tests', summary: 'npx vitest run tests/relay', hint: 'npx · exit 1', status: 'failed', output: 'FAIL', error: 'exit 1'
      }]
    }).steps[0]!
    expect(step.action).toBe('The relay regression tests')
    expect(step.shell).toEqual({ command: 'npx vitest run tests/relay', output: 'FAIL', exitCode: 1, error: 'exit 1' })
    // 中文说明不受影响。
    const zh = buildProcessTurnView({
      id: 'turn',
      blocks: [{ kind: 'tool', id: 'sh2', toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall', title: '跑测试', summary: 'npm test', status: 'done' }]
    }).steps[0]!
    expect(zh.action).toBe('跑测试')
    expect(zh.shell).toEqual({ command: 'npm test', output: undefined, exitCode: undefined, error: undefined })
  })

  it('names MCP tools by their real tool name and surfaces the server as the hint', () => {
    const model = buildProcessTurnView({
      id: 'turn',
      blocks: [
        { kind: 'tool', id: 'mcp-1', toolName: 'mcp-SG Team-team_task', toolKind: 'mcp', summary: '', status: 'done' },
        { kind: 'tool', id: 'mcp-2', toolName: 'mcp-cursor-ide-browser-browser_navigate', toolKind: 'mcp', summary: 'http://localhost', status: 'running' },
        { kind: 'tool', id: 'plan', toolName: 'planUpdate', toolKind: 'todo', summary: '执行计划', status: 'done' }
      ]
    })
    expect(model.steps[0]).toMatchObject({ action: '已调用 team_task', hint: 'SG Team' })
    expect(model.steps[1]).toMatchObject({ action: '调用中 browser_navigate', hint: 'cursor-ide-browser', target: 'http://localhost' })
    expect(model.steps[2]).toMatchObject({ action: '已更新计划', target: '执行计划' })
  })

  it('exposes ask_question as a question step whose state text follows the questionnaire, not the tool status', () => {
    const question = {
      toolCallId: 'tc-1', title: '方向', status: 'pending' as const,
      questions: [{ id: 'q', prompt: '选哪个？', allowMultiple: false, options: [{ id: 'a', label: 'A' }] }]
    }
    const pending = buildProcessTurnView({
      id: 'turn',
      blocks: [{ kind: 'tool', id: 'q', toolName: 'ask_question', toolKind: 'question', title: '方向', summary: '', status: 'running', question, input: { title: '方向' } }]
    }).steps[0]!
    expect(pending).toMatchObject({ kind: 'question', action: '方向', verb: undefined, stateText: '等待回答' })
    // 题目由卡片承载，不再重复输出「输入」JSON。
    expect(pending.details.some((detail) => detail.label === '输入')).toBe(false)
    expect(pending.question).toBe(question)

    const submitted = buildProcessTurnView({
      id: 'turn',
      blocks: [{ kind: 'tool', id: 'q', toolName: 'ask_question', toolKind: 'question', summary: '', status: 'done', question: { ...question, status: 'submitted' } }]
    }).steps[0]!
    expect(submitted).toMatchObject({ action: '已回答', stateText: '已回答' })
    const timedOut = buildProcessTurnView({
      id: 'turn',
      blocks: [{ kind: 'tool', id: 'q', toolName: 'ask_question', toolKind: 'question', summary: '', status: 'done', question: { ...question, status: 'cancelled', skipReason: 'timeout' } }]
    }).steps[0]!
    expect(timedOut.stateText).toBe('已超时')
  })
})
