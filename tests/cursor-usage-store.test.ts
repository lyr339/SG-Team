import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { priceForModel, projectUsage } from '../src/domain/cursor-usage'
import { CursorUsageStore } from '../src/infrastructure/cursor/cursor-usage-store'

describe('CursorUsageStore', () => {
  it('原子保存并恢复按 composer 聚合的用量', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    store.save('run-1', {
      'composer-1': {
        composerId: 'composer-1', turns: 2,
        inputTokens: 12_000, outputTokens: 300,
        cacheReadTokens: 8_000, cacheWriteTokens: 0,
        estimatedCostUsd: 0.123, pricedModel: 'Claude Sonnet', lastTurnAt: 2_000
      }
    })
    // 行自身没有 runId 的旧形态：顶层 runId 盖上去；文件不再因 run 切换而清空。
    expect(store.load()['composer-1']).toMatchObject({ turns: 2, inputTokens: 12_000, runId: 'run-1' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 4, runId: 'run-1' })
  })

  it('跨 run 的账并存：每行 runId 权威，顶层 runId 只补无标签的行', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    const row = (composerId: string, lastTurnAt: number, runId?: string) => ({
      composerId, turns: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      estimatedCostUsd: 0.01, pricedModel: 'GPT', lastTurnAt, ...(runId ? { runId } : {})
    })
    store.save('run-b', {
      old: row('old', 1_000, 'run-a'),
      current: row('current', 2_000, 'run-b'),
      untagged: row('untagged', 3_000)
    })
    const loaded = store.load()
    expect(loaded.old?.runId).toBe('run-a')
    expect(loaded.current?.runId).toBe('run-b')
    expect(loaded.untagged?.runId).toBe('run-b')
    // 带账本的行同样保留归属（projectUsage 投影不吞 runId）。
    store.save('run-c', {
      ledgered: projectUsage('ledgered', { turns: { g1: {
        inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.001,
        price: priceForModel('gpt-5'), exact: true, at: 5_000
      } }, frozenAt: 6_000 }, 'run-a')
    })
    expect(store.load().ledgered).toMatchObject({ runId: 'run-a', quality: 'exact', ledger: { frozenAt: 6_000 } })
  })

  it('V3 单 run 文件升级：全部行归入文件级 runId，不丢账', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    writeFileSync(path, JSON.stringify({ version: 3, runId: 'session-run:ws:run-1', sessions: {
      c1: { turns: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.1, pricedModel: 'GPT', lastTurnAt: 5 }
    } }))
    const loaded = new CursorUsageStore(path).load()
    expect(loaded.c1).toMatchObject({ composerId: 'c1', runId: 'session-run:ws:run-1', quality: 'legacy' })
  })

  it('坏文件与非法行不进入运行快照', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    writeFileSync(path, '{bad json')
    expect(store.load()).toEqual({})
    writeFileSync(path, JSON.stringify({ version: 99, runId: 'run-1', sessions: {} }))
    expect(store.load()).toEqual({})
    writeFileSync(path, JSON.stringify({ version: 2, runId: 'run-1', sessions: {
      broken: { turns: -1 },
      valid: {
        turns: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
        estimatedCostUsd: 0.1, pricedModel: 'GPT', lastTurnAt: 5
      }
    }}))
    expect(store.load()).toEqual({ valid: expect.objectContaining({ composerId: 'valid', turns: 1 }) })
  })

  it('请求级采样基线随快照往返（跨重启延续），旧版本快照缺字段不受影响', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shiguang-usage-')), 'usage.json')
    const store = new CursorUsageStore(path)
    store.save('run-1', {
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
