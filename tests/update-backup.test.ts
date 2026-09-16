import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  BACKUP_DATABASE_FILE,
  BACKUP_MANIFEST_FILE,
  createUpdateBackup,
  findRollbackBackup,
  readBackupManifest,
  vacuumDatabaseInto,
  type UpdateBackupManifest
} from '../src/infrastructure/app-update/update-backup'

/** 一个 WAL 模式、带数据、保持打开的库——模拟拾光运行中的 task-pool。 */
function makeDatabase(dir: string): { path: string; close: () => void } {
  const path = join(dir, 'task-pool.sqlite3')
  const database = new DatabaseSync(path)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
  database.exec("INSERT INTO tasks (title) VALUES ('写测试'), ('发版')")
  return { path, close: () => database.close() }
}

function rowsOf(path: string): unknown[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare('SELECT id, title FROM tasks ORDER BY id').all()
  } finally {
    database.close()
  }
}

describe('vacuumDatabaseInto', () => {
  it('对打开着的 WAL 库拿到自洽快照；目标已存在则拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-vacuum-'))
    const source = makeDatabase(dir)
    const target = join(dir, 'snapshot.sqlite3')
    vacuumDatabaseInto(source.path, target)
    expect(rowsOf(target)).toEqual([
      { id: 1, title: '写测试' },
      { id: 2, title: '发版' }
    ])
    expect(() => vacuumDatabaseInto(source.path, target)).toThrow(/备份目标已存在/)
    source.close()
  })
})

describe('createUpdateBackup', () => {
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'sg-backup-'))
    const backupRoot = join(dir, 'backup')
    const database = makeDatabase(dir)
    const mcpJson = join(dir, 'mcp.json')
    writeFileSync(mcpJson, '{"mcpServers":{}}')
    return { dir, backupRoot, database, mcpJson }
  }

  it('库快照 + 小文件 + backup.json；不存在的文件与目录跳过；再备份时清掉旧的', () => {
    const h = harness()
    const plan = createUpdateBackup({
      backupRoot: h.backupRoot,
      appVersion: '0.3.3',
      bundleName: '拾光.app',
      databasePath: h.database.path,
      extraFiles: [h.mcpJson, join(h.dir, 'missing.json'), h.dir],
      now: () => 1_758_000_000_000
    })
    expect(plan.dir).toBe(join(h.backupRoot, '0.3.3-1758000000000'))
    expect(plan.bundlePath).toBe(join(plan.dir, '拾光.app'))
    expect(rowsOf(plan.databaseCopyPath)).toHaveLength(2)
    expect(readFileSync(join(plan.dir, 'mcp.json'), 'utf8')).toBe('{"mcpServers":{}}')
    const manifest = readBackupManifest(plan.dir)
    expect(manifest).toEqual({
      version: 1,
      appVersion: '0.3.3',
      createdAt: 1_758_000_000_000,
      bundleName: '拾光.app',
      databasePath: h.database.path,
      files: ['mcp.json']
    })

    const next = createUpdateBackup({
      backupRoot: h.backupRoot,
      appVersion: '0.3.4',
      bundleName: '拾光.app',
      databasePath: h.database.path,
      extraFiles: [],
      now: () => 1_758_000_100_000
    })
    expect(readdirSync(h.backupRoot)).toEqual(['0.3.4-1758000100000'])
    expect(existsSync(next.databaseCopyPath)).toBe(true)
    h.database.close()
  })

  it('中途失败：本次目录整个清掉、错误上抛，已有的旧备份不动', () => {
    const h = harness()
    const keep = createUpdateBackup({
      backupRoot: h.backupRoot,
      appVersion: '0.3.2',
      bundleName: '拾光.app',
      databasePath: h.database.path,
      extraFiles: [],
      now: () => 1_000
    })
    expect(() => createUpdateBackup({
      backupRoot: h.backupRoot,
      appVersion: '0.3.3',
      bundleName: '拾光.app',
      databasePath: h.database.path,
      extraFiles: [],
      now: () => 2_000,
      copyDatabase: () => { throw new Error('disk full') }
    })).toThrow('disk full')
    expect(existsSync(join(h.backupRoot, '0.3.3-2000'))).toBe(false)
    expect(existsSync(keep.dir)).toBe(true)
    h.database.close()
  })

  it('库文件不存在：跳过快照，其余照常', () => {
    const h = harness()
    const plan = createUpdateBackup({
      backupRoot: h.backupRoot,
      appVersion: '0.3.3',
      bundleName: '拾光.app',
      databasePath: join(h.dir, 'nowhere.sqlite3'),
      extraFiles: [h.mcpJson],
      now: () => 3_000
    })
    expect(existsSync(plan.databaseCopyPath)).toBe(false)
    expect(readBackupManifest(plan.dir)?.files).toEqual(['mcp.json'])
    h.database.close()
  })
})

describe('readBackupManifest / findRollbackBackup', () => {
  const manifestOf = (over: Partial<UpdateBackupManifest> = {}): UpdateBackupManifest => ({
    version: 1,
    appVersion: '0.3.3',
    createdAt: 1_000,
    bundleName: '拾光.app',
    databasePath: '/data/task-pool.sqlite3',
    files: ['mcp.json'],
    ...over
  })

  function writeBackupDir(root: string, name: string, manifest: UpdateBackupManifest | string, options: { bundle?: boolean; database?: boolean } = {}): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, BACKUP_MANIFEST_FILE), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    if (options.bundle !== false) mkdirSync(join(dir, '拾光.app'), { recursive: true })
    if (options.database) writeFileSync(join(dir, BACKUP_DATABASE_FILE), 'sqlite-bytes')
    return dir
  }

  it('backup.json 缺失 / 坏 JSON / 版本不符 → undefined', () => {
    const root = mkdtempSync(join(tmpdir(), 'sg-manifest-'))
    expect(readBackupManifest(join(root, 'nowhere'))).toBeUndefined()
    const bad = writeBackupDir(root, 'bad', '{oops')
    expect(readBackupManifest(bad)).toBeUndefined()
    const wrongVersion = writeBackupDir(root, 'wrong', JSON.stringify({ ...manifestOf(), version: 2 }))
    expect(readBackupManifest(wrongVersion)).toBeUndefined()
  })

  it('没有备份根 / 只有清单没有 app 包 → 不可回滚；有包的最新备份胜出', () => {
    const root = mkdtempSync(join(tmpdir(), 'sg-rollback-'))
    expect(findRollbackBackup(join(root, 'nowhere'))).toBeUndefined()

    writeBackupDir(root, 'manifest-only', manifestOf({ createdAt: 9_000 }), { bundle: false })
    expect(findRollbackBackup(root)).toBeUndefined()

    // 更新的备份没有包（脚本还没挪 / 挪失败）→ 落到更早但完整的那份
    const complete = writeBackupDir(root, 'complete', manifestOf({ appVersion: '0.3.2', createdAt: 5_000 }), { database: true })
    expect(findRollbackBackup(root)).toMatchObject({
      version: '0.3.2',
      createdAt: 5_000,
      dir: complete,
      bundlePath: join(complete, '拾光.app'),
      databaseCopyPath: join(complete, BACKUP_DATABASE_FILE),
      files: ['mcp.json']
    })

    // 没有库快照的备份：databaseCopyPath 缺省
    const newer = writeBackupDir(root, 'newer', manifestOf({ appVersion: '0.3.3', createdAt: 8_000 }))
    expect(findRollbackBackup(root)).toMatchObject({ version: '0.3.3', dir: newer, databaseCopyPath: undefined })
  })
})
