import { promises as fs, type Dirent } from 'node:fs'
import { join } from 'node:path'
import {
  CHAT_HISTORY_DEFAULT_OLDER_THAN_DAYS,
  CURSOR_STORAGE_CATALOG,
  buildCleanupPlan,
  canCompactDatabase,
  isStaleDatabaseBackup,
  workspaceStorageTarget,
  type CursorChatHistoryFacts,
  type CursorLegacyPatchFacts,
  type CursorStorageCleanupRequest,
  type CursorStorageCleanupResult,
  type CursorStorageCleanupSkip,
  type CursorStorageItemId,
  type CursorStorageScan,
  type CursorStorageScanEntry
} from '../../domain/cursor-storage-cleanup'
import { formatFileSize } from '../../shared/format-file-size'
import type {
  CursorStateDatabaseAnalysis,
  CursorStateDatabaseAnalysisInput,
  CursorStateDatabasePruneInput,
  CursorStateDatabasePruneResult
} from './cursor-state-db-analysis'

/** Cursor 用户数据目录下按 Cursor 会自动重建、清掉只影响启动速度的缓存目录。 */
export const CURSOR_CACHE_DIRECTORIES = [
  'Cache',
  'CachedData',
  'CachedProfilesData',
  'CachedExtensionVSIXs',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Shared Dictionary'
] as const

/** bundle 尾部遗留补丁的识别标记（晴天时代运行时 / 网关 V2）。 */
export const LEGACY_PATCH_MARKERS = ['__QINGTIAN_SEAMLESS__', '__QINGTIAN_COMPOSER_BRIDGE_V2__', '__QINGTIAN_START_PROMPT_AUTOMATION'] as const

export interface CursorStorageFileSystem {
  stat(path: string): Promise<{ size: number; isDirectory(): boolean; isSymbolicLink(): boolean; mtimeMs: number }>
  lstat(path: string): Promise<{ size: number; isDirectory(): boolean; isSymbolicLink(): boolean; mtimeMs: number }>
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
  access(path: string): Promise<void>
  statfs?(path: string): Promise<{ bavail: number | bigint; bsize: number | bigint }>
}

export interface CursorStorageScannerOptions {
  userDataRoot: string
  /** workbench bundle 路径（遗留补丁盘点）；缺省不盘点。 */
  workbenchBundlePath?: string
  /** true / false 明确；undefined = 无法确认。 */
  cursorRunning: () => Promise<boolean | undefined>
  /** 拾光运行绑定的 Composer（永不清理）。 */
  protectedComposerIds: () => string[]
  analyzeDatabase: (input: CursorStateDatabaseAnalysisInput) => Promise<CursorStateDatabaseAnalysis>
  pruneDatabase: (input: CursorStateDatabasePruneInput) => Promise<CursorStateDatabasePruneResult>
  /** 移到回收站（Electron shell.trashItem）；缺省 fs.rm。 */
  trashItem?: (path: string) => Promise<void>
  fs?: CursorStorageFileSystem
  now?: () => number
  platform?: NodeJS.Platform
}

interface Measured {
  bytes: number
  files: number
  partial: boolean
}

interface OrphanWorkspace {
  path: string
  target: string
  bytes: number
}

/**
 * Cursor 本机存储的盘点与清理。扫描全程只读；清理按项执行，目录类走回收站
 *（可找回），对话历史走 worker 里的数据库删除（不可恢复，调用方已二次确认）。
 * 每次执行前都用新一轮扫描重建计划——不用渲染层带过来的旧数字动文件。
 */
export class CursorStorageScanner {
  private readonly fs: CursorStorageFileSystem
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private lastAnalysis?: { olderThanDays: number; analysis: CursorStateDatabaseAnalysis }

  constructor(private readonly options: CursorStorageScannerOptions) {
    this.fs = options.fs ?? (fs as unknown as CursorStorageFileSystem)
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
  }

  private path(...segments: string[]): string {
    return join(this.options.userDataRoot, ...segments)
  }

  get databasePath(): string {
    return this.path('User', 'globalStorage', 'state.vscdb')
  }

