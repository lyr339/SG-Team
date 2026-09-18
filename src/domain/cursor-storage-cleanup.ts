/**
 * Cursor 本机存储清理：目录（可清理项的定义）与纯规则（计划、分类、候选筛选）。
 *
 * 只描述「有什么、清掉会失去什么、需要什么前提」，不碰文件系统；扫描与执行在
 * infrastructure/cursor/cursor-storage-scanner.ts，数据库分析在 worker 里。
 *
 * 用户语言优先：label 是名词，summary 说它是什么，loss 说清掉后会失去什么。
 * 风险等级只表达「误清的后果」，不表达体量。
 */

export type CursorStorageItemId =
  | 'chat-history'
  | 'snapshots'
  | 'orphan-workspaces'
  | 'stale-backups'
  | 'local-history'
  | 'caches'
  | 'logs'
  | 'legacy-patch'

export type CursorStorageRisk = 'none' | 'low' | 'medium' | 'high'

export interface CursorStorageItemSpec {
  id: CursorStorageItemId
  label: string
  /** 它是什么。 */
  summary: string
  /** 清掉之后会失去什么。 */
  loss: string
  risk: CursorStorageRisk
  /** 清理前 Cursor 必须已退出（文件被占用 / 会被 Cursor 回写）。 */
  needsCursorClosed: boolean
  /** 只盘点、不提供清理。 */
  diagnostic?: boolean
  /** 不经回收站、不可恢复。 */
  irreversible?: boolean
}

export const CURSOR_STORAGE_CATALOG: readonly CursorStorageItemSpec[] = [
  {
    id: 'chat-history',
    label: '对话历史',
    summary: 'Cursor 全部聊天记录所在的数据库（state.vscdb）',
    loss: '被清理的旧会话从 Cursor 聊天列表消失，无法恢复；拾光运行中绑定的会话永不清理',
    risk: 'high',
    needsCursorClosed: true,
    irreversible: true
  },
  {
    id: 'snapshots',
    label: '检查点快照',
    summary: 'Agent 修改文件前保存的整文件快照，供「恢复到此检查点」使用',
    loss: '历史对话里的「恢复检查点」不再可用；当前文件与 Git 历史不受影响',
    risk: 'medium',
    needsCursorClosed: true
  },
  {
    id: 'local-history',
    label: '本地文件历史',
    summary: 'Cursor 为编辑过的文件保存的本地历史版本',
    loss: '「时间线」面板里的本地历史版本消失；Git 历史不受影响',
    risk: 'medium',
    needsCursorClosed: true
  },
  {
    id: 'orphan-workspaces',
    label: '失效工作区存储',
    summary: '对应文件夹已不存在的工作区状态（标签页、面板布局、聊天索引）',
    loss: '若日后重新创建同路径文件夹，会按新工作区打开',
    risk: 'low',
    needsCursorClosed: false
  },
  {
    id: 'stale-backups',
    label: '旧数据库备份',
    summary: 'Cursor 升级时留下的 state.vscdb 备份副本',
    loss: '不能再回滚到这些旧备份',
    risk: 'low',
    needsCursorClosed: false
  },
  {
    id: 'caches',
    label: '缓存',
    summary: '页面、着色器与扩展安装包缓存，Cursor 会自动重建',
    loss: '下次启动略慢',
    risk: 'low',
    needsCursorClosed: true
  },
  {
    id: 'logs',
    label: '日志',
    summary: '每次启动 Cursor 产生的运行日志',
    loss: '排查历史问题时没有日志可查',
    risk: 'low',
    needsCursorClosed: true
  },
  {
    id: 'legacy-patch',
    label: '遗留网关补丁',
    summary: '写在 Cursor 主 bundle 尾部的晴天时代运行时（拾光已改用自带网关，不再依赖它）',
    loss: '只盘点不清理：观察器接入时会在页面内让它停摆；彻底摘除是一次性维护动作（scripts/unpatch-cursor.ts，需关闭 Cursor）',
    risk: 'none',
    needsCursorClosed: true,
    diagnostic: true
  }
]

/** 扫描结果里的一项：体量、条目数与一句补充。 */
export interface CursorStorageScanEntry {
  id: CursorStorageItemId
  bytes: number
  /** 条目数：文件 / 会话 / 工作区 / 备份文件。 */
  count: number
  /** 一行补充（已经是用户语言）。 */
  note?: string
  /** 有读不到的部分，体量偏小。 */
  partial?: boolean
  /** 现在有内容可清理。 */
  cleanable: boolean
}

