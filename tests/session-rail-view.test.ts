import { describe, expect, it } from 'vitest'
import type { ProcessBlock } from '../src/domain/conversation-entry'
import type { LiveAgentResponseState, LiveProcessState, LiveStatusLineState } from '../src/shared/desktop-api'
import {
  buildSessionRailSections,
  contextRingDash,
  sessionRailActivity,
  sessionRailGroupOf,
  sessionRailStateLabel,
  sessionRailSummary,
  sessionRailTitle
} from '../src/renderer/src/session-rail-view'

const facts = (patch: Partial<Parameters<typeof sessionRailGroupOf>[0]> = {}) => ({
  online: true,
  status: 'waiting' as const,
  waiting: true,
  connectionPhase: 'waiting',
  runtimeEvidence: 'active' as const,
  ...patch
})

describe('session-rail-view 分组与色调', () => {
  it('离线证据优先级最高：不在线 / 停止相位 / 运行时正面终止都归离线', () => {
    expect(sessionRailGroupOf(facts({ online: false }))).toBe('offline')
    expect(sessionRailGroupOf(facts({ status: 'stopped' }))).toBe('offline')
    expect(sessionRailGroupOf(facts({ status: 'running', runtimeEvidence: 'stopped' }))).toBe('offline')
  })

  it('阻塞 / 待验收归需关注；处理中相位即执行中；在岗待命归待命；未待命的空闲落回需关注', () => {
    expect(sessionRailGroupOf(facts({ status: 'running', waiting: false, connectionPhase: 'processing', awaitingUser: true }))).toBe('attention')
    expect(sessionRailGroupOf(facts({ status: 'blocked', waiting: false, connectionPhase: 'approval' }))).toBe('attention')
    expect(sessionRailGroupOf(facts({ status: 'review', waiting: false }))).toBe('attention')
    expect(sessionRailGroupOf(facts({ status: 'idle', waiting: false, connectionPhase: 'processing' }))).toBe('active')
    expect(sessionRailGroupOf(facts({ status: 'reviving', waiting: false, connectionPhase: 'reviving' }))).toBe('active')
    expect(sessionRailGroupOf(facts({ status: 'idle', waiting: false, connectionPhase: 'keepalive' }))).toBe('waiting')
    expect(sessionRailGroupOf(facts({ status: 'idle', waiting: false, connectionPhase: '' }))).toBe('attention')
  })

  it('状态词：离线统一「已离线」，其余沿用全局状态文案；一律三个字', () => {
    expect(sessionRailStateLabel(facts({ online: false, status: 'reviving' }))).toBe('已离线')
    expect(sessionRailStateLabel(facts({ status: 'running', waiting: false, connectionPhase: 'processing', awaitingUser: true }))).toBe('待回答')
    expect(sessionRailStateLabel(facts({ status: 'blocked' }))).toBe('待拍板')
    expect(sessionRailStateLabel(facts({ status: 'running', waiting: false, connectionPhase: 'processing' }))).toBe('干活中')
    expect(sessionRailStateLabel(facts())).toBe('待命中')
    for (const status of ['starting', 'idle', 'running', 'waiting', 'review', 'blocked', 'reviving', 'stopped'] as const) {
      expect(sessionRailStateLabel(facts({ status, online: true, waiting: status === 'waiting', connectionPhase: 'processing' }))).toHaveLength(3)
    }
  })
})

