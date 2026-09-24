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
  /**
   * 基线不是用户为本批次显式设定的，而是沿用来的：`cursor` = Cursor 当前选中的模型，
   * `previous` = 上一次运行里多数席位的配置。据此打一枚说明标。
   */
  implicitFrom?: 'cursor' | 'previous'
  /** 与统一配置不同的席位数（有基线时）。 */
  overriddenCount?: number
  /** 注脚上追加的一句说明，例如运行中的批次：改动只作用于下一次新建会话。 */
  hint?: string
  /** 没有统一基线时各席的分布，如「2 席 Claude Fable 5 · 2 席 Kimi K3」。 */
  spread?: string
  /** 没有统一基线时弹层的起草点（通常是第一席的现状）。 */
  fallback?: CursorModelSelection
  disabled?: boolean
  /** 把一套配置写到全部席位；抛错时弹层留在原地显示错误。 */
  onSave: (selection: CursorModelSelection) => Promise<void> | void
}

const IMPLICIT_TAG = {
  cursor: { label: 'Cursor 当前', title: '尚未统一设置，沿用 Cursor 当前选中的模型' },
  previous: { label: '沿用上次', title: '尚未为本批次设置，沿用上一次运行里多数席位的配置' }
} as const

/**
 * 「会话配置」：批次的一项属性，与目标工程、会话数量并列——
 * 一眼看到全部席位共用的模型与参数，点「修改」一次改全部；各席已经分叉时显示分布并提供「统一」。
 * 单个席位的例外在席位列表里标「单独配置」，可就地恢复。
 */
export function RunBatchConfig({
  models,
  seatCount,
  uniform,
  implicitFrom,
  overriddenCount = 0,
  hint,
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
  const tag = implicitFrom ? IMPLICIT_TAG[implicitFrom] : undefined
  const note = [overriddenCount > 0 ? `另有 ${overriddenCount} 席单独配置` : '', hint].filter(Boolean).join(' · ')

  return (
    // 播报区是这一行本身：值块换装时会整块重挂载，读屏监听的必须是它稳定的父节点。
    <div className={`run-field run-batch-config${diverged ? ' is-spread' : ''}`} aria-live="polite">
      <span className="run-field__label">会话配置</span>
      <div key={stamp} className={`run-field__value run-batch-config__value${stamp > 0 ? ' is-swapped' : ''}`}>
        {!ready ? (
          // 目录不是「正在加载」——主进程每一拍都在读 Cursor 的 state.vscdb。读不到只有两种情形：
          // Cursor 还没把模型列表写回（刚登录 / 冷切换账号后要等它几十秒），或 Cursor 根本没启动、没登录。
          <>
            <strong><span>Cursor 当前模型</span></strong>
            <small>Cursor 尚未写入模型列表：登录或切换账号后需等几十秒；持续如此请确认 Cursor 已启动并登录</small>
          </>
        ) : uniform ? (
          <>
            <strong className={modelProviderClass(uniform.modelId, uniform.displayName)}>
              <i className="run-batch-config__swatch" aria-hidden="true" />
              <span>{uniform.displayName}</span>
              {tag ? <em className="run-batch-config__tag" title={tag.title}>{tag.label}</em> : null}
            </strong>
            <small>{cursorModelSelectionSummary(uniform, option)}</small>
          </>
        ) : (
          <>
            <strong><span>各席配置不同</span></strong>
            <small>{spread}</small>
          </>
        )}
        {ready && note ? <small className="run-batch-config__note">{note}</small> : null}
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
