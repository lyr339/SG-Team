import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string }>

export function defaultExecFile(file: string, args: string[]): Promise<{ stdout: string }> {
  return execFileAsync(file, args, { encoding: 'utf8', timeout: 5_000 })
}

export function cursorProcessName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'Cursor.exe' : 'Cursor'
}

/**
 * Cursor 主进程是否存活——「独占写 state.vscdb 是否安全」这一问题的唯一出口
 * （换号写库、存储清理共用）。mac/linux `pgrep -x Cursor`，win `tasklist /FI IMAGENAME eq Cursor.exe`。
 * 退出码 1 = 过滤器无匹配 = 确定未运行（pgrep 与部分 tasklist 版本语义）；其他失败
 * （超时 / 命令缺失 / 被策略禁用）原样抛出——无法证明 Cursor 已死，调用方必须 fail-closed，
 * 绝不带着不确定的进程状态动数据库（「Cursor 运行中抢写锁冻结主进程」卡死根因的防线）。
 *
 * CDP 重启流程另有「任一 Cursor 进程（含 Helper）仍在即未退净」的计数语义，见
 * cursor-cdp-restart.ts；那是退出轮询用的，不在这里合并。
 */
export async function isCursorMainProcessRunning(
  execFileFn: ExecFileFn = defaultExecFile,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const name = cursorProcessName(platform)
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileFn('tasklist', ['/NH', '/FI', `IMAGENAME eq ${name}`])
      return stdout.includes(name)
    }
    const { stdout } = await execFileFn('pgrep', ['-x', name])
    return stdout.trim().length > 0
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 1) return false
    throw error
  }
}

/**
 * 三态版：true / false 明确；undefined = 探测本身失败，无法证明任何事。
 * 需要「Cursor 已退出」为前提的操作把 undefined 当作不可执行。
 */
export async function probeCursorRunning(
  execFileFn: ExecFileFn = defaultExecFile,
  platform: NodeJS.Platform = process.platform
): Promise<boolean | undefined> {
  try {
    return await isCursorMainProcessRunning(execFileFn, platform)
  } catch {
    return undefined
  }
}
