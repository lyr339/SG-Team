import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WireStore } from '@shiguang/cursor-wire-runtime/store'

const { fileHandles, flushedFiles, rejectFileFlush } = vi.hoisted(() => ({ fileHandles: new Map<number, { path: string; flags: unknown }>(), flushedFiles: [] as string[], rejectFileFlush: { value: false } }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      fileHandles.set(fd, { path: String(args[0]), flags: args[1] }); return fd
    },
    fsyncSync: (fd: number) => {
      const file = fileHandles.get(fd)
      if (file && fs.statSync(file.path).isFile()) {
        if (file.flags === 'r') throw Object.assign(Error('Windows requires a writable flush handle'), { code: 'EPERM' })
        if (rejectFileFlush.value) throw Object.assign(Error('File flush failed'), { code: 'EIO' })
        flushedFiles.push(file.path)
      }
      return fs.fsyncSync(fd)
    },
    closeSync: (fd: number) => { fileHandles.delete(fd); return fs.closeSync(fd) }
  }
})
const paths: string[] = []
afterEach(() => { rejectFileFlush.value = false; flushedFiles.length = 0; fileHandles.clear(); for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }) })
const store = () => { const path = mkdtempSync(join(tmpdir(), 'sg-wire-durable-')); paths.push(path); return { path, value: new WireStore(path, { accountScope: 'test-account', conversationId: 'test-conversation' }) } }
describe('wire store cross-platform durability', () => {
  it('uses writable file flushes before committing checkpoint metadata and resumes from real persisted files', () => {
    const { path, value } = store(), data = Buffer.from('isolated-checkpoint')
    value.saveCheckpoint(data)
    expect(flushedFiles.length).toBe(3)
    expect(flushedFiles.every(p => p.endsWith('.tmp'))).toBe(true)
    expect(value.checkpoint()).toEqual(data)
    expect(new WireStore(path, { accountScope: 'test-account', conversationId: 'test-conversation' }).checkpoint()).toEqual(data)
    expect(fileHandles.size).toBe(0)
  })
  it('does not suppress a real file flush failure or overwrite the previous committed checkpoint', () => {
    const { path, value } = store(), first = Buffer.from('first-checkpoint'), next = Buffer.from('next-checkpoint')
    value.saveCheckpoint(first)
    const before = readFileSync(join(path, 'session.json'))
    rejectFileFlush.value = true
    expect(() => value.saveCheckpoint(next)).toThrow('File flush failed')
    expect(readFileSync(join(path, 'session.json'))).toEqual(before)
    expect(value.checkpoint()).toEqual(first)
    expect(value.metadata.checkpointId).toBe(createHash('sha256').update(first).digest('hex'))
    expect(fileHandles.size).toBe(0)
  })
})
