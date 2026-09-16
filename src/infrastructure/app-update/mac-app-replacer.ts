import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RunCommandResult {
  status: number
  stdout: string
  stderr: string
}

/** 外部命令的结构子集（ditto / plutil / codesign / xattr）；异步以免 130 MB 的解压与签名校验卡住主进程。测试注入假实现。 */
export type RunCommand = (command: string, args: string[]) => Promise<RunCommandResult>

export const defaultRunCommand: RunCommand = (command, args) => new Promise((resolve) => {
  execFile(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    const status = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
    resolve({ status, stdout: stdout ?? '', stderr: stderr || (error?.message ?? '') })
  })
})

/** POSIX 单引号转义：路径里有中文、空格、单引号都是常态（`拾光.app`、`Application Support`）。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface StageMacBundleInput {
  zipPath: string
  /** 解压目标目录（每次清空重建）。 */
  stagingDir: string
  /** 期望的 `CFBundleShortVersionString`。 */
  expectedVersion: string
  bundleIdentifier: string
  /** 现有包的文件名（`拾光.app`）：解压结果里必须有同名 bundle。 */
  bundleName: string
  run?: RunCommand
}

function failStage(message: string, detail?: string): never {
  throw new Error(detail?.trim() ? `${message}：${detail.trim().split('\n').at(-1)}` : message)
}

/**
 * 解压并验收新包（任务书 §7.1）。任一步不满足就抛错，暂存目录随即清掉——不动正在运行的包。
 * `ditto -x -k` 保留符号链接与权限（`unzip` 会把 Electron Framework 的 Versions/Current 展开）。
 */
export async function stageMacBundle(input: StageMacBundleInput): Promise<string> {
  const run = input.run ?? defaultRunCommand
  rmSync(input.stagingDir, { recursive: true, force: true })
  mkdirSync(input.stagingDir, { recursive: true })
  try {
    const extracted = await run('ditto', ['-x', '-k', input.zipPath, input.stagingDir])
    if (extracted.status !== 0) failStage('解压安装包失败', extracted.stderr)
    const bundlePath = join(input.stagingDir, input.bundleName)
    if (!existsSync(bundlePath)) {
      const apps = readdirSync(input.stagingDir).filter((name) => name.endsWith('.app'))
      failStage(`解压结果里没有 ${input.bundleName}${apps.length ? `（有：${apps.join('、')}）` : ''}`)
    }
    const plist = join(bundlePath, 'Contents', 'Info.plist')
    const version = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])
    if (version.status !== 0) failStage('读取新包版本失败', version.stderr)
    if (version.stdout.trim() !== input.expectedVersion) {
      failStage(`新包版本 ${version.stdout.trim() || '（空）'} 与清单 ${input.expectedVersion} 不一致`)
    }
    const identifier = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])
    if (identifier.status !== 0 || identifier.stdout.trim() !== input.bundleIdentifier) {
      failStage(`新包不是拾光（CFBundleIdentifier=${identifier.stdout.trim() || '（空）'}）`)
    }
    const signature = await run('codesign', ['--verify', '--deep', '--strict', bundlePath])
    if (signature.status !== 0) failStage('新包签名校验失败', signature.stderr)
    // 预期本来就没有隔离标记（net 写盘不打标）；防御性清一次，失败无所谓。
    await run('xattr', ['-dr', 'com.apple.quarantine', bundlePath])
    const mcpServer = join(bundlePath, 'Contents', 'Resources', 'mcp', 'index.mjs')
    if (!existsSync(mcpServer)) failStage('新包缺少 MCP 服务器（Contents/Resources/mcp/index.mjs）')
    const executables = readdirSync(join(bundlePath, 'Contents', 'MacOS'))
      .map((name) => join(bundlePath, 'Contents', 'MacOS', name))
      .filter((path) => statSync(path).isFile() && (process.platform === 'win32' || (statSync(path).mode & 0o111) !== 0))
    if (!executables.length) failStage('新包缺少可执行文件（Contents/MacOS）')
    return bundlePath
  } catch (error) {
    rmSync(input.stagingDir, { recursive: true, force: true })
    throw error
  }
}

