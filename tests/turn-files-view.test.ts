import { describe, expect, it } from 'vitest'
import type { ConversationEntry, ProcessBlock } from '../src/domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../src/domain/workspace-review'
import type { LiveProcessState } from '../src/shared/desktop-api'
import {
  buildTurnFilesView,
  describeLineCounts,
  parseEditHint,
  sameTurnFilesView,
  splitTurnFilePath,
  turnTotalsTitle
} from '../src/renderer/src/turn-files-view'

function edit(id: string, path: string, hint?: string, extra: Partial<Extract<ProcessBlock, { kind: 'tool' }>> = {}): ProcessBlock {
  return { kind: 'tool', id, toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall', summary: path, hint, status: 'done', ...extra }
}

function entry(partial: Partial<ConversationEntry> & Pick<ConversationEntry, 'id' | 'role'>): ConversationEntry {
  return { channelId: '2', text: '', timestamp: 1_000, status: 'complete', source: 'cursor', ...partial }
}

const summaryReady: WorkspaceReviewSummary = {
  state: 'ready', scope: 'uncommitted', workspaceName: 'demo', revision: 'r1', updatedAt: 1, additions: 45, deletions: 355,
  files: [
    { path: 'src/domain/team-control.ts', status: 'modified', staged: false, unstaged: true, additions: 18, deletions: 20 },
    { path: 'src/application/team-failover-service.ts', status: 'modified', staged: false, unstaged: true, additions: 27, deletions: 318 },
    { path: 'src/application/unrelated.ts', status: 'modified', staged: false, unstaged: true, additions: 1, deletions: 1 },
    { path: 'docs/old.md', status: 'deleted', staged: false, unstaged: true, additions: 0, deletions: 30 },
    { path: 'build/icon.png', status: 'untracked', staged: false, unstaged: true, binary: true }
  ]
}

describe('turn-files-view · 解析与拆分', () => {
  it('parseEditHint 认 hook 的 `+N −M`（Unicode 减号与 ASCII 减号都认），其余形态返回 undefined', () => {
    expect(parseEditHint('+18 −20')).toEqual({ additions: 18, deletions: 20 })
    expect(parseEditHint('+9 -15')).toEqual({ additions: 9, deletions: 15 })
    expect(parseEditHint(' +0 −3 ')).toEqual({ additions: 0, deletions: 3 })
    expect(parseEditHint('L12-80')).toBeUndefined()
    expect(parseEditHint('3 个文件')).toBeUndefined()
    expect(parseEditHint(undefined)).toBeUndefined()
  })

  it('describeLineCounts 只说非零的一侧；两侧为零说无行数变化，二进制说二进制', () => {
    expect(describeLineCounts(18, 20)).toBe('+18 −20')
    expect(describeLineCounts(28, 0)).toBe('+28')
    expect(describeLineCounts(0, 30)).toBe('−30')
    expect(describeLineCounts(0, 0)).toBe('无行数变化')
    expect(describeLineCounts(5, 5, true)).toBe('二进制')
  })

  it('splitTurnFilePath 拆目录 / 主干 / 扩展名，隐藏文件与无扩展名整体视为主干', () => {
    expect(splitTurnFilePath('src/renderer/src/App.tsx')).toEqual({ dir: 'src/renderer/src/', stem: 'App', ext: '.tsx' })
    expect(splitTurnFilePath('README')).toEqual({ dir: '', stem: 'README', ext: '' })
    expect(splitTurnFilePath('.gitignore')).toEqual({ dir: '', stem: '.gitignore', ext: '' })
  })
})

describe('turn-files-view · 投影', () => {
  const userAt = 10_000
  const entries: ConversationEntry[] = [
    // 上一轮：它的编辑不属于本轮。
    entry({ id: 'u0', role: 'user', source: 'desktop', timestamp: 1_000, deliveredAt: 1_500, text: '上一轮' }),
    entry({ id: 'r0', role: 'assistant', timestamp: 2_000, replyToEntryId: 'u0', processBlocks: [edit('old', 'src/old-turn.ts', '+5 −5')] }),
    // 本轮：已落库回复里的编辑 + 续作里的编辑。
    entry({ id: 'u1', role: 'user', source: 'desktop', timestamp: userAt, deliveredAt: userAt + 500, text: '本轮' }),
    entry({
      id: 'r1', role: 'assistant', timestamp: userAt + 60_000, replyToEntryId: 'u1',
      processBlocks: [
        edit('e1', 'src/domain/team-control.ts', '+10 −2'),
        { kind: 'tool', id: 'read', toolName: 'read_file_v2', toolKind: 'read', summary: 'src/domain/team-control.ts', status: 'done' },
        edit('e2', 'src/domain/team-control.ts', '+8 −18')
      ],
      continuationBlocks: [edit('e3', 'src/application/team-failover-service.ts', '+27 −318')]
    })
  ]
  const live: LiveProcessState = {
    turn: 'live', startedAt: userAt + 70_000, updatedAt: userAt + 80_000, generating: true,
    blocks: [
      edit('e4', 'docs/old.md', undefined, { toolCase: 'deleteToolCall', toolName: 'delete_file' }),
      edit('e5', 'src/new-file.ts', undefined, { toolKind: 'write', diff: { lines: [
        { type: 'hunk', text: '@@' }, { type: 'added', text: 'a' }, { type: 'added', text: 'b' }, { type: 'removed', text: 'c' }
      ] } })
    ]
  }

  it('只收本轮的 edit / write，按首次出现排序、按路径去重；有 Git 摘要时数字取文件级 diff', () => {
    const view = buildTurnFilesView({ entries, liveProcess: live, summary: summaryReady, working: true })
    expect(view.files.map((file) => file.path)).toEqual([
      'src/domain/team-control.ts',
      'src/application/team-failover-service.ts',
      'docs/old.md',
      'src/new-file.ts'
    ])
    // 上一轮的 src/old-turn.ts 与只被读过的文件不出现；摘要里未被本轮改动的 unrelated.ts 也不出现。
    expect(view.files.some((file) => file.path.includes('old-turn') || file.path.includes('unrelated'))).toBe(false)
    const [control, failover, deleted, fresh] = view.files
    // Git 口径：两次编辑 (+10 −2) + (+8 −18) 不做求和，取工作树净变化 +18 −20。
    expect(control).toMatchObject({ additions: 18, deletions: 20, status: 'modified', source: 'git', icon: 'typescript', stem: 'team-control', ext: '.ts', dir: 'src/domain/', ambiguous: false })
    expect(failover).toMatchObject({ additions: 27, deletions: 318, source: 'git' })
    expect(deleted).toMatchObject({ status: 'deleted', additions: 0, deletions: 30, source: 'git', icon: 'markdown' })
    // Git 还没看到的新文件回退到过程块：hint 缺失就数结构化 diff 的行。
    expect(fresh).toMatchObject({ additions: 2, deletions: 1, source: 'process' })
    expect(fresh?.status).toBeUndefined()
    expect(view.estimated).toBe(true)
    expect(view.working).toBe(true)
    expect(view.additions).toBe(18 + 27 + 0 + 2)
    expect(view.deletions).toBe(20 + 318 + 30 + 1)
  })

  it('没有 Git 摘要（非 git 工程 / 未就绪）时全部回退到过程块 hint 逐次求和，并整体标为估算', () => {
    const view = buildTurnFilesView({ entries, liveProcess: undefined, summary: undefined, working: false })
    expect(view.files.map((file) => [file.path, file.additions, file.deletions, file.source])).toEqual([
      ['src/domain/team-control.ts', 18, 20, 'process'],
      ['src/application/team-failover-service.ts', 27, 318, 'process']
    ])
    expect(view.estimated).toBe(true)
    expect(view.working).toBe(false)
    const notReady: WorkspaceReviewSummary = { ...summaryReady, state: 'not_git', files: [] }
    expect(buildTurnFilesView({ entries, summary: notReady, working: false }).files.every((file) => file.source === 'process')).toBe(true)
  })

  it('二进制文件保留 binary 标记，工作区绝对路径按 workspacePath 归一为仓库相对路径', () => {
    const absolute: ConversationEntry[] = [
      entry({ id: 'u', role: 'user', source: 'desktop', timestamp: 1, deliveredAt: 2, text: 'x' }),
      entry({ id: 'r', role: 'assistant', timestamp: 3, replyToEntryId: 'u', processBlocks: [
        edit('w', 'E:\\SG\\build\\icon.png', undefined, { toolKind: 'write' })
      ] })
    ]
    const view = buildTurnFilesView({ entries: absolute, summary: summaryReady, workspacePath: 'E:\\SG', working: false })
    expect(view.files).toHaveLength(1)
    expect(view.files[0]).toMatchObject({ path: 'build/icon.png', binary: true, status: 'untracked', source: 'git', icon: 'image' })
  })

  it('同名文件不止一个时才标 ambiguous（行里才摆目录）；名字唯一的文件不标', () => {
    const sameNames: ConversationEntry[] = [
      entry({ id: 'u', role: 'user', source: 'desktop', timestamp: 1, deliveredAt: 2, text: 'x' }),
      entry({ id: 'r', role: 'assistant', timestamp: 3, replyToEntryId: 'u', processBlocks: [
        edit('a', 'src/mcp/index.ts', '+1 −0'),
        edit('b', 'src/renderer/src/App.tsx', '+2 −0'),
        edit('c', 'src/main/index.ts', '+3 −0'),
        edit('d', 'src/preload/index.ts', '+4 −0')
      ] })
    ]
    const view = buildTurnFilesView({ entries: sameNames, working: false })
    expect(view.files.map((file) => [file.path, file.ambiguous])).toEqual([
      ['src/mcp/index.ts', true],
      ['src/renderer/src/App.tsx', false],
      ['src/main/index.ts', true],
      ['src/preload/index.ts', true]
    ])
  })

  it('本轮没有文件改动时返回同一个空视图对象（栏不渲染，memo 边界天然稳定）', () => {
    const readOnly: ConversationEntry[] = [
      entry({ id: 'u', role: 'user', source: 'desktop', timestamp: 1, deliveredAt: 2, text: 'x' }),
      entry({ id: 'r', role: 'assistant', timestamp: 3, replyToEntryId: 'u', processBlocks: [
        { kind: 'tool', id: 'read', toolName: 'read_file_v2', toolKind: 'read', summary: 'a.ts', status: 'done' }
      ] })
    ]
    const first = buildTurnFilesView({ entries: readOnly, working: true })
    const second = buildTurnFilesView({ entries: [], working: false })
    expect(first.files).toEqual([])
    expect(first).toBe(second)
  })

  it('下一条用户消息被取走即为新回合：Agent 干活中且本轮尚无编辑时保住上一轮（标 previous），第一次编辑后替换', () => {
    const next: ConversationEntry[] = [
      ...entries,
      entry({ id: 'u2', role: 'user', source: 'desktop', timestamp: userAt + 100_000, deliveredAt: userAt + 100_500, text: '下一轮' })
    ]
    // 消息刚被取走、还没有编辑：栏不清零，保住上一轮（只算已落库回复：r1 的封口块 + 续作块）。
    const held = buildTurnFilesView({ entries: next, summary: summaryReady, working: true })
    expect(held.scope).toBe('previous')
    expect(held.files.map((file) => file.path)).toEqual(['src/domain/team-control.ts', 'src/application/team-failover-service.ts'])
    expect(held.files[0]).toMatchObject({ additions: 18, deletions: 20, source: 'git' })
    expect(held.working).toBe(true)
    // 本轮第一次编辑到达：换成本轮自己的文件。
    const firstEdit: LiveProcessState = { ...live, blocks: [edit('n1', 'src/mcp/index.ts', '+22 −37')] }
    const replaced = buildTurnFilesView({ entries: next, liveProcess: firstEdit, working: true })
    expect(replaced.scope).toBe('turn')
    expect(replaced.files.map((file) => file.path)).toEqual(['src/mcp/index.ts'])
    // 回复落库后仍没有编辑（Agent 不再处理本轮）：这一轮确实什么都没改，栏消失。
    const settled = buildTurnFilesView({ entries: next, working: false })
    expect(settled.files).toEqual([])
    expect(settled.scope).toBe('turn')
    // 上一轮本身也没有编辑：没有可保住的东西。
    const twoEmpty: ConversationEntry[] = [
      entry({ id: 'a', role: 'user', source: 'desktop', timestamp: 1, deliveredAt: 2, text: 'a' }),
      entry({ id: 'ra', role: 'assistant', timestamp: 3, replyToEntryId: 'a', processBlocks: [] }),
      entry({ id: 'b', role: 'user', source: 'desktop', timestamp: 4, deliveredAt: 5, text: 'b' })
    ]
    expect(buildTurnFilesView({ entries: twoEmpty, working: true }).files).toEqual([])
    // 仍在排队（未投递）的消息不开新回合：本轮照常。
    const queued: ConversationEntry[] = [
      ...entries,
      entry({ id: 'u2', role: 'user', source: 'desktop', timestamp: userAt + 100_000, text: '排队中' })
    ]
    const current = buildTurnFilesView({ entries: queued, working: true })
    expect(current.scope).toBe('turn')
    expect(current.files.map((file) => file.path)).toEqual(['src/domain/team-control.ts', 'src/application/team-failover-service.ts'])
  })

  it('sameTurnFilesView 按内容判等：路径集、顺序、数字、状态、来源、生成态与范围任一不同即不等', () => {
    const base = buildTurnFilesView({ entries, liveProcess: live, summary: summaryReady, working: true })
    const again = buildTurnFilesView({ entries, liveProcess: live, summary: summaryReady, working: true })
    expect(again).not.toBe(base)
    expect(sameTurnFilesView(base, again)).toBe(true)
    expect(sameTurnFilesView(undefined, again)).toBe(false)
    expect(sameTurnFilesView(base, { ...again, working: false })).toBe(false)
    const bumped: WorkspaceReviewSummary = { ...summaryReady, files: summaryReady.files.map((file) => (
      file.path === 'src/domain/team-control.ts' ? { ...file, additions: 19 } : file
    )) }
    expect(sameTurnFilesView(base, buildTurnFilesView({ entries, liveProcess: live, summary: bumped, working: true }))).toBe(false)
    const fewer = buildTurnFilesView({ entries, liveProcess: undefined, summary: summaryReady, working: true })
    expect(sameTurnFilesView(base, fewer)).toBe(false)
    expect(sameTurnFilesView(fewer, { ...fewer, scope: 'previous' })).toBe(false)
    expect(sameTurnFilesView(fewer, { ...fewer, totalsSource: 'composer' })).toBe(false)
  })
})

describe('turn-files-view · 合计与名册同源（Cursor Composer 累计净值）', () => {
  // 本轮是会话迄今唯一的改动区间：一条已投递用户消息，全部编辑都在直播块里（还没落库）。
  const soleTurn: ConversationEntry[] = [
    entry({ id: 'u', role: 'user', source: 'desktop', timestamp: 1, deliveredAt: 2, text: '接手' })
  ]
  const soleLive: LiveProcessState = {
    turn: 'live', startedAt: 3, updatedAt: 4, generating: true,
    blocks: [
      edit('a', 'src/renderer/src/SessionSidebar.tsx', '+300 −40'),
      edit('b', 'src/renderer/src/SessionSidebar.tsx', '+200 −60'),
      edit('c', 'src/renderer/src/styles.css', '+407 −83')
    ]
  }
  const cursorTotals = { additions: 863, deletions: 137, files: 13 }

  it('逐笔估算会把同文件反复编辑重复计入；本轮 = 唯一改动区间时合计改用 Cursor 净值，与名册行同一个数', () => {
    const estimatedOnly = buildTurnFilesView({ entries: soleTurn, liveProcess: soleLive, working: true })
    expect(estimatedOnly.additions).toBe(907)
    expect(estimatedOnly.deletions).toBe(183)
    expect(estimatedOnly.estimated).toBe(true)
    expect(estimatedOnly.totalsSource).toBe('sum')

    const reconciled = buildTurnFilesView({ entries: soleTurn, liveProcess: soleLive, working: true, sessionChanges: cursorTotals })
    expect(reconciled.additions).toBe(863)
    expect(reconciled.deletions).toBe(137)
    expect(reconciled.estimated).toBe(false)
    expect(reconciled.totalsSource).toBe('composer')
    // 逐文件行保持过程估算（明细自己标 process，行内继续淡显）。
    expect(reconciled.files.map((file) => [file.path, file.additions, file.deletions, file.source])).toEqual([
      ['src/renderer/src/SessionSidebar.tsx', 500, 100, 'process'],
      ['src/renderer/src/styles.css', 407, 83, 'process']
    ])
  })

  it('更早回合有过改动（含旧 Composer 的历史）：区间不同，不能互换，保持逐笔估算', () => {
    const withHistory: ConversationEntry[] = [
      entry({ id: 'u0', role: 'user', source: 'desktop', timestamp: 1, deliveredAt: 2, text: '上一轮' }),
      entry({ id: 'r0', role: 'assistant', timestamp: 3, replyToEntryId: 'u0', processBlocks: [edit('old', 'src/old-turn.ts', '+5 −5')] }),
      entry({ id: 'u1', role: 'user', source: 'desktop', timestamp: 4, deliveredAt: 5, text: '本轮' })
    ]
    const view = buildTurnFilesView({ entries: withHistory, liveProcess: soleLive, working: true, sessionChanges: cursorTotals })
    expect(view.scope).toBe('turn')
    expect(view.totalsSource).toBe('sum')
    expect(view.estimated).toBe(true)
    expect(view.additions).toBe(907)
  })

  it('Cursor 累计还没写盘（全零）时不接管——避免有文件而合计为 0', () => {
    const view = buildTurnFilesView({
      entries: soleTurn, liveProcess: soleLive, working: true,
      sessionChanges: { additions: 0, deletions: 0 }
    })
    expect(view.additions).toBe(907)
    expect(view.totalsSource).toBe('sum')
    expect(view.estimated).toBe(true)
  })

  it('全部走 Git 精确口径时不接管（合计 = 文件级 diff 相加，与审查页一致）', () => {
    const gitOnly: ConversationEntry[] = [
      entry({ id: 'u', role: 'user', source: 'desktop', timestamp: 1, deliveredAt: 2, text: 'x' }),
      entry({ id: 'r', role: 'assistant', timestamp: 3, replyToEntryId: 'u', processBlocks: [
        edit('a', 'src/domain/team-control.ts', '+10 −2')
      ] })
    ]
    const view = buildTurnFilesView({ entries: gitOnly, summary: summaryReady, working: false, sessionChanges: cursorTotals })
    expect(view.totalsSource).toBe('sum')
    expect(view.additions).toBe(18)
    expect(view.deletions).toBe(20)
    expect(view.estimated).toBe(false)
  })

  it('没有刻度时保住上一轮（scope=previous）不接管：Cursor 累计描述的不是被保住的那一轮', () => {
    const next: ConversationEntry[] = [
      entry({ id: 'u0', role: 'user', source: 'desktop', timestamp: 1, deliveredAt: 2, text: '上一轮' }),
      entry({ id: 'r0', role: 'assistant', timestamp: 3, replyToEntryId: 'u0', processBlocks: [edit('old', 'src/old-turn.ts', '+5 −5')] }),
      entry({ id: 'u1', role: 'user', source: 'desktop', timestamp: 4, deliveredAt: 5, text: '下一轮' })
    ]
    const held = buildTurnFilesView({ entries: next, working: true, sessionChanges: cursorTotals })
    expect(held.scope).toBe('previous')
    expect(held.files.map((file) => file.path)).toEqual(['src/old-turn.ts'])
    expect(held.totalsSource).toBe('sum')
  })
})

describe('turn-files-view · 回合起点刻度差分（多回合也与名册同源，不再倒挂）', () => {
  const composerId = 'composer-c1'
  // 第 1 轮改了 105/8（Cursor 净值），第 2 轮的消息被取走时盖上刻度 105/8；第 2 轮直播里逐笔估算已经堆到 ≈145/22。
  const turnOne: ConversationEntry[] = [
    entry({ id: 'u0', role: 'user', source: 'desktop', timestamp: 1, deliveredAt: 2, text: '第一轮', changesBaseline: { composerId, additions: 0, deletions: 0 } }),
    entry({ id: 'r0', role: 'assistant', timestamp: 3, replyToEntryId: 'u0', processBlocks: [
      edit('a', 'tests/desktop-session-service.test.ts', '+86 −0'),
      edit('b', 'tests/cursor-composer-telemetry.test.ts', '+29 −9'),
      edit('c', 'tests/cursor-composer-telemetry.test.ts', '+30 −13')
    ] })
  ]
  const turnTwoMessage = entry({ id: 'u1', role: 'user', source: 'desktop', timestamp: 10, deliveredAt: 11, text: '第二轮', changesBaseline: { composerId, additions: 105, deletions: 8 } })
  const turnTwoLive: LiveProcessState = {
    turn: 'live', startedAt: 12, updatedAt: 13, generating: true,
    blocks: [
      edit('d', 'src/renderer/src/TodoIndicator.tsx', '+40 −36'),
      edit('e', 'src/renderer/src/styles.css', '+10 −8'),
      edit('f', 'src/renderer/src/styles.css', '+1 −1')
    ]
  }

  it('本轮：现在的累计 − 本轮起点刻度；更早回合有过改动也照样同源（这正是名册 +105 −8 对栏 ≈+145 −22 的倒挂根因）', () => {
    const view = buildTurnFilesView({
      entries: [...turnOne, turnTwoMessage], liveProcess: turnTwoLive, working: true,
      sessionChanges: { additions: 105 + 22, deletions: 8 + 15, files: 9 }, sessionComposerId: composerId
    })
    expect(view.scope).toBe('turn')
    expect(view.totalsSource).toBe('composer')
    expect(view.estimated).toBe(false)
    expect(view.additions).toBe(22)
    expect(view.deletions).toBe(15)
    // 逐文件仍是过程估算（行内淡显、悬停说明），相加可以大于合计。
    expect(view.files.map((file) => [file.path, file.additions, file.deletions, file.source])).toEqual([
      ['src/renderer/src/TodoIndicator.tsx', 40, 36, 'process'],
      ['src/renderer/src/styles.css', 11, 9, 'process']
    ])
    expect(turnTotalsTitle(view)).toContain('本轮开始到现在')
  })

  it('保住上一轮：本轮起点刻度 − 上一轮起点刻度；上一轮是会话第一段改动时起点按零（截图场景：栏与名册同为 +105 −8）', () => {
    const twoStamps = buildTurnFilesView({
      entries: [...turnOne, turnTwoMessage], working: true,
      sessionChanges: { additions: 105, deletions: 8 }, sessionComposerId: composerId
    })
    expect(twoStamps.scope).toBe('previous')
    expect(twoStamps.totalsSource).toBe('composer')
    expect(twoStamps.additions).toBe(105)
    expect(twoStamps.deletions).toBe(8)
    expect(turnTotalsTitle(twoStamps)).toContain('上一轮开始到本轮开始之间')
    // 第一条消息没有刻度（旧数据 / 投递时桌面端不在），但它之前没有任何改动：起点按零，同样能差分。
    const firstUnstamped: ConversationEntry[] = [{ ...turnOne[0]!, changesBaseline: undefined }, turnOne[1]!, turnTwoMessage]
    const held = buildTurnFilesView({ entries: firstUnstamped, working: true, sessionChanges: { additions: 105, deletions: 8 }, sessionComposerId: composerId })
    expect(held.totalsSource).toBe('composer')
    expect(held.additions).toBe(105)
    // 再往前还有改动、而上一轮又没刻度：区间起点不可知，退回估算。
    const older: ConversationEntry[] = [
      entry({ id: 'z', role: 'user', source: 'desktop', timestamp: 0, deliveredAt: 0, text: '更早' }),
      entry({ id: 'rz', role: 'assistant', timestamp: 0, replyToEntryId: 'z', processBlocks: [edit('z1', 'src/z.ts', '+1 −1')] }),
      ...firstUnstamped
    ]
    expect(buildTurnFilesView({ entries: older, working: true, sessionChanges: { additions: 105, deletions: 8 }, sessionComposerId: composerId }).totalsSource).toBe('sum')
  })

  it('刻度属于别的 Composer（席位重建）：本轮从零计数；上一轮跨了两个计数器则差分不成立，退回估算', () => {
    const rebuilt = buildTurnFilesView({
      entries: [...turnOne, turnTwoMessage], liveProcess: turnTwoLive, working: true,
      sessionChanges: { additions: 30, deletions: 4 }, sessionComposerId: 'composer-c2'
    })
    expect(rebuilt.totalsSource).toBe('composer')
    expect(rebuilt.additions).toBe(30)
    expect(rebuilt.deletions).toBe(4)
    const crossComposer: ConversationEntry[] = [
      ...turnOne,
      { ...turnTwoMessage, changesBaseline: { composerId: 'composer-c2', additions: 3, deletions: 0 } }
    ]
    const held = buildTurnFilesView({ entries: crossComposer, working: true, sessionChanges: { additions: 3, deletions: 0 }, sessionComposerId: 'composer-c2' })
    expect(held.scope).toBe('previous')
    expect(held.totalsSource).toBe('sum')
  })

  it('差分为全零（Cursor 尚未写盘）时先用估算顶住；净值回落的一侧按 0 计而不是负数', () => {
    const notFlushed = buildTurnFilesView({
      entries: [...turnOne, turnTwoMessage], liveProcess: turnTwoLive, working: true,
      sessionChanges: { additions: 105, deletions: 8 }, sessionComposerId: composerId
    })
    expect(notFlushed.totalsSource).toBe('sum')
    expect(notFlushed.estimated).toBe(true)
    expect(notFlushed.additions).toBe(51)
    // 本轮删掉了上一轮加的行：累计新增回落到 100，删除涨到 20 → 本轮 +0 −12。
    const fell = buildTurnFilesView({
      entries: [...turnOne, turnTwoMessage], liveProcess: turnTwoLive, working: true,
      sessionChanges: { additions: 100, deletions: 20 }, sessionComposerId: composerId
    })
    expect(fell.totalsSource).toBe('composer')
    expect(fell.additions).toBe(0)
    expect(fell.deletions).toBe(12)
  })
})
