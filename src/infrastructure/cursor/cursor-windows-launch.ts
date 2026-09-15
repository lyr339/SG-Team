import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { CURSOR_CDP_PORT_ENV } from './cursor-cdp-session-creator'
import { cursorInstallRoots, cursorWorkbenchBundleCandidates } from './cursor-install-paths'

// 这里只构造 Windows 路径：显式用 win32 语义，宿主是 macOS（测试）时结果也一致。
const { join } = win32

/**
 * Windows 版 Cursor 进程操作共享辅助（账号切换器 cursor-account-switcher 与
 * CDP 重启 cursor-cdp-restart 共用——单一来源，两处行为必须一致）。
 *
 * 与 macOS 版彻底分离：mac 走 open/pkill/pgrep；win 走 cmd start/taskkill/tasklist。
 * 拉起一律通过 `cmd.exe /d /s /c "start "" <exe> ..."`（start 立即返回，cmd 不等待 GUI 进程；
 * 裸名时 start 还会查 App Paths）。整段命令必须以 windowsVerbatimArguments 原样交给 cmd：
 * Node/libuv 默认会给含空格与引号的参数外加引号、把内部引号转义成 `\"`，而 cmd 不认反斜杠
 * 转义——start 会收到 `\"\" \"C:\...\Cursor.exe\"`，把 `\"\"` 当成要运行的程序。Node 自己在
 * shell:true 时就是这样处理 cmd.exe 的（/d /s /c + 原样命令串）。
 */

export interface WindowsCursorLaunchSpec {
  /** Cursor 可执行文件（已解析的绝对路径或裸名）。 */
  executable: string
  /** 拉起后打开的工作区（无效路径由调用方先行过滤）。 */
  workspacePath?: string
  /** 附带的 CDP 调试端口（undefined = 普通拉起）。 */
  cdpPort?: number
}

type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string }>

/**
 * Cursor 的 Inno Setup 安装器有「仅当前用户」与「所有用户」两种位置；后者落在
 * Program Files 且不注册 App Paths，裸名 `Cursor.exe` 对 cmd start 不可见。
 */
export function cursorWindowsExecutableCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return cursorInstallRoots('win32', env).map((root) => join(root, 'Cursor.exe'))
}

/** powershell.exe 解析：PATH 优先；System32 缺失的异常会话回退绝对路径。 */
export function windowsPowerShellCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const systemRoot = env.SystemRoot?.trim() || 'C:\\Windows'
  return ['powershell.exe', join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
}

/**
 * Windows PowerShell 5.1 往管道写字符串时默认用 OEM 代码页（zh-CN 机器 = GBK），
 * 而 execFile 按 UTF-8 解码——用户名或安装目录含中文时，读回的 Cursor 路径会变成
 * 乱码，随后 `cmd start "" "<乱码路径>"` 直接失败。每条 -Command 前先把控制台输出
 * 切成无 BOM 的 UTF-8，两端编码才一致（Node 侧不需要任何改动）。
 */
const POWERSHELL_UTF8_OUTPUT_PRELUDE = '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);'

/** 组装 `powershell.exe` 的参数：-NoProfile + UTF-8 输出前导 + 脚本正文。所有 Windows 进程探测统一走这里。 */
export function windowsPowerShellCommandArgs(script: string): string[] {
  return ['-NoProfile', '-Command', `${POWERSHELL_UTF8_OUTPUT_PRELUDE}${script}`]
}

const RUNNING_CURSOR_PATH_ARGS = windowsPowerShellCommandArgs(
  'Get-Process -Name Cursor -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path'
)

/**
 * 正在运行的 Cursor 主进程可执行路径——用户实际在用的那份安装，比任何候选目录都可靠。
 * 必须在终止 Cursor 之前采集；未运行 / 查询失败返回 undefined，调用方回退候选目录。
 */
export async function runningCursorWindowsExecutable(execFileFn: ExecFileFn): Promise<string | undefined> {
  for (const powershell of windowsPowerShellCandidates()) {
    try {
      const { stdout } = await execFileFn(powershell, RUNNING_CURSOR_PATH_ARGS)
      const path = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      return path && /\\Cursor\.exe$/i.test(path) ? path : undefined
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') return undefined
    }
  }
  return undefined
}

/** 补丁与运行中的安装保持一致；未运行时查安装器登记的位置，再回退常见目录。 */
export async function resolveWindowsCursorWorkbench(
  execFileFn: ExecFileFn,
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  const bundleIn = (root: string) => join(root, 'resources', 'app', 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
  const runningPath = await runningCursorWindowsExecutable(execFileFn)
  // 已找到活进程时，即使文件缺失也返回这份路径，让调用方报告读失败，绝不改另一份安装。
  if (runningPath) return bundleIn(win32.dirname(runningPath))
  const registryArgs = windowsPowerShellCommandArgs(
    "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Cursor( \\(.*\\))?$' -and $_.InstallLocation } | Select-Object -ExpandProperty InstallLocation -Unique"
  )
  for (const powershell of windowsPowerShellCandidates(env)) {
    try {
      const { stdout } = await execFileFn(powershell, registryArgs)
      const registered = stdout.split(/\r?\n/).map(path => path.trim()).filter(path => win32.isAbsolute(path))
      const located = registered.map(bundleIn).find(exists)
      if (located) return located
      break
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'ENOENT') break
    }
  }
  return cursorWorkbenchBundleCandidates('win32', env).find(exists)
}

