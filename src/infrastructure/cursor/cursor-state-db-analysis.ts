import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import {
  SPECIAL_COMPOSER_FLAGS,
  chatHistoryPruneCandidates,
  type CursorComposerHeader
} from '../../domain/cursor-storage-cleanup'

/**
 * Cursor 全局 state.vscdb（cursorDiskKV）的对话历史分析与清理。
 *
 * 同步 node:sqlite——本模块只在 worker 线程里跑（main/cursor-storage-worker.ts），
 * 22GB 数据库上一次索引遍历要好几秒，绝不能落在 Electron 主进程线程上。
 *
 * 数据形态（2026-09-12 实查 Cursor 3.6.31）：
 * - ItemTable `composer.composerHeaders` = { allComposers: [{ composerId, createdAt, lastUpdatedAt, name, … }] }
 *   是 Cursor 聊天列表的全局索引；
 * - cursorDiskKV 按会话前缀分家：`composerData:<id>`、`bubbleId:<id>:<bubble>`、`checkpointId:<id>:…`、
 *   `ofsContent:<id>:…`、`messageRequestContext:<id>:…`、`codeBlockDiff:<id>:…`、
 *   `codeBlockPartialInlineDiffFates:<id>:…`、`composerVirtualRowHeights:<id>`；
 * - `agentKv:blob:<sha>` 是内容寻址 blob，不按会话归属，不动；`inlineDiff:<workspaceHash>:…` 按工作区，不动。
 * - workspaceStorage/<hash>/state.vscdb 的 ItemTable `composer.composerData` 里也有一份 allComposers 索引。
 */

/** 按会话 id 分家的 key 家族：`<family>:<composerId>` 与 `<family>:<composerId>:…` 都属于该会话。 */
export const COMPOSER_KEY_FAMILIES = [
  'composerData',
  'bubbleId',
  'checkpointId',
  'ofsContent',
  'messageRequestContext',
  'codeBlockDiff',
  'codeBlockPartialInlineDiffFates',
  'composerVirtualRowHeights'
] as const

export const GLOBAL_COMPOSER_HEADERS_KEY = 'composer.composerHeaders'
export const WORKSPACE_COMPOSER_INDEX_KEY = 'composer.composerData'

export interface CursorStateDatabaseAnalysisInput {
  databasePath: string
  olderThanDays: number
  protectedComposerIds: string[]
  now?: number
  /** 体量估算的抽样上限（气泡条数）。 */
  sampleLimit?: number
}

export interface CursorStateDatabaseAnalysis {
  fileBytes: number
  sidecarBytes: number
  composerCount: number
  indexedCount: number
  bubbleCount: number
  candidateIds: string[]
  candidateBubbleCount: number
  /** 抽样平均气泡大小 × 候选气泡数 + 候选 composerData 体量。 */
  candidateBytesEstimate: number
  protectedCount: number
  specialCount: number
}

const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal']

function fileBytesOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function parseHeaders(raw: unknown): CursorComposerHeader[] {
  const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : ''
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as { allComposers?: unknown }
    const list = Array.isArray(parsed?.allComposers) ? parsed.allComposers : []
    return list.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      if (typeof record.composerId !== 'string') return []
      const special = SPECIAL_COMPOSER_FLAGS.some((flag) => record[flag] === true)
      return [{
        composerId: record.composerId,
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : undefined,
        lastUpdatedAt: typeof record.lastUpdatedAt === 'number' ? record.lastUpdatedAt : undefined,
        name: typeof record.name === 'string' ? record.name : undefined,
        ...(special ? { special } : {})
      }]
    })
  } catch {
    return []
  }
}

/** 半开区间 [`prefix:`, `prefix;`)：`;` 是 `:` 的下一个字符，正好覆盖同前缀的全部 key。 */
function rangeOf(family: string, composerId?: string): [string, string] {
  const head = composerId ? `${family}:${composerId}` : family
  return [`${head}:`, `${head};`]
}

function countRange(database: DatabaseSync, family: string, composerId?: string): number {
  const [from, to] = rangeOf(family, composerId)
  const row = database.prepare('SELECT count(*) AS n FROM cursorDiskKV WHERE key >= ? AND key < ?').get(from, to) as { n: number | bigint }
  return Number(row.n)
}