export interface ApplyScriptPlan {
  /** 正在运行的拾光进程 PID：脚本先等它退出。 */
  pid: number
  fromVersion: string
  toVersion: string
  /** 正在运行的包（`/Applications/拾光.app`），替换后路径不变。 */
  bundlePath: string
  /** 已验收的新包（暂存目录里的 `拾光.app`）。 */
  stagedBundlePath: string
  /** 旧包要挪去的位置（备份目录里的 `拾光.app`）。 */
  backupBundlePath: string
  backupDir: string
  /** 新包签名复验失败时挪去的位置。 */
  rejectedBundlePath: string
  logPath: string
  resultPath: string
  /** 等旧实例退出的最多轮次 × 每轮秒数（默认 300 × 0.2 s = 60 s）。 */
  waitTicks?: number
  tickSeconds?: string
}

function resultJson(fields: Record<string, string>): string {
  return JSON.stringify(fields)
}

/**
 * 替换脚本（任务书 §7.3）。所有参数在生成时内联并单引号转义；由 `/bin/sh` 在拾光退出后执行：
 * 等退出 → 旧包 mv 进备份 → 新包 mv 到原路径 → 复验签名（失败换回）→ 写结果 → open 新版。
 * 任何一步失败都把旧包放回原位并重新打开旧版，结果文件记 apply_failed。
 */
export function buildApplyScript(plan: ApplyScriptPlan): string {
  const ticks = plan.waitTicks ?? 300
  const tick = plan.tickSeconds ?? '0.2'
  const applied = resultJson({ status: 'applied', from: plan.fromVersion, to: plan.toVersion, backupDir: plan.backupDir })
  // 失败原因是脚本内的固定标识符（$1），经 printf 的 %s 填入；版本号里不会出现 % 或引号。
  const failedFormat = resultJson({ status: 'apply_failed', from: plan.fromVersion, to: plan.toVersion, reason: '%s' })
  return [
    '#!/bin/sh',
    '# 拾光自更新：由拾光退出前生成，/bin/sh 在拾光退出后执行。',
    'set -u',
    `LOG=${shellQuote(plan.logPath)}`,
    'exec >>"$LOG" 2>&1',
    `echo "[$(date '+%F %T')] apply ${plan.fromVersion} -> ${plan.toVersion} pid=${plan.pid}"`,
    `APP=${shellQuote(plan.bundlePath)}`,
    `NEW=${shellQuote(plan.stagedBundlePath)}`,
    `BAK=${shellQuote(plan.backupBundlePath)}`,
    `REJECTED=${shellQuote(plan.rejectedBundlePath)}`,
    `RESULT=${shellQuote(plan.resultPath)}`,
    `fail() { printf ${shellQuote(`${failedFormat}\\n`)} "$1" > "$RESULT"; echo "FAIL: $1"; open "$APP" 2>/dev/null; exit 1; }`,
    '# 1. 等旧实例退出（relauncher 已等过一轮；这里兜底）',
    `i=0; while kill -0 ${plan.pid} 2>/dev/null; do i=$((i+1)); [ "$i" -gt ${ticks} ] && fail app_still_running; sleep ${tick}; done`,
    'echo "old instance gone after $i ticks"',
    '# 2. 交换（同卷 mv = rename，瞬时；Cursor 起的旧 MCP 进程从备份路径继续跑）',
    '[ -d "$NEW" ] || fail staged_missing',
    'mv "$APP" "$BAK" || fail move_old_failed',
    'mv "$NEW" "$APP" || { mv "$BAK" "$APP"; fail move_new_failed; }',
    '# 3. 收尾校验；失败即换回',
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true',
    'codesign --verify --deep --strict "$APP" || { mv "$APP" "$REJECTED"; mv "$BAK" "$APP"; fail codesign_failed; }',
    `printf '%s\\n' ${shellQuote(applied)} > "$RESULT"`,
    'echo "OK"',
    'open "$APP"',
    ''
  ].join('\n')
}

