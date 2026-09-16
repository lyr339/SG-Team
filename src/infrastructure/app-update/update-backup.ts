import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AppUpdateBackupInfo } from '../../domain/app-update'

export const BACKUP_MANIFEST_FILE = 'backup.json'
export const BACKUP_DATABASE_FILE = 'task-pool.sqlite3'

export interface UpdateBackupManifest {
  version: 1
  /** 备份时正在运行的拾光版本——回滚的目标。 */
  appVersion: string
  createdAt: number
  /** 备份里 app 包的文件名（`拾光.app`）；脚本 `mv` 进来之前这一项先写好。 */
  bundleName: string
  databasePath: string
  files: string[]
}

export interface CreateUpdateBackupInput {
  backupRoot: string
  appVersion: string
  bundleName: string
  databasePath: string
  /** 一并复制的小文件（mcp.json、userData 根下的 *.json）；不存在的跳过。 */
  extraFiles: string[]
  now?: () => number
  /** 测试注入；默认用 node:sqlite 的 `VACUUM INTO`。 */
  copyDatabase?: (source: string, target: string) => void
}

export interface UpdateBackupPlan {
  dir: string
  bundlePath: string
  databaseCopyPath: string
}

/** `VACUUM INTO`：对 WAL 库也能得到一份自洽的单文件快照，目标文件必须不存在。 */
export function vacuumDatabaseInto(source: string, target: string): void {
  if (existsSync(target)) throw new Error(`备份目标已存在：${target}`)
  const database = new DatabaseSync(source, { readOnly: true })
  try {
    database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } finally {
    database.close()
  }
}

/**
 * 更新前的备份（任务书 §6.6 / §7.2）：库快照 + 配置小文件 + backup.json。app 本体稍后由辅助脚本
 * `mv` 进同一目录（主进程活着时不能动自己的包）。只保留最近一份：新备份成功后删除更早的。
 */
export function createUpdateBackup(input: CreateUpdateBackupInput): UpdateBackupPlan {
  const now = input.now ?? (() => Date.now())
  const createdAt = now()
  const dir = join(input.backupRoot, `${input.appVersion}-${createdAt}`)
  mkdirSync(dir, { recursive: true })
  const copyDatabase = input.copyDatabase ?? vacuumDatabaseInto
  const databaseCopyPath = join(dir, BACKUP_DATABASE_FILE)
  const files: string[] = []
  try {
    if (existsSync(input.databasePath)) copyDatabase(input.databasePath, databaseCopyPath)
    for (const file of input.extraFiles) {
      if (!existsSync(file) || !statSync(file).isFile()) continue
      const name = basename(file)
      copyFileSync(file, join(dir, name))
      files.push(name)
    }
    const manifest: UpdateBackupManifest = {
      version: 1,
      appVersion: input.appVersion,
      createdAt,
      bundleName: input.bundleName,
      databasePath: input.databasePath,
      files
    }
    writeFileSync(join(dir, BACKUP_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  for (const entry of readdirSync(input.backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === basename(dir)) continue
    rmSync(join(input.backupRoot, entry.name), { recursive: true, force: true })
  }
  return { dir, bundlePath: join(dir, input.bundleName), databaseCopyPath }
}

export interface UpdateBackupRecord extends AppUpdateBackupInfo {
  bundlePath: string
  databaseCopyPath: string | undefined
  files: string[]
}

export function readBackupManifest(dir: string): UpdateBackupManifest | undefined {
  const path = join(dir, BACKUP_MANIFEST_FILE)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateBackupManifest>
    if (raw.version !== 1 || typeof raw.appVersion !== 'string' || typeof raw.createdAt !== 'number' || typeof raw.bundleName !== 'string') {
      return undefined
    }
    return {
      version: 1,
      appVersion: raw.appVersion,
      createdAt: raw.createdAt,
      bundleName: raw.bundleName,
      databasePath: typeof raw.databasePath === 'string' ? raw.databasePath : '',
      files: Array.isArray(raw.files) ? raw.files.filter((file): file is string => typeof file === 'string') : []
    }
  } catch {
    return undefined
  }
}

/** 可回滚的备份 = 最新一个目录里 backup.json 合法且 app 包已被脚本挪进来。 */
export function findRollbackBackup(backupRoot: string): UpdateBackupRecord | undefined {
  if (!existsSync(backupRoot)) return undefined
  const candidates = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(backupRoot, entry.name))
    .map((dir) => ({ dir, manifest: readBackupManifest(dir) }))
    .filter((entry): entry is { dir: string; manifest: UpdateBackupManifest } => entry.manifest !== undefined)
    .sort((a, b) => b.manifest.createdAt - a.manifest.createdAt)
  for (const { dir, manifest } of candidates) {
    const bundlePath = join(dir, manifest.bundleName)
    if (!existsSync(bundlePath)) continue
    const databaseCopyPath = join(dir, BACKUP_DATABASE_FILE)
    return {
      version: manifest.appVersion,
      createdAt: manifest.createdAt,
      dir,
      bundlePath,
      databaseCopyPath: existsSync(databaseCopyPath) ? databaseCopyPath : undefined,
      files: manifest.files
    }
  }
  return undefined
}