  async scan(input: { chatHistoryOlderThanDays?: number } = {}): Promise<CursorStorageScan> {
    const olderThanDays = input.chatHistoryOlderThanDays ?? CHAT_HISTORY_DEFAULT_OLDER_THAN_DAYS
    const [cursorRunning, snapshots, history, caches, logs, orphans, backups, chatHistory, legacyPatch] = await Promise.all([
      this.options.cursorRunning().catch(() => undefined),
      this.measure(this.path('snapshots')),
      this.measure(this.path('User', 'History')),
      this.measureMany(CURSOR_CACHE_DIRECTORIES.map((name) => this.path(name))),
      this.measure(this.path('logs')),
      this.orphanWorkspaces(),
      this.staleBackups(),
      this.chatHistory(olderThanDays),
      this.legacyPatch()
    ])
    const entries: CursorStorageScanEntry[] = [
      chatHistory
        ? {
            id: 'chat-history',
            bytes: chatHistory.candidateBytesEstimate,
            count: chatHistory.candidateCount,
            note: chatHistoryNote(chatHistory),
            cleanable: chatHistory.candidateCount > 0
          }
        : { id: 'chat-history', bytes: 0, count: 0, note: '未找到 Cursor 聊天数据库', cleanable: false },
      entryOf('snapshots', snapshots, snapshots.files ? `${snapshots.files} 个文件` : undefined),
      entryOf('local-history', history, history.files ? `${history.files} 个历史版本` : undefined),
      {
        id: 'orphan-workspaces',
        bytes: orphans.reduce((sum, item) => sum + item.bytes, 0),
        count: orphans.length,
        note: orphans.length ? `${orphans.length} 个文件夹已不存在` : '每个工作区的文件夹都还在',
        cleanable: orphans.length > 0
      },
      {
        id: 'stale-backups',
        bytes: backups.reduce((sum, item) => sum + item.bytes, 0),
        count: backups.length,
        note: backups.length ? backups.map((item) => item.name).join('、') : undefined,
        cleanable: backups.length > 0
      },
      entryOf('caches', caches, caches.files ? `${caches.files} 个文件` : undefined),
      entryOf('logs', logs, logs.files ? `${logs.files} 个文件` : undefined),
      {
        id: 'legacy-patch',
        bytes: legacyPatch.bytes ?? 0,
        count: legacyPatch.detected ? 1 : 0,
        note: legacyPatch.detected ? legacyPatch.markers.join(' · ') : '未检测到',
        cleanable: false
      }
    ]
    const totalBytes = entries
      .filter((entry) => !CURSOR_STORAGE_CATALOG.find((spec) => spec.id === entry.id)?.diagnostic && entry.cleanable)
      .reduce((sum, entry) => sum + entry.bytes, 0)
    return {
      scannedAt: this.now(),
      userDataRoot: this.options.userDataRoot,
      cursorRunning,
      entries,
      chatHistory,
      legacyPatch,
      totalBytes
    }
  }

