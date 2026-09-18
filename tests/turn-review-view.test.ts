import { describe, expect, it } from 'vitest'
import type { ConversationEntry, ProcessDiffLine } from '../src/domain/conversation-entry'
import { processDiffHunks, turnReviewEditsByPath } from '../src/renderer/src/inspector/turn-review-view'

const workspace = '/Users/me/project'

function user(id: string, timestamp: number, deliveredAt?: number): ConversationEntry {
  return { id, channelId: '2', role: 'user', text: `消息 ${id}`, timestamp, status: 'complete', source: 'desktop', deliveredAt }
}

describe('processDiffHunks', () => {
  it('splits on hunk markers, keeps line numbers and folds leading lines into a headless hunk', () => {
    const lines: ProcessDiffLine[] = [
      { type: 'context', text: 'import x', oldLine: 1, newLine: 1 },
      { type: 'hunk', text: '@@ -10,2 +10,2 @@ login()' },
      { type: 'removed', text: 'const a = 1', oldLine: 10 },
      { type: 'added', text: 'const a = 2', newLine: 10 },
      { type: 'hunk', text: '@@ -30 +30 @@' }
    ]
    const hunks = processDiffHunks(lines)
    // 只有头没有内容行的尾块被丢弃；块外前导行成为无头块。
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({ header: '', skippedBefore: 0 })
    expect(hunks[0]!.lines).toEqual([{ kind: 'context', text: 'import x', oldLine: 1, newLine: 1 }])
    expect(hunks[1]!.header).toBe('@@ -10,2 +10,2 @@ login()')
    expect(hunks[1]!.lines).toEqual([
      { kind: 'deletion', text: 'const a = 1', oldLine: 10 },
      { kind: 'addition', text: 'const a = 2', newLine: 10 }
    ])
  })
})

describe('turnReviewEditsByPath', () => {
  const diff = { lines: [{ type: 'added', text: 'x', newLine: 1 }] as ProcessDiffLine[] }
  const entries: ConversationEntry[] = [
    user('u1', 1, 2),
    {
      id: 'r1', channelId: '2', role: 'assistant', text: '上一轮', timestamp: 3, status: 'complete', source: 'cursor',
      processBlocks: [
        { kind: 'tool', id: 'old-edit', toolName: 'edit_file', toolKind: 'edit', status: 'done', summary: `${workspace}/src/old.ts`, hint: '+1 −0', diff }
      ]
    },
    user('u2', 10, 11),
    {
      id: 'r2', channelId: '2', role: 'assistant', text: '本轮', timestamp: 12, status: 'complete', source: 'cursor',
      processBlocks: [
        { kind: 'tool', id: 'e1', toolName: 'edit_file', toolKind: 'edit', status: 'done', summary: `${workspace}/src/a.ts`, hint: '+2 −1', diff: { lines: [{ type: 'hunk', text: '@@ -1 +1 @@' }, { type: 'added', text: 'one', newLine: 1 }], truncatedLineCount: 3 } },
        { kind: 'tool', id: 'skip-read', toolName: 'read_file', toolKind: 'read', status: 'done', summary: `${workspace}/src/a.ts` },
        { kind: 'tool', id: 'e2', toolName: 'delete_file', toolKind: 'write', toolCase: 'deleteToolCall', status: 'done', summary: `${workspace}/src/b.ts` },
        { kind: 'tool', id: 'e3', toolName: 'edit_file', toolKind: 'edit', status: 'failed', summary: `${workspace}/src/a.ts`, hint: '+0 −0' }
      ]
    }
  ]
  const live = {
    turn: 'live', startedAt: 13, updatedAt: 14,
    blocks: [
      { kind: 'tool' as const, id: 'live-1', toolName: 'write', toolKind: 'write' as const, status: 'running' as const, summary: `${workspace}/src/c.ts` }
    ]
  }

  it('groups this turn’s edit blocks by normalized path in block order, with live blocks appended', () => {
    const edits = turnReviewEditsByPath('turn', entries, live, workspace)
    expect([...edits.keys()]).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    const a = edits.get('src/a.ts')!
    expect(a.map((edit) => edit.blockId)).toEqual(['e1', 'e3'])
    expect(a[0]).toMatchObject({ action: 'edit', hint: '+2 −1', truncatedLineCount: 3, running: false, failed: false })
    expect(a[0]!.hunks).toHaveLength(1)
    expect(a[1]).toMatchObject({ failed: true, hunks: [] })
    // 删除类工具按 toolCase 识别为 delete，即使 toolKind 是 write。
    expect(edits.get('src/b.ts')![0]!.action).toBe('delete')
    expect(edits.get('src/c.ts')![0]).toMatchObject({ action: 'write', running: true })
  })

  it('previous scope reads the persisted previous turn only（直播中的块一律属于当前回合）', () => {
    const edits = turnReviewEditsByPath('previous', entries, live, workspace)
    expect([...edits.keys()]).toEqual(['src/old.ts'])
    expect(edits.get('src/old.ts')![0]).toMatchObject({ blockId: 'old-edit', action: 'edit', hint: '+1 −0' })
  })
})