/**
 * 解析 Windows Cursor 可执行文件：运行中进程路径（刚从活进程读到，直接信任）→ 常见安装目录
 * → 裸名（App Paths / PATH）。裸名是最后手段：没有 App Paths 注册时 cmd start 会报「找不到 Cursor.exe」。
 */
export function resolveCursorWindowsExecutable(options: {
  runningPath?: string
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
} = {}): string {
  if (options.runningPath) return options.runningPath
  const exists = options.exists ?? existsSync
  return cursorWindowsExecutableCandidates(options.env).find((candidate) => exists(candidate)) ?? 'Cursor.exe'
}

/** 交给 execFile 的完整拉起命令：file + args + 必须携带的 spawn 选项。 */
export interface WindowsCursorStartCommand {
  file: 'cmd.exe'
  args: string[]
  options: { windowsVerbatimArguments: true }
}

/**
 * 组装 cmd start 命令：`/d /s /c "start "" "<exe>" ["<workspace>"] [--remote-debugging-port=N ...]"`。
 * 整段命令外面再包一层引号并以 windowsVerbatimArguments 原样传递——cmd 的 /s 规则是「首字符为引号
 * 则去掉首尾两个引号、其余原样」，于是 start 拿到的正是我们写的那一行；不加原样标记时 Node 会把
 * 内部引号转义成 `\"`（见文件头注释）。两个调用方（CDP 重启、账号切换拉起）都必须把 options 传下去。
 */
export function cursorWindowsStartCommand(spec: WindowsCursorLaunchSpec): WindowsCursorStartCommand {
  const parts = [`start "" "${spec.executable}"`]
  if (spec.workspacePath) parts.push(`"${spec.workspacePath}"`)
  if (spec.cdpPort) {
    parts.push(`--remote-debugging-port=${spec.cdpPort}`)
    parts.push('--disable-features=LocalNetworkAccessChecks')
  }
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${parts.join(' ')}"`], options: { windowsVerbatimArguments: true } }
}

const CURSOR_COMMAND_LINES_ARGS = windowsPowerShellCommandArgs(
  'Get-CimInstance Win32_Process -Filter "Name=\'Cursor.exe\'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine'
)

/**
 * 运行中所有 Cursor.exe 进程的完整命令行（主进程 + Chromium 子进程）。CDP 端口没起来时用它区分
 * 「没起来 / 起来了但没带参数 / 带了参数但端口不通」三种完全不同的原因。查询失败返回 undefined。
 */
export async function windowsCursorCommandLines(execFileFn: ExecFileFn): Promise<string[] | undefined> {
  for (const powershell of windowsPowerShellCandidates()) {
    try {
      const { stdout } = await execFileFn(powershell, CURSOR_COMMAND_LINES_ARGS)
      return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') return undefined
    }
  }
  return undefined
}

/**
 * 拉起后调试端口在限定时间内未响应时的诊断文案（纯函数）。三种原因的处置完全不同，
 * 一句「未就绪」分不出来；同事把这句话截图回来就能定位。
 */
export function describeWindowsCdpStartFailure(input: {
  port: number
  executable: string
  commandLines: string[] | undefined
}): string {
  const { port, executable, commandLines } = input
  if (commandLines === undefined) {
    return `Cursor 已拉起，但调试端口 ${port} 在限定时间内未就绪，且无法读取 Cursor 进程信息（PowerShell 不可用）；请确认 Cursor 完全启动后重试`
  }
  if (commandLines.length === 0) {
    return `Cursor 没有启动起来（拉起命令：${executable}）；请检查 Cursor 的安装位置，或手动打开 Cursor 后重试`
  }
  const flag = `--remote-debugging-port=${port}`
  if (!commandLines.some((line) => line.includes(flag))) {
    return `Cursor 在运行，但进程命令行里没有 ${flag}——很可能拉起时仍有残留的 Cursor.exe，本次启动被它接管；请完全退出 Cursor（任务管理器里确认没有 Cursor.exe）后重试`
  }
  return `Cursor 已带 ${flag} 启动，但端口 ${port} 无响应：可能落在 Windows 保留端口段（netsh int ipv4 show excludedportrange protocol=tcp）或被安全软件拦截；可用环境变量 ${CURSOR_CDP_PORT_ENV} 指定其他端口后重启拾光`
}

/**
 * 统计运行中的 Cursor 主进程数（含 Helper——与 mac 侧 pgrep -f 的匹配语义对齐：
 * 只要还有任一 Cursor 进程就视为「未退净」）。
 * 探测真实失败（超时/命令被策略禁用）时抛错：调用方（CDP 重启）必须 fail-closed，
 * 否则会误判「未运行」跳过退出流程，直接 start 出第二个 Cursor 实例。
 * 退出码 1 = 过滤器无匹配（部分 tasklist 版本语义，同 pgrep），按 0 处理。
 */
export async function countWindowsCursorProcesses(execFileFn: ExecFileFn): Promise<number> {
  try {
    const { stdout } = await execFileFn('tasklist', ['/NH', '/FI', 'IMAGENAME eq Cursor.exe'])
    return stdout.split(/\r?\n/).filter((line) => line.includes('Cursor.exe')).length
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 1) return 0
    throw error
  }
}
