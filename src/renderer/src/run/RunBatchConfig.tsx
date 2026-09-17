import { useState } from 'react'
import type { CursorModelOption, CursorModelSelection } from '../../../domain/cursor-model'
import { cursorModelSelectionSummary, sameCursorModelSelection } from '../cursor-model-selection'
import { CursorModelConfigDialog } from '../lobby/CursorModelConfigDialog'
import { modelProviderClass } from '../model-provider'
import { LayersIcon } from '../UiIcons'

export interface RunBatchConfigProps {
  models: CursorModelOption[]
  /** 这套配置会铺到多少个席位（配置中 = 会话数量；运行中 = 批次席位数）。 */
  seatCount: number
  /** 批次的统一配置。各席已经不同、又没有统一基线时为空——此时显示分布并提供「统一」。 */
  uniform?: CursorModelSelection
  /** 统一配置只是沿用 Cursor 当前模型，用户尚未显式设置过。 */
  implicit?: boolean
  /** 与统一配置不同的席位数（有基线时）。 */
  overriddenCount?: number
  /** 没有统一基线时各席的分布，如「2 席 Claude Fable 5 · 2 席 Kimi K3」。 */
  spread?: string
  /** 没有统一基线时弹层的起草点（通常是第一席的现状）。 */
  fallback?: CursorModelSelection
  disabled?: boolean
  /** 把一套配置写到全部席位；抛错时弹层留在原地显示错误。 */
  onSave: (selection: CursorModelSelection) => Promise<void> | void
}

/**
 * 「会话配置」：批次的一项属性，与目标工程、会话数量并列——
 * 一眼看到全部席位共用的模型与参数，点「修改」一次改全部；各席已经分叉时显示分布并提供「统一」。
 * 单个席位的例外在席位列表里标「单独配置」，可就地恢复。
 */
export function RunBatchConfig({
  models,
  seatCount,
  uniform,
  implicit = false,
  overriddenCount = 0,
  spread,
  fallback,
  disabled = false,
  onSave
}: RunBatchConfigProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // 每次统一落地后递增：值块重新挂载，回放一次「换装」动画作确认（首次挂载不放）。
  const [stamp, setStamp] = useState(0)
  const ready = models.length > 0
  const option = uniform ? models.find((model) => model.modelId === uniform.modelId) : undefined
  const diverged = ready && !uniform
  const actionLabel = diverged ? '统一' : '修改'

  return (
    <div className={`run-field run-batch-config${diverged ? ' is-spread' : ''}`}>
      <span className="run-field__label">会话配置</span>
      <div key={stamp} className={`run-field__value run-batch-config__value${stamp > 0 ? ' is-swapped' : ''}`} aria-live="polite">
        {!ready ? (
          <>
            <strong><span>Cursor 当前模型</span></strong>
            <small>模型目录加载后即可为全部席位统一设置</small>
          </>
        ) : uniform ? (
          <>
            <strong className={modelProviderClass(uniform.modelId, uniform.displayName)}>
              <i className="run-batch-config__swatch" aria-hidden="true" />
              <span>{uniform.displayName}</span>
              {implicit ? <em className="run-batch-config__tag" title="尚未统一设置，沿用 Cursor 当前选中的模型">Cursor 当前</em> : null}
            </strong>
            <small>{cursorModelSelectionSummary(uniform, option)}</small>
            {overriddenCount > 0 ? (
              <small className="run-batch-config__note">另有 {overriddenCount} 席单独配置</small>
            ) : null}
          </>
        ) : (
          <>
            <strong><span>各席配置不同</span></strong>
            <small>{spread}</small>
          </>
        )}
      </div>
      <button
        type="button"
        className="run-link run-batch-config__action"
        disabled={disabled || !ready || seatCount === 0}
        aria-label={`${actionLabel}全部 ${seatCount} 个席位的会话配置`}
        title={`为全部 ${seatCount} 个席位设置同一套模型与参数`}
        onClick={() => setOpen(true)}
      >
        <LayersIcon />{actionLabel}
      </button>

      {open ? (
        <CursorModelConfigDialog
          scope={{ kind: 'all', count: seatCount }}
          models={models}
          selection={uniform ?? fallback}
          disabled={disabled}
          onSave={async (selection) => {
            await onSave(selection)
            setStamp((current) => current + 1)
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

/**
 * 运行中批次的统一基线：被严格多数席位共用的那份配置（5 席里 3 席以上）。
 * 没有多数就没有基线——各席分叉，显示分布。参数顺序无关，MAX Mode 缺省视为关。
 */
export function majoritySelection(selections: Array<CursorModelSelection | undefined>): CursorModelSelection | undefined {
  const groups: Array<{ selection: CursorModelSelection; count: number }> = []
  for (const selection of selections) {
    if (!selection) continue
    const group = groups.find((candidate) => sameCursorModelSelection(candidate.selection, selection))
    if (group) group.count += 1
    else groups.push({ selection, count: 1 })
  }
  const best = groups.reduce<{ selection: CursorModelSelection; count: number } | undefined>(
    (winner, group) => (!winner || group.count > winner.count ? group : winner),
    undefined
  )
  return best && best.count * 2 > selections.length ? best.selection : undefined
}

/** 各席分布的一句话：按模型归并，「2 席 Claude Fable 5 · 2 席 Kimi K3」；同一模型不同参数时点明是参数不同。 */
export function describeSelectionSpread(selections: Array<CursorModelSelection | undefined>): string {
  const counts = new Map<string, { name: string; count: number }>()
  for (const selection of selections) {
    const key = selection?.modelId ?? ''
    const entry = counts.get(key) ?? { name: selection?.displayName ?? 'Cursor 当前模型', count: 0 }
    entry.count += 1
    counts.set(key, entry)
  }
  if (counts.size <= 1) {
    const only = [...counts.values()][0]
    return only ? `${only.name} · 参数各不相同` : ''
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count)
    .map((entry) => `${entry.count} 席 ${entry.name}`)
    .join(' · ')
}
