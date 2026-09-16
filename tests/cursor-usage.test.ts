import { describe, expect, it } from 'vitest'
import {
  cursorUsageDetail,
  estimateUsageFromReference,
  hasCacheWriteBucket,
  projectUsage,
  reduceUsage,
  estimateTurnCostUsd,
  formatCostUsd,
  formatTokenCount,
  priceForModel,
  totalUsageTokens,
  upgradeUsageEstimate,
  usageBelongsToRun,
  usageHasCacheWriteBucket,
  USAGE_HISTORY_RETENTION_MS,
  type CursorSessionUsage,
  type CursorUsageEvent
} from '../src/domain/cursor-usage'

function event(overrides: Partial<CursorUsageEvent> = {}): CursorUsageEvent {
  return {
    composerId: 'composer-1',
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    occurredAt: 1_000,
    ...overrides
  }
}

describe('priceForModel', () => {
  it('未命中价格表时如实显示真实模型名 + 估算档位（跨回合重解析费率一致）', () => {
    const auto = priceForModel('auto')
    expect(auto.label).toBe('auto · Sonnet 档估算')
    expect(auto.inputPerM).toBe(3)
    expect(priceForModel(auto.label).inputPerM).toBe(auto.inputPerM)
    expect(priceForModel('starlight-9').label).toBe('starlight-9 · Sonnet 档估算')
  })

  it('归一化后按词边界匹配并区分版本（表内顺序即优先级，更具体的在前）', () => {
    expect(priceForModel('claude-sonnet-4-5').label).toBe('Claude Sonnet')
    expect(priceForModel('CLAUDE-OPUS-4-1').label).toBe('Claude Opus 4.1')
    expect(priceForModel('gpt-5.1').label).toBe('GPT-5.1')
    expect(priceForModel('gpt-5.1-codex-mini').label).toBe('GPT-5.1 Codex Mini')
    expect(priceForModel('gemini-2.5-pro').label).toBe('Gemini 2.5 Pro')
    expect(priceForModel('composer-2.5').label).toBe('Composer')
    expect(priceForModel(undefined).label).toBe('默认（Sonnet 档）')
  })

  it('gpt-4o-mini 先于 gpt-4o 命中（顺序敏感）', () => {
    expect(priceForModel('gpt-4o-mini-2024').inputPerM).toBe(0.15)
    expect(priceForModel('gpt-4o-2024').inputPerM).toBe(2.5)
  })

  it('键与版本数字紧邻仍从词首命中（qwen3-max），跨系列不误伤（o3 ≠ gpt-5.3-codex）', () => {
    expect(priceForModel('qwen3-max').label).toBe('Qwen3 Max')
    expect(priceForModel('Qwen3 Max').label).toBe('Qwen3 Max')
    expect(priceForModel('gpt-5.3-codex').label).toBe('GPT-5.3 Codex')
    expect(priceForModel('o3-2025-04-16').label).toBe('OpenAI o3')
    expect(priceForModel('claude-fable-5-1-20260815').label).toBe('Claude Fable 5.1')
    expect(priceForModel('fable-5').label).toBe('Claude Fable 5')
    expect(priceForModel('grok-4.6-fast').label).toBe('Grok 4.6 Fast')
    // 无 fast 后缀的 grok 落泛化条目，而不是错拼进带版本的 fast 变体
    expect(priceForModel('grok-4.6').label).toBe('Grok')
    expect(priceForModel('kimi-k3').label).toBe('Kimi K3')
    // DeepSeek 2026-09-14 起 v4-pro 请求也按 V4.1 Flash 计费，泛化条目即 Flash 价
    expect(priceForModel('deepseek-v4-flash').label).toBe('DeepSeek V4.1 Flash')
    expect(priceForModel('deepseek-v4-pro').inputPerM).toBe(0.15)
  })

  it('Cursor 价表新增条目命中专档而非泛化档：GPT-6 Astra、Composer 1、Muse Spark 1.3', () => {
    expect(priceForModel('gpt-6-astra')).toMatchObject({ label: 'GPT-6 Astra', inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 })
    expect(priceForModel('gpt-6').label).toBe('GPT-6')
    expect(priceForModel('composer-1')).toMatchObject({ label: 'Composer 1', inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 })
    expect(priceForModel('composer-2.5').inputPerM).toBe(0.5)
    expect(priceForModel('muse-spark-1-3')).toMatchObject({ label: 'Muse Spark 1.3', inputPerM: 1.25, outputPerM: 4.25, cacheReadPerM: 0.15 })
  })

  it('缓存写价按 provider 口径：Anthropic 与 GPT-5.6 系写 1.25×，其余写价 = 输入价（非 0）', () => {
    const opus = priceForModel('claude-opus-4-1')
    expect(opus.cacheWritePerM).toBeCloseTo(opus.inputPerM * 1.25, 6)
    const sol = priceForModel('gpt-5.6-sol')
    expect(sol.cacheWritePerM).toBeCloseTo(sol.inputPerM * 1.25, 6)
    // OpenAI 5.5 及更早不收写入溢价：新进上下文按普通输入价计，写价为 0 会把新进 token 算成免费
    const legacy = priceForModel('gpt-5.5')
    expect(legacy.cacheWritePerM).toBe(legacy.inputPerM)
    expect(legacy.cacheWritePerM).toBeGreaterThan(0)
    const gemini = priceForModel('gemini-3-pro')
    expect(gemini.cacheWritePerM).toBe(gemini.inputPerM)
  })

  it('「有无缓存写入桶」由写价是否高于输入价推导（官方口径 2026-09-15）', () => {
    for (const model of ['claude-fable-5-1', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra', 'auto']) {
      expect(hasCacheWriteBucket(priceForModel(model)), model).toBe(true)
    }
    for (const model of ['gpt-5.5', 'gpt-5.4', 'gpt-5', 'o3', 'gemini-3-8-flash', 'gemini-3-pro', 'grok-4.6', 'cursor-grok-4.6-fast',
      'composer-2.5-fast', 'composer-1', 'kimi-k3', 'kimi-k2.7-code', 'glm-5.2', 'muse-spark-1-3', 'deepseek-v4-1-flash', 'qwen3-max']) {
      expect(hasCacheWriteBucket(priceForModel(model)), model).toBe(false)
    }
  })
})

describe('estimateTurnCostUsd', () => {
  it('sonnet 档：1M 输入 = $3；缓存读 1/10 价', () => {
    const price = priceForModel('claude-sonnet-4-5')
    expect(estimateTurnCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, occurredAt: 0 }, price)).toBeCloseTo(3, 6)
    expect(estimateTurnCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, occurredAt: 0 }, price)).toBeCloseTo(0.3, 6)
    expect(estimateTurnCostUsd({ inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, occurredAt: 0 }, price)).toBeCloseTo(1.5, 6)
  })
})