export interface CursorChatHistoryFacts {
  databasePath: string
  fileBytes: number
  sidecarBytes: number
  /** 数据库里实际存着的会话数（composerData 行）。 */
  composerCount: number
  /** Cursor 聊天列表索引到的会话数。 */
  indexedCount: number
  /** 气泡总数（未知时省略）。 */
  bubbleCount?: number
  /** 本次候选：超过阈值天数、且不在保护名单里的会话。 */
  candidateCount: number
  /** 候选体量的估算（按气泡数占比折算文件大小），实际以清理后为准。 */
  candidateBytesEstimate: number
  /** 因绑定在拾光运行上而被保护的会话数。 */
  protectedCount: number
  /** 超过阈值但因被其他功能引用而跳过的特殊会话数（子会话 / 项目 / 规格 / 工作树）。 */
  specialCount: number
  olderThanDays: number
  /** 数据库所在磁盘的可用空间（未知时省略）。 */
  freeDiskBytes?: number
  /** 可用空间足够做一次 VACUUM 压实（≥ 文件大小 × 1.1）。 */
  compactable: boolean
}

export interface CursorLegacyPatchFacts {
  detected: boolean
  bundlePath?: string
  /** 补丁段字节数（从首个标记到文件末尾）。 */
  bytes?: number
  markers: string[]
}

export interface CursorStorageScan {
  scannedAt: number
  userDataRoot: string
  /** true / false 明确；undefined = 无法确认进程状态。 */
  cursorRunning: boolean | undefined
  entries: CursorStorageScanEntry[]
  chatHistory?: CursorChatHistoryFacts
  legacyPatch?: CursorLegacyPatchFacts
  /** 可清理项（非盘点项）的合计体量。 */
  totalBytes: number
}

export interface CursorStorageCleanupRequest {
  ids: CursorStorageItemId[]
  /** 对话历史阈值（默认 CHAT_HISTORY_DEFAULT_OLDER_THAN_DAYS）。 */
  chatHistoryOlderThanDays?: number
  /** 清理对话历史后是否 VACUUM 压实文件（需要足够空闲磁盘）。 */
  compactDatabase?: boolean
}

export interface CursorStorageCleanupSkip {
  id: CursorStorageItemId
  reason: string
}

export interface CursorStorageCleanupResult {
  ok: boolean
  freedBytes: number
  done: CursorStorageItemId[]
  skipped: CursorStorageCleanupSkip[]
  message: string
  /** 清理完成后的重新盘点。 */
  scan?: CursorStorageScan
}

export const CHAT_HISTORY_OLDER_THAN_OPTIONS = [30, 90, 180] as const
export const CHAT_HISTORY_DEFAULT_OLDER_THAN_DAYS = 90

export interface CursorStorageCleanupPlan {
  runnable: CursorStorageItemId[]
  blocked: CursorStorageCleanupSkip[]
  totalBytes: number
  /** 至少一项要求 Cursor 已退出。 */
  needsCursorClosed: boolean
  irreversible: CursorStorageItemId[]
}

/**
 * 把「用户勾了什么」折成「现在能做什么」。阻断原因用用户语言，一项一条；
 * Cursor 进程状态无法确认时，所有要求退出的项一律阻断——不带着不确定的状态动文件。
 */
export function buildCleanupPlan(scan: CursorStorageScan, request: CursorStorageCleanupRequest): CursorStorageCleanupPlan {
  const runnable: CursorStorageItemId[] = []
  const blocked: CursorStorageCleanupSkip[] = []
  const irreversible: CursorStorageItemId[] = []
  let totalBytes = 0
  let needsCursorClosed = false
  for (const id of new Set(request.ids)) {
    const spec = CURSOR_STORAGE_CATALOG.find((item) => item.id === id)
    if (!spec) {
      blocked.push({ id, reason: '未知的清理项' })
      continue
    }
    if (spec.diagnostic) {
      blocked.push({ id, reason: '只盘点，不提供清理' })
      continue
    }
    const entry = scan.entries.find((item) => item.id === id)
    if (!entry?.cleanable) {
      blocked.push({ id, reason: '没有可清理的内容' })
      continue
    }
    if (spec.needsCursorClosed) {
      if (scan.cursorRunning === true) {
        blocked.push({ id, reason: '需要先退出 Cursor' })
        continue
      }
      if (scan.cursorRunning === undefined) {
        blocked.push({ id, reason: '无法确认 Cursor 是否已退出' })
        continue
      }
      needsCursorClosed = true
    }
    runnable.push(id)
    totalBytes += id === 'chat-history' ? (scan.chatHistory?.candidateBytesEstimate ?? 0) : entry.bytes
    if (spec.irreversible) irreversible.push(id)
  }
  return { runnable, blocked, totalBytes, needsCursorClosed, irreversible }
}

/** workspace.json 的目标：本地文件夹 / 本地工作区文件 / 远程 / 未知。 */
export type WorkspaceStorageTarget =
  | { kind: 'folder' | 'workspace'; path: string }
  | { kind: 'remote'; uri: string }
  | { kind: 'unknown' }

