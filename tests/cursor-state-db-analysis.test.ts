import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  COMPOSER_KEY_FAMILIES,
  GLOBAL_COMPOSER_HEADERS_KEY,
  WORKSPACE_COMPOSER_INDEX_KEY,
  analyzeCursorStateDatabase,
  pruneCursorStateDatabase,
  readGlobalComposerHeaders
} from '../src/infrastructure/cursor/cursor-state-db-analysis'

const DAY = 86_400_000
const NOW = 400 * DAY

interface ComposerSeed {
  id: string
  updatedAt?: number
  bubbles: string[]
  flags?: Record<string, boolean>
  /** 不进全局索引（Cursor 删过聊天但数据没清的孤儿）。 */
  unindexed?: boolean
}

/** 按 2026-09-12 实查的 Cursor 3.6.31 形态造一份 state.vscdb。 */
function seedDatabase(path: string, composers: ComposerSeed[], options: { headersAsBlob?: boolean } = {}): void {
  const database = new DatabaseSync(path)
  try {
    database.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    database.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    const insert = database.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
    for (const composer of composers) {
      insert.run(`composerData:${composer.id}`, JSON.stringify({ composerId: composer.id, fullConversationHeadersOnly: composer.bubbles }))
      composer.bubbles.forEach((text, index) => insert.run(`bubbleId:${composer.id}:b${index}`, JSON.stringify({ text })))
      insert.run(`checkpointId:${composer.id}:c0`, 'checkpoint')
      insert.run(`ofsContent:${composer.id}:file:///a.ts`, 'const a = 1')
      insert.run(`messageRequestContext:${composer.id}:b0`, '{}')
      insert.run(`codeBlockDiff:${composer.id}:d0`, '{}')
      insert.run(`codeBlockPartialInlineDiffFates:${composer.id}:d0`, '{}')
      insert.run(`composerVirtualRowHeights:${composer.id}`, '[]')
    }
    // 不按会话归属的两族：内容寻址 blob 与按工作区哈希的 inlineDiff——任何清理都不能碰。
    insert.run('agentKv:blob:sha-1', Buffer.from('blob-1'))
    insert.run('inlineDiff:workspace-hash:x', '{}')
    const headers = {
      allComposers: composers
        .filter((composer) => !composer.unindexed)
        .map((composer) => ({ composerId: composer.id, name: composer.id, createdAt: 1, lastUpdatedAt: composer.updatedAt, ...(composer.flags ?? {}) }))
    }
    const encoded = JSON.stringify(headers)
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(GLOBAL_COMPOSER_HEADERS_KEY, options.headersAsBlob ? Buffer.from(encoded) : encoded)
  } finally {
    database.close()
  }
}

function seedWorkspaceDatabase(path: string, composerIds: string[]): void {
  const database = new DatabaseSync(path)
  try {
    database.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(WORKSPACE_COMPOSER_INDEX_KEY, JSON.stringify({ allComposers: composerIds.map((composerId) => ({ composerId })), selectedComposerIds: [] }))
  } finally {
    database.close()
  }
}

function keysOf(path: string): string[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return (database.prepare('SELECT key FROM cursorDiskKV ORDER BY key').all() as Array<{ key: string }>).map((row) => row.key)
  } finally {
    database.close()
  }
}

function indexedIds(path: string, key = GLOBAL_COMPOSER_HEADERS_KEY): string[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const row = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as { allComposers: Array<{ composerId: string }> }).allComposers.map((item) => item.composerId) : []
  } finally {
    database.close()
  }
}

