import type { TeamMemberConfiguration } from '../domain/team-control'
import type { CreateIndependentSessionsInput } from '../shared/desktop-api'
import type { CursorModelOption, CursorModelSelection } from '../domain/cursor-model'
import { cursorVariantSupportsMode } from '../domain/cursor-model-variants'
import { AGENT_AVATAR_IDS } from '../domain/team-control'

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} 无效`)
  }
  return value.trim()
}

function defaultModelSelection(models: CursorModelOption[]): CursorModelSelection | undefined {
  const option = models.find((model) => model.selected) ?? models[0]
  return option ? {
    modelId: option.modelId,
    displayName: option.displayName,
    parameters: structuredClone(option.parameters),
    maxMode: option.maxMode === true
  } : undefined
}

function resolveModelSelection(
  models: CursorModelOption[],
  raw: unknown
): CursorModelSelection | undefined {
  if (raw === undefined) return defaultModelSelection(models)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Cursor 模型配置无效')
  const candidate = raw as Partial<CursorModelSelection>
  const modelId = requiredText(candidate.modelId, 'modelId', 160)
  const option = models.find((model) => model.modelId === modelId)
  if (!option) throw new Error(`Cursor 模型不可用或已失效：${modelId}`)
  if (!Array.isArray(candidate.parameters)) throw new Error(`模型参数无效：${option.displayName}`)
  const requested = new Map<string, string>()
  for (const parameter of candidate.parameters) {
    if (!parameter || typeof parameter !== 'object') throw new Error(`模型参数无效：${option.displayName}`)
    const id = requiredText((parameter as { id?: unknown }).id, 'parameter.id', 80)
    const value = requiredText((parameter as { value?: unknown }).value, 'parameter.value', 160)
    if (requested.has(id)) throw new Error(`模型参数重复：${id}`)
    requested.set(id, value)
  }
  const definitions = new Map(option.parameterDefinitions.map((definition) => [definition.id, definition]))
  for (const [id, value] of requested) {
    const definition = definitions.get(id)
    if (!definition || !definition.values.some((entry) => entry.value === value)) {
      throw new Error(`模型参数不可用：${option.displayName} · ${id}=${value}`)
    }
  }
  const defaults = new Map(option.parameters.map((parameter) => [parameter.id, parameter.value]))
  const parameters = option.parameterDefinitions.flatMap((definition) => {
    const value = requested.get(definition.id) ?? defaults.get(definition.id) ?? definition.values[0]?.value
    return value === undefined ? [] : [{ id: definition.id, value }]
  })
  if (candidate.maxMode === true && option.supportsMaxMode === false) {
    throw new Error(`模型不支持 MAX Mode：${option.displayName}`)
  }
  const maxMode = option.supportsNonMaxMode === false ? true : candidate.maxMode === true
  if (option.variants?.length) {
    const selected = new Map(parameters.map((parameter) => [parameter.id, parameter.value]))
    const validVariant = option.variants.some((variant) => {
      const values = new Map(variant.parameters.map((parameter) => [parameter.id, parameter.value]))
      return cursorVariantSupportsMode(option, variant, maxMode)
        && option.parameterDefinitions.every((definition) => values.get(definition.id) === selected.get(definition.id))
    })
    if (!validVariant) throw new Error(`Cursor 模型参数组合不可用：${option.displayName}`)
  }
  return {
    modelId: option.modelId,
    displayName: option.displayName,
    parameters,
    maxMode
  }
}

/** 独立批次（会话池）的席位配置：CH-1..N 全部 solo，每席一份模型选定（缺省取目录默认）。 */
export function resolveIndependentSessionMembers(
  models: CursorModelOption[],
  input: CreateIndependentSessionsInput
): TeamMemberConfiguration[] {
  if (!Array.isArray(input.sessions) || input.sessions.length < 1 || input.sessions.length > 16) {
    throw new Error('独立会话数量必须在 1 到 16 之间')
  }
  return input.sessions.map((session, index) => {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      throw new Error(`独立会话 ${index + 1} 配置无效`)
    }
    return {
      channelId: String(index + 1),
      roleTemplateKey: 'solo',
      avatarId: AGENT_AVATAR_IDS[(index + 5) % AGENT_AVATAR_IDS.length]!,
      skills: [],
      modelSelection: resolveModelSelection(models, session.modelSelection),
      solo: true
    }
  })
}
