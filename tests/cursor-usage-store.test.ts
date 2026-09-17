import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { priceForModel, projectUsage } from '../src/domain/cursor-usage'
import { CursorUsageStore } from '../src/infrastructure/cursor/cursor-usage-store'

describe('CursorUsageStore', () => {
  it('原子保存并恢复按 composer 聚合的用量；文件不带 run 语义', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    store.save({
      'composer-1': {
        composerId: 'composer-1', turns: 2,
        inputTokens: 12_000, outputTokens: 300,
        cacheReadTokens: 8_000, cacheWriteTokens: 0,
        estimatedCostUsd: 0.123, pricedModel: 'Claude Sonnet', lastTurnAt: 2_000
      }
    })
    expect(store.load()['composer-1']).toMatchObject({ turns: 2, inputTokens: 12_000 })
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written).toMatchObject({ version: 4 })
    expect(written).not.toHaveProperty('runId')
  })

  it('席位标签随行往返：无账本的旧行与带账本的行都保留 slotId；2E 之前的 runId 读入时忽略', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    const row = (composerId: string, lastTurnAt: number, slotId?: string) => ({
      composerId, turns: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      estimatedCostUsd: 0.01, pricedModel: 'GPT', lastTurnAt, ...(slotId ? { slotId } : {})
    })
    store.save({
      seated: row('seated', 1_000, 'slot-a'),
      untagged: row('untagged', 2_000),
      ledgered: projectUsage('ledgered', { turns: { g1: {
        inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.001,
        price: priceForModel('gpt-5'), exact: true, at: 5_000
      } }, frozenAt: 6_000 }, 'slot-b')
    })
    const loaded = store.load()
    expect(loaded.seated?.slotId).toBe('slot-a')
    expect(loaded.untagged).not.toHaveProperty('slotId')
    expect(loaded.ledgered).toMatchObject({ slotId: 'slot-b', quality: 'exact', ledger: { frozenAt: 6_000 } })
    // 2E 之前的 V4 文件：顶层与行上的 runId 都被忽略，账本原样读入。
    writeFileSync(path, JSON.stringify({ version: 4, runId: 'run-b', sessions: {
      old: { ...row('old', 1_000), runId: 'run-a' },
      slotted: { ...row('slotted', 2_000, 'slot-c'), runId: 'run-b' }
    } }))
    const upgraded = store.load()
    expect(upgraded.old).not.toHaveProperty('runId')
    expect(upgraded.old).not.toHaveProperty('slotId')
    expect(upgraded.slotted).toMatchObject({ slotId: 'slot-c' })
    expect(upgraded.slotted).not.toHaveProperty('runId')
  })

  it('V3 单 run 文件升级：全部行照常读入，不丢账', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    writeFileSync(path, JSON.stringify({ version: 3, runId: 'session-run:ws:run-1', sessions: {
      c1: { turns: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.1, pricedModel: 'GPT', lastTurnAt: 5 }
    } }))
    const loaded = new CursorUsageStore(path).load()
    expect(loaded.c1).toMatchObject({ composerId: 'c1', quality: 'legacy', turns: 1 })
    expect(loaded.c1).not.toHaveProperty('runId')
  })

  it('坏文件与非法行不进入运行快照', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    writeFileSync(path, '{bad json')
    expect(store.load()).toEqual({})
    writeFileSync(path, JSON.stringify({ version: 99, sessions: {} }))
    expect(store.load()).toEqual({})
    writeFileSync(path, JSON.stringify({ version: 2, runId: 'run-1', sessions: {
      broken: { turns: -1 },
      valid: {
        turns: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
        estimatedCostUsd: 0.1, pricedModel: 'GPT', lastTurnAt: 5, slotId: ''
      }
    }}))
    // 空 slotId 视为没有标签。
    expect(store.load()).toEqual({ valid: expect.objectContaining({ composerId: 'valid', turns: 1 }) })
    expect(store.load().valid).not.toHaveProperty('slotId')
    stderr.mockRestore()
  })

  it('断电损坏的账本先留档再回空：现场保留，后续保存不覆写（2026-09-17 事故回归）', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const base = mkdtempSync(join(tmpdir(), 'shiguang-usage-'))
    const path = join(base, 'usage.json')
    const store = new CursorUsageStore(path)
    // NTFS 断电后的典型现场：文件存在但内容零填充
    writeFileSync(path, '\u0000'.repeat(128))
    expect(store.load()).toEqual({})
    // 损坏文件已改名留档，不再停留在原路径
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(base).filter((name) => name.startsWith('usage.json.corrupt-'))).toHaveLength(1)
    // 下一次保存写全新文件，留档现场不受影响
    store.save({
      c1: {
        composerId: 'c1', turns: 1, inputTokens: 1, outputTokens: 1,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: 0.01, pricedModel: 'GPT', lastTurnAt: 1
      }
    })
    expect(store.load().c1).toMatchObject({ composerId: 'c1', turns: 1 })
    expect(readdirSync(base).filter((name) => name.startsWith('usage.json.corrupt-'))).toHaveLength(1)
    stderr.mockRestore()
  })

  it('请求级采样基线随快照往返（跨重启延续），旧版本快照缺字段不受影响', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    store.save({
      'sampled': {
        composerId: 'sampled', turns: 3, inputTokens: 90_000, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: 0.27, pricedModel: 'Claude Sonnet', lastTurnAt: 9_000,
        contextLastUsed: 31_000
      },
      'event-based': {
        composerId: 'event-based', turns: 1, inputTokens: 1_000, outputTokens: 200,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: 0.006, pricedModel: 'GPT', lastTurnAt: 8_000
      }
    })
    const loaded = store.load()
    expect(loaded['sampled']?.contextLastUsed).toBe(31_000)
    expect(loaded['event-based']?.contextLastUsed).toBeUndefined()
  })
})
