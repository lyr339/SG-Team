import { promises as fs, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { CursorStateDatabaseAnalysis, CursorStateDatabasePruneInput } from '../src/infrastructure/cursor/cursor-state-db-analysis'
import {
  CURSOR_CACHE_DIRECTORIES,
  CursorStorageScanner,
  type CursorStorageFileSystem,
  type CursorStorageScannerOptions
} from '../src/infrastructure/cursor/cursor-storage-scanner'
import { formatFileSize } from '../src/shared/format-file-size'

function write(path: string, bytes: number | string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof bytes === 'string' ? bytes : 'x'.repeat(bytes))
}

/** 失效工作区目录的体量：40 字节的 state.vscdb + 指向已消失文件夹的 workspace.json。 */
function byOrphan(root: string): number {
  return 40 + JSON.stringify({ folder: pathToFileURL(join(root, 'gone')).href }).length
}

const ANALYSIS: CursorStateDatabaseAnalysis = {
  fileBytes: 2_000, sidecarBytes: 64, composerCount: 30, indexedCount: 20, bubbleCount: 900,
  candidateIds: ['old-aaaaaaa', 'old-bbbbbbb', 'old-protect'], candidateBubbleCount: 300, candidateBytesEstimate: 1_200,
  protectedCount: 0, specialCount: 2
}

function fixture(overrides: Partial<CursorStorageScannerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sg-cursor-storage-'))
  // 会被 Cursor 重建的目录内容
  write(join(root, 'snapshots', 'stores', 'a.bin'), 100)
  write(join(root, 'snapshots', 'codebases', 'b.bin'), 50)
  write(join(root, 'User', 'History', 'h1', 'entries.json'), 10)
  write(join(root, 'Cache', 'x'), 7)
  write(join(root, 'Code Cache', 'y'), 8)
  mkdirSync(join(root, 'GPUCache'))
  write(join(root, 'logs', '20260912', 'main.log'), 30)
  // 工作区存储：在用 / 失效 / 远程 / 坏 JSON / 无 workspace.json
  const liveProject = join(root, 'live-project')
  mkdirSync(liveProject)
  write(join(root, 'User', 'workspaceStorage', 'live', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(liveProject).href }))
  write(join(root, 'User', 'workspaceStorage', 'live', 'state.vscdb'), 20)
  write(join(root, 'User', 'workspaceStorage', 'orphan', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(join(root, 'gone')).href }))
  write(join(root, 'User', 'workspaceStorage', 'orphan', 'state.vscdb'), 40)
  write(join(root, 'User', 'workspaceStorage', 'remote', 'workspace.json'), JSON.stringify({ folder: 'vscode-remote://ssh-remote%2Bbox/home/lyr/app' }))
  write(join(root, 'User', 'workspaceStorage', 'broken', 'workspace.json'), '{not json')
  mkdirSync(join(root, 'User', 'workspaceStorage', 'nojson'))
  // 全局数据库本体 + 运行时附属 + 两份旧备份
  write(join(root, 'User', 'globalStorage', 'state.vscdb'), 2_000)
  write(join(root, 'User', 'globalStorage', 'state.vscdb-wal'), 64)
  write(join(root, 'User', 'globalStorage', 'state.vscdb.options.json'), '{}')
  write(join(root, 'User', 'globalStorage', 'state.vscdb.backup'), 500)
  write(join(root, 'User', 'globalStorage', 'state.vscdb.bak'), 300)
  // 尾部带遗留补丁标记的 bundle
  const bundlePath = join(root, 'workbench.desktop.main.js')
  write(bundlePath, `${'a'.repeat(1_000)}/*__QINGTIAN_SEAMLESS__*/${'b'.repeat(99)}`)

  const trashed: string[] = []
  const analyzeDatabase = vi.fn(async () => ANALYSIS)
  const pruneDatabase = vi.fn(async (_input: CursorStateDatabasePruneInput) => ({
    removedComposers: 2, removedRows: 40, freedBytes: 0, compacted: false, workspaceIndexesUpdated: 1
  }))
  const scanner = new CursorStorageScanner({
    userDataRoot: root,
    workbenchBundlePath: bundlePath,
    cursorRunning: async () => true,
    protectedComposerIds: () => ['old-protect'],
    analyzeDatabase,
    pruneDatabase,
    trashItem: async (path) => { trashed.push(path); await fs.rm(path, { recursive: true, force: true }) },
    now: () => 1_700_000_000_000,
    ...overrides
  })
  return { root, bundlePath, scanner, trashed, analyzeDatabase, pruneDatabase }
}