export function readGlobalComposerHeaders(database: DatabaseSync): CursorComposerHeader[] {
  const row = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(GLOBAL_COMPOSER_HEADERS_KEY) as { value: unknown } | undefined
  return parseHeaders(row?.value)
}

/**
 * 只读分析：候选（阈值 + 保护名单）与体量估算。体量不做全量 `length(value)`——
 * 实测 22GB 库上对 80 万气泡求和要 3 分钟；改为索引计数 + 抽样均值。
 */
export function analyzeCursorStateDatabase(input: CursorStateDatabaseAnalysisInput): CursorStateDatabaseAnalysis {
  const fileBytes = fileBytesOf(input.databasePath)
  const sidecarBytes = SIDECAR_SUFFIXES.reduce((sum, suffix) => sum + fileBytesOf(`${input.databasePath}${suffix}`), 0)
  const database = new DatabaseSync(input.databasePath, { readOnly: true })
  try {
    const headers = readGlobalComposerHeaders(database)
    const composerCount = countRange(database, 'composerData')
    const bubbleCount = countRange(database, 'bubbleId')
    const candidates = chatHistoryPruneCandidates(headers, {
      now: input.now ?? Date.now(),
      olderThanDays: input.olderThanDays,
      protectedIds: new Set(input.protectedComposerIds)
    })
    let candidateBubbleCount = 0
    let candidateDataBytes = 0
    const dataLength = database.prepare('SELECT length(value) AS n FROM cursorDiskKV WHERE key = ?')
    for (const composerId of candidates.ids) {
      candidateBubbleCount += countRange(database, 'bubbleId', composerId)
      const row = dataLength.get(`composerData:${composerId}`) as { n: number | bigint | null } | undefined
      candidateDataBytes += Number(row?.n ?? 0)
    }
    // 抽样：把候选会话按步长取样，每个读前几条气泡的 length(value)，均值 × 候选气泡数。
    const sampleLimit = input.sampleLimit ?? 240
    let sampledBytes = 0
    let sampledCount = 0
    if (candidates.ids.length && candidateBubbleCount > 0) {
      const step = Math.max(1, Math.ceil(candidates.ids.length / Math.max(1, Math.floor(sampleLimit / 3))))
      const sample = database.prepare('SELECT length(value) AS n FROM cursorDiskKV WHERE key >= ? AND key < ? LIMIT 3')
      for (let index = 0; index < candidates.ids.length && sampledCount < sampleLimit; index += step) {
        const [from, to] = rangeOf('bubbleId', candidates.ids[index]!)
        for (const row of sample.all(from, to) as Array<{ n: number | bigint | null }>) {
          sampledBytes += Number(row.n ?? 0)
          sampledCount += 1
        }
      }
    }
    const averageBubbleBytes = sampledCount ? sampledBytes / sampledCount : 0
    return {
      fileBytes,
      sidecarBytes,
      composerCount,
      indexedCount: headers.length,
      bubbleCount,
      candidateIds: candidates.ids,
      candidateBubbleCount,
      candidateBytesEstimate: Math.round(candidateDataBytes + averageBubbleBytes * candidateBubbleCount),
      protectedCount: candidates.protectedCount,
      specialCount: candidates.specialCount
    }
  } finally {
    database.close()
  }
}

export interface CursorStateDatabasePruneInput {
  databasePath: string
  composerIds: string[]
  /** 各工作区 state.vscdb 路径（其 ItemTable 索引里也要摘掉这些会话）。 */
  workspaceDatabasePaths?: string[]
  /** 删完后 VACUUM 压实文件（调用方已确认磁盘空间足够）。 */
  compact?: boolean
}

export interface CursorStateDatabasePruneResult {
  removedComposers: number
  removedRows: number
  /** 压实前后文件字节差；未压实为 0（空间由 Cursor 后续写入复用）。 */
  freedBytes: number
  compacted: boolean
  workspaceIndexesUpdated: number
}

function removeFromIndex(database: DatabaseSync, key: string, composerIds: ReadonlySet<string>): boolean {
  const row = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as { value: unknown } | undefined
  if (!row) return false
  const text = typeof row.value === 'string' ? row.value : row.value instanceof Uint8Array ? Buffer.from(row.value).toString('utf8') : ''
  if (!text) return false
  let parsed: { allComposers?: unknown }
  try {
    parsed = JSON.parse(text) as { allComposers?: unknown }
  } catch {
    return false
  }
  if (!Array.isArray(parsed.allComposers)) return false
  const kept = parsed.allComposers.filter((item) => {
    const composerId = item && typeof item === 'object' ? (item as { composerId?: unknown }).composerId : undefined
    return !(typeof composerId === 'string' && composerIds.has(composerId))
  })
  if (kept.length === parsed.allComposers.length) return false
  database.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(JSON.stringify({ ...parsed, allComposers: kept }), key)
  return true
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // COMMIT 自身失败时事务已不存在，ROLLBACK 报错是预期内的。
  }
}

