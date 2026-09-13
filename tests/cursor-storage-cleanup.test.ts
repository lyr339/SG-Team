import { describe, expect, it } from 'vitest'
import {
  CHAT_HISTORY_DEFAULT_OLDER_THAN_DAYS,
  CURSOR_STORAGE_CATALOG,
  buildCleanupPlan,
  canCompactDatabase,
  chatHistoryPruneCandidates,
  cursorStorageRiskLabel,
  fileUriToPath,
  isStaleDatabaseBackup,
  workspaceStorageTarget,
  type CursorStorageItemId,
  type CursorStorageScan,
  type CursorStorageScanEntry
} from '../src/domain/cursor-storage-cleanup'
import { formatFileSize } from '../src/shared/format-file-size'

const DAY = 86_400_000

function entry(id: CursorStorageItemId, bytes: number, overrides: Partial<CursorStorageScanEntry> = {}): CursorStorageScanEntry {
  return { id, bytes, count: bytes ? 1 : 0, cleanable: bytes > 0, ...overrides }
}

function scan(overrides: Partial<CursorStorageScan> = {}): CursorStorageScan {
  return {
    scannedAt: 1_000,
    userDataRoot: '/Users/demo/Library/Application Support/Cursor',
    cursorRunning: true,
    entries: [
      entry('chat-history', 5_000, { count: 12 }),
      entry('snapshots', 4_000),
      entry('local-history', 300),
      entry('orphan-workspaces', 200),
      entry('stale-backups', 100),
      entry('caches', 50),
      entry('logs', 0),
      entry('legacy-patch', 243_000, { cleanable: false })
    ],
    chatHistory: {
      databasePath: '/db/state.vscdb', fileBytes: 20_000, sidecarBytes: 0, composerCount: 30, indexedCount: 20,
      candidateCount: 12, candidateBytesEstimate: 5_000, protectedCount: 1, specialCount: 0,
      olderThanDays: CHAT_HISTORY_DEFAULT_OLDER_THAN_DAYS, freeDiskBytes: 1_000, compactable: false
    },
    totalBytes: 9_650,
    ...overrides
  }
}

describe('存储清理目录', () => {
  it('每个可清理项都说清风险与代价；只有对话历史不可恢复，只有遗留补丁是纯盘点', () => {
    const ids = CURSOR_STORAGE_CATALOG.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const spec of CURSOR_STORAGE_CATALOG) {
      expect(spec.label.length).toBeGreaterThan(1)
      expect(spec.summary.length).toBeGreaterThan(4)
      expect(spec.loss.length).toBeGreaterThan(4)
    }
    expect(CURSOR_STORAGE_CATALOG.filter((spec) => spec.irreversible).map((spec) => spec.id)).toEqual(['chat-history'])
    expect(CURSOR_STORAGE_CATALOG.filter((spec) => spec.diagnostic).map((spec) => spec.id)).toEqual(['legacy-patch'])
    // 不可恢复的项风险必须是最高级，纯盘点项风险为无。
    expect(CURSOR_STORAGE_CATALOG.find((spec) => spec.id === 'chat-history')?.risk).toBe('high')
    expect(CURSOR_STORAGE_CATALOG.find((spec) => spec.id === 'legacy-patch')?.risk).toBe('none')
    expect(['不可恢复', '有代价', '可放心', '仅盘点']).toEqual((['high', 'medium', 'low', 'none'] as const).map(cursorStorageRiskLabel))
  })
})

describe('buildCleanupPlan', () => {
  it('Cursor 运行中：要求退出的项逐项阻断并说明原因，其余照常；合计只算可执行项', () => {
    const plan = buildCleanupPlan(scan(), { ids: ['chat-history', 'snapshots', 'orphan-workspaces', 'stale-backups', 'caches'] })
    expect(plan.runnable).toEqual(['orphan-workspaces', 'stale-backups'])
    expect(plan.blocked).toEqual([
      { id: 'chat-history', reason: '需要先退出 Cursor' },
      { id: 'snapshots', reason: '需要先退出 Cursor' },
      { id: 'caches', reason: '需要先退出 Cursor' }
    ])
    expect(plan.totalBytes).toBe(300)
    expect(plan.needsCursorClosed).toBe(false)
    expect(plan.irreversible).toEqual([])
  })

  it('Cursor 已退出：全部可执行；对话历史按估算体量计入，并标记为不可恢复', () => {
    const plan = buildCleanupPlan(scan({ cursorRunning: false }), { ids: ['chat-history', 'snapshots', 'caches'] })
    expect(plan.runnable).toEqual(['chat-history', 'snapshots', 'caches'])
    expect(plan.blocked).toEqual([])
    expect(plan.totalBytes).toBe(5_000 + 4_000 + 50)
    expect(plan.needsCursorClosed).toBe(true)
    expect(plan.irreversible).toEqual(['chat-history'])
  })

  it('进程状态不明：要求退出的项一律阻断——不带着不确定的状态动文件', () => {
    const plan = buildCleanupPlan(scan({ cursorRunning: undefined }), { ids: ['snapshots', 'orphan-workspaces'] })
    expect(plan.runnable).toEqual(['orphan-workspaces'])
    expect(plan.blocked).toEqual([{ id: 'snapshots', reason: '无法确认 Cursor 是否已退出' }])
  })

  it('纯盘点项、空项、未知项分别给出用户语言的阻断原因；重复勾选只算一次', () => {
    const plan = buildCleanupPlan(scan({ cursorRunning: false }), {
      ids: ['legacy-patch', 'logs', 'stale-backups', 'stale-backups', 'nonsense' as CursorStorageItemId]
    })
    expect(plan.runnable).toEqual(['stale-backups'])
    expect(plan.blocked).toEqual([
      { id: 'legacy-patch', reason: '只盘点，不提供清理' },
      { id: 'logs', reason: '没有可清理的内容' },
      { id: 'nonsense', reason: '未知的清理项' }
    ])
    expect(plan.totalBytes).toBe(100)
  })
})