describe('token 口径（缓存读/写 ⊂ 输入，2026-09-01 实证定稿）', () => {
  it('总 token = 输入 + 输出，缓存子集不重复计入', () => {
    // 事故会话形态：input 6.2M 中 5.82M 命中缓存读——旧口径曾报 12.06M（虚高一倍）。
    expect(totalUsageTokens({ inputTokens: 6_199_999, outputTokens: 44_859, cacheReadTokens: 5_819_074, cacheWriteTokens: 0 }))
      .toBe(6_244_858)
    expect(totalUsageTokens({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 5 })).toBe(110)
  })

  it('费用只对未缓存输入收全价：缓存读 1/10、缓存写 1.25×（旧口径虚报 6 倍）', () => {
    const price = priceForModel('claude-sonnet-4-5')
    // 1M 输入中 900K 命中缓存读：100K×$3 + 900K×$0.3 = $0.57（旧并列口径错算 $3.27）。
    expect(estimateTurnCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000, cacheWriteTokens: 0, occurredAt: 0 }, price))
      .toBeCloseTo(0.57, 6)
    // 事故会话整笔复核：$3.56 而非 $21.02。
    expect(estimateTurnCostUsd({ inputTokens: 6_199_999, outputTokens: 44_859, cacheReadTokens: 5_819_074, cacheWriteTokens: 0, occurredAt: 0 }, price))
      .toBeCloseTo(3.56, 2)
    // 上游口径异常（缓存 > 输入）时 clamp 到 0，不产生负费。
    expect(estimateTurnCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, occurredAt: 0 }, price))
      .toBeCloseTo(0.3, 6)
  })
})

