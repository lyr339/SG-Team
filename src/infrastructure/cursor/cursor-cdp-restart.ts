import { existsSync, statSync } from 'node:fs'
import {
  type ProcessExecFileFn,
  countWindowsCursorProcesses,
  cursorWindowsStartCommand,
  defaultProcessExecFile,
  describeWindowsCdpStartFailure,
  resolveCursorWindowsExecutable,
  runningCursorWindowsExecutable,
  windowsCursorCommandLines
} from './cursor-windows-launch'

/**
 * 一键重启 Cursor 并附加 --remote-debugging-port，使 CDP 会话创建可用。
 * 支持 macOS 与 Windows（两平台彻底分离：mac 走 osascript/open，win 走 taskkill/cmd start）。
 * 优雅退出优先，避免强杀丢失未保存状态。
 */

const CURSOR_PROCESS_PATTERN = 'Cursor.app/Contents/MacOS/Cursor'
const QUIT_TIMEOUT_MS = 12_000
const PORT_READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const FETCH_TIMEOUT_MS = 2_000

/** 默认端口探测：带 AbortController 超时，端口无响应时快速失败而不是挂起。 */
async function defaultFetchWithTimeout(url: string): Promise<{ status: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { status: response.status }
  } finally {
    clearTimeout(timer)
  }
}

export interface CursorCdpRestartResult {
  ok: boolean
  message: string
}

export interface CursorCdpRestartOptions {
  port: number
  workspacePath?: string
  execFileFn?: ProcessExecFileFn
  fetchFn?: (url: string) => Promise<{ status: number }>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  platform?: NodeJS.Platform
}

async function cursorMainProcessCount(execFileFn: ProcessExecFileFn, platform: NodeJS.Platform): Promise<number> {
  if (platform === 'win32') return countWindowsCursorProcesses(execFileFn)
  try {
    const { stdout } = await execFileFn('pgrep', ['-f', CURSOR_PROCESS_PATTERN])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean).length
  } catch {
    // pgrep 无匹配时退出码为 1
    return 0
  }
}

export async function restartCursorWithCdp(options: CursorCdpRestartOptions): Promise<CursorCdpRestartResult> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') {
    return { ok: false, message: '当前平台不支持自动重启 Cursor（仅 macOS / Windows）；请手动以 --remote-debugging-port 启动' }
  }
  // 默认执行器有界（PowerShell 探测预算）且不闪控制台窗；裸 execFile 曾让挂死的 PowerShell 挂住整个重启。
  const execFileFn = options.execFileFn ?? defaultProcessExecFile
  // 默认探测必须带超时：裸 fetch 在端口无响应时会挂起，拖延 PORT_READY_TIMEOUT_MS 的退出时机
  const fetchFn = options.fetchFn ?? defaultFetchWithTimeout
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const port = options.port
  const workspacePath = validWorkspacePath(options.workspacePath)
  if (options.workspacePath?.trim() && !workspacePath) {
    return { ok: false, message: `团队工作区路径不可用，已中止重启，避免打开错误 Cursor 窗口：${options.workspacePath.trim()}` }
  }

  try {
    // Windows：先记下正在运行的那份 Cursor 的路径，退出后按它拉起（Program Files 安装无 App Paths）。
    let windowsRunningExecutable: string | undefined
    let windowsExecutable: string | undefined
    if (await cursorMainProcessCount(execFileFn, platform) > 0) {
      if (platform === 'win32') windowsRunningExecutable = await runningCursorWindowsExecutable(execFileFn)
      // 优雅退出（不做强杀——本模块策略与账号切换器不同，保留用户未保存内容）：
      // mac 走 AppleScript quit；win 走 taskkill（无 /F 即 WM_CLOSE，等价语义）
      let quitIssue: string | undefined
      if (platform === 'win32') {
        // Electron 有十几个同名无窗口子进程，无 /F 的 taskkill 对它们必然报「只能强制终止」并以非 0
        // 退出——但主窗口已经收到 WM_CLOSE，Cursor 正在退出。退出码不作为成败依据，只看进程数是否归零。
        try {
          await execFileFn('taskkill', ['/IM', 'Cursor.exe'])
        } catch (error) {
          quitIssue = summarizeError(error)
        }
      } else {
        // AppleScript quit 在 Cursor 弹出「保存更改？」时会一直等对话框（AppleScript 默认 2 分钟才放弃）；执行器
        // 有界后到点被 kill 也不是失败——quit 事件早已送达，成败仍只看进程数是否归零，与 Windows taskkill 同一套处理。
        try {
          await execFileFn('osascript', ['-e', 'tell application "Cursor" to quit'])
        } catch (error) {
          quitIssue = summarizeError(error)
        }
      }
      const quitDeadline = now() + QUIT_TIMEOUT_MS
      while (now() < quitDeadline && await cursorMainProcessCount(execFileFn, platform) > 0) {
        await sleep(POLL_INTERVAL_MS)
      }
      if (await cursorMainProcessCount(execFileFn, platform) > 0) {
        const quitTool = platform === 'win32' ? 'taskkill' : 'osascript'
        return {
          ok: false,
          message: `Cursor 未能在限定时间内退出（可能有未保存的拦截弹窗），请手动关闭后重试${quitIssue ? `；${quitTool}：${quitIssue}` : ''}`
        }
      }
    }

    if (platform === 'win32') {
      windowsExecutable = resolveCursorWindowsExecutable({ runningPath: windowsRunningExecutable })
      const command = cursorWindowsStartCommand({ executable: windowsExecutable, workspacePath, cdpPort: port })
      await execFileFn(command.file, command.args, command.options)
    } else {
      const openArgs = workspacePath
        ? ['-a', 'Cursor', workspacePath, '--args', `--remote-debugging-port=${port}`]
        : ['-a', 'Cursor', '--args', `--remote-debugging-port=${port}`]
      await execFileFn('open', openArgs)
    }

    const readyDeadline = now() + PORT_READY_TIMEOUT_MS
    while (now() < readyDeadline) {
      try {
        const response = await fetchFn(`http://127.0.0.1:${port}/json/version`)
        if (response.status >= 200 && response.status < 300) {
          return {
            ok: true,
            message: workspacePath
              ? `Cursor 已重启、打开团队工作区并启用会话创建端口（${port}）`
              : `Cursor 已重启并启用会话创建端口（${port}）`
          }
        }
      } catch {
        // 端口尚未就绪，继续等待
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (platform === 'win32') {
      // 端口没起来的三种原因处置完全不同（没起来 / 被残留实例接管没带参数 / 带了参数但端口不通），
      // 读一遍 Cursor.exe 的命令行分清楚，同事截图即可定位。
      return {
        ok: false,
        message: describeWindowsCdpStartFailure({
          port,
          executable: windowsExecutable ?? 'Cursor.exe',
          commandLines: await windowsCursorCommandLines(execFileFn)
        })
      }
    }
    return { ok: false, message: `Cursor 已启动，但调试端口 ${port} 在限定时间内未就绪；请确认 Cursor 完全启动后重试` }
  } catch (error) {
    return { ok: false, message: `重启 Cursor 失败：${summarizeError(error)}` }
  }
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 200) : String(error)
}

function validWorkspacePath(input: string | undefined): string | undefined {
  const path = input?.trim()
  if (!path) return undefined
  try {
    return existsSync(path) && statSync(path).isDirectory() ? path : undefined
  } catch {
    return undefined
  }
}
