import { describe, expect, it } from 'vitest'
import type { ConversationEntry, ProcessBlock } from '../src/domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../src/domain/workspace-review'
import type { LiveProcessState } from '../src/shared/desktop-api'
import {
  buildTurnFilesView,
  describeLineCounts,
  parseEditHint,
  sameTurnFilesView,
  splitTurnFilePath
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
  })
})
