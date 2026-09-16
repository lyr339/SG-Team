import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildApplyScript,
  buildRollbackScript,
  shellQuote,
  stageMacBundle,
  writeHelperScript,
  type ApplyScriptPlan,
  type RollbackScriptPlan,
  type RunCommand,
  type RunCommandResult
} from '../src/infrastructure/app-update/mac-app-replacer'

const OK: RunCommandResult = { status: 0, stdout: '', stderr: '' }

/** 在暂存目录里造一个最小可验收的 .app 结构（Info.plist 由假 plutil 顶替，不需要真文件）。 */
function makeBundle(dir: string, options: { mcp?: boolean; executable?: boolean } = {}): void {
  const contents = join(dir, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  if (options.executable !== false) writeFileSync(join(contents, 'MacOS', '拾光'), 'binary', { mode: 0o755 })
  if (options.mcp !== false) {
    mkdirSync(join(contents, 'Resources', 'mcp'), { recursive: true })
    writeFileSync(join(contents, 'Resources', 'mcp', 'index.mjs'), '// mcp server')
  }
}

interface FakePlan {
  dittoStatus?: number
  /** ditto 解压出的 bundle 名（默认 拾光.app）；null = 什么都不解出来。 */
  extractedName?: string | null
  bundle?: { mcp?: boolean; executable?: boolean }
  version?: string
  versionStatus?: number
  identifier?: string
  codesignStatus?: number
}

function stageHarness(plan: FakePlan = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sg-replacer-'))
  const stagingDir = join(dir, 'staging')
  const zipPath = join(dir, 'ShiGuang-0.3.4-mac-arm64.zip')
  writeFileSync(zipPath, 'zip-bytes')
  const calls: string[] = []
  const run: RunCommand = async (command, args) => {
    calls.push(command)
    if (command === 'ditto') {
      expect(args).toEqual(['-x', '-k', zipPath, stagingDir])
      if (plan.dittoStatus) return { status: plan.dittoStatus, stdout: '', stderr: "ditto: couldn't read archive\n" }
      if (plan.extractedName !== null) makeBundle(join(stagingDir, plan.extractedName ?? '拾光.app'), plan.bundle)
      return OK
    }
    if (command === 'plutil') {
      const key = args[1]
      if (key === 'CFBundleShortVersionString') {
        if (plan.versionStatus) return { status: plan.versionStatus, stdout: '', stderr: 'plutil: bad plist\n' }
        return { status: 0, stdout: `${plan.version ?? '0.3.4'}\n`, stderr: '' }
      }
      return { status: 0, stdout: `${plan.identifier ?? 'app.shiguang.team'}\n`, stderr: '' }
    }
    if (command === 'codesign') {
      return plan.codesignStatus ? { status: plan.codesignStatus, stdout: '', stderr: 'invalid signature\n' } : OK
    }
    return OK // xattr
  }
  const stage = () => stageMacBundle({
    zipPath,
    stagingDir,
    expectedVersion: '0.3.4',
    bundleIdentifier: 'app.shiguang.team',
    bundleName: '拾光.app',
    run
  })
  return { stagingDir, stage, calls }
}

describe('shellQuote', () => {
  it('单引号、空格与中文都包成 POSIX 单引号字面量', () => {
    expect(shellQuote('/Applications/拾光.app')).toBe(`'/Applications/拾光.app'`)
    expect(shellQuote(`it's here`)).toBe(`'it'\\''s here'`)
    expect(shellQuote('Application Support')).toBe(`'Application Support'`)
  })
})

describe('stageMacBundle', () => {
  it('成功：ditto → plutil 版本 / 标识 → codesign → xattr 全过，返回暂存 bundle 路径', async () => {
    const h = stageHarness()
    const bundlePath = await h.stage()
    expect(bundlePath).toBe(join(h.stagingDir, '拾光.app'))
    expect(existsSync(bundlePath)).toBe(true)
    expect(h.calls).toEqual(['ditto', 'plutil', 'plutil', 'codesign', 'xattr'])
  })

  it('解压失败：报 stderr 末行并清掉暂存目录', async () => {
    const h = stageHarness({ dittoStatus: 1 })
    await expect(h.stage()).rejects.toThrow(/解压安装包失败：ditto: couldn't read archive/)
    expect(existsSync(h.stagingDir)).toBe(false)
  })

  it('解压结果里没有同名 bundle：列出实际解出的 .app', async () => {
    const h = stageHarness({ extractedName: 'ShiGuang.app' })
    await expect(h.stage()).rejects.toThrow(/没有 拾光\.app（有：ShiGuang\.app）/)
    expect(existsSync(h.stagingDir)).toBe(false)
  })

  it('版本与清单不一致 / 读不出版本 → 拒收', async () => {
    await expect(stageHarness({ version: '0.3.3' }).stage()).rejects.toThrow('新包版本 0.3.3 与清单 0.3.4 不一致')
    await expect(stageHarness({ versionStatus: 1 }).stage()).rejects.toThrow(/读取新包版本失败/)
  })

  it('CFBundleIdentifier 不对 → 拒收', async () => {
    await expect(stageHarness({ identifier: 'com.evil.app' }).stage()).rejects.toThrow('新包不是拾光（CFBundleIdentifier=com.evil.app）')
  })

  it('签名校验失败 → 拒收', async () => {
    await expect(stageHarness({ codesignStatus: 1 }).stage()).rejects.toThrow(/新包签名校验失败：invalid signature/)
  })

  it('缺 MCP 服务器或可执行文件 → 拒收', async () => {
    await expect(stageHarness({ bundle: { mcp: false } }).stage()).rejects.toThrow('新包缺少 MCP 服务器（Contents/Resources/mcp/index.mjs）')
    await expect(stageHarness({ bundle: { executable: false } }).stage()).rejects.toThrow('新包缺少可执行文件（Contents/MacOS）')
  })
})

const applyPlan: ApplyScriptPlan = {
  pid: 4242,
  fromVersion: '0.3.3',
  toVersion: '0.3.4',
  bundlePath: '/Applications/拾光.app',
  stagedBundlePath: '/Users/u/Library/Application Support/sg-team/updates/staging/拾光.app',
  backupBundlePath: '/Users/u/Library/Application Support/sg-team/updates/backup/0.3.3-1758000000000/拾光.app',
  backupDir: '/Users/u/Library/Application Support/sg-team/updates/backup/0.3.3-1758000000000',
  rejectedBundlePath: '/Users/u/Library/Application Support/sg-team/updates/staging/rejected.app',
  logPath: "/Users/u/Library/Application Support/sg-team/updates/apply.log",
  resultPath: '/Users/u/Library/Application Support/sg-team/updates/pending-result.json'
}

const rollbackPlan: RollbackScriptPlan = {
  pid: 4242,
  fromVersion: '0.3.4',
  toVersion: '0.3.3',
  bundlePath: '/Applications/拾光.app',
  backupBundlePath: applyPlan.backupBundlePath,
  rolledBackBundlePath: '/Users/u/Library/Application Support/sg-team/updates/staging/rolled-back.app',
  databasePath: '/Users/u/Library/Application Support/sg-team/task-pool.sqlite3',
  backupDatabasePath: `${applyPlan.backupDir}/task-pool.sqlite3`,
  logPath: applyPlan.logPath,
  resultPath: applyPlan.resultPath
}

describe('buildApplyScript', () => {
  const script = buildApplyScript(applyPlan)

  it('等退出 → 旧包挪备份 → 新包就位 → 复验签名（失败换回）→ 写结果 → open；路径全部内联转义', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain(`while kill -0 4242`)
    expect(script).toContain('[ "$i" -gt 300 ]')
    expect(script).toContain(`APP='/Applications/拾光.app'`)
    expect(script).toContain(`NEW='/Users/u/Library/Application Support/sg-team/updates/staging/拾光.app'`)
    // 顺序：先挪旧，再上新；codesign 失败把新包挪去 rejected、旧包放回
    const moveOld = script.indexOf('mv "$APP" "$BAK" || fail move_old_failed')
    const moveNew = script.indexOf('mv "$NEW" "$APP" || { mv "$BAK" "$APP"; fail move_new_failed; }')
    const reverify = script.indexOf('codesign --verify --deep --strict "$APP" || { mv "$APP" "$REJECTED"; mv "$BAK" "$APP"; fail codesign_failed; }')
    expect(moveOld).toBeGreaterThan(0)
    expect(moveNew).toBeGreaterThan(moveOld)
    expect(reverify).toBeGreaterThan(moveNew)
    expect(script).toContain(`printf '%s\\n' '{"status":"applied","from":"0.3.3","to":"0.3.4","backupDir":"/Users/u/Library/Application Support/sg-team/updates/backup/0.3.3-1758000000000"}' > "$RESULT"`)
    expect(script).toContain('"status":"apply_failed"')
    expect(script).toContain('open "$APP"')
  })

  it('单引号路径按 POSIX 规则转义；waitTicks / tickSeconds 可调', () => {
    const quoted = buildApplyScript({ ...applyPlan, logPath: "/tmp/it's/apply.log", waitTicks: 5, tickSeconds: '0.01' })
    expect(quoted).toContain(`LOG='/tmp/it'\\''s/apply.log'`)
    expect(quoted).toContain('[ "$i" -gt 5 ]')
    expect(quoted).toContain('sleep 0.01')
  })
})

describe('buildRollbackScript', () => {
  it('带库快照：清 -wal/-shm、经临时文件覆盖；结果写 rolled_back', () => {
    const script = buildRollbackScript(rollbackPlan)
    expect(script).toContain('[ -d "$BAK" ] || fail backup_missing')
    expect(script).toContain('mv "$APP" "$ROLLED" || fail move_current_failed')
    expect(script).toContain('mv "$BAK" "$APP" || { mv "$ROLLED" "$APP"; fail move_backup_failed; }')
    expect(script).toContain('cp "$DBBAK" "$DB.rollback-tmp" || fail database_copy_failed')
    expect(script).toContain('rm -f "$DB-wal" "$DB-shm"')
    expect(script).toContain('mv -f "$DB.rollback-tmp" "$DB" || fail database_restore_failed')
    expect(script).toContain(`printf '%s\\n' '{"status":"rolled_back","from":"0.3.4","to":"0.3.3"}' > "$RESULT"`)
    expect(script).toContain('"status":"rollback_failed"')
  })

  it('备份里没有库快照：不动库，只换包', () => {
    const { backupDatabasePath: _omit, ...withoutDb } = rollbackPlan
    const script = buildRollbackScript(withoutDb)
    expect(script).toContain('no database snapshot in backup; database left as is')
    expect(script).not.toContain('$DBBAK')
  })
})

describe('writeHelperScript', () => {
  it('写进目录并返回路径；目录不存在时创建', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sg-helper-')), 'updates')
    const path = writeHelperScript(dir, 'apply-1.sh', '#!/bin/sh\necho ok\n')
    expect(path).toBe(join(dir, 'apply-1.sh'))
    expect(readFileSync(path, 'utf8')).toBe('#!/bin/sh\necho ok\n')
  })

  it.skipIf(process.platform === 'win32')('生成的两种脚本都通过 sh -n 语法检查', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-sh-'))
    const apply = writeHelperScript(dir, 'apply.sh', buildApplyScript({ ...applyPlan, logPath: "/tmp/it's/apply.log" }))
    const rollback = writeHelperScript(dir, 'rollback.sh', buildRollbackScript(rollbackPlan))
    expect(() => execFileSync('sh', ['-n', apply])).not.toThrow()
    expect(() => execFileSync('sh', ['-n', rollback])).not.toThrow()
  })
})
