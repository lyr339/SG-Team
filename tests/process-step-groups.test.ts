import { describe, expect, it } from 'vitest'
import type { ProcessBlock } from '../src/domain/conversation-entry'
import {
  groupProcessSteps,
  inferToolCase,
  isGroupableText,
  parseFileChangeStats,
  thoughtDurationDetails,
  type ProcessTurnGroup
} from '../src/renderer/src/process-step-groups'
import { buildProcessTurnView } from '../src/renderer/src/process-turn-view'

type Status = 'running' | 'done' | 'failed'

let counter = 0
const next = (prefix: string): string => `${prefix}-${counter += 1}`

const read = (path: string, status: Status = 'done'): ProcessBlock => ({
  kind: 'tool', id: next('read'), toolName: 'read_file_v2', toolKind: 'read', toolCase: 'readToolCall', summary: path, hint: 'L1-40', status
})
const ls = (path: string): ProcessBlock => ({
  kind: 'tool', id: next('ls'), toolName: 'list_dir', toolKind: 'read', toolCase: 'lsToolCall', summary: path, status: 'done'
})
const grep = (pattern: string, path = 'src', status: Status = 'done'): ProcessBlock => ({
  kind: 'tool', id: next('grep'), toolName: 'ripgrep_raw_search', toolKind: 'search', toolCase: 'grepToolCall', summary: pattern, hint: path, status
})
const shell = (command: string, status: Status = 'done'): ProcessBlock => ({
  kind: 'tool', id: next('shell'), toolName: 'run_terminal_command_v2', toolKind: 'command', toolCase: 'shellToolCall', title: '运行测试', summary: command, hint: 'npm', status
})
const edit = (path: string, hint = '+12 −3'): ProcessBlock => ({
  kind: 'tool', id: next('edit'), toolName: 'edit_file_v2', toolKind: 'edit', toolCase: 'editToolCall', summary: path, hint, status: 'done'
})
const thinking = (text: string, status: Status = 'done', durationMs?: number): ProcessBlock => ({
  kind: 'thinking', id: next('th'), text, status: status === 'failed' ? 'done' : status, durationMs
})
const message = (text: string): ProcessBlock => ({ kind: 'message', id: next('msg'), text, status: 'done' })
const browserMcp = (tool: string): ProcessBlock => ({
  kind: 'tool', id: next('browser'), toolName: `mcp-user-playwright-${tool}`, toolKind: 'mcp', toolCase: 'mcpToolCall', summary: 'http://localhost', status: 'done'
})
const teamMcp = (): ProcessBlock => ({
  kind: 'tool', id: next('mcp'), toolName: 'mcp-SG Team-team_task', toolKind: 'mcp', toolCase: 'mcpToolCall', summary: '', status: 'done'
})
const awaitCall = (taskId: string, status: Status = 'done'): ProcessBlock => ({
  kind: 'tool', id: next('await'), toolName: 'awaitToolCall', toolKind: 'task', toolCase: 'awaitToolCall', summary: taskId, status
})
const question = (): ProcessBlock => ({
  kind: 'tool', id: next('q'), toolName: 'ask_question', toolKind: 'question', toolCase: 'askQuestionToolCall', summary: '', status: 'running',
  question: { toolCallId: 'tc', status: 'pending', questions: [{ id: 'q', prompt: '?', allowMultiple: false, options: [{ id: 'a', label: 'A' }] }] }
})

function itemsOf(blocks: ProcessBlock[], options: Parameters<typeof groupProcessSteps>[1] = {}) {
  const model = buildProcessTurnView({ id: 'turn', blocks })
  return groupProcessSteps(model.steps, { density: 'detailed', isCompleted: model.status !== 'running', ...options })
}

const shape = (items: ReturnType<typeof groupProcessSteps>): string[] => items.map((item) => (
  item.kind === 'group' ? `group(${item.variant}:${item.steps.length})` : `step(${item.step.kind})`
))

const groupAt = (items: ReturnType<typeof groupProcessSteps>, index: number): ProcessTurnGroup => {
  const item = items[index]
  if (!item || item.kind !== 'group') throw new Error(`items[${index}] 不是组`)
  return item
}

