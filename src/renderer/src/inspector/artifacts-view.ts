import { conversationEntryProcessBlocks, type ConversationEntry, type MessageAttachment } from '../../../domain/conversation-entry'
import type { WorkspaceReviewSummary } from '../../../domain/workspace-review'
import {
  imageMimeForPath,
  isLocalImagePath,
  localImageUrl,
  resolveMessageImageSource,
  type MessageImageSource
} from '../../../shared/local-image'
import { buildProcessTurnView } from '../process-turn-view'

/**
 * 产物视图：会话里「拿得出手」的东西——Agent 正文引用的截图、Agent 用图片生成工具做出的图、
 * 用户发来的图片、本次新增到工作区的文件。全部投影成 MessageAttachment，复用现有查看器与右键动作。
 */
export type ArtifactSource = 'reply' | 'process' | 'user' | 'worktree'

export interface ArtifactItem {
  id: string
  kind: 'image' | 'file'
  source: ArtifactSource
  name: string
  at?: number
  entryId?: string
  /** 工作区新增文件的仓库相对路径。 */
  relativePath?: string
  attachment: MessageAttachment
}

export interface ArtifactsView {
  images: ArtifactItem[]
  files: ArtifactItem[]
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

function fileNameOf(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
}

type LoadableImageSource = Exclude<MessageImageSource, { kind: 'remote' }>

/** 会话页可加载的图片来源（本地路径 / data: URL）→ 查看器附件；`id` 与正文 MessageImage 同规则。 */
function imageAttachment(id: string, source: LoadableImageSource, name: string): MessageAttachment {
  return {
    id,
    name,
    mimeType: source.mimeType,
    size: 0,
    previewUrl: source.src,
    ...(source.kind === 'local' ? { path: source.path } : {})
  }
}

/** 回复正文里的图片引用（本地路径 / data: URL；远程链接不在会话页加载，跳过）。 */
export function replyImageArtifacts(entry: ConversationEntry): ArtifactItem[] {
  if (entry.role !== 'assistant' || !entry.text) return []
  const items: ArtifactItem[] = []
  const seen = new Set<string>()
  for (const match of entry.text.matchAll(MARKDOWN_IMAGE)) {
    const alt = (match[1] ?? '').trim()
    const target = match[2] ?? ''
    const source = resolveMessageImageSource(target)
    if (!source || source.kind === 'remote' || seen.has(target)) continue
    seen.add(target)
    const name = alt || (source.kind === 'local' ? fileNameOf(source.path) : 'image')
    items.push({
      id: `artifact:reply:${entry.id}:${target}`,
      kind: 'image',
      source: 'reply',
      name,
      at: entry.timestamp,
      entryId: entry.id,
      attachment: imageAttachment(`message-image:${target}`, source, name)
    })
  }
  return items
}

/**
 * 过程流里图片生成工具做出的图（产出回复的过程 + 回复后的续作）。经过程视图模型取 `image`，
 * 与过程卡同一套规则——v35 之前落库、路径埋在 output 里的旧块也被认出来。
 */
export function processImageArtifacts(entry: ConversationEntry): ArtifactItem[] {
  if (entry.role !== 'assistant') return []
  const blocks = conversationEntryProcessBlocks(entry)
  if (!blocks.length) return []
  const items: ArtifactItem[] = []
  const seen = new Set<string>()
  for (const step of buildProcessTurnView({ id: entry.id, blocks }).steps) {
    if (!step.image || seen.has(step.image.path)) continue
    const source = resolveMessageImageSource(step.image.path)
    if (!source || source.kind === 'remote') continue
    seen.add(step.image.path)
    const name = step.target || (source.kind === 'local' ? fileNameOf(source.path) : 'image')
    items.push({
      id: `artifact:process:${entry.id}:${step.blockId}`,
      kind: 'image',
      source: 'process',
      name,
      at: step.completedAt ?? step.startedAt ?? entry.timestamp,
      entryId: entry.id,
      attachment: imageAttachment(`message-image:${step.image.path}`, source, name)
    })
  }
  return items
}

/** 用户消息里的图片附件。 */
export function userImageArtifacts(entry: ConversationEntry): ArtifactItem[] {
  if (entry.role !== 'user' || !entry.attachments?.length) return []
  return entry.attachments
    .filter((attachment) => String(attachment.mimeType || '').startsWith('image/'))
    .map((attachment) => ({
      id: `artifact:user:${entry.id}:${attachment.id}`,
      kind: 'image' as const,
      source: 'user' as const,
      name: attachment.name,
      at: entry.deliveredAt ?? entry.timestamp,
      entryId: entry.id,
      attachment
    }))
}

/** 工作区新增（untracked / added）文件；图片扩展名的给出可预览的本地协议地址。 */
export function worktreeArtifacts(summary: WorkspaceReviewSummary | undefined, workspacePath?: string): ArtifactItem[] {
  if (!summary || summary.state !== 'ready') return []
  const root = workspacePath?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return summary.files
    .filter((file) => file.status === 'added' || file.status === 'untracked')
    .map((file) => {
      const absolute = root ? `${root}/${file.path}` : undefined
      const image = absolute !== undefined && isLocalImagePath(absolute)
      const mimeType = image ? imageMimeForPath(absolute!) ?? 'image/png' : 'application/octet-stream'
      return {
        id: `artifact:worktree:${file.path}`,
        kind: image ? 'image' as const : 'file' as const,
        source: 'worktree' as const,
        name: fileNameOf(file.path),
        relativePath: file.path,
        attachment: {
          id: `worktree-file:${file.path}`,
          name: fileNameOf(file.path),
          mimeType,
          size: 0,
          ...(image && absolute ? { previewUrl: localImageUrl(absolute), path: absolute } : {})
        }
      }
    })
}

export function projectArtifacts(
  entries: readonly ConversationEntry[],
  summary: WorkspaceReviewSummary | undefined,
  workspacePath?: string
): ArtifactsView {
  const conversationImages: ArtifactItem[] = []
  for (const entry of entries) {
    if (entry.silent) continue
    // 同一条回复里既生成又在正文引用的图只出现一次：正文引用（带说明文字）优先。
    const referenced = replyImageArtifacts(entry)
    const referencedPaths = new Set(referenced.map((item) => item.attachment.path).filter(Boolean))
    const generated = processImageArtifacts(entry).filter((item) => !referencedPaths.has(item.attachment.path))
    conversationImages.push(...referenced, ...generated, ...userImageArtifacts(entry))
  }
  conversationImages.reverse()
  const worktree = worktreeArtifacts(summary, workspacePath)
  const seenPaths = new Set(conversationImages.map((item) => item.attachment.path).filter(Boolean))
  const worktreeImages = worktree.filter((item) => item.kind === 'image' && !seenPaths.has(item.attachment.path))
  return {
    images: [...conversationImages, ...worktreeImages],
    files: worktree.filter((item) => item.kind === 'file')
  }
}