describe('CursorStorageScanner.scan', () => {
  it('逐项盘点体量与条目数：孤儿工作区只算文件夹已消失的本地目标，旧备份按体量降序，补丁从首个标记量到文件尾', async () => {
    const { root, bundlePath, scanner, analyzeDatabase } = fixture()
    const scan = await scanner.scan()
    const byId = new Map(scan.entries.map((entry) => [entry.id, entry]))

    expect(scan.userDataRoot).toBe(root)
    expect(scan.cursorRunning).toBe(true)
    expect(scan.scannedAt).toBe(1_700_000_000_000)
    expect(byId.get('snapshots')).toMatchObject({ bytes: 150, count: 2, note: '2 个文件', cleanable: true })
    expect(byId.get('local-history')).toMatchObject({ bytes: 10, count: 1, note: '1 个历史版本', cleanable: true })
    expect(byId.get('caches')).toMatchObject({ bytes: 15, count: 2, cleanable: true })
    expect(byId.get('logs')).toMatchObject({ bytes: 30, count: 1, cleanable: true })
    expect(byId.get('orphan-workspaces')).toMatchObject({ bytes: byOrphan(root), count: 1, note: '1 个文件夹已不存在', cleanable: true })
    expect(byId.get('stale-backups')).toMatchObject({ bytes: 800, count: 2, note: 'state.vscdb.backup、state.vscdb.bak', cleanable: true })
    // 补丁体量从标记本身量到文件尾（标记 21 + `*/` 2 + 尾巴 99）。
    expect(byId.get('legacy-patch')).toMatchObject({ bytes: 122, count: 1, note: '__QINGTIAN_SEAMLESS__', cleanable: false })
    expect(scan.legacyPatch).toEqual({ detected: true, bundlePath, bytes: 122, markers: ['__QINGTIAN_SEAMLESS__'] })

    expect(analyzeDatabase).toHaveBeenCalledWith({
      databasePath: join(root, 'User', 'globalStorage', 'state.vscdb'),
      olderThanDays: 90,
      protectedComposerIds: ['old-protect'],
      now: 1_700_000_000_000
    })
    expect(byId.get('chat-history')).toMatchObject({
      bytes: 1_200, count: 3, cleanable: true,
      note: '数据库 2.0 KB · 20 个会话 · 90 天前的 3 个可清理 · 2 个项目 / 规格 / 子会话不清理'
    })
    expect(scan.chatHistory).toMatchObject({ fileBytes: 2_000, sidecarBytes: 64, candidateCount: 3, candidateBytesEstimate: 1_200, specialCount: 2, olderThanDays: 90, compactable: true })
    // 合计只含可清理的非盘点项：补丁的 122 字节不在其中。
    expect(scan.totalBytes).toBe(1_200 + 150 + 10 + byOrphan(root) + 800 + 15 + 30)
  })

  it('阈值随请求传给数据库分析；没有数据库时对话历史不可清理且不做分析', async () => {
    const { root, scanner, analyzeDatabase } = fixture()
    await scanner.scan({ chatHistoryOlderThanDays: 30 })
    expect(analyzeDatabase).toHaveBeenLastCalledWith(expect.objectContaining({ olderThanDays: 30 }))

    await fs.rm(join(root, 'User', 'globalStorage', 'state.vscdb'))
    analyzeDatabase.mockClear()
    const scan = await scanner.scan()
    expect(analyzeDatabase).not.toHaveBeenCalled()
    expect(scan.chatHistory).toBeUndefined()
    expect(scan.entries.find((entry) => entry.id === 'chat-history')).toEqual({ id: 'chat-history', bytes: 0, count: 0, note: '未找到 Cursor 聊天数据库', cleanable: false })
  })

  it('读不到的子目录只标记 partial、不让整次盘点失败；进程探测失败记为不确定', async () => {
    const realFs = fs as unknown as CursorStorageFileSystem
    const { root, scanner } = fixture({
      cursorRunning: async () => { throw new Error('pgrep 超时') },
      fs: {
        ...realFs,
        stat: realFs.stat.bind(realFs),
        lstat: realFs.lstat.bind(realFs),
        readFile: realFs.readFile.bind(realFs),
        rm: realFs.rm.bind(realFs),
        access: realFs.access.bind(realFs),
        statfs: realFs.statfs?.bind(realFs),
        readdir: async (path, options) => {
          if (path.endsWith(join('snapshots', 'codebases'))) throw new Error('EACCES')
          return realFs.readdir(path, options)
        }
      }
    })
    const scan = await scanner.scan()
    expect(scan.cursorRunning).toBeUndefined()
    expect(scan.entries.find((entry) => entry.id === 'snapshots')).toMatchObject({ bytes: 100, count: 1, partial: true, cleanable: true })
    expect(scan.userDataRoot).toBe(root)
  })
})