/** 一个会话一个事务：8 个 key 家族的精确键 + 范围键。返回删掉的行数。 */
function composerRowDeleter(database: DatabaseSync): (composerId: string) => number {
  const deleteRange = database.prepare('DELETE FROM cursorDiskKV WHERE key >= ? AND key < ?')
  const deleteExact = database.prepare('DELETE FROM cursorDiskKV WHERE key = ?')
  return (composerId) => {
    let removed = 0
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const family of COMPOSER_KEY_FAMILIES) {
        removed += Number(deleteExact.run(`${family}:${composerId}`).changes)
        const [from, to] = rangeOf(family, composerId)
        removed += Number(deleteRange.run(from, to).changes)
      }
      database.exec('COMMIT')
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
    return removed
  }
}

/**
 * 删除会话。每个会话自成一个事务：一次要删的可能是上千个会话、上百万行、十几 GB，
 * 放在一个事务里 WAL 会膨胀到与删除量同量级（这台机器只剩 21GB 盘），中途失败还会
 * 全部回滚；分会话提交让自动检查点在事务间回收 WAL，失败时已删的会话保持删除，
 * 索引只摘掉真正删掉的那些，随后带着进度抛错。结束时 `wal_checkpoint(TRUNCATE)`
 * 把 WAL 文件收回，再按需 VACUUM。各工作区索引逐库处理（缺失/损坏的库跳过）。
 * 调用方保证 Cursor 已退出——运行中的 Cursor 会把内存里的索引回写覆盖这里的改动。
 */
export function pruneCursorStateDatabase(input: CursorStateDatabasePruneInput): CursorStateDatabasePruneResult {
  const ids = [...new Set(input.composerIds.filter((id) => /^[a-zA-Z0-9_-]{8,128}$/.test(id)))]
  if (!ids.length) return { removedComposers: 0, removedRows: 0, freedBytes: 0, compacted: false, workspaceIndexesUpdated: 0 }
  const before = fileBytesOf(input.databasePath)
  const database = new DatabaseSync(input.databasePath)
  const removed: string[] = []
  let removedRows = 0
  let failure: unknown
  try {
    database.exec('PRAGMA busy_timeout = 5000')
    const deleteComposerRows = composerRowDeleter(database)
    for (const composerId of ids) {
      try {
        removedRows += deleteComposerRows(composerId)
        removed.push(composerId)
      } catch (error) {
        failure = error
        break
      }
    }
    if (removed.length) {
      database.exec('BEGIN IMMEDIATE')
      try {
        removeFromIndex(database, GLOBAL_COMPOSER_HEADERS_KEY, new Set(removed))
        database.exec('COMMIT')
      } catch (error) {
        rollbackQuietly(database)
        failure ??= error
      }
    }
    try {
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // 非 WAL 模式或检查点被占用：文件不缩但数据已提交，不算失败。
    }
    if (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      throw new Error(`已删除 ${removed.length} / ${ids.length} 个会话后中断：${reason}`)
    }
    let compacted = false
    if (input.compact) {
      database.exec('VACUUM')
      compacted = true
    }
    const after = fileBytesOf(input.databasePath)
    let workspaceIndexesUpdated = 0
    for (const path of input.workspaceDatabasePaths ?? []) {
      try {
        const workspace = new DatabaseSync(path)
        try {
          workspace.exec('PRAGMA busy_timeout = 2000')
          if (removeFromIndex(workspace, WORKSPACE_COMPOSER_INDEX_KEY, new Set(removed))) workspaceIndexesUpdated += 1
        } finally {
          workspace.close()
        }
      } catch {
        // 单个工作区库打不开/结构不同：跳过，不影响主库结果。
      }
    }
    return {
      removedComposers: removed.length,
      removedRows,
      freedBytes: Math.max(0, before - after),
      compacted,
      workspaceIndexesUpdated
    }
  } finally {
    database.close()
  }
}