describe('缓存写入桶按厂商口径拆分（2026-09-15 官方核对：只有 Anthropic 与 GPT-5.6+ 有写入桶）', () => {
  const INPUT = 57_500_000
  const NO_BUCKET = ['kimi-k3', 'gemini-3-8-flash', 'composer-2.5', 'gpt-5.5', 'glm-5.2', 'muse-spark-1-3', 'deepseek-v4-1-flash', 'qwen3-max']

  it('无写入桶厂商：估算 Cache Write 为零，写入份额归回普通输入；命中缓存 / 输入总量 / 输出与同比例的有桶拆分一致，费用不变', () => {
    // GPT-5.6 Sol 与这些模型同走 default 比例但有写入桶——作为「同比例、有桶」的对照形态。
    const shaped = estimateUsageFromReference(INPUT, 'gpt-5.6-sol', priceForModel('gpt-5.6-sol'))
    expect(shaped.estimateProfile).toBe('default')
    expect(shaped.cacheWriteTokens).toBeGreaterThan(0)
    for (const model of NO_BUCKET) {
      const price = priceForModel(model)
      const usage = estimateUsageFromReference(INPUT, model, price)
      expect(usage.estimateProfile, model).toBe('default')
      expect(usage.cacheWriteTokens, model).toBe(0)
      expect(usage.inputTokens, model).toBe(INPUT)
      expect(usage.cacheReadTokens, model).toBe(shaped.cacheReadTokens)
      expect(usage.outputTokens, model).toBe(shaped.outputTokens)
      // fresh = input − read − write：原写入份额并入普通输入
      expect(usage.inputTokens - usage.cacheReadTokens, model).toBe(shaped.inputTokens - shaped.cacheReadTokens)
      // 这些厂商写价 = 输入价：同一形态按写入桶计价与归并后计价费用相同
      expect(usage.estimatedCostUsd, model).toBeCloseTo(estimateTurnCostUsd({ ...shaped, occurredAt: 0 }, price), 10)
    }
  })

  it('有写入桶厂商保留写入份额：Claude 走 claudeCode 比例，GPT-5.6 / GPT-6 与未知模型（Sonnet 档）走 default 比例', () => {
    const cases = [['claude-fable-5-1', 'claudeCode'], ['claude-sonnet-4-5', 'claudeCode'], ['gpt-5.6-sol', 'default'], ['gpt-6-astra', 'default'], ['auto', 'default']] as const
    for (const [model, profile] of cases) {
      const usage = estimateUsageFromReference(INPUT, model, priceForModel(model))
      expect(usage.estimateProfile, model).toBe(profile)
      expect(usage.cacheWriteTokens, model).toBeGreaterThan(0)
      expect(usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens, model).toBeGreaterThanOrEqual(0)
    }
  })

  it('已落盘的混合账本：无桶厂商的估算写入归零并回普通输入，精确回合与有桶厂商不动；原对象不变、重复投影幂等', () => {
    const turn = { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 100,
      estimatedCostUsd: .001, price: priceForModel('kimi-k3'), exact: false, at: 10 }
    const ledger = { frozenAt: 20, turns: {
      kimi: turn,
      gemini: { ...turn, price: priceForModel('gemini-3-pro') },
      // Cursor 精确结算若带写入，以 Cursor 为准
      geminiExact: { ...turn, price: priceForModel('gemini-3-pro'), exact: true },
      claude: { ...turn, price: priceForModel('claude-sonnet') }
    } }
    const result = projectUsage('mixed', ledger)
    expect(result.ledger!.turns.kimi!.cacheWriteTokens).toBe(0)
    expect(result.ledger!.turns.gemini!.cacheWriteTokens).toBe(0)
    expect(result.ledger!.turns.geminiExact!.cacheWriteTokens).toBe(100)
    expect(result.ledger!.turns.claude!.cacheWriteTokens).toBe(100)
    expect(result.cacheWriteTokens).toBe(200)
    expect(result.inputTokens).toBe(4000)
    expect(result.cacheReadTokens).toBe(3200)
    expect(result.estimatedCostUsd).toBeCloseTo(.004, 10)
    expect(result.ledger!.frozenAt).toBe(20)
    expect(result.pricedModel).toBe('Mixed models')
    expect(turn.cacheWriteTokens).toBe(100)
    expect(projectUsage('mixed', result.ledger!)).toEqual(result)
  })

  it('upgradeUsageEstimate 归一旧 default 比例回合的写入份额（不重估、费用不变）；无需归一时原样返回，二次加载幂等', () => {
    const counts = { inputTokens: 3_000_000, outputTokens: 60_000, cacheReadTokens: 2_760_000, cacheWriteTokens: 222_000 }
    const persist = (price: ReturnType<typeof priceForModel>, estimateProfile: string): CursorSessionUsage => {
      const turn = { ...counts, estimatedCostUsd: estimateTurnCostUsd({ ...counts, occurredAt: 0 }, price), price, exact: false, estimateProfile, at: 5 }
      return { composerId: 'c', turns: 1, ...counts, estimatedCostUsd: turn.estimatedCostUsd, pricedModel: price.label, lastTurnAt: 5, quality: 'estimated', ledger: { turns: { g1: turn } } }
    }
    const gemini = persist(priceForModel('gemini-3-8-flash'), 'default')
    const upgraded = upgradeUsageEstimate(gemini)
    expect(upgraded).not.toBe(gemini)
    expect(upgraded.cacheWriteTokens).toBe(0)
    expect(upgraded.ledger!.turns.g1).toMatchObject({ cacheWriteTokens: 0, estimateProfile: 'default', inputTokens: 3_000_000, cacheReadTokens: 2_760_000, outputTokens: 60_000 })
    expect(upgraded.estimatedCostUsd).toBeCloseTo(gemini.estimatedCostUsd, 10)
    expect(upgradeUsageEstimate(upgraded)).toBe(upgraded)
    // Claude 同形态回合有写入桶，不归一、原样返回
    const claude = persist(priceForModel('claude-sonnet-4-5'), 'claudeCode')
    expect(upgradeUsageEstimate(claude)).toBe(claude)
  })

  it('usageHasCacheWriteBucket / cursorUsageDetail：无桶厂商的 Cache Write 写 —；有桶、混合模型或 Cursor 精确结算带写入时写数字', () => {
    const base = { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 0, estimatedCostUsd: .001, exact: false, at: 1 }
    const kimi = projectUsage('k', { turns: { g1: { ...base, price: priceForModel('kimi-k3') } } })
    expect(usageHasCacheWriteBucket(kimi)).toBe(false)
    expect(cursorUsageDetail(kimi)).toBe('Tokens 1K · Cost $0.001 · Input 200 · Output 10 · Cache Write — · Cache Read 800')
    const claude = projectUsage('c', { turns: { g1: { ...base, cacheWriteTokens: 50, price: priceForModel('claude-sonnet-4-5') } } })
    expect(usageHasCacheWriteBucket(claude)).toBe(true)
    expect(cursorUsageDetail(claude)).toBe('Tokens 1K · Cost $0.001 · Input 150 · Output 10 · Cache Write 50 · Cache Read 800')
    // 有桶厂商写入恰为 0 仍保留该行（0 是观测值，不是「不适用」）
    expect(usageHasCacheWriteBucket(projectUsage('c0', { turns: { g1: { ...base, price: priceForModel('claude-sonnet-4-5') } } }))).toBe(true)
    // 混合模型：任一厂商有桶即呈现
    expect(usageHasCacheWriteBucket(projectUsage('m', { turns: {
      k: { ...base, price: priceForModel('kimi-k3') }, c: { ...base, price: priceForModel('claude-sonnet-4-5') } } }))).toBe(true)
    // 精确结算带写入：以 Cursor 为准
    expect(usageHasCacheWriteBucket(projectUsage('x', { turns: { g1: { ...base, cacheWriteTokens: 5, exact: true, price: priceForModel('kimi-k3') } } }))).toBe(true)
    // 无账本的旧快照按 pricedModel 判断
    const legacy = { composerId: 'l', turns: 1, inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 0, estimatedCostUsd: .001, lastTurnAt: 1, quality: 'legacy' as const }
    expect(usageHasCacheWriteBucket({ ...legacy, pricedModel: 'Kimi K3' })).toBe(false)
    expect(usageHasCacheWriteBucket({ ...legacy, pricedModel: 'Gemini 3.8 Flash' })).toBe(false)
    expect(usageHasCacheWriteBucket({ ...legacy, pricedModel: 'Claude Fable 5.1' })).toBe(true)
    expect(usageHasCacheWriteBucket({ ...legacy, pricedModel: '默认（Sonnet 档）' })).toBe(true)
  })
})