const SEEDS: ComposerSeed[] = [
  { id: 'old-aaaaaaa', updatedAt: NOW - 120 * DAY, bubbles: ['第一条很长的回复'.repeat(20), '短', '中等长度的一条'] },
  { id: 'old-bbbbbbb', updatedAt: NOW - 95 * DAY, bubbles: ['x'.repeat(300), 'y'.repeat(100)] },
  { id: 'old-protect', updatedAt: NOW - 200 * DAY, bubbles: ['p1', 'p2'] },
  { id: 'old-project', updatedAt: NOW - 200 * DAY, bubbles: ['proj'], flags: { isProject: true } },
  { id: 'recent-cccc', updatedAt: NOW - 3 * DAY, bubbles: ['r1', 'r2', 'r3', 'r4', 'r5'] },
  { id: 'orphan-dddd', updatedAt: NOW - 300 * DAY, bubbles: ['o1'], unindexed: true }
]

function fixture(options: { headersAsBlob?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sg-cursor-state-db-'))
  const databasePath = join(root, 'state.vscdb')
  seedDatabase(databasePath, SEEDS, options)
  return { root, databasePath }
}

describe('analyzeCursorStateDatabase', () => {
  it('候选 = 阈值前 − 保护 − 特殊；体量估算 = 候选 composerData 字节 + 抽样均值 × 候选气泡数', () => {
    const { databasePath } = fixture()
    const analysis = analyzeCursorStateDatabase({
      databasePath,
      olderThanDays: 90,
      protectedComposerIds: ['old-protect'],
      now: NOW
    })
    expect(analysis.composerCount).toBe(6)
    expect(analysis.indexedCount).toBe(5)
    expect(analysis.bubbleCount).toBe(3 + 2 + 2 + 1 + 5 + 1)
    expect(analysis.candidateIds).toEqual(['old-aaaaaaa', 'old-bbbbbbb'])
    expect(analysis.candidateBubbleCount).toBe(5)
    expect(analysis.protectedCount).toBe(1)
    expect(analysis.specialCount).toBe(1)
    expect(analysis.fileBytes).toBe(statSync(databasePath).size)
    // 两个候选各不超过 3 条气泡，抽样即全量：估算严格等于候选行的真实字节数。
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const bytesOf = (sql: string, ...params: string[]): number => Number((database.prepare(sql).get(...params) as { n: number | bigint }).n)
      const expected = ['old-aaaaaaa', 'old-bbbbbbb'].reduce((total, id) =>
        total
        + bytesOf('SELECT length(value) AS n FROM cursorDiskKV WHERE key = ?', `composerData:${id}`)
        + bytesOf('SELECT coalesce(sum(length(value)), 0) AS n FROM cursorDiskKV WHERE key >= ? AND key < ?', `bubbleId:${id}:`, `bubbleId:${id};`), 0)
      expect(analysis.candidateBytesEstimate).toBe(expected)
    } finally {
      database.close()
    }
  })

  it('索引以 BLOB 形态存储时同样能读；没有候选时估算为 0', () => {
    const { databasePath } = fixture({ headersAsBlob: true })
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      expect(readGlobalComposerHeaders(database).map((header) => header.composerId)).toEqual(SEEDS.filter((seed) => !seed.unindexed).map((seed) => seed.id))
      expect(readGlobalComposerHeaders(database).find((header) => header.composerId === 'old-project')?.special).toBe(true)
    } finally {
      database.close()
    }
    const analysis = analyzeCursorStateDatabase({ databasePath, olderThanDays: 365, protectedComposerIds: [], now: NOW })
    expect(analysis.candidateIds).toEqual([])
    expect(analysis.candidateBubbleCount).toBe(0)
    expect(analysis.candidateBytesEstimate).toBe(0)
  })
})

