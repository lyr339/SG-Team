import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restartCursorWithCdp } from '../src/infrastructure/cursor/cursor-cdp-restart'

interface FakeExec {
  calls: string[]
  cursorProcesses: number
  openCalled: boolean
  failOpen?: boolean
  /** cmd.exe 调用时收到的 spawn 选项（Windows 拉起必须原样传递命令串）。 */
  cmdOptions?: { windowsVerbatimArguments?: boolean }
  /** Windows 优雅退出是否真的让进程退净（false = 模拟未保存弹窗拦住）。 */
  quitSucceeds: boolean
  /** 端口未就绪时 Get-CimInstance 回显的 Cursor.exe 命令行；'fail' = PowerShell 查询失败。 */
  commandLines: string[] | 'fail'
}

function createHarness(options: {
  cursorProcesses?: number
  portReadyAfter?: number
  failOpen?: boolean
  quitSucceeds?: boolean
  commandLines?: string[] | 'fail'
} = {}) {
  const exec: FakeExec = {
    calls: [],
    cursorProcesses: options.cursorProcesses ?? 0,
    openCalled: false,
    failOpen: options.failOpen,
    quitSucceeds: options.quitSucceeds ?? true,
    commandLines: options.commandLines ?? []
  }
  let clock = 0
  let fetchCount = 0
  const execFileFn = async (
    file: string,
    args?: readonly string[],
    spawnOptions?: { windowsVerbatimArguments?: boolean }
  ): Promise<{ stdout: string; stderr: string }> => {
    const command = `${file} ${(args ?? []).join(' ')}`
    exec.calls.push(command)
    if (file === 'pgrep') {
      if (exec.cursorProcesses <= 0) {
        const error = new Error('no match') as Error & { code?: number }
        error.code = 1
        throw error
      }
      return { stdout: Array.from({ length: exec.cursorProcesses }, (_, index) => `${1000 + index}`).join('\n'), stderr: '' }
    }
    if (file === 'tasklist') {
      // Windows：按进程数回显 Cursor.exe 行；无匹配时 tasklist 输出 INFO 行（不含 Cursor.exe）
      const lines = Array.from({ length: exec.cursorProcesses }, () => '"Cursor.exe","1234","Console","1","45,678 K"')
      return { stdout: lines.length ? lines.join('\r\n') : 'INFO: No tasks are running which match the specified criteria.', stderr: '' }
    }
    if (file === 'osascript') {
      exec.cursorProcesses = 0
      return { stdout: '', stderr: '' }
    }
    if (file === 'taskkill') {
      // 真实语义：无 /F 的 taskkill 对 Electron 的无窗口子进程必然报错并以非 0 退出，
      // 但主窗口已收到 WM_CLOSE——进程随后（若无弹窗拦截）退净。
      if (exec.quitSucceeds) exec.cursorProcesses = 0
      const error = new Error(
        'Command failed: taskkill /IM Cursor.exe\nSUCCESS: Sent termination signal to the process "Cursor.exe" with PID 4120.\n' +
        'ERROR: The process "Cursor.exe" with PID 4388 could not be terminated.\nReason: This process can only be terminated forcefully (with /F option).'
      ) as Error & { code?: number }
      error.code = 128
      throw error
    }
    if (file === 'powershell.exe') {
      const script = args?.[2] ?? ''
      if (script.includes('Win32_Process')) {
        // Get-CimInstance：端口未就绪时读 Cursor.exe 的命令行做诊断。
        if (exec.commandLines === 'fail') {
          const error = new Error('spawn ETIMEDOUT') as Error & { code?: string }
          error.code = 'ETIMEDOUT'
          throw error
        }
        return { stdout: exec.commandLines.join('\r\n'), stderr: '' }
      }
      // Get-Process：运行中回显可执行路径（全用户安装位置），未运行为空。
      return { stdout: exec.cursorProcesses > 0 ? 'C:\\Program Files\\cursor\\Cursor.exe\r\n' : '', stderr: '' }
    }
    if (file === 'open' || file === 'cmd.exe') {
      if (exec.failOpen) throw new Error('launch failed')
      if (file === 'cmd.exe') exec.cmdOptions = spawnOptions
      exec.openCalled = true
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const portReadyAfter = options.portReadyAfter ?? 1
  const fetchFn = async (): Promise<{ status: number }> => {
    fetchCount += 1
    if (!exec.openCalled || fetchCount <= portReadyAfter) throw new Error('ECONNREFUSED')
    return { status: 200 }
  }
  const sleep = async (ms: number): Promise<void> => { clock += ms }
  const now = (): number => clock
  return { exec, execFileFn, fetchFn, sleep, now, getFetchCount: () => fetchCount }
}

describe('restartCursorWithCdp', () => {
  it('非 macOS/Windows 平台直接拒绝', async () => {
    const harness = createHarness()
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'linux',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('不支持')
  })

  it('Cursor 未运行：跳过退出直接启动并等端口就绪', async () => {
    const harness = createHarness({ cursorProcesses: 0, portReadyAfter: 2 })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('9333')
    expect(harness.exec.calls.some((call) => call.startsWith('osascript'))).toBe(false)
    expect(harness.exec.calls.some((call) => call.includes('open -a Cursor --args --remote-debugging-port=9333'))).toBe(true)
  })

  it('带工作区路径时：直接打开 IDE 工作区并附加端口参数', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'sg-cdp-workspace-'))
    const harness = createHarness({ cursorProcesses: 0, portReadyAfter: 1 })
    const result = await restartCursorWithCdp({
      port: 9333,
      workspacePath,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('打开团队工作区')
    expect(harness.exec.calls.some((call) => call.includes(`open -a Cursor ${workspacePath} --args --remote-debugging-port=9333`))).toBe(true)
  })

  it('Cursor 运行中：先优雅退出再带参启动', async () => {
    const harness = createHarness({ cursorProcesses: 2, portReadyAfter: 1 })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(true)
    const quitIndex = harness.exec.calls.findIndex((call) => call.includes('tell application "Cursor" to quit'))
    const openIndex = harness.exec.calls.findIndex((call) => call.startsWith('open -a Cursor'))
    expect(quitIndex).toBeGreaterThanOrEqual(0)
    expect(openIndex).toBeGreaterThan(quitIndex)
  })

  it('端口一直不就绪 → 明确报错', async () => {
    const harness = createHarness({ cursorProcesses: 0, portReadyAfter: Number.MAX_SAFE_INTEGER })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未就绪')
  })

  it('open 调用失败 → 透出错误', async () => {
    const harness = createHarness({ cursorProcesses: 0, failOpen: true })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('重启 Cursor 失败')
  })

  it('工作区路径不存在时：不退出 Cursor，避免落到错误窗口', async () => {
    const harness = createHarness({ cursorProcesses: 2 })
    const result = await restartCursorWithCdp({
      port: 9333,
      workspacePath: '/path/that/does/not/exist/demo-app',
      platform: 'darwin',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('团队工作区路径不可用')
    expect(harness.exec.calls.some((call) => call.startsWith('osascript'))).toBe(false)
    expect(harness.exec.calls.some((call) => call.startsWith('open -a Cursor'))).toBe(false)
  })

  it('Windows：Cursor 未运行 → tasklist 探测后 cmd start 带端口启动', async () => {
    const harness = createHarness({ cursorProcesses: 0, portReadyAfter: 1 })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'win32',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(true)
    expect(harness.exec.calls.some((call) => call.startsWith('tasklist'))).toBe(true)
    // 不走 mac 链路
    expect(harness.exec.calls.some((call) => call.includes('osascript'))).toBe(false)
    expect(harness.exec.calls.some((call) => call.startsWith('open '))).toBe(false)
    // cmd start 带调试端口
    const startCall = harness.exec.calls.find((call) => call.startsWith('cmd.exe'))
    expect(startCall).toBeDefined()
    expect(startCall).toContain('--remote-debugging-port=9333')
    expect(startCall).toContain('start ""')
  })

  it('Windows：Cursor 运行中 → taskkill 优雅退出（无 /F 强杀）再带参启动', async () => {
    const harness = createHarness({ cursorProcesses: 2, portReadyAfter: 1 })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'win32',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(true)
    const killIndex = harness.exec.calls.findIndex((call) => call.startsWith('taskkill /IM Cursor.exe'))
    const startIndex = harness.exec.calls.findIndex((call) => call.startsWith('cmd.exe'))
    expect(killIndex).toBeGreaterThanOrEqual(0)
    // 优雅退出不带 /F（保留用户未保存内容——与 mac osascript quit 语义对齐）
    expect(harness.exec.calls.some((call) => call.startsWith('taskkill /F'))).toBe(false)
    expect(startIndex).toBeGreaterThan(killIndex)
    // 退出前采集到的可执行路径用于拉起：全用户安装（Program Files）没有 App Paths，裸名会找不到。
    const probeIndex = harness.exec.calls.findIndex((call) => call.startsWith('powershell.exe'))
    expect(probeIndex).toBeGreaterThanOrEqual(0)
    expect(probeIndex).toBeLessThan(killIndex)
    expect(harness.exec.calls[startIndex]).toContain('start "" "C:\\Program Files\\cursor\\Cursor.exe"')
    // taskkill 对无窗口子进程报错、非 0 退出（夹具按真实语义抛错）——不是失败：进程数归零即继续拉起。
    expect(result.message).toContain('9333')
    // 命令串整体带引号并原样传递：否则 Node 把内部引号转义成 \"，cmd start 会把 \"\" 当程序名。
    expect(harness.exec.cmdOptions).toEqual({ windowsVerbatimArguments: true })
    expect(harness.exec.calls[startIndex]).toMatch(/^cmd\.exe \/d \/s \/c "start "" "C:\\Program Files\\cursor\\Cursor\.exe" --remote-debugging-port=9333 --disable-features=LocalNetworkAccessChecks"$/)
  })

  it('Windows：taskkill 报错且进程始终不退（未保存弹窗拦截）→ 明确报退出超时并附 taskkill 输出，不拉起第二个实例', async () => {
    const harness = createHarness({ cursorProcesses: 2, quitSucceeds: false })
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'win32',
      execFileFn: harness.execFileFn as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未能在限定时间内退出')
    expect(result.message).toContain('taskkill：')
    expect(result.message).toContain('could not be terminated')
    expect(harness.exec.calls.some((call) => call.startsWith('cmd.exe'))).toBe(false)
  })

  it('Windows：端口超时后按 Cursor.exe 命令行分三种原因给提示', async () => {
    const run = async (commandLines: string[] | 'fail') => {
      const harness = createHarness({ cursorProcesses: 0, portReadyAfter: Number.MAX_SAFE_INTEGER, commandLines })
      const result = await restartCursorWithCdp({
        port: 9333,
        platform: 'win32',
        execFileFn: harness.execFileFn as never,
        fetchFn: harness.fetchFn,
        sleep: harness.sleep,
        now: harness.now
      })
      expect(result.ok).toBe(false)
      return result.message
    }
    // 没起来：进程列表为空，提示里带上实际用的拉起命令。
    expect(await run([])).toContain('Cursor 没有启动起来（拉起命令：')
    // 起来了但没带参数：被残留实例接管。
    expect(await run(['"C:\\P\\Cursor.exe" --type=renderer'])).toContain('没有 --remote-debugging-port=9333')
    // 带了参数但端口不通：保留段 / 安全软件，指向换端口的环境变量。
    const blocked = await run(['"C:\\P\\Cursor.exe" --remote-debugging-port=9333 "C:\\ws"'])
    expect(blocked).toContain('excludedportrange')
    expect(blocked).toContain('SG_TEAM_CURSOR_CDP_PORT')
    // 查询本身失败：退回通用文案，但仍然是失败结论。
    expect(await run('fail')).toContain('无法读取 Cursor 进程信息')
  })

  it('Windows：tasklist 探测真实失败 → fail-closed 拒绝重启，绝不双开 Cursor', async () => {
    const harness = createHarness({ cursorProcesses: 1 })
    const originalExec = harness.execFileFn
    const failingTasklist = async (file: string, args?: readonly string[]) => {
      if (file === 'tasklist') {
        // 真实探测失败（超时，非退出码 1 的无匹配语义）
        const error = new Error('spawn ETIMEDOUT') as Error & { code?: unknown }
        error.code = 'ETIMEDOUT'
        throw error
      }
      return originalExec(file, args)
    }
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'win32',
      execFileFn: failingTasklist as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('重启 Cursor 失败')
    // 未杀进程、未 start 第二个实例——探测不确定时宁可不动
    expect(harness.exec.calls.some((call) => call.startsWith('taskkill'))).toBe(false)
    expect(harness.exec.calls.some((call) => call.startsWith('cmd.exe'))).toBe(false)
  })

  it('Windows：tasklist 退出码 1（无匹配语义）→ 视为未运行照常启动', async () => {
    const harness = createHarness({ cursorProcesses: 0 })
    const originalExec = harness.execFileFn
    const exitCodeOne = async (file: string, args?: readonly string[]) => {
      if (file === 'tasklist') {
        const error = new Error('no tasks match the filter') as Error & { code?: unknown }
        error.code = 1
        throw error
      }
      return originalExec(file, args)
    }
    const result = await restartCursorWithCdp({
      port: 9333,
      platform: 'win32',
      execFileFn: exitCodeOne as never,
      fetchFn: harness.fetchFn,
      sleep: harness.sleep,
      now: harness.now
    })
    expect(result.ok).toBe(true)
    expect(harness.exec.calls.some((call) => call.startsWith('cmd.exe'))).toBe(true)
  })
})