describe('展示格式化', () => {
  it('token 缩写与费用缩写', () => {
    expect(formatTokenCount(950)).toBe('950')
    expect(formatTokenCount(12_168)).toBe('12.2K')
    expect(formatTokenCount(95_000)).toBe('95K')
    expect(formatTokenCount(150_000)).toBe('150K')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
    expect(formatTokenCount(12_000_000)).toBe('12M')
    expect(formatTokenCount(2_100_000_000)).toBe('2.1B')
    expect(formatCostUsd(0)).toBe('$0.00')
    expect(formatCostUsd(0.004)).toBe('$0.004')
    expect(formatCostUsd(0.0421)).toBe('$0.042')
    expect(formatCostUsd(1.5)).toBe('$1.50')
  })

  it('run 归属：投影与归约都随行保留 runId；徽章只认当前 run，无标签的旧账不限定', () => {
    const turn = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.001, price: priceForModel('gpt-5'), exact: true, at: 5 }
    const tagged = projectUsage('c', { turns: { g1: turn } }, 'run-a')
    expect(tagged.runId).toBe('run-a')
    expect(projectUsage('c', { turns: { g1: turn } })).not.toHaveProperty('runId')
    // 同 composer 的下一回合：归约后 runId 不丢。
    const reduced = reduceUsage(tagged, { kind: 'checkpoint', value: { ...event({ composerId: 'c', inputTokens: 20, outputTokens: 2, cacheReadTokens: 0 }), generationId: 'g2' } })
    expect(reduced).toMatchObject({ runId: 'run-a', turns: 2 })
    expect(upgradeUsageEstimate(tagged).runId).toBe('run-a')
    expect(usageBelongsToRun({ runId: 'run-a' }, 'run-a')).toBe(true)
    expect(usageBelongsToRun({ runId: 'run-a' }, 'run-b')).toBe(false)
    expect(usageBelongsToRun({ runId: 'run-a' }, undefined)).toBe(false)
    expect(usageBelongsToRun({}, 'run-b')).toBe(true)
    // 保留窗口至少覆盖统计页「30 天」范围（本地午夜起算 ≤ 30×24h）。
    expect(USAGE_HISTORY_RETENTION_MS).toBeGreaterThanOrEqual(30 * 86_400_000)
  })
})
