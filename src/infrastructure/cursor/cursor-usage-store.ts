import { projectUsage, type CursorUsageLedger, type UsageTurn, type CursorSessionUsage, type CursorUsageSnapshot } from '../../domain/cursor-usage'
import { quarantineStoreFileSync, readStoreJsonSync, writeStoreFileSync } from '../fs/store-file'

/**
 * V4：每行自带 runId，文件跨 run 保留全部账本（历史 run 已由 tracker 冻结）。
 * V2/V3 文件只有顶层 runId（单 run 覆盖写），读入时把它盖到没有 runId 的行上——
 * 升级那一刻的账本恰好属于当时的 run，不丢也不错归属。
 */
const STORE_VERSION = 4
const READABLE_VERSIONS = new Set([2, 3, STORE_VERSION])
const MAX_SESSIONS = 1_000

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sessionUsage(value: unknown, composerId: string, fallbackRunId: string | undefined): CursorSessionUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const runId = typeof row.runId === 'string' && row.runId.length > 0 && row.runId.length <= 200 ? row.runId : fallbackRunId
  const turns = finiteNonNegative(row.turns)
  const inputTokens = finiteNonNegative(row.inputTokens)
  const outputTokens = finiteNonNegative(row.outputTokens)
  const cacheReadTokens = finiteNonNegative(row.cacheReadTokens)
  const cacheWriteTokens = finiteNonNegative(row.cacheWriteTokens)
  const estimatedCostUsd = finiteNonNegative(row.estimatedCostUsd)
  const lastTurnAt = finiteNonNegative(row.lastTurnAt)
  // 请求级采样基线：缺失（事件通道会话/旧版本快照）= undefined，存在则随快照恢复
  const contextLastUsed = finiteNonNegative(row.contextLastUsed)
  if (
    turns === undefined || inputTokens === undefined || outputTokens === undefined
    || cacheReadTokens === undefined || cacheWriteTokens === undefined
    || estimatedCostUsd === undefined || lastTurnAt === undefined
    || typeof row.pricedModel !== 'string'
  ) return undefined
  if (row.ledger && typeof row.ledger === 'object' && !Array.isArray(row.ledger)) {
    const raw = row.ledger as Record<string, unknown>
    if (!raw.turns || typeof raw.turns !== 'object' || Array.isArray(raw.turns)) return undefined
    const ledger: CursorUsageLedger = { turns: {} }
    const frozenAt = finiteNonNegative(raw.frozenAt)
    if (raw.frozenAt !== undefined && frozenAt === undefined) return undefined
    if (frozenAt !== undefined) ledger.frozenAt = frozenAt
    for (const [id, value] of Object.entries(raw.turns)) {
      if (!id || id.length > 200 || !value || typeof value !== 'object') return undefined
      const turn = value as UsageTurn
      const counts = [turn.inputTokens, turn.outputTokens, turn.cacheReadTokens, turn.cacheWriteTokens]
      if (counts.some((n) => !Number.isSafeInteger(n) || n < 0)
        || turn.cacheReadTokens + turn.cacheWriteTokens > turn.inputTokens
        || finiteNonNegative(turn.estimatedCostUsd) === undefined || finiteNonNegative(turn.at) === undefined
        || typeof turn.exact !== 'boolean' || !turn.price || typeof turn.price.label !== 'string'
        || [turn.price.inputPerM, turn.price.outputPerM, turn.price.cacheReadPerM, turn.price.cacheWritePerM].some((n) => finiteNonNegative(n) === undefined)
        || (turn.stopped !== undefined && typeof turn.stopped !== 'boolean')
        || (turn.estimateProfile !== undefined && !['claudeCode', 'fable', 'opus46', 'opus5', 'grok', 'default'].includes(turn.estimateProfile))
        || (turn.lastUsed !== undefined && (!Number.isSafeInteger(turn.lastUsed) || turn.lastUsed < 0))) return undefined
      Object.defineProperty(ledger.turns, id, { value: structuredClone(turn), enumerable: true, writable: true, configurable: true })
    }
    return projectUsage(composerId, ledger, runId)
  }
  return {
    quality: 'legacy',
    composerId,
    ...(runId !== undefined ? { runId } : {}),
    turns: Math.floor(turns),
    inputTokens: Math.floor(inputTokens),
    outputTokens: Math.floor(outputTokens),
    cacheReadTokens: Math.floor(cacheReadTokens),
    cacheWriteTokens: Math.floor(cacheWriteTokens),
    estimatedCostUsd,
    pricedModel: row.pricedModel.slice(0, 120),
    lastTurnAt: Math.floor(lastTurnAt),
    ...(contextLastUsed !== undefined ? { contextLastUsed: Math.floor(contextLastUsed) } : {})
  }
}

/** Cursor 用量的本地持久化；只保存计数与费用估算，不含正文或凭据。跨 run 保留，归属由每行 runId 表达。 */
export class CursorUsageStore {
  constructor(readonly path: string) {}

  /**
   * 读出全部 run 的账（时间裁旧由 tracker 负责）。
   * 坏文件 / 不识别的版本不再静默回空——先留档再回空，否则下一次 save 会把
   * 仅存的历史覆写掉（2026-09-17 断电事故正是这样丢的全部账本）。
   */
  load(): CursorUsageSnapshot {
    const file = readStoreJsonSync(this.path)
    if (file.kind !== 'json') return {}
    try {
      const parsed = file.value as {
        version?: unknown
        runId?: unknown
        sessions?: unknown
      }
      const storedRunId = typeof parsed.runId === 'string' ? parsed.runId : undefined
      if (typeof parsed.version !== 'number' || !READABLE_VERSIONS.has(parsed.version) || !parsed.sessions || typeof parsed.sessions !== 'object') {
        quarantineStoreFileSync(this.path, '用量账本版本或结构不符')
        return {}
      }
      const rows = Object.entries(parsed.sessions as Record<string, unknown>)
        .flatMap(([composerId, value]) => {
          const normalizedId = composerId.trim().slice(0, 200)
          const usage = normalizedId ? sessionUsage(value, normalizedId, storedRunId) : undefined
          return usage ? [[normalizedId, usage] as const] : []
        })
        .sort((left, right) => right[1].lastTurnAt - left[1].lastTurnAt)
        .slice(0, MAX_SESSIONS)
      return Object.fromEntries(rows)
    } catch {
      quarantineStoreFileSync(this.path, '用量账本内容异常')
      return {}
    }
  }

  /** runId = 当前 run（诊断用，也是旧格式行的归属回退）；每行自身的 runId 才是权威归属。 */
  save(runId: string | undefined, snapshot: CursorUsageSnapshot): void {
    const sessions = Object.fromEntries(Object.entries(snapshot)
      .sort((left, right) => right[1].lastTurnAt - left[1].lastTurnAt)
      .slice(0, MAX_SESSIONS))
    writeStoreFileSync(this.path, JSON.stringify({ version: STORE_VERSION, runId, sessions }), { mode: 0o600 })
  }
}