export interface RollbackScriptPlan {
  pid: number
  /** 当前（要被换走的）版本。 */
  fromVersion: string
  /** 备份里的版本（回滚目标）。 */
  toVersion: string
  bundlePath: string
  backupBundlePath: string
  /** 当前包挪去的位置（暂存目录里的 `rolled-back.app`）。 */
  rolledBackBundlePath: string
  databasePath: string
  /** 备份里的库快照；没有则不动库。 */
  backupDatabasePath?: string
  logPath: string
  resultPath: string
  waitTicks?: number
  tickSeconds?: string
}

/**
 * 回滚脚本（任务书 §7.5）：等退出 → 当前包挪走 → 备份包放回 → 用备份库快照覆盖库（先清 -wal/-shm，
 * 经临时文件 mv 覆盖，避免半写）→ 写结果 → open 旧版。库必须一起回：旧代码打不开更高 schema 的库。
 */
export function buildRollbackScript(plan: RollbackScriptPlan): string {
  const ticks = plan.waitTicks ?? 300
  const tick = plan.tickSeconds ?? '0.2'
  const done = resultJson({ status: 'rolled_back', from: plan.fromVersion, to: plan.toVersion })
  const failedFormat = resultJson({ status: 'rollback_failed', from: plan.fromVersion, to: plan.toVersion, reason: '%s' })
  const databaseLines = plan.backupDatabasePath
    ? [
        `DB=${shellQuote(plan.databasePath)}`,
        `DBBAK=${shellQuote(plan.backupDatabasePath)}`,
        '[ -f "$DBBAK" ] || fail database_backup_missing',
        'cp "$DBBAK" "$DB.rollback-tmp" || fail database_copy_failed',
        'rm -f "$DB-wal" "$DB-shm"',
        'mv -f "$DB.rollback-tmp" "$DB" || fail database_restore_failed'
      ]
    : ['echo "no database snapshot in backup; database left as is"']
  return [
    '#!/bin/sh',
    '# 拾光回滚：由拾光退出前生成，/bin/sh 在拾光退出后执行。',
    'set -u',
    `LOG=${shellQuote(plan.logPath)}`,
    'exec >>"$LOG" 2>&1',
    `echo "[$(date '+%F %T')] rollback ${plan.fromVersion} -> ${plan.toVersion} pid=${plan.pid}"`,
    `APP=${shellQuote(plan.bundlePath)}`,
    `BAK=${shellQuote(plan.backupBundlePath)}`,
    `ROLLED=${shellQuote(plan.rolledBackBundlePath)}`,
    `RESULT=${shellQuote(plan.resultPath)}`,
    `fail() { printf ${shellQuote(`${failedFormat}\\n`)} "$1" > "$RESULT"; echo "FAIL: $1"; open "$APP" 2>/dev/null; exit 1; }`,
    `i=0; while kill -0 ${plan.pid} 2>/dev/null; do i=$((i+1)); [ "$i" -gt ${ticks} ] && fail app_still_running; sleep ${tick}; done`,
    'echo "current instance gone after $i ticks"',
    '[ -d "$BAK" ] || fail backup_missing',
    'mkdir -p "$(dirname "$ROLLED")"',
    'rm -rf "$ROLLED"',
    'mv "$APP" "$ROLLED" || fail move_current_failed',
    'mv "$BAK" "$APP" || { mv "$ROLLED" "$APP"; fail move_backup_failed; }',
    ...databaseLines,
    `printf '%s\\n' ${shellQuote(done)} > "$RESULT"`,
    'echo "OK"',
    'open "$APP"',
    ''
  ].join('\n')
}

/** 把脚本写到 updates 目录（0o700），返回路径。 */
export function writeHelperScript(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, content, { mode: 0o700 })
  return path
}