describe('workspaceStorageTarget / fileUriToPath', () => {
  it('本地文件夹与工作区文件解析为路径；远程与缺失目标不参与失效判定', () => {
    expect(workspaceStorageTarget({ folder: 'file:///Users/lyr/Downloads/%E9%A1%B9%E7%9B%AE' }, 'darwin'))
      .toEqual({ kind: 'folder', path: '/Users/lyr/Downloads/项目' })
    expect(workspaceStorageTarget({ workspace: 'file:///Users/lyr/dev/app.code-workspace' }, 'darwin'))
      .toEqual({ kind: 'workspace', path: '/Users/lyr/dev/app.code-workspace' })
    expect(workspaceStorageTarget({ folder: 'vscode-remote://ssh-remote%2Bbox/home/lyr/app' }, 'darwin'))
      .toEqual({ kind: 'remote', uri: 'vscode-remote://ssh-remote%2Bbox/home/lyr/app' })
    expect(workspaceStorageTarget({}, 'darwin')).toEqual({ kind: 'unknown' })
    expect(workspaceStorageTarget(null, 'darwin')).toEqual({ kind: 'unknown' })
    expect(workspaceStorageTarget({ folder: 'file:///%ZZ' }, 'darwin')).toEqual({ kind: 'unknown' })
  })

  it('Windows：盘符与 UNC 路径都还原成反斜杠形态', () => {
    expect(fileUriToPath('file:///C:/Users/lyr/Downloads/%E9%A1%B9%E7%9B%AE', 'win32')).toBe('C:\\Users\\lyr\\Downloads\\项目')
    expect(fileUriToPath('file://server/share/app', 'win32')).toBe('\\\\server\\share\\app')
    expect(fileUriToPath('https://example.com/x', 'win32')).toBeUndefined()
  })
})

describe('isStaleDatabaseBackup', () => {
  it('只把 state.vscdb 的旧备份副本视为可清理，数据库本体与运行时附属文件不算', () => {
    expect(isStaleDatabaseBackup('state.vscdb.backup')).toBe(true)
    expect(isStaleDatabaseBackup('state.vscdb.bak')).toBe(true)
    expect(isStaleDatabaseBackup('state.vscdb.2026-05-17.backup')).toBe(true)
    for (const name of ['state.vscdb', 'state.vscdb-wal', 'state.vscdb-shm', 'state.vscdb-journal', 'state.vscdb.options.json', 'storage.json']) {
      expect(isStaleDatabaseBackup(name)).toBe(false)
    }
  })
})

describe('chatHistoryPruneCandidates', () => {
  const now = 100 * DAY
  const headers = [
    { composerId: 'old-a', lastUpdatedAt: now - 120 * DAY },
    { composerId: 'old-b', createdAt: now - 95 * DAY },
    { composerId: 'old-protected', lastUpdatedAt: now - 200 * DAY },
    { composerId: 'old-project', lastUpdatedAt: now - 200 * DAY, special: true },
    { composerId: 'recent', lastUpdatedAt: now - 3 * DAY },
    { composerId: 'undated' },
    { composerId: '', lastUpdatedAt: 0 }
  ]

  it('阈值之前、未受保护、非特殊的会话才是候选；无时间戳的保守保留；空 id 忽略', () => {
    const result = chatHistoryPruneCandidates(headers, { now, olderThanDays: 90, protectedIds: new Set(['old-protected']) })
    expect(result).toEqual({ ids: ['old-a', 'old-b'], protectedCount: 1, specialCount: 1, recentCount: 2 })
  })

  it('阈值放宽到 30 天会吞掉「最近」以外的一切；收紧到 180 天则一个都不删', () => {
    expect(chatHistoryPruneCandidates(headers, { now, olderThanDays: 30, protectedIds: new Set() }).ids)
      .toEqual(['old-a', 'old-b', 'old-protected'])
    expect(chatHistoryPruneCandidates(headers, { now, olderThanDays: 180, protectedIds: new Set() }))
      .toEqual({ ids: ['old-protected'], protectedCount: 0, specialCount: 1, recentCount: 4 })
  })
})

describe('canCompactDatabase / formatFileSize', () => {
  it('VACUUM 需要 ≥ 1.1 倍文件大小的空闲空间；空闲未知即不压实', () => {
    expect(canCompactDatabase(10_000, 11_000)).toBe(true)
    expect(canCompactDatabase(10_000, 10_999)).toBe(false)
    expect(canCompactDatabase(10_000, undefined)).toBe(false)
  })

  it('体量格式化在 GB 量级不再输出四位数 MB', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatFileSize(1023.9 * 1024 * 1024)).toBe('1023.9 MB')
    expect(formatFileSize(22.4 * 1024 ** 3)).toBe('22.4 GB')
  })
})
