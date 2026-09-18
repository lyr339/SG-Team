import { describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  cursorWindowsExecutableCandidates,
  cursorWindowsStartCommand,
  describeWindowsCdpStartFailure,
  resolveCursorWindowsExecutable,
  resolveWindowsCursorWorkbench,
  runningCursorWindowsExecutable,
  windowsCursorCommandLines,
  windowsPowerShellCommandArgs
} from '../src/infrastructure/cursor/cursor-windows-launch'

const env = {
  LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  ProgramW6432: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)'
}

describe('Windows Cursor executable resolution', () => {
  const bundleIn = (root: string) => `${root}\\resources\\app\\out\\vs\\workbench\\workbench.desktop.main.js`

  it.skipIf(process.platform !== 'win32')('resolves an actual process in a custom Unicode folder through Windows PowerShell', async (context) => {
    // exec 超时 20s 而非 5s：09-18 main 两连红（7001bee / e25321a）都是本用例在 windows-latest 上收到 undefined，
    // 相关代码零改动、同一 run 里 knip 从 10s 慢到 25s / 72s——整台 VM 慢，PowerShell 启动 + Get-Process 超过 5s
    // 被 runningCursorWindowsExecutable 按「探测失败」吞成 undefined，回退到不存在的候选目录后断言只剩 undefined，
    // CI retry 落在同一台 VM 再挂一次。20s 与 vitest.config testTimeout 放宽的慢盘前科同理。
    // calls 记录每次真实 PowerShell 调用的脚本、耗时、首行输出或失败原因，断言失败时随消息进 annotation，下次不用再猜。
    const calls: string[] = []
    const firstLine = (text: string) => text.split(/\r?\n/).map(line => line.trim()).find(Boolean)
    const exec = async (file: string, args: string[]) => {
      const label = `${file} ${args.at(-1)?.split(';').at(-1)?.trim().split(' ')[0] ?? ''}`
      const started = Date.now()
      try {
        const result = await promisify(execFile)(file, args, { timeout: 20_000, windowsHide: true })
        const stderr = firstLine(result.stderr)
        calls.push(`${label} ok in ${Date.now() - started}ms → ${firstLine(result.stdout) ?? '<empty>'}${stderr ? ` (stderr: ${stderr})` : ''}`)
        return result
      } catch (error) {
        const cause = error as Error & { code?: unknown; killed?: boolean }
        // 未找到进程时 -Command 的 $? 为 false → powershell.exe 以 1 退出（而非空输出），与超时被 kill 区分开。
        const reason = cause.killed ? 'killed (exec timeout)' : typeof cause.code === 'number' ? `exit ${cause.code}` : String(cause.code ?? cause.message)
        calls.push(`${label} failed in ${Date.now() - started}ms: ${reason}`)
        throw error
      }
    }
    if (await runningCursorWindowsExecutable(exec)) context.skip()
    const root = mkdtempSync(join(tmpdir(), 'sg 路径验证 '))
    const executable = join(root, 'Cursor.exe')
    copyFileSync(process.execPath, executable)
    const child = spawn(executable, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { windowsHide: true })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.stdout!.once('data', () => resolve())
        child.once('exit', () => reject(new Error('fixture exited before ready')))
      })
      // 无 bundle 时仍指向运行中的自定义安装，不误选机器上的其他副本。
      expect(await resolveWindowsCursorWorkbench(exec), `PowerShell calls: ${calls.join(' | ')}`).toBe(bundleIn(root))
    } finally {
      if (child.pid && child.exitCode === null) {
        await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    // 最坏路径三次 20s 的 PowerShell（skip 探测 + running 探测 + 注册表查询）= 60s，再加拷贝 node.exe 与拉起；
    // 沿用 30s 会先于断言掐掉，只剩一个没有诊断的 timeout。
  }, 90_000)

  it('targets the running D-drive install even if a C-drive copy exists or the running bundle is missing', async () => {
    let calls = 0
    const exec = async () => { calls++; return { stdout: 'D:\\软件 空间\\Cursor\\Cursor.exe\r\n' } }
    const expected = bundleIn('D:\\软件 空间\\Cursor')
    expect(await resolveWindowsCursorWorkbench(exec, () => true, env)).toBe(expected)
    expect(await resolveWindowsCursorWorkbench(exec, () => false, env)).toBe(expected)
    expect(calls).toBe(2)
  })

  it('reads registered custom installs when closed, ignoring stale entries', async () => {
    const expected = bundleIn('E:\\开发工具\\Cursor')
    const exec = async (_file: string, args: string[]) => ({
      stdout: args.join(' ').includes('Get-Process') ? '' : 'D:\\removed\\Cursor\r\nE:\\开发工具\\Cursor\r\n'
    })
    expect(await resolveWindowsCursorWorkbench(exec, path => path === expected, env)).toBe(expected)
  })

  it('falls back to existing default installs when discovery fails, or returns no path', async () => {
    const exec = async () => { throw new Error('PowerShell failed') }
    const expected = bundleIn('C:\\Program Files\\Cursor')
    expect(await resolveWindowsCursorWorkbench(exec, path => path === expected, env)).toBe(expected)
    expect(await resolveWindowsCursorWorkbench(exec, () => false, env)).toBeUndefined()
  })

  it('lists per-user and all-users install locations once each', () => {
    expect(cursorWindowsExecutableCandidates(env)).toEqual([
      'C:\\Users\\demo\\AppData\\Local\\Programs\\Cursor\\Cursor.exe',
      'C:\\Program Files\\Cursor\\Cursor.exe',
      'C:\\Program Files (x86)\\Cursor\\Cursor.exe'
    ])
  })

  it('trusts the running process path, then the first existing install, then the bare name', () => {
    const programFiles = 'C:\\Program Files\\Cursor\\Cursor.exe'
    expect(resolveCursorWindowsExecutable({ runningPath: 'D:\\Tools\\Cursor\\Cursor.exe', env, exists: () => false }))
      .toBe('D:\\Tools\\Cursor\\Cursor.exe')
    // 全用户安装：LOCALAPPDATA 下没有，Program Files 下有——以前会退回裸名而找不到。
    expect(resolveCursorWindowsExecutable({ env, exists: (path) => path === programFiles })).toBe(programFiles)
    expect(resolveCursorWindowsExecutable({ env, exists: () => false })).toBe('Cursor.exe')
  })

  it('reads the running Cursor path from PowerShell and ignores anything that is not Cursor.exe', async () => {
    const calls: string[] = []
    const exec = (stdout: string) => async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`)
      return { stdout }
    }
    await expect(runningCursorWindowsExecutable(exec('C:\\Program Files\\cursor\\Cursor.exe\r\n'))).resolves.toBe('C:\\Program Files\\cursor\\Cursor.exe')
    expect(calls[0]).toContain('Get-Process -Name Cursor')
    await expect(runningCursorWindowsExecutable(exec(''))).resolves.toBeUndefined()
    await expect(runningCursorWindowsExecutable(exec('C:\\Windows\\explorer.exe'))).resolves.toBeUndefined()
    // 中文用户名的安装路径：PowerShell 已按 UTF-8 写管道，Node 侧原样读回，不再是 GBK 乱码。
    await expect(runningCursorWindowsExecutable(exec('C:\\Users\\张三\\AppData\\Local\\Programs\\Cursor\\Cursor.exe\r\n')))
      .resolves.toBe('C:\\Users\\张三\\AppData\\Local\\Programs\\Cursor\\Cursor.exe')
  })

  it('prefixes every PowerShell command with a BOM-less UTF-8 output encoding (OEM code page would garble Chinese paths)', () => {
    const args = windowsPowerShellCommandArgs('Get-Process -Name Cursor')
    expect(args.slice(0, 2)).toEqual(['-NoProfile', '-Command'])
    expect(args[2]).toBe('[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);Get-Process -Name Cursor')
    // runningCursorWindowsExecutable 与 cdp-keeper 的探测都必须经过同一入口。
    const calls: string[][] = []
    void runningCursorWindowsExecutable(async (_file, commandArgs) => {
      calls.push(commandArgs)
      return { stdout: '' }
    })
    expect(calls[0]?.[2]?.startsWith('[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);')).toBe(true)
  })

  it('falls back to the System32 PowerShell on ENOENT and gives up on other failures', async () => {
    const attempted: string[] = []
    const enoentThenFound = async (file: string) => {
      attempted.push(file)
      if (file === 'powershell.exe') {
        const error = new Error('spawn powershell.exe ENOENT') as Error & { code?: string }
        error.code = 'ENOENT'
        throw error
      }
      return { stdout: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Cursor\\Cursor.exe' }
    }
    await expect(runningCursorWindowsExecutable(enoentThenFound)).resolves.toBe('C:\\Users\\demo\\AppData\\Local\\Programs\\Cursor\\Cursor.exe')
    expect(attempted).toHaveLength(2)
    expect(attempted[1]).toMatch(/System32[\\/]WindowsPowerShell/)
    const timeout = async () => {
      const error = new Error('spawn ETIMEDOUT') as Error & { code?: string }
      error.code = 'ETIMEDOUT'
      throw error
    }
    await expect(runningCursorWindowsExecutable(timeout)).resolves.toBeUndefined()
  })
})

describe('Windows Cursor launch command', () => {
  it('wraps the whole start line in quotes and demands verbatim arguments (Node would otherwise escape the inner quotes as \\" which cmd does not understand)', () => {
    const command = cursorWindowsStartCommand({
      executable: 'C:\\Program Files\\Cursor\\Cursor.exe',
      workspacePath: 'C:\\Users\\张三\\work space',
      cdpPort: 9333
    })
    expect(command.file).toBe('cmd.exe')
    expect(command.options).toEqual({ windowsVerbatimArguments: true })
    expect(command.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    // cmd /s：首字符是引号则去掉首尾两个引号、其余原样——start 拿到的正是里面这一行。
    expect(command.args[3]).toBe(
      '"start "" "C:\\Program Files\\Cursor\\Cursor.exe" "C:\\Users\\张三\\work space" --remote-debugging-port=9333 --disable-features=LocalNetworkAccessChecks"'
    )
    // 普通拉起（无端口、无工作区）也走同一形态。
    expect(cursorWindowsStartCommand({ executable: 'Cursor.exe' }).args[3]).toBe('"start "" "Cursor.exe""')
  })

  it('reads every Cursor.exe command line through the UTF-8 PowerShell entry and returns undefined when the probe itself fails', async () => {
    const calls: string[][] = []
    const lines = await windowsCursorCommandLines(async (_file, args) => {
      calls.push(args)
      return { stdout: '"C:\\Users\\demo\\AppData\\Local\\Programs\\Cursor\\Cursor.exe" --remote-debugging-port=9333 "C:\\ws"\r\n"C:\\Users\\demo\\AppData\\Local\\Programs\\Cursor\\Cursor.exe" --type=gpu-process\r\n\r\n' }
    })
    expect(lines).toHaveLength(2)
    expect(lines?.[0]).toContain('--remote-debugging-port=9333')
    expect(calls[0]?.[2]).toContain('[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);')
    expect(calls[0]?.[2]).toContain("Win32_Process -Filter \"Name='Cursor.exe'\"")
    await expect(windowsCursorCommandLines(async () => ({ stdout: '' }))).resolves.toEqual([])
    await expect(windowsCursorCommandLines(async () => {
      const error = new Error('spawn ETIMEDOUT') as Error & { code?: string }
      error.code = 'ETIMEDOUT'
      throw error
    })).resolves.toBeUndefined()
  })

  it('tells the three "port never came up" causes apart', () => {
    const base = { port: 9333, executable: 'C:\\Program Files\\Cursor\\Cursor.exe' }
    expect(describeWindowsCdpStartFailure({ ...base, commandLines: undefined })).toContain('无法读取 Cursor 进程信息')
    expect(describeWindowsCdpStartFailure({ ...base, commandLines: [] })).toContain('Cursor 没有启动起来（拉起命令：C:\\Program Files\\Cursor\\Cursor.exe）')
    // 残留实例接管：进程在，但命令行里没有本次端口参数。
    const takenOver = describeWindowsCdpStartFailure({ ...base, commandLines: ['"C:\\...\\Cursor.exe" --type=renderer', '"C:\\...\\Cursor.exe"'] })
    expect(takenOver).toContain('没有 --remote-debugging-port=9333')
    expect(takenOver).toContain('完全退出 Cursor')
    // 带了参数但端口不通：保留段 / 安全软件，指向换端口的环境变量。
    const blocked = describeWindowsCdpStartFailure({ ...base, commandLines: ['"C:\\...\\Cursor.exe" --remote-debugging-port=9333 "C:\\ws"'] })
    expect(blocked).toContain('已带 --remote-debugging-port=9333 启动')
    expect(blocked).toContain('excludedportrange')
    expect(blocked).toContain('SG_TEAM_CURSOR_CDP_PORT')
  })
})
