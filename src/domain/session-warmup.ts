import type { CursorModelOption, CursorModelSelection, CursorModelVariant } from './cursor-model'

/**
 * 会话预热探针：批量发起前，用最低成本模型跑一次「只回复：1」，
 * 把「当前账号能真实跑通模型响应」变成硬证据，再放行批量创建。
 *
 * 两条铁律：
 * 1. 预热绝不经过 AgentSessionLauncher 的 onAllTriggered——否则一次探针
 *    就会触发账号自动化（删号链）。预热有自己的独立服务与判定级。
 * 2. 低成本模型全部不可用时绝不静默升级贵模型——报告并交给用户决策。
 */

export const SESSION_WARMUP_PROMPT = '只回复：1'
export const SESSION_WARMUP_SESSION_NAME = '拾光预热'
export const SESSION_WARMUP_TIMEOUT_MS = 30_000
export const SESSION_WARMUP_SLOW_MS = 10_000
export const SESSION_WARMUP_MAX_CANDIDATES = 3

export type SessionWarmupPhase = 'creating' | 'waiting' | 'done' | 'failed'

export interface SessionWarmupRun {
  phase: SessionWarmupPhase
  message: string
  /** 实际用于预热的模型展示名。 */
  modelLabel?: string
  startedAt: number
  finishedAt?: number
  /** 提交到响应完成的耗时（done 时必有）。 */
  durationMs?: number
  /** 响应偏慢（> SESSION_WARMUP_SLOW_MS）：成功但提示账号可能拥挤。 */
  slow?: boolean
}

/**
 * 低成本模型偏好链（按牌价升序，GPT-5.6 Luna 为用户指定首选）。
 * 匹配语义与 cursor-usage 牌价表一致：双方归一为小写、非字母数字折成 `-`，
 * 片段必须从词首开始、到词尾结束——`gpt-5-mini` 不会命中 `gpt-5-6-mini`。
 */
const WARMUP_MODEL_PREFERENCE = [
  'gpt-5-6-luna',
  'gpt-4o-mini',
  'gpt-5-4-nano',
  'gpt-5-mini',
  'gpt-5-1-codex-mini'
] as const

function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function modelIdMatchesFragment(modelId: string, fragment: string): boolean {
  const key = normalizeModelKey(modelId)
  const pattern = new RegExp(`(^|-)${fragment}(?=-|$|\\d)`)
  return pattern.test(key)
}

/**
 * 一个参数组合的成本分：每个「增加费用」的参数值记 1 分，MAX Mode 记 100 分
 * （预热永远不选 MAX）。无目录定义时不猜，按 0 计。
 */
function variantCostScore(option: CursorModelOption, variant: CursorModelVariant): number {
  let score = variant.maxMode ? 100 : 0
  for (const parameter of variant.parameters) {
    const definition = option.parameterDefinitions.find((candidate) => candidate.id === parameter.id)
    const value = definition?.values.find((candidate) => candidate.value === parameter.value)
    if (value?.increasesCost) score += 1
  }
  return score
}

/**
 * 从模型目录条目选出「无思考」配置：成本分最低的 variant；
 * 同分优先目录默认非 MAX 配置（最贴近 Cursor 原生默认行为）。
 * 无 variants 时沿用条目默认参数，maxMode 恒为 false。
 */
export function pickWarmupSelectionFromOption(option: CursorModelOption): CursorModelSelection {
  const variants = option.variants ?? []
  const best = variants.length
    ? [...variants].sort((a, b) => {
        const costDiff = variantCostScore(option, a) - variantCostScore(option, b)
        if (costDiff !== 0) return costDiff
        if ((a.isDefaultNonMaxConfig === true) !== (b.isDefaultNonMaxConfig === true)) return a.isDefaultNonMaxConfig ? -1 : 1
        return 0
      })[0]!
    : undefined
  return {
    modelId: option.modelId,
    displayName: option.displayName,
    parameters: structuredClone(best?.parameters ?? option.parameters),
    maxMode: false
  }
}

export interface SessionWarmupCandidate {
  selection: CursorModelSelection
  /** 展示名（如「GPT-5.6 Luna」），用于预热状态文案。 */
  label: string
}

/**
 * 按偏好链从当前模型目录挑出前 N 个预热候选（目录中没有的跳过）。
 * 返回空数组 = 无可用低成本模型——调用方必须报告，不得静默换贵模型。
 */
export function rankWarmupModelCandidates(models: CursorModelOption[]): SessionWarmupCandidate[] {
  const candidates: SessionWarmupCandidate[] = []
  for (const fragment of WARMUP_MODEL_PREFERENCE) {
    const option = models.find((model) => modelIdMatchesFragment(model.modelId, fragment))
    if (!option) continue
    candidates.push({ selection: pickWarmupSelectionFromOption(option), label: option.displayName })
    if (candidates.length >= SESSION_WARMUP_MAX_CANDIDATES) break
  }
  return candidates
}

/** 模型配置类错误（换下一个候选重试）与其他错误（立即失败）的分流判定。 */
export function isWarmupModelRejection(message: string): boolean {
  return /^model_(config_service_not_ready|unconfirmed|inspection_failed)/.test(message)
    || message === 'composer_handle_not_ready'
}

export function warmupDoneMessage(label: string, durationMs: number, slow: boolean): string {
  const seconds = (durationMs / 1_000).toFixed(1)
  return slow
    ? `预热通过 · ${label} · ${seconds}s（响应偏慢，账号可能拥挤）`
    : `预热通过 · ${label} · ${seconds}s`
}
