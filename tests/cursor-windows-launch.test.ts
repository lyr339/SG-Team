import { describe, expect, it } from 'vitest'
import {
  cursorWindowsExecutableCandidates,
  resolveCursorWindowsExecutable,
  runningCursorWindowsExecutable,
  windowsPowerShellCommandArgs
} from '../src/infrastructure/cursor/cursor-windows-launch'

const env = {
  LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  ProgramW6432: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)'
}

describe('Windows Cursor executable resolution', () => {
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