describe('groupProcessSteps · Cursor detailed 密度分组（Jmd 移植）', () => {
  it('folds three consecutive light reads into one Explored group, but leaves two as singles (XUv 阈值 3)', () => {
    const three = itemsOf([read('/a.ts'), read('/b.ts'), read('/c.ts')])
    expect(shape(three)).toEqual(['group(explore:3)'])
    expect(groupAt(three, 0)).toMatchObject({ action: '已探索', details: '3 个文件', status: 'done' })

    const two = itemsOf([read('/a.ts'), read('/b.ts')])
    expect(shape(two)).toEqual(['step(read)', 'step(read)'])
  })

  it('absorbs a thinking step that follows a groupable tool, but a leading thinking cannot open a group', () => {
    const readThenThink = itemsOf([read('/a.ts'), thinking('看看实现')])
    expect(shape(readThenThink)).toEqual(['group(explore:2)'])
    expect(groupAt(readThenThink, 0).details).toBe('1 个文件')

    const thinkThenRead = itemsOf([thinking('先看文件'), read('/a.ts')])
    expect(shape(thinkThenRead)).toEqual(['step(thinking)', 'step(read)'])
  })

  it('counts searches next to files and groups non-light tools at threshold 1', () => {
    const items = itemsOf([grep('foo'), read('/a.ts')])
    expect(shape(items)).toEqual(['group(explore:2)'])
    expect(groupAt(items, 0).details).toBe('1 个文件、1 次搜索')

    const directories = itemsOf([ls('/src'), ls('/tests'), grep('bar')])
    expect(groupAt(directories, 0).details).toBe('2 个目录、1 次搜索')
  })

  it('keeps shell and edit standalone under detailed density and splits the exploration around them', () => {
    const items = itemsOf([shell('npm test'), read('/a.ts'), read('/b.ts'), read('/c.ts'), edit('/a.ts'), read('/d.ts')])
    expect(shape(items)).toEqual(['step(command)', 'group(explore:3)', 'step(edit)', 'step(read)'])
  })

  it('groups shell calls only under compact density', () => {
    const compact = itemsOf([shell('npm test'), shell('npm run build')], { density: 'compact-grouped' })
    expect(shape(compact)).toEqual(['group(commands:2)'])
    expect(groupAt(compact, 0)).toMatchObject({ action: '已运行', details: '2 条命令' })
    // compact 下 edit 与 shell 不混组（Xev）。
    const mixed = itemsOf([shell('npm test'), edit('/a.ts'), edit('/b.ts')], { density: 'compact-grouped' })
    expect(shape(mixed)).toEqual(['step(command)', 'group(edits:2)'])
    const edits = groupAt(mixed, 1)
    expect(edits).toMatchObject({ action: '已编辑', details: '2 个文件', fileChangeStats: { additions: 24, deletions: 6 } })
  })

  it('names a single edited file in the header when the name is short enough (iqv=20)', () => {
    // compact-grouped 下 edit 与非 edit 不混组（Xev）：各自成条。
    expect(shape(itemsOf([edit('/src/renderer/styles.css', '+4 −1'), read('/a.ts')], { density: 'compact-grouped' })))
      .toEqual(['step(edit)', 'step(read)'])
    // compact-all-grouped 才允许混组，此时组头带文件名与 explored 前缀。
    const items = itemsOf([edit('/src/renderer/styles.css', '+4 −1'), read('/a.ts')], { density: 'compact-all-grouped' })
    expect(shape(items)).toEqual(['group(edits:2)'])
    expect(groupAt(items, 0)).toMatchObject({ action: '已编辑', details: 'styles.css、探索了 1 个文件', fileChangeStats: { additions: 4, deletions: 1 } })
  })

  it('folds two browser MCP calls into a browser-actions group and leaves a lone one standalone', () => {
    const pair = itemsOf([browserMcp('browser_navigate'), browserMcp('browser_click')])
    expect(shape(pair)).toEqual(['group(browser:2)'])
    expect(groupAt(pair, 0)).toMatchObject({ action: '已操作浏览器', details: '2 次操作' })
    expect(shape(itemsOf([browserMcp('browser_navigate')]))).toEqual(['step(mcp)'])
    // 非浏览器 MCP（team_task）不可归组。
    expect(shape(itemsOf([teamMcp(), teamMcp()]))).toEqual(['step(mcp)', 'step(mcp)'])
  })

  it('monitors background tasks: two awaits open a waiting group that keeps absorbing shells and reads until text arrives', () => {
    const items = itemsOf([awaitCall('t1'), awaitCall('t2', 'running'), shell('tail log'), read('/log.txt'), message('后台任务完成了，接下来处理结果。这段正文足够长因此不会被当作短文本吸入任何组里面去。')])
    expect(shape(items)).toEqual(['group(waiting:4)', 'step(message)'])
    expect(groupAt(items, 0)).toMatchObject({ action: '监控后台任务', details: '1 已完成、1 进行中', status: 'running' })
    expect(shape(itemsOf([awaitCall('t1')]))).toEqual(['step(task)'])
  })

  it('moves a trailing thinking from the activity group into the waiting group (Jmd await 分支)', () => {
    const items = itemsOf([read('/a.ts'), thinking('等一下后台'), awaitCall('t1'), awaitCall('t2')])
    expect(shape(items)).toEqual(['step(read)', 'group(waiting:3)'])
  })

  it('keeps the group id stable while the group grows and flips the header verb when it settles', () => {
    // 同一批块的两帧：第二帧 thinking 收尾并追加第三个 read（块 id 不变，与直播帧一致）。
    const [first, second] = [read('/a.ts'), read('/b.ts')]
    const thought = thinking('继续', 'running')
    const growing = itemsOf([first!, second!, thought])
    const grown = itemsOf([first!, second!, { ...thought, status: 'done', durationMs: 1_800 } as ProcessBlock, read('/c.ts')])
    expect(groupAt(growing, 0).id).toBe(groupAt(grown, 0).id)
    expect(groupAt(growing, 0)).toMatchObject({ status: 'running', action: '探索中' })
    expect(groupAt(grown, 0)).toMatchObject({ status: 'done', action: '已探索', details: '3 个文件', thinkingDurationMs: 1_800 })
  })

  it('never groups a pending ask_question and flushes the activity around it', () => {
    const items = itemsOf([read('/a.ts'), read('/b.ts'), read('/c.ts'), question(), read('/d.ts')])
    expect(shape(items)).toEqual(['group(explore:3)', 'step(question)', 'step(read)'])
  })

  it('absorbs short plain text into a pending group but not long or structured text', () => {
    // 以 grep 开组（非轻探索，阈值 1）；正文后再接一个 read：回合未结束时的中间短正文
    //（回合结束时的末尾正文另有规则，见下一用例）。
    const short = itemsOf([grep('foo'), message('先看这个文件。'), read('/b.ts')])
    expect(shape(short)).toEqual(['group(explore:3)'])
    const long = itemsOf([grep('foo'), message('这是一段很长的说明。'.repeat(12)), read('/b.ts')])
    expect(shape(long)).toEqual(['group(explore:1)', 'step(message)', 'step(read)'])
    const list = itemsOf([grep('foo'), message('- 第一点'), read('/b.ts')])
    expect(shape(list)).toEqual(['group(explore:1)', 'step(message)', 'step(read)'])
    // 只有轻探索（read/ls）时正文也算组员，但工具数不足 3 仍逐条显示。
    expect(shape(itemsOf([read('/a.ts'), message('先看这个文件。'), read('/b.ts')]))).toEqual(['step(read)', 'step(message)', 'step(read)'])
  })

  it('leaves the closing assistant text standalone once the turn is completed', () => {
    const items = itemsOf([read('/a.ts'), message('好的。')], { isCompleted: true })
    expect(shape(items)).toEqual(['step(read)', 'step(message)'])
  })

  it('falls back to toolName / toolKind inference when the block carries no toolCase (旧持久化数据)', () => {
    const legacy: ProcessBlock[] = [
      { kind: 'tool', id: 'l1', toolName: 'read_file_v2', toolKind: 'read', summary: '/a.ts', status: 'done' },
      { kind: 'tool', id: 'l2', toolName: 'ripgrep_raw_search', toolKind: 'search', summary: 'x', status: 'done' },
      { kind: 'tool', id: 'l3', toolName: 'run_terminal_command_v2', toolKind: 'command', summary: 'ls', status: 'done' }
    ]
    expect(shape(itemsOf(legacy))).toEqual(['group(explore:2)', 'step(command)'])
    expect(inferToolCase('read', 'list_dir', false)).toBe('lsToolCall')
    expect(inferToolCase('search', 'glob_file_search', false)).toBe('globToolCall')
    expect(inferToolCase('mcp', 'mcp-sg team-team_task', true)).toBe('mcpToolCall')
    expect(inferToolCase('image', 'generate_image', false)).toBe('generateImageToolCall')
    expect(inferToolCase('other', 'capability:30', false)).toBeUndefined()
  })
})

describe('groupProcessSteps · helpers', () => {
  it('parses edit hints into file change stats (U+2212 and ASCII minus)', () => {
    expect(parseFileChangeStats('+12 −3')).toEqual({ additions: 12, deletions: 3 })
    expect(parseFileChangeStats('+0 -7')).toEqual({ additions: 0, deletions: 7 })
    expect(parseFileChangeStats('L1-20')).toBeUndefined()
  })

  it('mirrors Cursor short-text rule (Omd)', () => {
    expect(isGroupableText('简短说明')).toBe(true)
    expect(isGroupableText('a\nb\nc')).toBe(false)
    expect(isGroupableText('# 标题')).toBe(false)
    expect(isGroupableText('| a | b |')).toBe(false)
    expect(isGroupableText('x'.repeat(101))).toBe(false)
  })

  it('formats thought duration like Cursor ($md)', () => {
    expect(thoughtDurationDetails(300)).toBe('片刻')
    // Cursor 先四舍五入到秒：0.8s → 1 秒。
    expect(thoughtDurationDetails(800)).toBe('1 秒')
    expect(thoughtDurationDetails(12_400)).toBe('12 秒')
    expect(thoughtDurationDetails(undefined)).toBe('片刻')
  })
})