describe('session-rail-view 名册分区（阶段 3 · D4=a：组即一级分区）', () => {
  const seat = (channelId: string, patch: Partial<Parameters<typeof sessionRailGroupOf>[0]> = {}) => ({ ...facts(patch), channelId })
  const working = { status: 'running' as const, waiting: false, connectionPhase: 'processing' }
  const blocked = { status: 'blocked' as const, waiting: false, connectionPhase: 'approval' }
  const offline = { online: false, status: 'offline' as const }

  it('组按来源顺序成段、独立段殿后；空组不出段；组内按状态紧要度排序，同状态保留传入（手动）顺序', () => {
    const sessions = [
      seat('1'),                    // 待命
      seat('2', offline),           // 离线
      seat('3', working),           // 执行中
      seat('4'),                    // 待命
      seat('5', blocked),           // 需关注
      seat('6', working),           // 执行中（独立）
      seat('7')                     // 待命（独立）
    ]
    const sections = buildSessionRailSections(sessions, [
      { id: 'g-review', name: '验收', channelIds: ['5', '4'], attention: true },
      { id: 'g-empty', name: '空组', channelIds: ['404'], attention: false },
      { id: 'g-refactor', name: '接口重构', channelIds: ['1', '2', '3'], leadChannelId: '1', attention: false }
    ])
    expect(sections.map((section) => [section.id, section.kind, section.label, section.state, section.attention, section.leadChannelId])).toEqual([
      ['g-review', 'group', '验收', 'attention', true, undefined],
      ['g-refactor', 'group', '接口重构', 'active', false, '1'],
      ['independent', 'independent', '独立', 'active', false, undefined]
    ])
    expect(sections.map((section) => section.sessions.map((session) => session.channelId))).toEqual([
      ['5', '4'],
      ['3', '1', '2'],
      ['6', '7']
    ])
    // 状态是排序键而不是分区：同一段里待命行仍按传入顺序（1 在 4 之前的手动顺序保留在各自段内）。
    const reordered = buildSessionRailSections([seat('4'), seat('1'), seat('3', working)], [
      { id: 'g', name: 'G', channelIds: ['1', '3', '4'], attention: false }
    ])
    expect(reordered[0]!.sessions.map((session) => session.channelId)).toEqual(['3', '4', '1'])
  })

  it('没有组来源时全部会话落「独立」段；席位同时出现在两个组时归先声明的组；书签状态取最紧要一行', () => {
    const solo = buildSessionRailSections([seat('1', offline), seat('2', offline)], [])
    expect(solo).toHaveLength(1)
    expect(solo[0]).toMatchObject({ id: 'independent', kind: 'independent', state: 'offline', attention: false })
    const overlapping = buildSessionRailSections([seat('1'), seat('2')], [
      { id: 'a', name: 'A', channelIds: ['1'], attention: false },
      { id: 'b', name: 'B', channelIds: ['1', '2'], attention: false }
    ])
    expect(overlapping.map((section) => [section.id, section.sessions.map((session) => session.channelId)])).toEqual([
      ['a', ['1']],
      ['b', ['2']]
    ])
    expect(buildSessionRailSections([], [{ id: 'a', name: 'A', channelIds: ['1'], attention: false }])).toEqual([])
  })
})

describe('session-rail-view 标题与摘要', () => {
  it('把「角色 · CH-N」拆成角色名与通道号；未绑定通道只留 SG Team', () => {
    expect(sessionRailTitle({ displayName: '架构实现 · CH-2', channelId: '2' })).toEqual({ name: '架构实现', channel: 'CH-2' })
    expect(sessionRailTitle({ displayName: '后端实现（临时主控） · CH-4', channelId: '4' })).toEqual({ name: '后端实现（临时主控）', channel: 'CH-4' })
    expect(sessionRailTitle({ displayName: 'SG Team CH-8', channelId: '8' })).toEqual({ name: 'SG Team', channel: 'CH-8' })
    expect(sessionRailTitle({ displayName: '', channelId: '9' })).toEqual({ name: 'SG Team', channel: 'CH-9' })
  })

  it('摘要：组数在前、会话总数、需关注计数与排队总数；没有组不报「0 组」；空名册返回空串', () => {
    const queued = (queueDepth: number, patch: Partial<Parameters<typeof sessionRailGroupOf>[0]> = {}) => ({ ...facts(patch), queueDepth })
    const group = (id: string, sessions: Array<ReturnType<typeof queued>>) => ({ id, kind: 'group' as const, label: id, state: 'waiting' as const, attention: false, sessions })
    const independent = (sessions: Array<ReturnType<typeof queued>>) => ({ id: 'independent', kind: 'independent' as const, label: '独立', state: 'waiting' as const, attention: false, sessions })
    expect(sessionRailSummary([])).toBe('')
    expect(sessionRailSummary([independent([])])).toBe('')
    expect(sessionRailSummary([
      group('a', [queued(0), queued(1, { status: 'running', waiting: false, connectionPhase: 'processing' })]),
      group('b', [queued(2, { status: 'blocked', waiting: false, connectionPhase: 'approval' })]),
      independent([queued(0, { online: false, status: 'offline' })])
    ])).toBe('2 组 · 4 会话 · 1 需关注 · 排队 3')
    expect(sessionRailSummary([independent([queued(0), queued(0)])])).toBe('2 会话')
  })

  it('上下文光环：百分比直接映射为 pathLength=100 的 dasharray；极小值保底可见；空值不画', () => {
    expect(contextRingDash(undefined)).toBeUndefined()
    expect(contextRingDash(Number.NaN)).toBeUndefined()
    expect(contextRingDash(0)).toBe('0 100')
    expect(contextRingDash(0.4)).toBe('1.5 100')
    expect(contextRingDash(72.46)).toBe('72.5 100')
    expect(contextRingDash(140)).toBe('100 100')
  })
})