describe('pruneCursorStateDatabase', () => {
  it('只删候选会话的 8 个 key 家族，并从全局与工作区索引摘掉；其他会话、blob 与 inlineDiff 原样', () => {
    const { root, databasePath } = fixture()
    const workspaceA = join(root, 'ws-a.vscdb')
    const workspaceB = join(root, 'ws-b.vscdb')
    seedWorkspaceDatabase(workspaceA, ['old-aaaaaaa', 'recent-cccc'])
    seedWorkspaceDatabase(workspaceB, ['recent-cccc'])
    const before = keysOf(databasePath)

    const result = pruneCursorStateDatabase({
      databasePath,
      composerIds: ['old-aaaaaaa', 'old-bbbbbbb', 'bad id;DROP', 'short'],
      workspaceDatabasePaths: [workspaceA, workspaceB, join(root, 'missing', 'state.vscdb')]
    })

    // 每个会话：8 族精确键 1 条（composerData / composerVirtualRowHeights 命中）+ 范围键若干。
    const rowsOf = (id: string): number => before.filter((key) => COMPOSER_KEY_FAMILIES.some((family) => key === `${family}:${id}` || key.startsWith(`${family}:${id}:`))).length
    expect(result).toEqual({
      removedComposers: 2,
      removedRows: rowsOf('old-aaaaaaa') + rowsOf('old-bbbbbbb'),
      freedBytes: 0,
      compacted: false,
      workspaceIndexesUpdated: 1
    })
    const after = keysOf(databasePath)
    expect(after.some((key) => key.includes('old-aaaaaaa') || key.includes('old-bbbbbbb'))).toBe(false)
    expect(after).toEqual(before.filter((key) => !key.includes('old-aaaaaaa') && !key.includes('old-bbbbbbb')))
    expect(after).toContain('agentKv:blob:sha-1')
    expect(after).toContain('inlineDiff:workspace-hash:x')
    expect(after.filter((key) => key.startsWith('bubbleId:recent-cccc:'))).toHaveLength(5)
    expect(indexedIds(databasePath)).toEqual(['old-protect', 'old-project', 'recent-cccc'])
    expect(indexedIds(workspaceA, WORKSPACE_COMPOSER_INDEX_KEY)).toEqual(['recent-cccc'])
    expect(indexedIds(workspaceB, WORKSPACE_COMPOSER_INDEX_KEY)).toEqual(['recent-cccc'])
  })

  it('没有合法 id 时是空操作；compact 会 VACUUM 并报告压实', () => {
    const { databasePath } = fixture()
    expect(pruneCursorStateDatabase({ databasePath, composerIds: ['', 'x', 'has space here'] }))
      .toEqual({ removedComposers: 0, removedRows: 0, freedBytes: 0, compacted: false, workspaceIndexesUpdated: 0 })
    const result = pruneCursorStateDatabase({ databasePath, composerIds: ['old-aaaaaaa'], compact: true })
    expect(result.removedComposers).toBe(1)
    expect(result.compacted).toBe(true)
    expect(result.freedBytes).toBeGreaterThanOrEqual(0)
    expect(keysOf(databasePath).some((key) => key.includes('old-aaaaaaa'))).toBe(false)
  })

  it('某个会话删除失败：已删的保持删除、索引只摘掉真正删掉的，随后带进度抛错，后续会话不再尝试', () => {
    const { databasePath } = fixture()
    const database = new DatabaseSync(databasePath)
    try {
      database.exec(`CREATE TRIGGER boom BEFORE DELETE ON cursorDiskKV WHEN old.key = 'composerData:old-bbbbbbb' BEGIN SELECT RAISE(ABORT, '磁盘已满'); END`)
    } finally {
      database.close()
    }
    expect(() => pruneCursorStateDatabase({ databasePath, composerIds: ['old-aaaaaaa', 'old-bbbbbbb', 'old-protect'] }))
      .toThrow('已删除 1 / 3 个会话后中断：磁盘已满')
    const after = keysOf(databasePath)
    expect(after.some((key) => key.includes('old-aaaaaaa'))).toBe(false)
    expect(after.filter((key) => key.includes('old-bbbbbbb'))).toHaveLength(2 + 7)
    expect(after.filter((key) => key.includes('old-protect'))).toHaveLength(2 + 7)
    expect(indexedIds(databasePath)).toEqual(['old-bbbbbbb', 'old-protect', 'old-project', 'recent-cccc'])
  })
})