  /**
   * 执行：先重新扫描，按新鲜事实建计划；被阻断的项如实报告；目录类逐个进回收站，
   * 单个失败只记入 skipped，不影响其他项；最后再扫描一次返回新盘点。
   */
  async cleanup(request: CursorStorageCleanupRequest): Promise<CursorStorageCleanupResult> {
    const before = await this.scan({ chatHistoryOlderThanDays: request.chatHistoryOlderThanDays })
    const plan = buildCleanupPlan(before, request)
    const skipped: CursorStorageCleanupSkip[] = [...plan.blocked]
    const done: CursorStorageItemId[] = []
    let freedBytes = 0
    for (const id of plan.runnable) {
      try {
        const freed = await this.cleanupItem(id, before, request)
        freedBytes += freed
        done.push(id)
      } catch (error) {
        skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    const scan = await this.scan({ chatHistoryOlderThanDays: request.chatHistoryOlderThanDays })
    const ok = done.length > 0 && skipped.length === plan.blocked.length
    return {
      ok: done.length > 0,
      freedBytes,
      done,
      skipped,
      message: summarizeCleanup(done, skipped, freedBytes, ok),
      scan
    }
  }

  private async cleanupItem(id: CursorStorageItemId, scan: CursorStorageScan, request: CursorStorageCleanupRequest): Promise<number> {
    switch (id) {
      case 'snapshots': return this.trashChildren(this.path('snapshots'))
      case 'local-history': return this.trashChildren(this.path('User', 'History'))
      case 'caches': {
        let freed = 0
        for (const name of CURSOR_CACHE_DIRECTORIES) freed += await this.trashPath(this.path(name))
        return freed
      }
      case 'logs': return this.trashChildren(this.path('logs'))
      case 'orphan-workspaces': {
        let freed = 0
        for (const orphan of await this.orphanWorkspaces()) freed += await this.trashPath(orphan.path)
        return freed
      }
      case 'stale-backups': {
        let freed = 0
        for (const backup of await this.staleBackups()) freed += await this.trashPath(backup.path)
        return freed
      }
      case 'chat-history': return this.pruneChatHistory(scan, request)
      default: throw new Error('只盘点，不提供清理')
    }
  }

  private async pruneChatHistory(scan: CursorStorageScan, request: CursorStorageCleanupRequest): Promise<number> {
    const facts = scan.chatHistory
    const analysis = this.lastAnalysis?.analysis
    if (!facts || !analysis || this.lastAnalysis?.olderThanDays !== facts.olderThanDays) {
      throw new Error('对话历史盘点已过期，请重新扫描')
    }
    // 再次确认运行状态：扫描到执行之间 Cursor 可能被重新打开。
    if ((await this.options.cursorRunning().catch(() => undefined)) !== false) {
      throw new Error('需要先退出 Cursor')
    }
    const protectedIds = new Set(this.options.protectedComposerIds())
    const composerIds = analysis.candidateIds.filter((id) => !protectedIds.has(id))
    if (!composerIds.length) return 0
    const workspaceRoot = this.path('User', 'workspaceStorage')
    const workspaceDatabasePaths = (await this.listDirectories(workspaceRoot)).map((name) => join(workspaceRoot, name, 'state.vscdb'))
    const compact = request.compactDatabase === true && facts.compactable
    const result = await this.options.pruneDatabase({
      databasePath: this.databasePath,
      composerIds,
      workspaceDatabasePaths,
      compact
    })
    // 未压实时文件不缩：释放的是「Cursor 后续写入可复用」的空间，按估算记。
    return result.compacted ? result.freedBytes : facts.candidateBytesEstimate
  }

  // ---- 盘点 ----

  private async chatHistory(olderThanDays: number): Promise<CursorChatHistoryFacts | undefined> {
    if (!(await this.exists(this.databasePath))) return undefined
    const analysis = await this.options.analyzeDatabase({
      databasePath: this.databasePath,
      olderThanDays,
      protectedComposerIds: this.options.protectedComposerIds(),
      now: this.now()
    })
    this.lastAnalysis = { olderThanDays, analysis }
    const freeDiskBytes = await this.freeDiskBytes(this.path('User', 'globalStorage'))
    return {
      databasePath: this.databasePath,
      fileBytes: analysis.fileBytes,
      sidecarBytes: analysis.sidecarBytes,
      composerCount: analysis.composerCount,
      indexedCount: analysis.indexedCount,
      bubbleCount: analysis.bubbleCount,
      candidateCount: analysis.candidateIds.length,
      candidateBytesEstimate: analysis.candidateBytesEstimate,
      protectedCount: analysis.protectedCount,
      specialCount: analysis.specialCount,
      olderThanDays,
      ...(freeDiskBytes === undefined ? {} : { freeDiskBytes }),
      compactable: canCompactDatabase(analysis.fileBytes, freeDiskBytes)
    }
  }

  private async legacyPatch(): Promise<CursorLegacyPatchFacts> {
    const bundlePath = this.options.workbenchBundlePath
    if (!bundlePath || !(await this.exists(bundlePath))) return { detected: false, markers: [] }
    try {
      const text = await this.fs.readFile(bundlePath, 'utf8')
      const markers = LEGACY_PATCH_MARKERS.filter((marker) => text.includes(marker))
      if (!markers.length) return { detected: false, bundlePath, markers: [] }
      const first = Math.min(...markers.map((marker) => text.indexOf(marker)))
      return { detected: true, bundlePath, bytes: Buffer.byteLength(text.slice(first), 'utf8'), markers }
    } catch {
      return { detected: false, bundlePath, markers: [] }
    }
  }

  private async orphanWorkspaces(): Promise<OrphanWorkspace[]> {
    const root = this.path('User', 'workspaceStorage')
    const orphans: OrphanWorkspace[] = []
    for (const name of await this.listDirectories(root)) {
      const directory = join(root, name)
      let json: unknown
      try {
        json = JSON.parse(await this.fs.readFile(join(directory, 'workspace.json'), 'utf8'))
      } catch {
        continue
      }
      const target = workspaceStorageTarget(json, this.platform)
      if (target.kind !== 'folder' && target.kind !== 'workspace') continue
      if (await this.exists(target.path)) continue
      const measured = await this.measure(directory)
      orphans.push({ path: directory, target: target.path, bytes: measured.bytes })
    }
    return orphans
  }

  private async staleBackups(): Promise<Array<{ path: string; name: string; bytes: number }>> {
    const root = this.path('User', 'globalStorage')
    let entries: Dirent[]
    try {
      entries = await this.fs.readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const backups: Array<{ path: string; name: string; bytes: number }> = []
    for (const entry of entries) {
      if (!entry.isFile() || !isStaleDatabaseBackup(entry.name)) continue
      const path = join(root, entry.name)
      const measured = await this.measure(path)
      backups.push({ path, name: entry.name, bytes: measured.bytes })
    }
    return backups.sort((a, b) => b.bytes - a.bytes)
  }

  // ---- 文件系统 ----

  private async exists(path: string): Promise<boolean> {
    try {
      await this.fs.access(path)
      return true
    } catch {
      return false
    }
  }

  private async listDirectories(root: string): Promise<string[]> {
    try {
      const entries = await this.fs.readdir(root, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    } catch {
      return []
    }
  }

  private async measureMany(paths: string[]): Promise<Measured> {
    const results = await Promise.all(paths.map((path) => this.measure(path)))
    return results.reduce<Measured>((sum, item) => ({
      bytes: sum.bytes + item.bytes,
      files: sum.files + item.files,
      partial: sum.partial || item.partial
    }), { bytes: 0, files: 0, partial: false })
  }

  /** 递归求和文件大小；不跟随符号链接；读不到的部分标记 partial。 */
  private async measure(path: string): Promise<Measured> {
    let stat: Awaited<ReturnType<CursorStorageFileSystem['lstat']>>
    try {
      stat = await this.fs.lstat(path)
    } catch {
      return { bytes: 0, files: 0, partial: false }
    }
    if (stat.isSymbolicLink()) return { bytes: 0, files: 0, partial: false }
    if (!stat.isDirectory()) return { bytes: stat.size, files: 1, partial: false }
    const result: Measured = { bytes: 0, files: 0, partial: false }
    const walk = async (directory: string): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await this.fs.readdir(directory, { withFileTypes: true })
      } catch {
        result.partial = true
        return
      }
      for (const entry of entries) {
        const child = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(child)
          continue
        }
        try {
          result.bytes += (await this.fs.lstat(child)).size
          result.files += 1
        } catch {
          result.partial = true
        }
      }
    }
    await walk(path)
    return result
  }

  /** 目录本身保留、内容进回收站（Cursor 期待目录存在时不会因缺目录报错）。 */
  private async trashChildren(directory: string): Promise<number> {
    let freed = 0
    let entries: Dirent[]
    try {
      entries = await this.fs.readdir(directory, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) freed += await this.trashPath(join(directory, entry.name))
    return freed
  }

  private async trashPath(path: string): Promise<number> {
    if (!(await this.exists(path))) return 0
    const measured = await this.measure(path)
    if (this.options.trashItem) {
      await this.options.trashItem(path)
    } else {
      await this.fs.rm(path, { recursive: true, force: true })
    }
    return measured.bytes
  }

  private async freeDiskBytes(path: string): Promise<number | undefined> {
    if (!this.fs.statfs) return undefined
    try {
      const stats = await this.fs.statfs(path)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      return undefined
    }
  }
}

function entryOf(id: CursorStorageItemId, measured: Measured, note: string | undefined): CursorStorageScanEntry {
  return {
    id,
    bytes: measured.bytes,
    count: measured.files,
    note,
    ...(measured.partial ? { partial: true } : {}),
    cleanable: measured.bytes > 0 || measured.files > 0
  }
}

function chatHistoryNote(facts: CursorChatHistoryFacts): string {
  const parts = [`数据库 ${formatFileSize(facts.fileBytes)} · ${facts.indexedCount} 个会话`]
  if (facts.candidateCount) {
    parts.push(`${facts.olderThanDays} 天前的 ${facts.candidateCount} 个可清理`)
  } else {
    parts.push(`没有 ${facts.olderThanDays} 天前的会话`)
  }
  if (facts.protectedCount) parts.push(`${facts.protectedCount} 个受拾光保护`)
  if (facts.specialCount) parts.push(`${facts.specialCount} 个项目 / 规格 / 子会话不清理`)
  return parts.join(' · ')
}

function summarizeCleanup(done: CursorStorageItemId[], skipped: CursorStorageCleanupSkip[], freedBytes: number, allOk: boolean): string {
  if (!done.length) {
    return skipped.length === 1 ? `未清理：${skipped[0]!.reason}` : `未清理：${skipped.length} 项被阻断`
  }
  const labels = done.map((id) => CURSOR_STORAGE_CATALOG.find((spec) => spec.id === id)?.label ?? id)
  const head = `已清理 ${labels.join('、')}，释放约 ${formatFileSize(freedBytes)}`
  if (allOk || !skipped.length) return head
  return `${head}；${skipped.length} 项未处理`
}