describe('session-rail-view 常驻状态行（Cursor 会话列表副标题复刻）', () => {
  const live = (blocks: ProcessBlock[], generating = true): LiveProcessState => ({
    turn: 'cursor:t1', blocks, generating, startedAt: 1, updatedAt: 2
  })
  const streaming: LiveAgentResponseState = {
    id: 'b1', channelId: '1', text: '**结论**：先修 `hook`，再修渲染层。\n\n第二段不进片段。', status: 'streaming', startedAt: 1, updatedAt: 2
  }
  const cursor = (patch: Partial<LiveStatusLineState> = {}): LiveStatusLineState => ({
    composerId: 'c1', generating: true, composerStatus: 'generating', updatedAt: 2, ...patch
  })
  const active = () => facts({ status: 'running', waiting: false, connectionPhase: 'processing' })
  const on = { live: true, muted: false }
  const off = { live: false, muted: true }

  it('永远返回一条：离线常驻——明确终止 → Stopped，心跳消失 → Completed；灰化、无转圈', () => {
    expect(sessionRailActivity(facts({ online: false, status: 'offline' }))).toEqual({ kind: 'other', verb: 'Completed', ...off })
    expect(sessionRailActivity(facts({ online: false, status: 'stopped' }))).toEqual({ kind: 'other', verb: 'Stopped', ...off })
    expect(sessionRailActivity(facts({ status: 'running', runtimeEvidence: 'stopped' }))).toEqual({ kind: 'other', verb: 'Stopped', ...off })
    expect(sessionRailActivity(facts({ online: false, status: 'offline', connectionPhase: 'cursor_stopped' })).verb).toBe('Stopped')
    expect(sessionRailActivity(facts({ online: false, status: 'offline', connectionPhase: 'tool_aborted' })).verb).toBe('Stopped')
    // Cursor 自己说回合 aborted → 离线行也读作 Stopped。
    expect(sessionRailActivity(facts({ online: false, status: 'offline' }), undefined, undefined, cursor({ generating: false, composerStatus: 'aborted' })).verb).toBe('Stopped')
    // 离线优先于任何实时事实：运行中的块不会把离线行说成 Reading。
    const runningTool: ProcessBlock = { kind: 'tool', id: 't1', toolName: 'read_file_v2', toolKind: 'read', summary: 'src/main.ts', status: 'running' }
    expect(sessionRailActivity(facts({ online: false, status: 'offline' }), live([runningTool]), streaming, cursor({ statusLine: { kind: 'thinking', label: 'Thinking' } })).verb).toBe('Completed')
  })

  it('正在启动 → Starting up（转圈）', () => {
    expect(sessionRailActivity(facts({ status: 'starting', waiting: false, connectionPhase: '' }))).toEqual({ kind: 'other', verb: 'Starting up', ...on })
  })

  it('等待用户决策 → Awaiting approval · 问题标题；权威 false 撤销旧 pending；离线优先', () => {
    const question: ProcessBlock = {
      kind: 'tool', id: 'q1', toolName: 'ask_question', toolKind: 'question', status: 'running',
      question: { toolCallId: 'q1', title: '请选择方向', status: 'pending', questions: [] }
    }
    const snapshot = live([question], false)
    expect(sessionRailActivity({ ...active(), awaitingUser: true }, snapshot))
      .toEqual({ kind: 'question', verb: 'Awaiting approval', detail: '请选择方向', live: false, muted: false })
    // 运行时未知时回退过程块里的待答问卷。
    expect(sessionRailActivity(active(), snapshot).verb).toBe('Awaiting approval')
    // 权威 false：旧 pending 块不再充当依据——回合已结束（generating=false）→ Completed。
    expect(sessionRailActivity({ ...active(), awaitingUser: false }, snapshot)).toEqual({ kind: 'other', verb: 'Completed', ...off })
    expect(sessionRailActivity({ ...active(), awaitingUser: true, online: false }, snapshot).verb).toBe('Completed')
    // 没有过程块也能只凭权威值显示（标题缺省）。
    expect(sessionRailActivity({ ...active(), awaitingUser: true })).toEqual({ kind: 'question', verb: 'Awaiting approval', live: false, muted: false })
    // 待决策优先于 Cursor 侧事实（Cursor 此时把 composer 标为非生成态，副标题会说 Completed）。
    expect(sessionRailActivity({ ...active(), awaitingUser: true }, undefined, undefined, cursor({ generating: false, composerStatus: 'completed' })).verb).toBe('Awaiting approval')
  })

  it('Cursor 侧事实优先：Thinking / 工具拆成动词 + 对象 / 正文片段 / To-Dos；扫不到 → Planning next moves；回合结束 → Completed / Stopped', () => {
    expect(sessionRailActivity(active(), undefined, undefined, cursor({ statusLine: { kind: 'thinking', label: 'Thinking' } })))
      .toEqual({ kind: 'thinking', verb: 'Thinking', ...on })
    expect(sessionRailActivity(active(), undefined, undefined, cursor({ statusLine: { kind: 'tool', label: 'Reading index.ts L1-40', detail: 'index.ts L1-40', toolKind: 'read' } })))
      .toEqual({ kind: 'read', verb: 'Reading', detail: 'index.ts L1-40', ...on })
    expect(sessionRailActivity(active(), undefined, undefined, cursor({ statusLine: { kind: 'tool', label: 'Grepping sessionRailActivity in src/ (*.ts)', detail: 'sessionRailActivity in src/ (*.ts)', toolKind: 'search' } })))
      .toEqual({ kind: 'search', verb: 'Grepping', detail: 'sessionRailActivity in src/ (*.ts)', ...on })
    expect(sessionRailActivity(active(), undefined, undefined, cursor({ statusLine: { kind: 'text', label: 'I dug into the Cursor 3.6.31 bundle and probed the…' } })))
      .toEqual({ kind: 'message', verb: 'I dug into the Cursor 3.6.31 bundle and probed the…', ...on })
    expect(sessionRailActivity(active(), undefined, undefined, cursor({ statusLine: { kind: 'todos', label: '3/7 To-Dos Completed', toolKind: 'todo' } })))
      .toEqual({ kind: 'todo', verb: '3/7 To-Dos Completed', ...on })
    // 回合存活但 Cursor 一个都没扫到：它自己的兜底原话。
    expect(sessionRailActivity(active(), undefined, undefined, cursor())).toEqual({ kind: 'other', verb: 'Planning next moves', ...on })
    // 回合结束：Completed；aborted → Stopped。有事实时不再看过程块。
    const thinking: ProcessBlock = { kind: 'thinking', id: 'th1', text: '先看入口', status: 'running' }
    expect(sessionRailActivity(active(), live([thinking]), streaming, cursor({ generating: false, composerStatus: 'completed' })))
      .toEqual({ kind: 'other', verb: 'Completed', ...off })
    expect(sessionRailActivity(active(), live([thinking]), undefined, cursor({ generating: false, composerStatus: 'aborted' }))).toEqual({ kind: 'other', verb: 'Stopped', ...off })
  })

  it('没有事实时按过程块用同一算法回退：有详情的工具 → 动词 + basename；shell / MCP 跳过；贯穿 thinking → 工具 → thinking 不消失', () => {
    const thinking: ProcessBlock = { kind: 'thinking', id: 'th1', text: '先看入口', status: 'running' }
    const read: ProcessBlock = { kind: 'tool', id: 'r1', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: 'src/main/index.ts', status: 'running' }
    const frames: LiveProcessState[] = [
      live([thinking]),
      live([{ ...thinking, status: 'done' }, read]),
      live([{ ...thinking, status: 'done' }, { ...read, status: 'done' }]),
      live([{ ...thinking, status: 'done' }, { ...read, status: 'done' }, { kind: 'thinking', id: 'th2', text: '继续', status: 'running' }])
    ]
    const activities = frames.map((frame) => sessionRailActivity(active(), frame))
    // Cursor 副标题动词恒为 loading 形态（Reading 而非 Read），不看块状态。
    expect(activities.map((activity) => activity.verb)).toEqual(['Thinking', 'Reading', 'Reading', 'Thinking'])
    expect(activities[1]).toEqual({ kind: 'read', verb: 'Reading', detail: 'index.ts', ...on })
    expect(activities.every((activity) => activity.live)).toBe(true)

    // shell 没有「详情」→ 被跳过；其前是 thinking → Thinking；单独一个 shell → Planning next moves。
    const shell: ProcessBlock = {
      kind: 'tool', id: 'sh1', toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall',
      title: '运行分组相关测试', summary: 'npx vitest run tests/process-step-groups.test.ts', hint: 'npx', status: 'running'
    }
    expect(sessionRailActivity(active(), live([{ ...thinking, status: 'done' }, shell])).verb).toBe('Thinking')
    expect(sessionRailActivity(active(), live([shell]))).toEqual({ kind: 'other', verb: 'Planning next moves', ...on })
    // 业务 MCP 同样无详情：落到其前的正文片段。
    const mcp: ProcessBlock = { kind: 'tool', id: 'm1', toolName: 'mcp-SG Team-team_task', toolKind: 'mcp', toolCase: 'mcpToolCall', summary: 'team_task', status: 'running' }
    const message: ProcessBlock = { kind: 'message', id: 'msg', text: '先领取任务，再看看板。', status: 'done' }
    expect(sessionRailActivity(active(), live([message, mcp]))).toEqual({ kind: 'message', verb: '先领取任务，再看看板。', ...on })
    // 旧持久化块只有 summary（无 input / toolCase）：按 toolKind 回填参数位。
    expect(sessionRailActivity(active(), live([{ kind: 'tool', id: 'g', toolName: 'grep_search', toolKind: 'search', summary: 'sessionRailActivity', status: 'running' }])))
      .toEqual({ kind: 'search', verb: 'Grepping', detail: 'sessionRailActivity', ...on })
    // input 是真实参数时按 Cursor 的详情规则：读取带行号范围。
    expect(sessionRailActivity(active(), live([{ kind: 'tool', id: 'r2', toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: 'a.ts', input: { path: 'src/a.ts', offset: 10, limit: 30 }, status: 'running' }])))
      .toEqual({ kind: 'read', verb: 'Reading', detail: 'a.ts L10-40', ...on })
  })

  it('正文流式 → 首行剥 Markdown 截 50 字；回合明确结束 → Completed；一无所知但在岗 → Planning next moves', () => {
    expect(sessionRailActivity(active(), live([]), streaming)).toEqual({ kind: 'message', verb: '结论：先修 hook，再修渲染层。', ...on })
    expect(sessionRailActivity(active(), undefined, streaming).verb).toBe('结论：先修 hook，再修渲染层。')
    // 正文流式优先于遗留 running 块（它是最新的气泡）。
    const stale: ProcessBlock = { kind: 'tool', id: 'old', toolName: 'read_file', toolKind: 'read', summary: 'old.ts', status: 'running' }
    expect(sessionRailActivity(active(), live([stale], false), streaming).verb).toBe('结论：先修 hook，再修渲染层。')
    // 长正文按 50 字截断加省略号。
    const long: LiveAgentResponseState = { ...streaming, text: 'x'.repeat(80) }
    expect(sessionRailActivity(active(), undefined, long).verb).toBe(`${'x'.repeat(50)}…`)
    // 回合明确结束（generating=false、无流式正文）→ Completed（旧规格是「不显示」）。
    expect(sessionRailActivity(active(), live([stale], false))).toEqual({ kind: 'other', verb: 'Completed', ...off })
    expect(sessionRailActivity(active(), live([], false))).toEqual({ kind: 'other', verb: 'Completed', ...off })
    // 完全没有 Cursor 侧事实、席位在岗：Cursor 对「生成中但无可展示动作」的原话。
    expect(sessionRailActivity(active())).toEqual({ kind: 'other', verb: 'Planning next moves', ...on })
    expect(sessionRailActivity(facts())).toEqual({ kind: 'other', verb: 'Planning next moves', ...on })
    // 回合存活、视图为空（封口撤下全部块 / MCP 长轮询期）：同样是 Planning next moves，行不消失。
    expect(sessionRailActivity(active(), live([]))).toEqual({ kind: 'other', verb: 'Planning next moves', ...on })
  })

  it('不为一个状态标签解析已结束历史的输出和 Diff', () => {
    const history: ProcessBlock = { kind: 'tool', id: 'old-edit', toolName: 'edit_file', toolKind: 'edit', status: 'done',
      get output(): string { throw new Error('历史输出不应被状态标签读取') } }
    const current: ProcessBlock = { kind: 'tool', id: 'read', toolName: 'read_file', toolKind: 'read', summary: 'now.ts', status: 'running' }
    expect(sessionRailActivity(active(), live([history, current]))).toEqual({ kind: 'read', verb: 'Reading', detail: 'now.ts', ...on })
  })
})
