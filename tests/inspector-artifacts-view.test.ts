import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../src/domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../src/domain/workspace-review'
import { processImageArtifacts, projectArtifacts, replyImageArtifacts } from '../src/renderer/src/inspector/artifacts-view'

const entries: ConversationEntry[] = [
  {
    id: 'u1', channelId: '2', role: 'user', text: '看图', timestamp: 1, deliveredAt: 2, status: 'complete', source: 'desktop',
    attachments: [
      { id: 'att-1', name: 'shot.png', mimeType: 'image/png', size: 10, path: '/tmp/att/shot.png', previewUrl: 'data:image/png;base64,AAAA' },
      { id: 'att-2', name: 'notes.txt', mimeType: 'text/plain', size: 3 }
    ]
  },
  {
    id: 'r1', channelId: '2', role: 'assistant', timestamp: 3, status: 'complete', source: 'cursor',
    text: '截图如下 ![登录页](/tmp/login.png) 以及远程 ![logo](https://example.com/a.png) 和重复 ![again](/tmp/login.png)'
  }
]

describe('artifacts projection', () => {
  it('extracts local image references from replies, skipping remote links and duplicates', () => {
    const items = replyImageArtifacts(entries[1]!)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'image', source: 'reply', name: '登录页', entryId: 'r1' })
    expect(items[0]!.attachment).toMatchObject({ path: '/tmp/login.png', mimeType: 'image/png', previewUrl: 'sg-image://local/%2Ftmp%2Flogin.png' })
  })

  it('merges reply images, user image attachments and worktree additions, newest conversation item first', () => {
    const summary: WorkspaceReviewSummary = {
      state: 'ready', scope: 'uncommitted', workspaceName: 'demo', revision: 'r', updatedAt: 1, additions: 3, deletions: 0,
      files: [
        { path: 'docs/diagram.png', status: 'untracked', staged: false, unstaged: true },
        { path: 'src/new-module.ts', status: 'added', staged: true, unstaged: false, additions: 3, deletions: 0 },
        { path: 'src/changed.ts', status: 'modified', staged: false, unstaged: true }
      ]
    }
    const view = projectArtifacts(entries, summary, '/Users/me/demo')
    expect(view.images.map((item) => [item.source, item.name])).toEqual([
      ['reply', '登录页'],
      ['user', 'shot.png'],
      ['worktree', 'diagram.png']
    ])
    expect(view.images[2]!.attachment).toMatchObject({ path: '/Users/me/demo/docs/diagram.png', previewUrl: 'sg-image://local/%2FUsers%2Fme%2Fdemo%2Fdocs%2Fdiagram.png' })
    expect(view.files).toEqual([expect.objectContaining({ kind: 'file', relativePath: 'src/new-module.ts', name: 'new-module.ts' })])
  })

  it('lists images made by the image-generation tool (new blocks and pre-v35 legacy blocks), skipping ones the reply already references', () => {
    const entry: ConversationEntry = {
      id: 'r2', channelId: '2', role: 'assistant', timestamp: 10, status: 'complete', source: 'cursor',
      text: '两版方向：![v1](/tmp/assets/board-v1.png)',
      processBlocks: [
        { kind: 'tool', id: 'img-1', toolName: 'generate_image', toolKind: 'image', toolCase: 'generateImageToolCall', summary: 'board-v1.png', status: 'done', completedAt: 8, image: { path: '/tmp/assets/board-v1.png' } },
        { kind: 'tool', id: 'img-2', toolName: 'generate_image', toolKind: 'image', toolCase: 'generateImageToolCall', summary: 'board-v2.png', status: 'done', completedAt: 9, image: { path: '/tmp/assets/board-v2.png' } },
        { kind: 'tool', id: 'img-running', toolName: 'generate_image', toolKind: 'image', toolCase: 'generateImageToolCall', summary: 'board-v3.png', status: 'running' }
      ],
      continuationBlocks: [
        { kind: 'tool', id: 'img-legacy', toolName: 'generate_image', toolKind: 'other', toolCase: 'generateImageToolCall', status: 'done', output: '{"filePath":"/tmp/assets/board-v0.png","imageData":"[binary/image payload omitted]"}' }
      ]
    }
    expect(processImageArtifacts(entry).map((item) => [item.source, item.name, item.attachment.path, item.at])).toEqual([
      ['process', 'board-v1.png', '/tmp/assets/board-v1.png', 8],
      ['process', 'board-v2.png', '/tmp/assets/board-v2.png', 9],
      ['process', 'board-v0.png', '/tmp/assets/board-v0.png', 10]
    ])
    // 正文已引用的 v1 只出现一次（带说明文字的引用优先）；产物按会话倒序。
    expect(projectArtifacts([entry], undefined).images.map((item) => [item.source, item.name])).toEqual([
      ['process', 'board-v0.png'],
      ['process', 'board-v2.png'],
      ['reply', 'v1']
    ])
  })

  it('returns an empty view without a review summary or images', () => {
    expect(projectArtifacts([], undefined)).toEqual({ images: [], files: [] })
  })
})