describe('CursorStorageScanner.cleanup', () => {
  it('Cursor 运行中：不要求退出的项进回收站，要求退出的项如实阻断；结果附带清理后的新盘点', async () => {
    const { root, scanner, trashed } = fixture()
    const result = await scanner.cleanup({ ids: ['orphan-workspaces', 'stale-backups', 'snapshots', 'chat-history'] })

    expect(result.done).toEqual(['orphan-workspaces', 'stale-backups'])
    expect(result.skipped).toEqual([
      { id: 'snapshots', reason: '需要先退出 Cursor' },
      { id: 'chat-history', reason: '需要先退出 Cursor' }
    ])
    // 被阻断的项在 skipped 里逐条列出，不算失败：ok 为真、总结只报做成的。
    expect(result.ok).toBe(true)
    expect(result.freedBytes).toBe(800 + byOrphan(root))
    expect(result.message).toBe(`已清理 失效工作区存储、旧数据库备份，释放约 ${formatFileSize(result.freedBytes)}`)
    expect(trashed.sort()).toEqual([
      join(root, 'User', 'globalStorage', 'state.vscdb.backup'),
      join(root, 'User', 'globalStorage', 'state.vscdb.bak'),
      join(root, 'User', 'workspaceStorage', 'orphan')
    ].sort())
    // 在用 / 远程 / 坏 JSON 的工作区一个都没动。
    expect(await fs.readdir(join(root, 'User', 'workspaceStorage'))).toEqual(expect.arrayContaining(['live', 'remote', 'broken', 'nojson']))
    expect(result.scan?.entries.find((entry) => entry.id === 'orphan-workspaces')).toMatchObject({ bytes: 0, count: 0, cleanable: false })
    expect(result.scan?.entries.find((entry) => entry.id === 'stale-backups')).toMatchObject({ bytes: 0, count: 0, cleanable: false })
  })

  it('Cursor 已退出：目录类只清内容保留目录本身，缓存目录整个进回收站；对话历史把保护名单再过滤一遍后交给 worker', async () => {
    const { root, scanner, trashed, pruneDatabase } = fixture({ cursorRunning: async () => false })
    const result = await scanner.cleanup({ ids: ['snapshots', 'logs', 'caches', 'chat-history'], chatHistoryOlderThanDays: 30, compactDatabase: true })

    expect(result.done).toEqual(['snapshots', 'logs', 'caches', 'chat-history'])
    expect(result.skipped).toEqual([])
    expect((await fs.stat(join(root, 'snapshots'))).isDirectory()).toBe(true)
    expect(await fs.readdir(join(root, 'snapshots'))).toEqual([])
    expect(await fs.readdir(join(root, 'logs'))).toEqual([])
    expect(trashed).toEqual(expect.arrayContaining([join(root, 'Cache'), join(root, 'Code Cache'), join(root, 'GPUCache')]))
    expect(trashed.filter((path) => CURSOR_CACHE_DIRECTORIES.some((name) => path === join(root, name)))).toHaveLength(3)
    expect(pruneDatabase).toHaveBeenCalledTimes(1)
    expect(pruneDatabase).toHaveBeenCalledWith({
      databasePath: join(root, 'User', 'globalStorage', 'state.vscdb'),
      composerIds: ['old-aaaaaaa', 'old-bbbbbbb'],
      workspaceDatabasePaths: ['broken', 'live', 'nojson', 'orphan', 'remote'].map((name) => join(root, 'User', 'workspaceStorage', name, 'state.vscdb')),
      compact: true
    })
    // 未压实：释放按估算记（空间由 Cursor 后续写入复用）；目录类按实际字节。
    expect(result.freedBytes).toBe(150 + 30 + 15 + 1_200)
  })

  it('扫描到执行之间 Cursor 又被打开：对话历史拒绝执行，其他项照常', async () => {
    const answers = [false, true, false]
    const { scanner, pruneDatabase } = fixture({ cursorRunning: async () => answers.shift() ?? false })
    const result = await scanner.cleanup({ ids: ['chat-history', 'stale-backups'] })
    expect(pruneDatabase).not.toHaveBeenCalled()
    expect(result.done).toEqual(['stale-backups'])
    expect(result.skipped).toEqual([{ id: 'chat-history', reason: '需要先退出 Cursor' }])
  })

  it('单个目录进回收站失败只记入 skipped，其余项继续', async () => {
    const { root, scanner } = fixture({
      cursorRunning: async () => false,
      trashItem: async (path) => {
        if (path.endsWith('.bak')) throw new Error('回收站不可用')
        await fs.rm(path, { recursive: true, force: true })
      }
    })
    const result = await scanner.cleanup({ ids: ['stale-backups', 'logs'] })
    expect(result.done).toEqual(['logs'])
    expect(result.skipped).toEqual([{ id: 'stale-backups', reason: '回收站不可用' }])
    expect(result.ok).toBe(true)
    expect(result.message).toBe('已清理 日志，释放约 30 B；1 项未处理')
    expect(await fs.readdir(join(root, 'User', 'globalStorage'))).not.toContain('state.vscdb.backup')
  })

  it('一项都没做成时 ok=false，信息直说原因', async () => {
    const { scanner } = fixture()
    const result = await scanner.cleanup({ ids: ['snapshots'] })
    expect(result).toMatchObject({ ok: false, done: [], freedBytes: 0, message: '未清理：需要先退出 Cursor' })
  })
})
