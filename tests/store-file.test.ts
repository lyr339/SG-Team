import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quarantineStoreFileSync, readStoreJsonSync, writeStoreFileSync } from '../src/infrastructure/fs/store-file'

const freshDir = () => mkdtempSync(join(tmpdir(), 'sg-store-file-'))

describe('writeStoreFileSync', () => {
  it('fsync 落盘并原子替换，自动建目录，不留临时文件', () => {
    const path = join(freshDir(), 'nested', 'store.json')
    writeStoreFileSync(path, '{"version":1}\n', { mode: 0o600 })
    expect(readFileSync(path, 'utf8')).toBe('{"version":1}\n')
    writeStoreFileSync(path, '{"version":2}\n', { mode: 0o600 })
    expect(readFileSync(path, 'utf8')).toBe('{"version":2}\n')
    expect(readdirSync(dirname(path))).toEqual(['store.json'])
    // POSIX 权限断言只在类 Unix 生效：Windows 的 statSync 不映射 0600 语义
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('自定义临时文件路径被采用且随替换消失', () => {
    const base = freshDir()
    const path = join(base, 'config.json')
    writeStoreFileSync(path, 'x', { temporaryPath: join(base, '.config.custom.tmp') })
    expect(readFileSync(path, 'utf8')).toBe('x')
    expect(readdirSync(base)).toEqual(['config.json'])
  })
})

describe('readStoreJsonSync / quarantineStoreFileSync', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('文件不存在回 missing（首次启动不算损坏），正常 JSON 回原值', () => {
    const path = join(freshDir(), 'a.json')
    expect(readStoreJsonSync(path)).toEqual({ kind: 'missing' })
    writeFileSync(path, '{"ok":true}')
    expect(readStoreJsonSync(path)).toEqual({ kind: 'json', value: { ok: true } })
  })

  it('断电式损坏（全 NUL）改名留档，绝不留在原路径等着被下次保存覆写', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const base = freshDir()
    const path = join(base, 'usage.json')
    // NTFS 断电后的典型现场：rename 已提交、数据页未落盘 → 文件读出来是零填充
    writeFileSync(path, '\u0000'.repeat(64))
    const read = readStoreJsonSync(path)
    expect(read.kind).toBe('quarantined')
    expect(existsSync(path)).toBe(false)
    const kept = readdirSync(base).filter((name) => name.startsWith('usage.json.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(base, kept[0]!), 'utf8')).toBe('\u0000'.repeat(64))
    expect(stderr).toHaveBeenCalled()
  })

  it('留档失败（文件已不存在）不抛错，返回 undefined', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(quarantineStoreFileSync(join(freshDir(), 'missing.json'), '测试')).toBeUndefined()
    expect(stderr).toHaveBeenCalled()
  })
})