/**
 * 解析 workspaceStorage/<id>/workspace.json。只有 file:// 目标才能判断是否失效；
 * 远程（vscode-remote:// 等）无法核对本地存在性，一律视为仍在使用。
 */
export function workspaceStorageTarget(json: unknown, platform: NodeJS.Platform = process.platform): WorkspaceStorageTarget {
  if (!json || typeof json !== 'object') return { kind: 'unknown' }
  const record = json as Record<string, unknown>
  const raw = typeof record.folder === 'string' ? record.folder : typeof record.workspace === 'string' ? record.workspace : ''
  if (!raw) return { kind: 'unknown' }
  const kind = typeof record.folder === 'string' ? 'folder' : 'workspace'
  if (!raw.startsWith('file://')) return { kind: 'remote', uri: raw }
  const path = fileUriToPath(raw, platform)
  return path ? { kind, path } : { kind: 'unknown' }
}

export function fileUriToPath(uri: string, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') return undefined
    let pathname = decodeURIComponent(url.pathname)
    if (platform === 'win32') {
      // file:///C:/Users/... → C:\Users\...；file://server/share → \\server\share
      if (url.hostname) return `\\\\${url.hostname}${pathname.replace(/\//g, '\\')}`
      pathname = pathname.replace(/^\/([a-zA-Z]:)/, '$1')
      return pathname.replace(/\//g, '\\')
    }
    return pathname
  } catch {
    return undefined
  }
}

/** state.vscdb 的旧备份：同前缀、但不是数据库本体及其运行时附属文件。 */
export function isStaleDatabaseBackup(fileName: string): boolean {
  if (!fileName.startsWith('state.vscdb')) return false
  return !['state.vscdb', 'state.vscdb-wal', 'state.vscdb-shm', 'state.vscdb-journal', 'state.vscdb.options.json'].includes(fileName)
}

/**
 * 聊天索引条目上表示「被其他功能引用」的标记：bestOfN 子会话归父会话、项目 / 规格会话
 * 归 Projects / Specs 面板、工作树会话对应磁盘上的 git worktree。删掉任何一类都会留下
 * 悬空引用，所以无论多旧都不进候选。
 */
export const SPECIAL_COMPOSER_FLAGS = ['isBestOfNSubcomposer', 'isProject', 'isSpec', 'isWorktree'] as const

/** Cursor 全局聊天列表索引（ItemTable `composer.composerHeaders`）里的一条。 */
export interface CursorComposerHeader {
  composerId: string
  createdAt?: number
  lastUpdatedAt?: number
  name?: string
  /** 带 SPECIAL_COMPOSER_FLAGS 之一。 */
  special?: boolean
}

export interface ChatHistoryPruneCandidates {
  ids: string[]
  protectedCount: number
  /** 超过阈值但因特殊标记跳过的会话数。 */
  specialCount: number
  /** 阈值之内（保留）的会话数。 */
  recentCount: number
}

/**
 * 对话历史候选：最近更新时间早于阈值、不在保护名单里、也不是特殊会话。保护名单来自
 * 拾光运行的 Composer 绑定——哪怕它很旧也不能清（可能正是待恢复的会话）。缺少时间戳
 * 的条目无法判定年龄，保守地保留。
 */
export function chatHistoryPruneCandidates(
  headers: readonly CursorComposerHeader[],
  options: { now: number; olderThanDays: number; protectedIds: ReadonlySet<string> }
): ChatHistoryPruneCandidates {
  const cutoff = options.now - options.olderThanDays * 86_400_000
  const ids: string[] = []
  let protectedCount = 0
  let specialCount = 0
  let recentCount = 0
  for (const header of headers) {
    if (!header.composerId) continue
    const updatedAt = header.lastUpdatedAt ?? header.createdAt
    if (updatedAt === undefined || !Number.isFinite(updatedAt)) { recentCount += 1; continue }
    if (updatedAt >= cutoff) { recentCount += 1; continue }
    if (options.protectedIds.has(header.composerId)) { protectedCount += 1; continue }
    if (header.special) { specialCount += 1; continue }
    ids.push(header.composerId)
  }
  return { ids, protectedCount, specialCount, recentCount }
}

/** VACUUM 需要临时写出整库副本；可用空间不足 1.1 倍文件大小时不压实。 */
export function canCompactDatabase(fileBytes: number, freeDiskBytes: number | undefined): boolean {
  return freeDiskBytes !== undefined && freeDiskBytes >= fileBytes * 1.1
}

export function cursorStorageRiskLabel(risk: CursorStorageRisk): string {
  switch (risk) {
    case 'high': return '不可恢复'
    case 'medium': return '有代价'
    case 'low': return '可放心'
    default: return '仅盘点'
  }
}
