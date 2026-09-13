import { describe, expect, it, vi } from 'vitest'
import { cursorProcessName, isCursorMainProcessRunning, probeCursorRunning } from '../src/infrastructure/cursor/cursor-process-probe'

function exitCode(code: number | string, message = 'exec failed'): Error & { code: number | string } {
  return Object.assign(new Error(message), { code })
}

describe('Cursor 主进程探针', () => {
  it('mac：pgrep -x Cursor 有输出即运行中；退出码 1 = 确定未运行；其他失败原样抛出', async () => {
    const exec = vi.fn(async () => ({ stdout: '424242\n' }))
    expect(await isCursorMainProcessRunning(exec, 'darwin')).toBe(true)
    expect(exec).toHaveBeenCalledWith('pgrep', ['-x', 'Cursor'])

    expect(await isCursorMainProcessRunning(async () => ({ stdout: '   \n' }), 'darwin')).toBe(false)
    expect(await isCursorMainProcessRunning(async () => { throw exitCode(1, 'no matching processes') }, 'darwin')).toBe(false)
    await expect(isCursorMainProcessRunning(async () => { throw exitCode('ETIMEDOUT', 'spawn pgrep ETIMEDOUT') }, 'darwin'))
      .rejects.toThrow('spawn pgrep ETIMEDOUT')
  })

  it('win：tasklist 按映像名过滤，输出里出现 Cursor.exe 即运行中；退出码 1 同样视为未运行', async () => {
    const exec = vi.fn(async () => ({ stdout: 'Cursor.exe   1234 Console   1   512,000 K\r\n' }))
    expect(await isCursorMainProcessRunning(exec, 'win32')).toBe(true)
    expect(exec).toHaveBeenCalledWith('tasklist', ['/NH', '/FI', 'IMAGENAME eq Cursor.exe'])
    expect(await isCursorMainProcessRunning(async () => ({ stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' }), 'win32')).toBe(false)
    expect(await isCursorMainProcessRunning(async () => { throw exitCode(1) }, 'win32')).toBe(false)
    await expect(isCursorMainProcessRunning(async () => { throw exitCode('ENOENT', 'spawn tasklist ENOENT') }, 'win32')).rejects.toThrow('ENOENT')
    expect(cursorProcessName('win32')).toBe('Cursor.exe')
    expect(cursorProcessName('linux')).toBe('Cursor')
  })

  it('三态版把探测失败折成 undefined——需要「已退出」为前提的操作据此拒绝执行', async () => {
    expect(await probeCursorRunning(async () => ({ stdout: '1\n' }), 'darwin')).toBe(true)
    expect(await probeCursorRunning(async () => { throw exitCode(1) }, 'darwin')).toBe(false)
    expect(await probeCursorRunning(async () => { throw exitCode('ETIMEDOUT') }, 'darwin')).toBeUndefined()
  })
})
